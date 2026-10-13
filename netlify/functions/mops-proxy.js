import { invokeEventHandler } from '../lib/http-function.js'
import { authorizeApi, apiError, apiHeaders, cachedApi } from '../lib/api-access.js'
// netlify/functions/mops-proxy.js
// 財報日 / 法說會查詢，四層架構：
//   1. 富聯網法說會時間表（全市場靜態 HTML，最穩定）
//   2. Yahoo Finance（cookie+crumb，取 earningsDate）
//   3. TWSE 重大訊息 API（t187ap04_L，當日資料）
//   4. 固定法則推算（依台灣財報截止日）

export const handleEvent = async (event) => {
    const headers = apiHeaders
    const denied = await authorizeApi(event, 'mops')
    if (denied) return denied


    const { stockNo, year, month } = event.queryStringParameters || {}

    if (!stockNo || !year || !month) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: '缺少必要參數: stockNo, year, month' }),
        }
    }

    if (!/^[A-Za-z0-9]{2,10}$/.test(stockNo) || !/^20\d{2}$/.test(year) || !/^(0?[1-9]|1[0-2])$/.test(month)) return apiError(400, '日期或代號格式不正確')
    const y = parseInt(year)
    const m = parseInt(month)

    // ETF / 權證（含字母或超過5碼）跳過
    const isEtfOrWarrant = /[A-Za-z]/.test(stockNo) || stockNo.length > 5
    if (isEtfOrWarrant) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ source: 'skip', dates: [] }),
        }
    }

    // ── 1. 富聯網法說會時間表（主要） ──
    try {
        const dates = await fetchMoneyLinkCalendar(stockNo, y, m)
        if (dates.length > 0) {
            console.log(`[moneylink] ${stockNo} 法說會：`, dates)
            return { statusCode: 200, headers, body: JSON.stringify({ source: 'moneylink', dates }) }
        }
        console.log(`[moneylink] ${stockNo} 無資料`)
    } catch (err) {
        console.error(`[moneylink] ${stockNo} 失敗：`, err.message)
    }

    // ── 2. Yahoo Finance（cookie+crumb） ──
    try {
        const dates = await fetchYahooEarnings(`${stockNo}.TW`, y, m)
        if (dates.length > 0) {
            console.log(`[yahoo] ${stockNo} 財報日：`, dates)
            return { statusCode: 200, headers, body: JSON.stringify({ source: 'yahoo', dates }) }
        }
        console.log(`[yahoo] ${stockNo} 無資料`)
    } catch (err) {
        console.error(`[yahoo] ${stockNo} 失敗：`, err.message)
    }

    // ── 3. TWSE 重大訊息 API ──
    try {
        const dates = await fetchTWSEFinancialReport(stockNo, y, m)
        if (dates.length > 0) {
            console.log(`[twse] ${stockNo} 財報日：`, dates)
            return { statusCode: 200, headers, body: JSON.stringify({ source: 'twse', dates }) }
        }
        console.log(`[twse] ${stockNo} 無資料`)
    } catch (err) {
        console.error(`[twse] ${stockNo} 失敗：`, err.message)
    }

    // ── 4. 固定法則推算 ──
    const estimated = estimateEarningsDate(y, m)
    console.log(`[estimate] ${stockNo} 推算：`, estimated)
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ source: 'estimate', dates: estimated }),
    }
}

// ══════════════════════════════════════════════
// 1. 富聯網法說會時間表
// URL: https://ww2.money-link.com.tw/TWStock/TWStockMarket.aspx?mainOptionType=2&optionType=6
// 全市場法說會，靜態 HTML 表格，無需 session
// 格式範例：1152026/04/16 | 2330 | 台積電 | 14:00 | ...
// ══════════════════════════════════════════════
async function fetchMoneyLinkCalendar(stockNo, year, month) {
    const url = 'https://ww2.money-link.com.tw/TWStock/TWStockMarket.aspx?mainOptionType=2&optionType=6'

    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'zh-TW,zh;q=0.9',
            'Referer': 'https://ww2.money-link.com.tw/',
        },
        signal: AbortSignal.timeout(12000),
    })

    if (!res.ok) throw new Error(`money-link HTTP ${res.status}`)

    const html = await res.text()
    if (html.length < 1000) throw new Error(`money-link 回應過短（${html.length}）`)

    return parseMoneyLinkCalendar(html, stockNo, year, month)
}

