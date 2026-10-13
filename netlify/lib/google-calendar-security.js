import { createHash, timingSafeEqual } from 'node:crypto'
import { authorizeApiIdentity, apiError } from './api-access.js'

export function sameSecret(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
    return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

/** An allowed Firebase user may only use their own saved Google connection. */
export async function authorizeGoogleRequest(event, payload, { ensure = false, route = 'calendarGoogle' } = {}) {
    const identity = await authorizeApiIdentity(event, route, 1, 'POST')
    if (identity.statusCode) return identity
    if (!payload || typeof payload !== 'object' || typeof payload.refreshToken !== 'string' || payload.refreshToken.length > 8192
        || (payload.calendarId !== undefined && (typeof payload.calendarId !== 'string' || payload.calendarId.length > 1024))) return apiError(400, 'Google 請求格式錯誤')
    try {
        const snapshot = await identity.db.doc(`users/${identity.uid}/settings/googleCalendarAuth`).get()
        const saved = snapshot.data()
        if (!sameSecret(saved?.refreshToken, payload.refreshToken)) return apiError(403, 'Google 連結與目前帳號不符，請重新讀取連結狀態')
        if ((!ensure || payload.calendarId) && (!payload.calendarId || payload.calendarId !== saved?.calendarId)) return apiError(403, '行事曆與目前帳號的連結不符')
        // ensure must not silently replace an already saved calendar with an omitted ID.
        if (ensure && !payload.calendarId && saved?.calendarId) return apiError(409, '行事曆連結已變更，請重新讀取後再同步')
        return null
    } catch { return apiError(503, 'Google 連結驗證暫時無法使用，請稍後重試') }
}
