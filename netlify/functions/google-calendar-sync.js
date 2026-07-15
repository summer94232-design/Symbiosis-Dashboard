// netlify/functions/google-calendar-sync.js
// ──────────────────────────────────────────────────────────────
// 把一批 CalendarEvent 同步進使用者的 Google 主行事曆（calendarId=primary）。
//
// 去重策略：每個事件用 extendedProperties.private.sourceId 存自己的
// CalendarEvent.id（例如 "investor-2330-2026-07-15"）。同步前先用這個
// key 查 Google Calendar 上是否已存在，存在就跳過，不存在才新增。
// 這樣完全不需要另外在 Firestore 存一份「eventId 對應表」。
//
// ⚠️ 前端請「分批」呼叫（例如每批 30 筆），避免單次執行時間超過
// Netlify Function 的逾時限制。這支 function 本身不做批次拆分，
// 一次請求就是一批，處理完就回傳，由前端負責迴圈呼叫下一批。
//
// Request body:
//   {
//     refreshToken: string,
//     events: {
//       id: string           // 唯一鍵，用來去重
//       date: string         // YYYY-MM-DD
//       title: string
//       type?: string
//       description?: string
//       url?: string
//     }[]
//   }
// Response body:
//   { created: number, skipped: number, failed: number, errors: string[] }
// ──────────────────────────────────────────────────────────────

export const handler = async (event) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    }

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' }
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) }
    }

    let payload
    try {
        payload = JSON.parse(event.body || '{}')
    } catch {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '請求格式錯誤（非合法 JSON）' }) }
    }

    const { refreshToken, events: calEvents } = payload
    if (!refreshToken || !Array.isArray(calEvents)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 refreshToken 或 events' }) }
    }

    // ── 1. 用 refresh_token 換一個新的 access_token ──────────────────
    let accessToken
    try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                refresh_token: refreshToken,
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                grant_type: 'refresh_token',
            }),
        })
        const tokenData = await tokenRes.json()
        if (!tokenRes.ok) {
            console.error('[google-calendar-sync] refresh token 失敗：', tokenData)
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ error: `Google 憑證已失效，請重新連結帳號（${tokenData.error || 'unknown'}）` }),
            }
        }
        accessToken = tokenData.access_token
    } catch (err) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: `換取 access_token 失敗：${err.message}` }) }
    }

    const apiHeaders = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
    }

    let created = 0
    let skipped = 0
    let failed = 0
    const errors = []

    // ── 2. 逐筆處理（依序處理，避免瞬間打爆 Google Calendar API 速率限制）──
    for (const ev of calEvents) {
        try {
            if (!ev || !ev.id || !ev.date || !ev.title) {
                failed++
                continue
            }

            // 2a. 先查這個 sourceId 是否已經同步過
            const searchUrl =
                'https://www.googleapis.com/calendar/v3/calendars/primary/events' +
                `?privateExtendedProperty=${encodeURIComponent(`sourceId=${ev.id}`)}`
            const searchRes = await fetch(searchUrl, { headers: apiHeaders })
            const searchData = await searchRes.json()

            if (!searchRes.ok) {
                failed++
                errors.push(`${ev.id}：查詢失敗（${searchData.error?.message || searchRes.status}）`)
                continue
            }

            if (Array.isArray(searchData.items) && searchData.items.length > 0) {
                skipped++
                continue
            }

            // 2b. 不存在才建立（全天事件；Google Calendar 全天事件的 end.date 規定要是「隔天」）
            const insertRes = await fetch(
                'https://www.googleapis.com/calendar/v3/calendars/primary/events',
                {
                    method: 'POST',
                    headers: apiHeaders,
                    body: JSON.stringify({
                        summary: ev.title,
                        description: [ev.description, ev.url].filter(Boolean).join('\n\n'),
                        start: { date: ev.date },
                        end: { date: addOneDay(ev.date) },
                        extendedProperties: { private: { sourceId: ev.id, sourceType: ev.type || '' } },
                    }),
                }
            )

            if (!insertRes.ok) {
                const insertData = await insertRes.json().catch(() => ({}))
                failed++
                errors.push(`${ev.id}：建立失敗（${insertData.error?.message || insertRes.status}）`)
                continue
            }

            created++
        } catch (err) {
            failed++
            errors.push(`${ev?.id || '未知事件'}：${err.message}`)
        }
    }

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ created, skipped, failed, errors: errors.slice(0, 20) }),
    }
}

function addOneDay(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1, d))
    dt.setUTCDate(dt.getUTCDate() + 1)
    const yy = dt.getUTCFullYear()
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(dt.getUTCDate()).padStart(2, '0')
    return `${yy}-${mm}-${dd}`
}