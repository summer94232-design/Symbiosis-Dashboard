import { createHash } from 'node:crypto'
import { getFirestore } from 'firebase-admin/firestore'
import { invokeEventHandler } from '../lib/http-function.js'
import { authorizeApiIdentity, getProtectedApp, apiError, apiHeaders } from '../lib/api-access.js'
import { createOAuthState, readOAuthState, oauthCookie } from '../lib/google-oauth-state.js'
import { sameSecret } from '../lib/google-calendar-security.js'

const SITE_ORIGIN = 'https://symbiosis-jiawei.netlify.app'
const REDIRECT_URI = `${SITE_ORIGIN}/.netlify/functions/google-calendar-auth`
const RETURN_URL = `${SITE_ORIGIN}/calendar/settings`
const pendingRef = (db, uid) => db.doc('googleOAuthPending/' + createHash('sha256').update(uid).digest('hex'))
const digest = state => createHash('sha256').update(state).digest('hex')
function redirect(params) {
    return { statusCode: 302, headers: { Location: `${RETURN_URL}#${new URLSearchParams(params)}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Set-Cookie': oauthCookie('', 0) }, body: '' }
}
export const handleEvent = async event => {
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim(), clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()
    const connect = event.queryStringParameters?.action === 'connect'
    if (!clientId || !clientSecret) return connect ? apiError(503, 'Google 行事曆授權設定尚未完成') : redirect({ gcal_error: 'Google 行事曆授權設定尚未完成' })
    if (connect) {
        const identity = await authorizeApiIdentity(event, 'calendarGoogle', 1, 'POST')
        if (identity.statusCode) return identity
        try {
            if ((event.body || '').length > 1024) return apiError(400, '授權請求格式錯誤')
            const { clientState } = JSON.parse(event.body || '{}')
            if (!/^[a-f0-9]{64}$/.test(clientState || '')) return apiError(400, '授權請求格式錯誤')
            const state = createOAuthState(identity.uid, identity.authTime, clientState)
            await pendingRef(identity.db, identity.uid).set({ stateHash: digest(state), expiresAt: Date.now() + 600000 })
            const params = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'https://www.googleapis.com/auth/calendar', access_type: 'offline', prompt: 'consent', state })
            return { statusCode: 200, headers: { ...apiHeaders, 'Set-Cookie': oauthCookie(state) }, body: JSON.stringify({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` }) }
        } catch { return apiError(503, '無法開始 Google 授權，請重新登入後再試') }
    }
    if (event.httpMethod !== 'GET') return apiError(405, '僅支援 GET', { Allow: 'GET' })
    let state
    try {
        state = readOAuthState(event.queryStringParameters?.state, event.headers?.cookie || event.headers?.Cookie)
        const db = getFirestore(getProtectedApp()), ref = pendingRef(db, state.uid)
        await db.runTransaction(async tx => {
            const saved = (await tx.get(ref)).data()
            if (!sameSecret(saved?.stateHash, digest(event.queryStringParameters.state)) || saved.expiresAt <= Date.now()) throw new Error('Invalid pending request')
            // Existing service-account role permits create/update, not delete.
            // Keep one bounded record per user and invalidate it atomically.
            tx.set(ref, { stateHash: 'consumed', expiresAt: 0 })
        })
    } catch { return redirect({ gcal_error: 'Google 授權驗證失敗或已逾時，請從目前帳號重新連結' }) }
    const resultState = { gcal_state: state.clientState, gcal_uid: state.uid, gcal_auth_time: String(state.authTime) }
    if (event.queryStringParameters?.error) return redirect({ ...resultState, gcal_error: 'Google 授權未完成，請重新連結' })
    const code = event.queryStringParameters?.code
    if (typeof code !== 'string' || !code || code.length > 8192) return redirect({ ...resultState, gcal_error: '缺少有效授權碼，請重新連結' })
    try {
        const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' }), signal: AbortSignal.timeout(10000) })
        const token = await response.json()
        if (!response.ok || typeof token.refresh_token !== 'string' || !token.refresh_token || token.refresh_token.length > 8192) return redirect({ ...resultState, gcal_error: '未取得有效 Google 授權，請重新連結' })
        return redirect({ ...resultState, gcal_refresh_token: token.refresh_token })
    } catch { return redirect({ ...resultState, gcal_error: 'Google 授權服務暫時無法使用，請稍後重試' }) }
}
export default async function (request) { return invokeEventHandler(request, handleEvent) }
