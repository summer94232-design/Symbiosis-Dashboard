// Intent filtering over the existing full-text index, without extra model calls
// or database reads. This remains lexical search, not a semantic search engine.
export const normalizeSearchText = text => String(text || '').normalize('NFKC').toLocaleLowerCase('zh-TW').replace(/\s+/g, '')
const ignored = new Set(['幫我','可以','什麼','哪些','一下','整理','筆記','內容','現在','目前','最新','投資','機會','曾經','我的','這個','這些','相關','研究',
    '需要','想要','想找','希望','有沒有','是不是','可不可以','是否','關於','有關','為什麼','為何','怎麼','如何','因為','所以','但是','應該','可能','一些','很多','兩個','你會','給我','提供','推薦','請問','請幫','幫忙','告訴','看看','搜尋','檢索','比較','分別','各自',
    '找出','知道','我想','中有','寫過','最近','那些','之前','以前','過去','建立','儲存','收藏','使用','包含','記得','印象','知識庫','裏面','裡面','or','and',
    '簡單','快速','好吃','容易','適合','不要','不含','不加','不放','排除'])
const categories = new Set(['食譜','料理','烹飪','烹調','菜譜','做法','品牌','服裝','書籍','書本','閱讀','紀錄','記錄','資訊','資料','題材','產業'])
const recipeTerms = ['食譜','料理','烹飪','烹調','菜譜']
const recipeMarkers = ['食譜','料理','烹飪','食材','調味','醬油','做法','烤箱','氣炸','燉煮','紅燒','滷牛','火鍋','牛肉麵','熱鍋','小火','大火','煎至','炒至']
// Broad ingredients include common cut names; specific cuts stay specific.
const aliases = {
    牛肉: ['牛肉','牛腱','牛腩','牛排','牛肋','牛小排','牛絞肉','牛筋','牛尾','beef'],
    雞肉: ['雞肉','雞胸','雞腿','雞翅','雞柳','chicken'],
    豬肉: ['豬肉','豬里肌','豬五花','豬絞肉','豬肋排','pork'],
}
const compoundTerms = ['知識庫','氣炸鍋','半導體','牛小排','牛絞肉','豬絞肉','豬五花','豬里肌']
const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function tokens(text) {
    const spans = [], pattern = new RegExp(compoundTerms.join('|'), 'g')
    let start = 0
    for (const match of text.matchAll(pattern)) {
        spans.push(text.slice(start, match.index), match[0]); start = match.index + match[0].length
    }
    spans.push(text.slice(start))
    const segmenter = new Intl.Segmenter('zh-TW', { granularity: 'word' })
    return spans.flatMap(span => compoundTerms.includes(span) ? [span] : [...segmenter.segment(span)]
        .filter(p => p.isWordLike && p.segment.length > 1).map(p => p.segment))
}
export function searchTerms(question, explicit = '') {
    const text = String(explicit.trim() || question).normalize('NFKC').toLocaleLowerCase('zh-TW')
    // Spaces separate explicit keywords instead of creating one joined phrase.
    const words = explicit.trim() ? text.slice(0, 120).split(/[\s，,、；;]+/).filter(Boolean).flatMap(tokens) : tokens(text)
    return [...new Set(words.filter(word => explicit.trim() || !ignored.has(word)
        && !/^(?:幾|哪|某|一|兩|二|三|四|五|六|七|八|九|十|\d+)(?:個|道|則|篇|份|種|本)$/.test(word)))].slice(0, 8)
}
export function isRetrievalDiscussion(question) {
    return /(?:搜尋|檢索|分詞|匹配)(?:結果|邏輯|方式|系統|條件|機制)|(?:AND|OR)\s*邏輯/i.test(question)
        && /為什麼|為何|怎麼|如何|問題|不準|不相關|無關|修正|解決/.test(question)
        && !/重新找|重新搜|再找|再搜/.test(question)
}
export function createSearchPlan(question, explicit = '') {
    const terms = searchTerms(question, explicit)
    const text = String(explicit.trim() || question).normalize('NFKC').toLocaleLowerCase('zh-TW')
    const excluded = terms.filter(term => new RegExp(`(?:不含|不加|不放|不要|排除)\\s*${escapePattern(term)}`).test(text))
    const positive = terms.filter(term => !excluded.includes(term))
    const core = positive.filter(term => !categories.has(term))
    const required = core.length ? core : positive
    const recipe = recipeTerms.some(term => positive.includes(term)) || /食譜|料理|烹飪|烹調|菜譜/.test(question)
    const groups = []
    for (const term of required) {
        const previous = groups.at(-1)?.at(-1)
        const alternatives = previous && new RegExp(`${escapePattern(previous)}\\s*(?:或是|或者|或|、|\\bor\\b)\\s*${escapePattern(term)}`, 'i').test(text)
        if (alternatives) groups.at(-1).push(term)
        else groups.push([term])
    }
    const comparison = /比較|分別|各自/.test(text)
    return { terms, core, excluded, groups: comparison && required.length ? [required] : groups, recipe,
        passageTerms: [...new Set((core.length ? core : positive).flatMap(term => aliases[term] || [term]))] }
}
export function matchSearchPlan(plan, rawTexts, title = '') {
    const texts = rawTexts.map(normalizeSearchText), normalizedTitle = normalizeSearchText(title)
    const dictionary = plan.aliases || aliases
    const matches = term => (dictionary[term] || [term]).some(alias => texts.some(text => text.includes(alias)))
    if (plan.excluded.some(matches)) return 0
    if (plan.groups.length ? !plan.groups.every(group => group.some(matches)) : !plan.terms.some(matches)) return 0
    if (plan.categoryTerms?.length && !plan.categoryTerms.some(matches)) return 0
    if (plan.recipe && !recipeMarkers.some(term => texts.some(text => text.includes(term)))) return 0
    return plan.terms.reduce((score, term) => score + (matches(term) ? (plan.core.includes(term) ? 4 : 1) : 0)
        + ((dictionary[term] || [term]).some(alias => normalizedTitle.includes(alias)) ? 2 : 0), 0)
}
