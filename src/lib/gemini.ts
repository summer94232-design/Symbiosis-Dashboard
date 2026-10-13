import { authenticatedFetch } from './authenticatedFetch'

// Existing note actions share the secure Gemini account and the combined AI budget.
async function callGemini(prompt: string): Promise<string> {
    if (prompt.length > 12000) throw new Error('候選筆記或標籤過多，請縮小畫面篩選範圍，或使用 AI 助理分批整理；本次尚未呼叫模型。')
    const response = await authenticatedFetch('/.netlify/functions/ai-assistant', undefined, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'helper', id: crypto.randomUUID(), model: 'gemini-3.5-flash-lite', messages: [{ role: 'user', content: prompt }] }),
    })
    const data = await response.json() as { answer: string; partial?:boolean }
    if (data.partial || typeof data.answer !== 'string' || !data.answer.trim()) throw new Error('AI 未完整回傳建議，原資料保留，請手動重試。')
    return data.answer
}
const callGeminiJSON = callGemini
function stringSuggestions(text:string) {
    let parsed:unknown
    try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'').trim()) }
    catch { throw new Error('AI 建議格式不完整，原資料保留，請手動重試。') }
    if (!Array.isArray(parsed) || parsed.some(value=>typeof value !== 'string')) throw new Error('AI 建議格式不正確，原資料保留，請手動重試。')
    return [...new Set((parsed as string[]).map(value=>value.trim()).filter(Boolean))]
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

export async function generateHashtags(
    content: string,
    title: string,
    existingTags: string[] = []
): Promise<string[]> {
    const existingTagsStr = existingTags.length > 0
        ? `\n\n現有標籤庫（優先從這裡選擇，若有合適的請直接使用，不要創造新標籤）：\n${existingTags.join('、')}`
        : ''

    const text = await callGeminiJSON(`請分析以下筆記內容，產生 3-6 個最相關的 hashtag 標籤。
標籤規則：
- 使用繁體中文
- 每個標籤簡短精確（2-6個字）
- 支援母子標籤格式，例如：投資/台股、料理/食譜
- 優先使用現有標籤庫中的標籤，只在沒有合適標籤時才新增
- 只回傳標籤字串陣列，格式為 JSON array，例如：["投資/台股","技術分析"]
- 不要加 # 符號，不要有其他文字${existingTagsStr}

標題：${title}
內容：${content.slice(0, 1000)}`)

    return stringSuggestions(text).filter(tag=>tag.length<=60 && !/[\r\n#]/.test(tag)).slice(0,6)
}

export async function summarizeContent(content: string): Promise<string> {
    const text = await callGemini(
        `請用 2-3 句話總結以下內容的重點，使用繁體中文，簡潔扼要：\n\n${content.slice(0, 2000)}`
    )
    return text
}

export async function findRelatedNotes(
    currentTitle: string,
    currentContent: string,
    allNotes: { id: string; title: string; content: string }[]
): Promise<string[]> {
    if (!allNotes.length) return []
    const notesList = allNotes
        .map(n => `ID: ${n.id} | 標題: ${n.title} | 內容摘要: ${n.content.slice(0, 100)}`)
        .join('\n')

    const text = await callGeminiJSON(`分析以下筆記，找出與「目標筆記」最相關的筆記 ID。

目標筆記：
標題：${currentTitle}
內容：${currentContent.slice(0, 500)}

目前畫面提供的候選清單（只是標題與部分摘要，不代表完整知識庫）：
${notesList}

請回傳最相關的 3-5 筆筆記 ID，格式為 JSON array，例如：["id1", "id2", "id3"]
只回傳 JSON array，不要其他文字。`)

    const allowed = new Set(allNotes.map(note=>note.id))
    return stringSuggestions(text).filter(id=>allowed.has(id)).slice(0,5)
}

// ── getDailyNews ──────────────────────────────────────────────────────────
// 本地端（netlify dev）和部署端一律走 /.netlify/functions/news-proxy
// news-proxy 負責：News API 抓取英文新聞 → 關鍵字分類 → 回傳 NewsItem[]
// 本地開發請用 `netlify dev` 啟動，不要用 `npm run dev`
export async function getDailyNews(): Promise<{ title: string; category: string; url: string; source: string }[]> {
    try {
        const res = await authenticatedFetch('/.netlify/functions/news-proxy')

        if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error((err as { error?: string }).error || `HTTP ${res.status}`)
        }

        const data = await res.json()

        if (!Array.isArray(data) || data.length === 0) {
            throw new Error('news-proxy 回傳空陣列')
        }

        return data
    } catch (err) {
        console.error('getDailyNews error:', err)
        throw err
    }
}
