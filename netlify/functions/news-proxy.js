import { invokeEventHandler } from '../lib/http-function.js'
import { authorizeApi, apiError, apiHeaders, cachedApi } from '../lib/api-access.js'
// netlify/functions/news-proxy.js
// 架構：三個來源並行抓取，各自失敗不影響其他來源
//   1. News API      → 英文國際財經新聞
//   2. 鉅亨網 API    → 台股中文財經新聞
//   3. Yahoo RSS     → 台股中文財經新聞（備援）
// 回傳統一格式：{ title, category, url, source, lang }

// ── 分類關鍵字（英文） ──────────────────────────────────────────────────────
const EN_CATEGORY_KEYWORDS = {
    科技: ['tech', 'ai', 'apple', 'google', 'microsoft', 'nvidia', 'chip', 'semiconductor', 'software', 'meta', 'amazon', 'tesla'],
    經濟: ['fed', 'rate', 'inflation', 'gdp', 'economy', 'economic', 'recession', 'unemployment', 'cpi', 'interest'],
    政治: ['trump', 'biden', 'president', 'congress', 'government', 'election', 'policy', 'tariff', 'sanction', 'war'],
}

// ── 分類關鍵字（中文） ──────────────────────────────────────────────────────
const ZH_CATEGORY_KEYWORDS = {
    科技: ['AI', '人工智慧', '晶片', '半導體', '輝達', '台積電', 'NVIDIA', 'Apple', '蘋果', '科技', '軟體'],
    經濟: ['通膨', '利率', 'GDP', '央行', '聯準會', '升息', '降息', '就業', 'CPI', '經濟', '財報'],
    政治: ['政府', '選舉', '關稅', '制裁', '地緣', '戰爭', '兩岸', '貿易戰', '政策'],
    台股: ['台股', '加權', '上市', '上櫃', '融資', '法人', '外資', '投信', '自營', '大盤'],
}

function classifyEN(title) {
    const lower = title.toLowerCase()
    for (const [cat, kws] of Object.entries(EN_CATEGORY_KEYWORDS)) {
        if (kws.some(kw => lower.includes(kw))) return cat
    }
    return '市場'
}

function classifyZH(title) {
    for (const [cat, kws] of Object.entries(ZH_CATEGORY_KEYWORDS)) {
        if (kws.some(kw => title.includes(kw))) return cat
    }
    return '台股'
}

// ── 1. News API（英文） ─────────────────────────────────────────────────────
async function fetchNewsAPI(apiKey) {
    const queries = ['stock market', 'finance economy', 'technology business']
    const allArticles = []

    for (const q of queries) {
        try {
            const res = await newsFetch(
                `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=5&apiKey=${apiKey}`
            )
            const data = await res.json()
            if (data.articles) allArticles.push(...data.articles)
        } catch (err) {
            console.error(`[newsapi] query "${q}" 失敗:`, err.message)
        }
    }

    const seen = new Set()
    return allArticles
        .filter(a => a.title && a.url && !a.title.includes('[Removed]'))
        .filter(a => {
            if (seen.has(a.url)) return false
            seen.add(a.url)
            return true
        })
        .slice(0, 15)
        .map(a => ({
            title: a.title,
            category: classifyEN(a.title),
            url: a.url,
            source: a.source?.name || 'NewsAPI',
            lang: 'en',
        }))
}

// ── 2. 鉅亨網 API（中文台股） ──────────────────────────────────────────────
async function fetchCnyes() {
    const res = await newsFetch(
        'https://api.cnyes.com/media/api/v1/newslist/category/tw_stock?limit=20',
        {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        }
    )
    if (!res.ok) throw new Error(`鉅亨網回應 ${res.status}`)

    const data = await res.json()
    const articles = data?.items?.data || []

    return articles.map(a => ({
        title: a.title || '',
        category: classifyZH(a.title || ''),
        url: `https://news.cnyes.com/news/id/${a.newsId}`,
        source: '鉅亨網',
        lang: 'zh',
    })).filter(a => a.title)
}

// ── 3. Yahoo 股市 RSS（中文台股） ───────────────────────────────────────────
async function fetchYahooRSS() {
    const res = await newsFetch('https://tw.stock.yahoo.com/rss', {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        },
    })
    if (!res.ok) throw new Error(`Yahoo RSS 回應 ${res.status}`)

    const xml = await res.text()

    // 用正規表達式解析 RSS（Node.js Netlify Function 沒有 DOMParser）
    const items = []
    const itemRegex = /<item>([\s\S]*?)<\/item>/g
    let match

    while ((match = itemRegex.exec(xml)) !== null) {
        const block = match[1]
        const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) ||
            /<title>(.*?)<\/title>/.exec(block))?.[1]?.trim()
        const link = (/<link>(.*?)<\/link>/.exec(block))?.[1]?.trim()

        if (title && link) {
            items.push({
                title,
                category: classifyZH(title),
                url: link,
                source: 'Yahoo 股市',
                lang: 'zh',
            })
        }
    }

    return items.slice(0, 20)
}

// ── 主 handler ──────────────────────────────────────────────────────────────
export const handleEvent = async event => {
    const denied = await authorizeApi(event, 'news')
    if (denied) return denied
    try { return await cachedApi('news', 300000, loadNews) }
    catch { return apiError(502, '新聞服務暫時無法使用') }
}
const loadNews = async () => {
    const NEWS_API_KEY = process.env.NEWS_API_KEY

    // 三個來源並行抓取，各自錯誤不影響其他
    const [newsAPIResult, cnyesResult, yahooResult] = await Promise.allSettled([
        NEWS_API_KEY ? fetchNewsAPI(NEWS_API_KEY) : Promise.resolve([]),
        fetchCnyes(),
        fetchYahooRSS(),
    ])

    // 收集成功的結果並記錄失敗
    const allArticles = []

    if (newsAPIResult.status === 'fulfilled') {
        allArticles.push(...newsAPIResult.value)
        console.log(`[newsapi] 抓到 ${newsAPIResult.value.length} 則`)
    } else {
        console.error('[newsapi] 失敗:', newsAPIResult.reason?.message)
    }

    if (cnyesResult.status === 'fulfilled') {
        allArticles.push(...cnyesResult.value)
        console.log(`[cnyes] 抓到 ${cnyesResult.value.length} 則`)
    } else {
        console.error('[cnyes] 失敗:', cnyesResult.reason?.message)
    }

    if (yahooResult.status === 'fulfilled') {
        allArticles.push(...yahooResult.value)
        console.log(`[yahoo-rss] 抓到 ${yahooResult.value.length} 則`)
    } else {
        console.error('[yahoo-rss] 失敗:', yahooResult.reason?.message)
    }

    // 全域去重（以 url 為準）
    const seen = new Set()
    const result = allArticles.filter(a => {
        if (!a.url || seen.has(a.url)) return false
        seen.add(a.url)
        return true
    })

    if (!result.length) throw new Error('No news sources available')
    return {
        statusCode: 200,
        headers: apiHeaders,
        body: JSON.stringify(result),
    }
}
function newsFetch(url, options = {}) { return fetch(url, { ...options, signal: AbortSignal.timeout(8000) }) }

export default async function (request) {
    return invokeEventHandler(request, handleEvent)
}
