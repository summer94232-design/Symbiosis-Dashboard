// netlify/functions/google-calendar-ensure.js
// 確保「Symbiosis 財經行事曆」這個專屬 Google 行事曆存在。
// 已有 calendarId 就先驗證是否還存在（可能被使用者手動刪掉），
// 沒有 / 已不存在，就建立一個新的。
//
// Request:  { refreshToken: string, calendarId?: string }
// Response: { calendarId: string, created: boolean }

const CALENDAR_NAME = 'Symbiosis 財經行事曆'
const CALENDAR_DESCRIPTION = '由 Symbiosis 個人系統自動同步的財經行事曆'

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

    const { refreshToken, calendarId } = payload
    if (!refreshToken) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 refreshToken' }) }
    }

    let accessToken
    try {
        accessToken = await refreshAccessToken(refreshToken)
    } catch (err) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: err.message }) }
    }

    const apiHeaders = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }

    if (calendarId) {
        try {
            const checkRes = await fetch(
                `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`,
                { headers: apiHeaders }
            )
            if (checkRes.ok) {
                return { statusCode: 200, headers, body: JSON.stringify({ calendarId, created: false }) }
            }
            // 只有確定不存在時才尋找替代日曆；暫時性 API 錯誤不可直接建立，否則會產生重複。
            if (checkRes.status !== 404 && checkRes.status !== 410) {
                const checkData = await checkRes.json().catch(() => ({}))
                return {
                    statusCode: checkRes.status,
                    headers,
                    body: JSON.stringify({ error: checkData.error?.message || `驗證既有行事曆失敗（HTTP ${checkRes.status}）` }),
                }
            }
        } catch (err) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: `驗證既有行事曆失敗：${err.message}` }) }
        }
    }

    try {
        // calendarId 遺失或原日曆不存在時，先從 CalendarList 重用既有同名日曆。
        // 這也能修復舊版重新授權後遺失 calendarId、反覆建立同名日曆的情況。
        const existingCalendarId = await findExistingCalendar(apiHeaders)
        if (existingCalendarId) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ calendarId: existingCalendarId, created: false, reused: true }),
            }
        }

        const createRes = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
            method: 'POST',
            headers: apiHeaders,
            body: JSON.stringify({
                summary: CALENDAR_NAME,
                description: CALENDAR_DESCRIPTION,
            }),
        })
        const createData = await createRes.json()
        if (!createRes.ok) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: createData.error?.message || '建立行事曆失敗' }),
            }
        }
        return { statusCode: 200, headers, body: JSON.stringify({ calendarId: createData.id, created: true }) }
    } catch (err) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }
    }
}

async function findExistingCalendar(apiHeaders) {
    let pageToken = ''
    do {
        const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList')
        url.searchParams.set('maxResults', '250')
        url.searchParams.set('minAccessRole', 'writer')
        if (pageToken) url.searchParams.set('pageToken', pageToken)

        const listRes = await fetch(url.toString(), { headers: apiHeaders })
        const listData = await listRes.json().catch(() => ({}))
        if (!listRes.ok) {
            throw new Error(listData.error?.message || `列出 Google 行事曆失敗（HTTP ${listRes.status}）`)
        }

        const match = (listData.items || []).find(item =>
            item.summary === CALENDAR_NAME && item.id
        )
        if (match) return match.id
        pageToken = listData.nextPageToken || ''
    } while (pageToken)

    return null
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
