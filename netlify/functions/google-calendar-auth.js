import { createHash } from 'node:crypto'
import { getFirestore } from 'firebase-admin/firestore'
import { invokeEventHandler } from '../lib/http-function.js'
import { authorizeApiIdentity, getProtectedApp, apiError, apiHeaders } from '../lib/api-access.js'
import { createOAuthState, readOAuthState, oauthCookie } from '../lib/google-oauth-state.js'
import { sameSecret } from '../lib/google-calendar-security.js'
import { GOOGLE_ACCOUNT_EMAIL, GOOGLE_AUTH_SCOPES, GOOGLE_DATA_SCOPES } from '../lib/google-authorization.js'

const SITE_ORIGIN = 'https://symbiosis-jiawei.netlify.app'
const REDIRECT_URI = `${SITE_ORIGIN}/.netlify/functions/google-calendar-auth`
const RETURN_URL = `${SITE_ORIGIN}/calendar/settings`
const pendingRef = (db, uid) => db.doc('googleOAuthPending/' + createHash('sha256').update(uid).digest('hex'))
const digest = state => createHash('sha256').update(state).digest('hex')
const isCompleteGrant = grant => grant?.googleEmail === GOOGLE_ACCOUNT_EMAIL
    && typeof grant.googleAccountId === 'string' && grant.googleAccountId.length > 0
    && typeof grant.refreshToken === 'string' && grant.refreshToken.length > 0 && grant.refreshToken.length <= 8192
    && Array.isArray(grant.grantedScopes)
    && GOOGLE_DATA_SCOPES.every(scope => grant.grantedScopes.includes(scope))
