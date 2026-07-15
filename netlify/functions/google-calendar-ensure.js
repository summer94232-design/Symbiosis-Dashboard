// netlify/functions/google-calendar-ensure.js
// 確保「Symbiosis 財經行事曆」這個專屬 Google 行事曆存在。
// 已有 calendarId 就先驗證是否還存在（可能被使用者手動刪掉），
// 沒有 / 已不存在，就建立一個新的。
//
// Request:  { refreshToken: string, calendarId?: string }
// Response: { calendarId: string, created: boolean }

const CALENDAR_NAME = 'Symbiosis 財經行事曆'

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
        } catch {
            // 驗證失敗就往下重新建立
        }
    }

    try {
        const createRes = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
            method: 'POST',
            headers: apiHeaders,
            body: JSON.stringify({
                summary: CALENDAR_NAME,
                description: '由 Symbiosis 個人系統自動同步的財經行事曆',
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