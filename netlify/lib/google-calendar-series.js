import { apiError, apiHeaders } from './api-access.js'
import { authorizeGoogleRequest } from './google-calendar-security.js'

export function validateRecurrence(lines) {
    if (!Array.isArray(lines) || !lines.length || lines.length > 20 || lines.some(line => typeof line !== 'string' || line.length > 2000 || /[\r\n]/.test(line) || !/^(RRULE:|RDATE[;:]|EXDATE[;:])/.test(line))) throw new Error('請提供有效的 RRULE／RDATE／EXDATE，每行一條規則。')
    if (!lines.some(line => /^(RRULE:|RDATE[;:])/.test(line))) throw new Error('必須有 RRULE 或 RDATE。')
    for (const rule of lines.filter(line => line.startsWith('RRULE:'))) {
        const entries = rule.slice(6).split(';').map(part => part.split('='))
        const fields = Object.fromEntries(entries)
        if (entries.some(pair => pair.length !== 2 || !pair[1]) || new Set(entries.map(([key]) => key)).size !== entries.length || !['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(fields.FREQ) || fields.COUNT && fields.UNTIL) throw new Error('重複頻率或結束條件無效。')
        for (const key of ['COUNT', 'INTERVAL']) if (fields[key] && (!/^\d+$/.test(fields[key]) || Number(fields[key]) < 1 || !Number.isSafeInteger(Number(fields[key])))) throw new Error('次數與間隔必須為正整數。')
    }
    return lines
}
const json = body => ({ statusCode: 200, headers: apiHeaders, body: JSON.stringify(body) })
export async function handler(event) {
    let input
    try {
        if ((event.body || '').length > 50000) throw new Error('請求過大')
        input = JSON.parse(event.body || '{}')
        if (!['read', 'update', 'inspect'].includes(input.action) || typeof input.refreshToken !== 'string' || !input.refreshToken || input.refreshToken.length > 8192 || typeof input.calendarId !== 'string' || !input.calendarId || input.calendarId.length > 1024 || !/^[a-zA-Z0-9_-]{1,1024}$/.test(input.seriesId || '')) throw new Error('系列請求參數無效')
        if (input.action === 'update') {
            validateRecurrence(input.recurrence)
            if (typeof input.etag !== 'string' || !input.etag || input.etag.length > 512 || /[\r\n]/.test(input.etag)) throw new Error('缺少有效事件版本，請重新讀取。')
        }
        if (input.action === 'inspect' && (!Array.isArray(input.ids) || input.ids.length > 50 || input.ids.some(id => typeof id !== 'string' || !id.startsWith(input.seriesId + '_') || !/^[a-zA-Z0-9_-]{1,1100}$/.test(id)))) throw new Error('待確認的事件清單無效')
    } catch (error) { return apiError(400, error.message) }
    const denied = await authorizeGoogleRequest(event, input, { route: 'calendarSeries' })
    if (denied) return denied
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return apiError(503, 'Google 伺服器設定尚未完成。')
    const budget = AbortSignal.timeout(24000)
    const timeoutFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.any([budget, AbortSignal.timeout(10000)]) })
    try {
        const tokenResponse = await timeoutFetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ refresh_token: input.refreshToken, client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token' }) })
        const token = await tokenResponse.json()
        if (!tokenResponse.ok || !token.access_token) return apiError(401, 'Google 授權失效，請重新連結。')
        const headers = { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }
        const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events/`
        const url = base + encodeURIComponent(input.seriesId)
        const response = await timeoutFetch(url, { headers })
        if (!response.ok) return apiError(response.status === 404 || response.status === 410 ? 404 : 502, '無法讀取系列主事件，請重新同步或確認權限。')
        const master = await response.json()
        if (!master.recurrence?.length || master.recurringEventId || master.status === 'cancelled') return apiError(409, '此事件不是有效的重複系列。')
        const pick = row => ({ id: row.id, etag: row.etag, summary: row.summary || '', description: row.description || '', start: row.start, end: row.end, recurrence: row.recurrence, recurringEventId: row.recurringEventId, updated: row.updated, status: row.status })
        if (input.action === 'read') return json(pick(master))
        if (input.action === 'inspect') {
            const instances = []
            for (let offset = 0; offset < input.ids.length; offset += 4) {
                instances.push(...await Promise.all(input.ids.slice(offset, offset + 4).map(async id => {
                    const res = await timeoutFetch(base + encodeURIComponent(id), { headers })
                    if ([404, 410].includes(res.status)) return { id, status: 'cancelled' }
                    if (!res.ok) throw new Error('無法確認舊行程狀態；保留本機資料，請重試刷新。')
                    const row = await res.json()
                    if (row.recurringEventId !== input.seriesId && row.status !== 'cancelled') throw new Error('事件不屬於此系列')
                    return pick(row)
                })))
            }
            return json({ instances })
        }
        // Replaying a request whose response was lost is safe if the desired rules already match.
        if (JSON.stringify(master.recurrence) === JSON.stringify(input.recurrence)) return json(pick(master))
        if (master.etag !== input.etag) return apiError(409, '整組行程已在其他裝置修改，請重新讀取規則後再編輯。')
        const patched = await timeoutFetch(url, { method: 'PATCH', headers: { ...headers, 'If-Match': input.etag }, body: JSON.stringify({ recurrence: input.recurrence }) })
        if (!patched.ok) return apiError(patched.status === 412 ? 409 : patched.status === 400 ? 400 : 502, patched.status === 412 ? '系列版本衝突，請重新讀取。' : 'Google 未接受此規則，請檢查規則或重試。')
        return json(pick(await patched.json()))
    } catch (error) { return apiError(502, error.name === 'TimeoutError' ? 'Google 回覆逾時；結果尚未確認，請重新讀取規則。' : 'Google 系列操作失敗，請重新讀取後重試。') }
}
