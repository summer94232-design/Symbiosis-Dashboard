// netlify/functions/mops-proxy.js
// 法說會資料來源：
//   主要：money-link.com.tw（元大證券，整合 MOPS，靜態 HTML 無 session 問題）
//   備援：agdstock.club（第三方整合站，已確認資料正確）

export const handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
    }

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' }
    }

    const { stockNo, year, month } = event.queryStringParameters || {}

    if (!stockNo || !year || !month) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: '缺少必要參數: stockNo, year, month' }),
        }
    }

    const y = parseInt(year)
    const m = parseInt(month)

    // 嘗試主要來源
    try {
        const result = await fetchFromMoneyLink(stockNo, y, m)
        if (result.dates.length > 0) {
            console.log(`[money-link] ${stockNo} 找到 ${result.dates.length} 筆法說會`)
            return { statusCode: 200, headers, body: JSON.stringify(result) }
        }
        console.log(`[money-link] ${stockNo} 無資料，嘗試備援...`)
    } catch (err) {
        console.error(`[money-link] ${stockNo} 失敗：`, err.message)
    }

    // 備援來源
    try {
        const result = await fetchFromAgdstock(stockNo, y, m)
        console.log(`[agdstock] ${stockNo} 找到 ${result.dates.length} 筆法說會`)
        return { statusCode: 200, headers, body: JSON.stringify(result) }
    } catch (err) {
        console.error(`[agdstock] ${stockNo} 失敗：`, err.message)
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ source: 'none', dates: [], error: err.message }),
        }
    }
}

// ──────────────────────────────────────────────
// 主要來源：money-link.com.tw
// 全市場法說會列表頁，靜態 HTML，不需 session
// ──────────────────────────────────────────────
async function fetchFromMoneyLink(stockNo, year, month) {
    // money-link 提供全市場當月法說會列表，無需逐一查詢個股
    // URL 格式：imwcontent0.asp?page=INVC1&ID=INVC1
    const url = 'https://money-link.com.tw/stxba/imwcontent0.asp?page=INVC1&ID=INVC1'

    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-TW,zh;q=0.9',
            'Referer': 'https://money-link.com.tw/',
        },
        signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) throw new Error(`money-link HTTP ${res.status}`)

    const html = await res.text()
    if (html.length < 500) throw new Error(`money-link 回應過短（${html.length} 字元），可能被擋`)

    const dates = parseMoneyLink(html, stockNo, year, month)
    return { source: 'money-link', dates }
}

function parseMoneyLink(html, stockNo, year, month) {
    // money-link 法說會頁面：表格含股票代號、日期欄位
    // 策略：找到含 stockNo 的 <tr>，取出同列日期
    const dates = new Set()

    // 移除 HTML tags 輔助函數
    const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

    // 切割成 <tr> 區塊
    const rows = html.split(/<tr[\s>]/i)

    for (const row of rows) {
        if (!row.includes(stockNo)) continue

        const text = stripTags(row)

        // 格式 1：西元年 YYYY/MM/DD 或 YYYY-MM-DD
        const adMatches = text.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/g) || []
        for (const d of adMatches) {
            const [y, mo, day] = d.replace(/-/g, '/').split('/')
            if (parseInt(y) === year && parseInt(mo) === month) {
                dates.add(`${y}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`)
            }
        }

        // 格式 2：民國年 RRR/MM/DD（3 位數）
        const rocMatches = text.match(/(\d{3})[\/](\d{1,2})[\/](\d{1,2})/g) || []
        for (const d of rocMatches) {
            const [ry, mo, day] = d.split('/')
            const adYear = parseInt(ry) + 1911
            if (adYear === year && parseInt(mo) === month) {
                dates.add(`${adYear}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`)
            }
        }
    }

    // 若 tr 切割無效，改用整體文字搜尋
    if (dates.size === 0) {
        const fullText = stripTags(html)
        // 在 stockNo 附近 200 字元內搜尋日期
        let idx = 0
        while ((idx = fullText.indexOf(stockNo, idx)) !== -1) {
            const nearby = fullText.slice(Math.max(0, idx - 100), idx + 200)
            const adMatches = nearby.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/g) || []
            for (const d of adMatches) {
                const [y, mo, day] = d.replace(/-/g, '/').split('/')
                if (parseInt(y) === year && parseInt(mo) === month) {
                    dates.add(`${y}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`)
                }
            }
            idx += stockNo.length
        }
    }

    return [...dates]
}

// ──────────────────────────────────────────────
// 備援來源：agdstock.club
// 個股法說會頁面，資料已確認正確（2330 顯示 2026-04-16）
// 缺點：URL 需要股票名稱，此處改用純代號路徑嘗試
// ──────────────────────────────────────────────
async function fetchFromAgdstock(stockNo, year, month) {
    // agdstock 支援純代號路徑（不含名稱）
    const url = `https://agdstock.club/iic/${stockNo}`

    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'zh-TW,zh;q=0.9',
        },
        signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) throw new Error(`agdstock HTTP ${res.status}`)

    const html = await res.text()
    if (html.length < 500) throw new Error(`agdstock 回應過短（${html.length} 字元）`)

    const dates = parseAgdstock(html, year, month)
    return { source: 'agdstock', dates }
}

function parseAgdstock(html, year, month) {
    const dates = new Set()
    const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    const text = stripTags(html)

    // agdstock 頁面日期格式通常為 YYYY-MM-DD 或 YYYY/MM/DD
    const allDates = text.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/g) || []
    for (const d of allDates) {
        const [y, mo, day] = d.replace(/-/g, '/').split('/')
        if (parseInt(y) === year && parseInt(mo) === month) {
            dates.add(`${y}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`)
        }
    }

    // 民國年
    const rocDates = text.match(/(\d{3})[\/](\d{1,2})[\/](\d{1,2})/g) || []
    for (const d of rocDates) {
        const [ry, mo, day] = d.split('/')
        const adYear = parseInt(ry) + 1911
        if (adYear === year && parseInt(mo) === month) {
            dates.add(`${adYear}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`)
        }
    }

    return [...dates]
}