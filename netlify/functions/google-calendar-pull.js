import { authorizeGoogleRequest } from '../lib/google-calendar-security.js'
import { invokeEventHandler } from '../lib/http-function.js'
// netlify/functions/google-calendar-pull.js
// 讀出「專屬行事曆」目前所有事件（含最近被刪除、標記為 cancelled 的），
// 回傳給前端做「App ↔ Google」雙向比對用。
//
// Request:  { refreshToken: string, calendarId: string }
// Response: { events: { googleEventId, sourceId, title, date, description, updated, cancelled }[] }

export const handleEvent = async (event) => {
    const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, no-store',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    }
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) }
    }

    let payload
    try {
        if ((event.body || '').length > 200000) throw new Error('Request too large')
        payload = JSON.parse(event.body || '{}')
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid request')
    } catch {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '請求格式錯誤（非合法 JSON）' }) }
    }

    const denied = await authorizeGoogleRequest(event, payload)
    if (denied) return denied

    const { refreshToken, calendarId } = payload
    if (!refreshToken || !calendarId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 refreshToken 或 calendarId' }) }
    }

    let accessToken
    try {
        accessToken = await refreshAccessToken(refreshToken)
    } catch (err) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: err.message }) }
    }

    const now = new Date()
    const timeMin = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()).toISOString()
    const timeMax = new Date(now.getFullYear(), now.getMonth() + 6, now.getDate()).toISOString()

    const events = []
    let pageToken = ''

    try {
        do {
            const url = new URL(
                `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
            )
            url.searchParams.set('timeMin', timeMin)
            url.searchParams.set('timeMax', timeMax)
            url.searchParams.set('showDeleted', 'true')
            url.searchParams.set('singleEvents', 'true')
            url.searchParams.set('maxResults', '250')
            if (pageToken) url.searchParams.set('pageToken', pageToken)

            const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } })
            const data = await res.json()

            if (!res.ok) {
                return {
                    statusCode: 500,
                    headers,
                    body: JSON.stringify({ error: data.error?.message || '讀取行事曆事件失敗' }),
                }
            }

            for (const item of data.items || []) {
                events.push({
                    googleEventId: item.id,
                    sourceKind: item.extendedProperties?.private?.sourceKind || null,
                    sourceType: item.extendedProperties?.private?.sourceType || null,
                    // Series properties can be inherited by every instance; only accept an instance's own binding.
                    sourceId: item.recurringEventId && item.extendedProperties?.private?.sourceGoogleEventId !== item.id
                        ? null : item.extendedProperties?.private?.sourceId || null,
                    title: item.summary || '',
                    date: item.start?.date || (item.start?.dateTime ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(item.start.dateTime)) : ''),
                    start: item.start || null,
                    end: item.end || null,
                    recurringEventId: item.recurringEventId || null,
                    originalStartTime: item.originalStartTime || null,
                    etag: item.etag || '',
                    description: item.description || '',
                    updated: item.updated || '',
                    cancelled: item.status === 'cancelled',
                })
            }
            pageToken = data.nextPageToken || ''
        } while (pageToken)
    } catch (err) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ events }) }
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

export default async function (request) {
    return invokeEventHandler(request, handleEvent)
}