function redirect(params) {
    return { statusCode: 302, headers: { Location: `${RETURN_URL}#${new URLSearchParams(params)}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Set-Cookie': oauthCookie('', 0) }, body: '' }
}
export const handleEvent = async event => {
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim(), clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()
    const action = event.queryStringParameters?.action
    if (!clientId || !clientSecret) return action ? apiError(503, 'Google 授權設定尚未完成') : redirect({ gcal_error: 'Google 授權設定尚未完成' })
    if (action === 'connect' || action === 'complete') {
        const identity = await authorizeApiIdentity(event, 'calendarGoogle', 1, 'POST')
        if (identity.statusCode) return identity
        try {
            if ((event.body || '').length > 1024) return apiError(400, '授權請求格式錯誤')
            const { clientState } = JSON.parse(event.body || '{}')
            if (!/^[a-f0-9]{64}$/.test(clientState || '')) return apiError(400, '授權請求格式錯誤')
            if (action === 'complete') {
                const ref = pendingRef(identity.db, identity.uid)
                const authRef = identity.db.doc(`users/${identity.uid}/settings/googleCalendarAuth`)
                await identity.db.runTransaction(async tx => {
                    const [pending, existing] = await Promise.all([tx.get(ref), tx.get(authRef)])
                    const saved = pending.data(), previous = existing.data()
                    if (!sameSecret(saved?.clientStateHash, digest(clientState)) || saved.authTime !== identity.authTime
                        || saved.expiresAt <= Date.now()) throw new Error('Invalid completion')
                    // A lost response can be retried only while this exact connection still exists.
                    if (saved.phase === 'complete' && previous?.authorizationRequestHash === saved.clientStateHash
                        && isCompleteGrant(previous)) return
                    if (saved.phase !== 'ready' || !isCompleteGrant(saved.grant)
                        || (previous?.googleAccountId && previous.googleAccountId !== saved.grant.googleAccountId)) throw new Error('Invalid grant')
                    tx.set(authRef, {
                        ...saved.grant, connectedAt: new Date().toISOString(),
                        authorizationRequestHash: saved.clientStateHash,
                        ...(!Array.isArray(previous?.syncTypes) ? { syncTypes: ['investor', 'personal'] } : {}),
                    }, { merge: true })
                    // Remove the temporary credential after the authenticated browser claims it.
                    tx.set(ref, { phase: 'complete', clientStateHash: saved.clientStateHash,
                        authTime: saved.authTime, expiresAt: saved.expiresAt })
                })
                return { statusCode: 200, headers: apiHeaders, body: JSON.stringify({ connected: true }) }
            }
            const state = createOAuthState(identity.uid, identity.authTime, clientState)
            await pendingRef(identity.db, identity.uid).set({ stateHash: digest(state), clientStateHash: digest(clientState),
                authTime: identity.authTime, phase: 'pending', expiresAt: Date.now() + 600000 })
            const params = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT_URI, response_type: 'code',
                scope: GOOGLE_AUTH_SCOPES.join(' '), access_type: 'offline', prompt: 'consent select_account',
                include_granted_scopes: 'true', login_hint: GOOGLE_ACCOUNT_EMAIL, state })
            return { statusCode: 200, headers: { ...apiHeaders, 'Set-Cookie': oauthCookie(state) }, body: JSON.stringify({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` }) }
        } catch { return apiError(503, action === 'complete' ? 'Google 授權未能儲存，請確認目前登入帳號後重新授權' : '無法開始 Google 授權，請重新登入後再試') }
    }
    if (action) return apiError(400, 'Google 授權操作無效')
    if (event.httpMethod !== 'GET') return apiError(405, '僅支援 GET', { Allow: 'GET' })
    let state
    try {
        state = readOAuthState(event.queryStringParameters?.state, event.headers?.cookie || event.headers?.Cookie)
        const db = getFirestore(getProtectedApp()), ref = pendingRef(db, state.uid)
        await db.runTransaction(async tx => {
            const saved = (await tx.get(ref)).data()
            if (!sameSecret(saved?.stateHash, digest(event.queryStringParameters.state)) || saved.expiresAt <= Date.now()
                || saved.phase !== 'pending') throw new Error('Invalid pending request')
            // Existing service-account role permits create/update, not delete.
            // Keep one bounded record per user and invalidate it atomically.
            tx.set(ref, { ...saved, phase: 'exchanging' })
        })
    } catch { return redirect({ gcal_error: 'Google 授權驗證失敗或已逾時，請從目前帳號重新連結' }) }
    const resultState = { gcal_state: state.clientState, gcal_uid: state.uid, gcal_auth_time: String(state.authTime) }
    if (event.queryStringParameters?.error) return redirect({ ...resultState, gcal_error: 'Google 授權未完成，請重新連結' })
    const code = event.queryStringParameters?.code
    if (typeof code !== 'string' || !code || code.length > 8192) return redirect({ ...resultState, gcal_error: '缺少有效授權碼，請重新連結' })
    try {
        const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' }), signal: AbortSignal.timeout(10000) })
        const token = await response.json()
        if (!response.ok || typeof token.refresh_token !== 'string' || !token.refresh_token || token.refresh_token.length > 8192
            || typeof token.access_token !== 'string' || !token.access_token) return redirect({ ...resultState, gcal_error: '未取得有效 Google 授權，原有連線已保留，請重新授權' })
        const grantedScopes = typeof token.scope === 'string' ? [...new Set(token.scope.split(/\s+/).filter(Boolean))] : []
        if (!GOOGLE_DATA_SCOPES.every(scope => grantedScopes.includes(scope))) {
            return redirect({ ...resultState, gcal_error: '請同時允許行事曆、試算表唯讀與報告檔案搜尋；原有連線已保留' })
        }
        // The identity comes directly from Google's authenticated HTTPS userinfo endpoint.
        // login_hint only selects a suggested account; it is never proof of identity.
        const userResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
            headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10000),
        })
        const user = await userResponse.json()
        if (!userResponse.ok || user.email_verified !== true || typeof user.sub !== 'string' || !user.sub
            || user.email !== GOOGLE_ACCOUNT_EMAIL) return redirect({ ...resultState, gcal_error: `請使用 ${GOOGLE_ACCOUNT_EMAIL} 授權；原有連線已保留` })
        const db = getFirestore(getProtectedApp()), ref = pendingRef(db, state.uid)
        await db.runTransaction(async tx => {
            const saved = (await tx.get(ref)).data()
            if (!sameSecret(saved?.stateHash, digest(event.queryStringParameters.state)) || saved.phase !== 'exchanging'
                || saved.expiresAt <= Date.now()) throw new Error('Superseded request')
            tx.set(ref, { ...saved, phase: 'ready', grant: { refreshToken: token.refresh_token,
                googleEmail: user.email, googleAccountId: user.sub, grantedScopes } })
        })
        return redirect({ ...resultState, gcal_complete: '1' })
    } catch { return redirect({ ...resultState, gcal_error: 'Google 授權服務暫時無法使用，請稍後重試' }) }
}
export default async function (request) { return invokeEventHandler(request, handleEvent) }
