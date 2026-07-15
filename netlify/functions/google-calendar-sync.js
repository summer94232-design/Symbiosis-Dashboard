// netlify/functions/google-calendar-sync.js
// 把事件「推」進指定的專屬 Google 行事曆（calendarId）：
// - events 陣列：已有 googleEventId 的做 PATCH 更新；沒有的話先用 sourceId
//   查是否已存在，查不到才 insert（給 App 新建立的事件、或法說會/除權息這類
//   不持續追蹤 googleEventId 的資料用）
// - deleteGoogleEventIds 陣列：直接刪除對應的 Google 事件（App 端已刪除的事件用）
//
// Request:
//   {
//     refreshToken: string,
//     calendarId: string,
//     events?: {
//       id: string              // sourceId，用來去重／比對
//       date: string            // YYYY-MM-DD
//       title: string
//       type?: string
//       description?: string
//       url?: string
//       googleEventId?: string  // 已知連結時帶入，會走「更新」而不是「新增」
//     }[],
//     deleteGoogleEventIds?: string[],
//   }
// Response:
//   {
//     created: number, updated: number, skipped: number, deleted: number, failed: number,
//     errors: string[],
//     links: { id: string, googleEventId: string }[]   // 給前端寫回 Firestore 的 googleEventId 對應
//   }

export const handler = async (event) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    }
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) }
    }

    let payload
    try {
        payload = JSON.parse(event.body || '{}')
    } catch {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '請求格式錯誤（非合法 JSON）' }) }
    }

    const {
        refreshToken,
        calendarId,
        events: calEvents = [],
        deleteGoogleEventIds = [],
    } = payload

    if (!refreshToken || !calendarId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 refreshToken 或 calendarId' }) }
    }

    let accessToken
    try {
        accessToken = await refreshAccessToken(refreshToken)
    } catch (err) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: err.message }) }
    }

    const apiHeaders = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`

    let created = 0
    let updated = 0
    let skipped = 0
    let deleted = 0
    let failed = 0
    const errors = []
    const links = []

    // ── 1. 刪除（App 端已刪除、需要同步刪掉 Google 上對應事件的）──────────
    for (const gid of deleteGoogleEventIds) {
        try {
            const res = await fetch(`${base}/${encodeURIComponent(gid)}`, { method: 'DELETE', headers: apiHeaders })
            if (res.ok || res.status === 410 || res.status === 404) {
                deleted++
            } else {
                const data = await res.json().catch(() => ({}))
                failed++
                errors.push(`刪除 ${gid} 失敗：${data.error?.message || res.status}`)
            }
        } catch (err) {
            failed++
            errors.push(`刪除 ${gid} 失敗：${err.message}`)
        }
    }

    // ── 2. 新增／更新 ──────────────────────────────────────────────────
    for (const ev of calEvents) {
        try {
            if (!ev || !ev.id || !ev.date || !ev.title) {
                failed++
                continue
            }

            const body = {
                summary: ev.title,
                description: [ev.description, ev.url].filter(Boolean).join('\n\n'),
                start: { date: ev.date },
                end: { date: addOneDay(ev.date) },
                extendedProperties: { private: { sourceId: ev.id, sourceType: ev.type || '' } },
            }

            if (ev.googleEventId) {
                // 已知連結，直接 PATCH 更新（同時也順便補上 sourceId，
                // 這樣「Google 端新建、App 端剛建立 Firestore 文件」的連結也能靠這條路徑補齊）
                const res = await fetch(`${base}/${encodeURIComponent(ev.googleEventId)}`, {
                    method: 'PATCH',
                    headers: apiHeaders,
                    body: JSON.stringify(body),
                })
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}))
                    failed++
                    errors.push(`${ev.id}：更新失敗（${data.error?.message || res.status}）`)
                    continue
                }
                updated++
                links.push({ id: ev.id, googleEventId: ev.googleEventId })
                continue
            }

            // 沒有 googleEventId：先用 sourceId 查是否已存在，避免重複建立
            const searchUrl = `${base}?privateExtendedProperty=${encodeURIComponent(`sourceId=${ev.id}`)}`
            const searchRes = await fetch(searchUrl, { headers: apiHeaders })
            const searchData = await searchRes.json()
            if (!searchRes.ok) {
                failed++
                errors.push(`${ev.id}：查詢失敗（${searchData.error?.message || searchRes.status}）`)
                continue
            }
            if (Array.isArray(searchData.items) && searchData.items.length > 0) {
                skipped++
                links.push({ id: ev.id, googleEventId: searchData.items[0].id })
                continue
            }

            const insertRes = await fetch(base, { method: 'POST', headers: apiHeaders, body: JSON.stringify(body) })
            if (!insertRes.ok) {
                const insertData = await insertRes.json().catch(() => ({}))
                failed++
                errors.push(`${ev.id}：建立失敗（${insertData.error?.message || insertRes.status}）`)
                continue
            }
            const insertData = await insertRes.json()
            created++
            links.push({ id: ev.id, googleEventId: insertData.id })
        } catch (err) {
            failed++
            errors.push(`${ev?.id || '未知事件'}：${err.message}`)
        }
    }

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ created, updated, skipped, deleted, failed, errors: errors.slice(0, 20), links }),
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

async function refreshAccessToken(refreshToken) {
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
        throw new Error(`Google 憑證已失效，請重新連結帳號（${tokenData.error || 'unknown'}）`)
    }
    return tokenData.access_token
}