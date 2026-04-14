// netlify/functions/news-proxy.js
// 架構：News API 抓英文新聞 → 關鍵字判斷分類 → 直接回傳英文標題 + url
// 不依賴 Gemini，穩定不受配額限制

const CATEGORY_KEYWORDS = {
    科技: ['tech', 'ai', 'apple', 'google', 'microsoft', 'nvidia', 'chip', 'semiconductor', 'software', 'meta', 'amazon', 'tesla'],
    經濟: ['fed', 'rate', 'inflation', 'gdp', 'economy', 'economic', 'recession', 'unemployment', 'cpi', 'interest'],
    政治: ['trump', 'biden', 'president', 'congress', 'government', 'election', 'policy', 'tariff', 'sanction', 'war'],
}

function classifyArticle(title) {
    const lower = title.toLowerCase()
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
        if (keywords.some(kw => lower.includes(kw))) return category
    }
    return '市場'
}

export const handler = async () => {
    const NEWS_API_KEY = process.env.NEWS_API_KEY

    try {
        const queries = ['stock market', 'finance economy', 'technology business']
        const allArticles = []

        for (const q of queries) {
            const res = await fetch(
                `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=5&apiKey=${NEWS_API_KEY}`
            )
            const data = await res.json()
            if (data.articles) allArticles.push(...data.articles)
        }

        // 去重、過濾無效文章
        const seen = new Set()
        const articles = allArticles
            .filter(a => a.title && a.url && !a.title.includes('[Removed]'))
            .filter(a => {
                if (seen.has(a.url)) return false
                seen.add(a.url)
                return true
            })
            .slice(0, 15)

        if (articles.length === 0) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([])
            }
        }

        // 直接回傳，不經過 Gemini
        const result = articles.map(a => ({
            title: a.title,
            category: classifyArticle(a.title),
            url: a.url,
            source: a.source?.name || '',
        }))

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result)
        }
    } catch (err) {
        console.error('news-proxy error:', err)
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: String(err) })
        }
    }
}