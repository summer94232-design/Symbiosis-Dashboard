import { invokeEventHandler } from '../lib/http-function.js'
import { authorizeApi, apiError, apiHeaders, cachedApi } from '../lib/api-access.js'
// netlify/functions/yahoo-calendar-proxy.js
// ──────────────────────────────────────────────────────────────
// 從 Yahoo 股市「台股行事曆 - 法說會」整頁抓取全市場法說會，一次回傳所有事件。
// 來源：https://tw.stock.yahoo.com/calendar/earnings-call
//
// 此頁為「伺服器端渲染（SSR）」，整份清單直接存在於回傳的 HTML 中，
// 用一個普通的 fetch 就能拿到，不需要無頭瀏覽器。
//
// 回傳格式：
//   { source: 'yahoo-calendar', count: <number>,
//     events: [{ code, market, name, date, time, region, desc }] }
//   code   裸代號（如 "2330"，不含 .TW，方便和你 Firestore docId 對齊）
//   market "TW" | "TWO"
//   date   "YYYY-MM-DD"
//   time   "HH:MM"（可能為空字串）
//   region "國內" | "國外"（可能為空字串）
// ──────────────────────────────────────────────────────────────

const SOURCE_URL = 'https://tw.stock.yahoo.com/calendar/earnings-call'

export const handleEvent = async (event) => {
    const headers = apiHeaders
    const denied = await authorizeApi(event, 'meetings')
    if (denied) return denied


    try {
        const res = await fetch(SOURCE_URL, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-TW,zh;q=0.9',
            },
            signal: AbortSignal.timeout(15000),
        })

        if (!res.ok) {
            return { statusCode: 502, headers, body: JSON.stringify({ error: `Yahoo HTTP ${res.status}` }) }
        }

        const html = await res.text()
        if (html.length < 2000) {
            return { statusCode: 502, headers, body: JSON.stringify({ error: `Yahoo 回應過短（${html.length} bytes）` }) }
        }

        const events = parseEarningsCall(html)
        console.log(`[yahoo-calendar] 解析出 ${events.length} 筆法說會`)

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ source: 'yahoo-calendar', count: events.length, events }),
        }
    } catch (err) {
        console.error('[yahoo-calendar] 失敗：', err.message)
        return { statusCode: 500, headers, body: JSON.stringify({ error: `抓取失敗：${err.message}` }) }
    }
}

// ──────────────────────────────────────────────────────────────
// 解析：以每筆個股連結 /quote/CODE.(TW|TWO) 為錨點切塊，逐塊抽欄位
// ──────────────────────────────────────────────────────────────
function parseEarningsCall(html) {
    const events = []
    const seen = new Set()

    // 只接受「連結結尾就是 /quote/代號.市場別」的錨點，
    // 後面必須緊接 引號 / 空白 / 標籤結尾，藉此排除導覽列那種
    // /quote/2330.TW/health-check、/quote-compare?symbolIds=... 等雜訊連結。
    // 注意：TWO 要放在 TW 前面，否則 8299.TWO 會被當成 8299.TW 然後比對失敗。
    const linkRe = /\/quote\/(\d{4,6})\.(TWO|TW)(?=["'\s<])/g

    const anchors = []
    let m
    while ((m = linkRe.exec(html)) !== null) {
        anchors.push({ code: m[1], market: m[2], start: m.index, end: m.index + m[0].length })
    }

    for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i]
        // a.end 只停在 "/quote/2308.TW" 這段文字結尾，此時 <a ...> 標籤還沒關閉
        // （後面通常還有 target="_self"> 之類的屬性）。若直接從 a.end 切片，
        // 殘留的屬性文字（例如 " target="_self">）會因為沒有對應的開頭 "<"
        // 而躲過下面的 /<[^>]+>/g 標籤清除，直接混進抓到的文字內容。
        // 因此要先找到這個標籤真正結束的 ">"，從它之後才開始擷取文字。
        const tagCloseIdx = html.indexOf('>', a.end)
        const sliceStart = tagCloseIdx === -1 ? a.end : tagCloseIdx + 1
        const sliceEnd = i + 1 < anchors.length ? anchors[i + 1].start : Math.min(html.length, sliceStart + 4000)

        const text = html
            .slice(sliceStart, sliceEnd)
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ')
            .trim()

        // 日期（必要）+ 時間（可選）：2026/05/07 14:00
        const dm = text.match(/(\d{4})\/(\d{2})\/(\d{2})(?:\s+(\d{1,2}:\d{2}))?/)
        if (!dm) continue
        // 防呆：日期必須出現在錨點附近，避免極端情況抓到遠處的區塊標題日期
        if (dm.index > 1000) continue

        const [, y, mo, d, time] = dm
        const isoDate = `${y}-${mo}-${d}`

        // 同股同日視為一筆（行事曆只在意日期）
        const key = `${a.code}-${isoDate}`
        if (seen.has(key)) continue
        seen.add(key)

        // 名稱：日期之前的文字，去掉「代號.市場別」與裸代號後剩下的就是股名
        const name =
            text
                .slice(0, dm.index)
                .replace(new RegExp(`${a.code}\\.(TWO|TW)`, 'g'), ' ')
                .replace(new RegExp(`\\b${a.code}\\b`, 'g'), ' ')
                .replace(/\s+/g, ' ')
                .trim() || a.code

        // 日期之後：國內/國外 + 地點 + 相關訊息（盡量擷取，失敗不影響主流程）
        const after = text.slice(dm.index + dm[0].length).trim()
        const region = /^(國內|國外)/.test(after) ? after.slice(0, 2) : ''
        const desc = after.replace(/^(國內|國外)\s*/, '').slice(0, 120)

        events.push({
            code: a.code,
            market: a.market,
            name,
            date: isoDate,
            time: time || '',
            region,
            desc,
        })
    }

    return events
}
export default async function (request) {
    return invokeEventHandler(request, handleEvent)
}