function parseMoneyLinkCalendar(html, stockNo, year, month) {
    const dates = new Set()

    // 表格每列格式（HTML 去 tag 後）：
    // "1152026/04/16 2330 台積電 14:00 線上法說會 ..."
    // 或 <td>1152026/04/16</td><td>2330</td>...
    // 用 <tr> 切割後在每列裡同時找股票代號 + 日期

    const rows = html.split(/<tr[\s>]/i)
    for (const row of rows) {
        // 快速過濾：這列是否包含目標股票代號
        // 富聯網的代號是帶連結的：SymId=2330 或純文字 2330
        if (!row.includes(stockNo)) continue

        const text = row.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

        // 確認這列確實有這個代號（不是部分匹配，如 2330 不能匹配 23301）
        const codeMatch = text.match(/\b(\d{4,6})\b/)
        if (!codeMatch || codeMatch[1] !== stockNo) continue

        // 找民國年格式日期：1152026/04/16 或 115年2026/04/16
        // 富聯網格式是「1152026/04/16」（民國年+西元年混排），
        // 實際上取 YYYY/MM/DD 部分
        const dateMatch = text.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/)
        if (dateMatch) {
            const [, y, mo, day] = dateMatch
            if (parseInt(y) === year && parseInt(mo) === month) {
                dates.add(`${y}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`)
            }
        }

        // 也嘗試純民國年格式：115/04/16
        const rocMatch = text.match(/\b(\d{3})[\/](\d{1,2})[\/](\d{1,2})\b/)
        if (rocMatch) {
            const [, ry, mo, day] = rocMatch
            const adYear = parseInt(ry) + 1911
            if (adYear === year && parseInt(mo) === month) {
                dates.add(`${adYear}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`)
            }
        }
    }

    return [...dates]
}

// ══════════════════════════════════════════════
// 2. Yahoo Finance — 兩步驟 cookie+crumb
// ══════════════════════════════════════════════
async function fetchYahooEarnings(symbol, year, month) {
    const { cookie, crumb } = await getYahooCookieAndCrumb(symbol)

    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents&crumb=${encodeURIComponent(crumb)}`

    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'zh-TW,zh;q=0.9',
            'Cookie': cookie,
        },
        signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) throw new Error(`Yahoo quoteSummary HTTP ${res.status}`)

    const data = await res.json()
    const earningsDates = data?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate ?? []

    const results = []
    for (const item of earningsDates) {
        const ts = item?.raw
        if (!ts) continue
        const d = new Date(ts * 1000)
        const dy = d.getUTCFullYear()
        const dm = d.getUTCMonth() + 1
        if (dy === year && dm === month) {
            results.push(`${dy}-${String(dm).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`)
        }
    }
    return results
}

async function getYahooCookieAndCrumb(symbol) {
    // 先試公開 crumb 端點
    const consentRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
            'Accept': '*/*',
        },
        signal: AbortSignal.timeout(8000),
    })

    const setCookie = consentRes.headers.get('set-cookie') || ''
    const cookie = setCookie.split(';')[0]

    if (consentRes.ok) {
        const crumb = await consentRes.text()
        if (crumb && crumb.length > 0 && !crumb.includes('<')) {
            return { cookie, crumb: crumb.trim() }
        }
    }

    // fallback：從個股頁 HTML 抽取 crumb
    const pageRes = await fetch(`https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(10000),
    })

    const setCookie2 = pageRes.headers.get('set-cookie') || ''
    const cookie2 = setCookie2.split(';')[0]
    const html = await pageRes.text()
    const match = html.match(/"crumb"\s*:\s*"([^"]{8,20})"/)
    if (!match) throw new Error('無法從 Yahoo 頁面取得 crumb')

    return { cookie: cookie2, crumb: match[1] }
}

// ══════════════════════════════════════════════
// 3. TWSE 重大訊息 API（當日資料）
// ══════════════════════════════════════════════
async function fetchTWSEFinancialReport(stockNo, year, month) {
    const url = 'https://openapi.twse.com.tw/v1/opendata/t187ap04_L'

    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) throw new Error(`TWSE API HTTP ${res.status}`)

    const data = await res.json()
    if (!Array.isArray(data)) return []

    const results = new Set()

    for (const item of data) {
        if (item['公司代號'] !== stockNo) continue

        const clause = item['符合條款'] || ''
        const subject = item['主旨'] || ''
        const isFinancial =
            clause.includes('7') ||
            subject.includes('財務報告') ||
            subject.includes('季報') ||
            subject.includes('年報') ||
            subject.includes('財報') ||
            subject.includes('法說') ||
            subject.includes('法人說明')

        if (!isFinancial) continue

        const dateStr = item['事實發生日'] || ''
        if (dateStr.length === 7) {
            const ry = parseInt(dateStr.slice(0, 3))
            const mo = parseInt(dateStr.slice(3, 5))
            const day = parseInt(dateStr.slice(5, 7))
            const adYear = ry + 1911
            if (adYear === year && mo === month) {
                results.add(`${adYear}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
            }
        }
    }

    return [...results]
}

// ══════════════════════════════════════════════
// 4. 固定法則推算
// 台灣財報截止日：Q4→3/31, Q1→5/15, Q2→8/14, Q3→11/14
// ══════════════════════════════════════════════
function estimateEarningsDate(year, month) {
    const earningsMonths = {
        3: `${year}-03-31`,
        5: `${year}-05-15`,
        8: `${year}-08-14`,
        11: `${year}-11-14`,
    }
    return earningsMonths[month] ? [earningsMonths[month]] : []
}
export default async function (request) {
    return invokeEventHandler(request, handleEvent)
}
