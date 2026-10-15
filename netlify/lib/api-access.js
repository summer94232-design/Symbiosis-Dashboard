import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { createHash } from 'node:crypto'
import { createMeetingsCredential } from './meetings-credential.js'

export const apiHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }
export const apiError = (statusCode, error, extra = {}) => ({ statusCode, headers: { ...apiHeaders, ...extra }, body: JSON.stringify({ error }) })
export const POLICIES = {
    news: { minute: 6, day: 100, globalDay: 300 },
    foreign: { minute: 120, day: 5000, globalDay: 10000 },
    fubonSnapshot: { minute: 12, day: 300, globalDay: 600 },
    marketCap: { minute: 300, day: 5000, globalDay: 10000 },
    meetings: { minute: 6, day: 100, globalDay: 300 },
    mops: { minute: 20, day: 500, globalDay: 1000 },
    calendarSeries: { minute: 30, day: 300, globalDay: 1000 },
    calendarGoogle: { minute: 60, day: 1000, globalDay: 3000 },
    marketReports: { minute: 12, day: 500, globalDay: 1500 },
    annualCalendars: { minute: 6, day: 100, globalDay: 300 },
    quoteBudget: { minute: 60, day: 1000, globalDay: 2000 },
    fugle: { minute: 120, day: 5000, globalDay: 10000 },
    dividends: { minute: 2, day: 12, globalDay: 50 },
    ai: { minute: 6, day: 100, globalDay: 100 },
}

// Only fixed labels leave this function. Never serialize an SDK error: its cause,
// response, request config and even message can contain credentials or tokens.
export function authenticationDiagnostic(error) {
    const sdkCodes = new Set([
        'app/invalid-credential', 'auth/invalid-credential', 'auth/insufficient-permission',
        'auth/internal-error', 'app/network-error', 'app/network-timeout', 'app/internal-error',
    ])
    const code = sdkCodes.has(error?.code) ? error.code : 'unknown'
    const exchangeReasons = new Set(['credential-key-format', 'network-connection', 'oauth-token-response-invalid',
        'oauth-grant-rejected', 'oauth-client-invalid', 'oauth-client-disabled', 'oauth-client-deleted',
        'oauth-client-unauthorized', 'oauth-scope-invalid', 'jwt-signature-invalid', 'jwt-time-invalid', 'upstream-unavailable'])
    if (code === 'auth/insufficient-permission') return { code, reason: 'permission-denied' }
    const chain = [], seen = new Set()
    let current = error
    while (current && chain.length < 5 && !seen.has(current)) {
        seen.add(current)
        chain.push(current)
        current = typeof current === 'object' ? current.cause : null
    }
    // Prefer the underlying cause over Firebase's wrapper and troubleshooting text.
    for (const item of chain.reverse()) {
        if (exchangeReasons.has(item?.credentialReason)) return { code, reason: item.credentialReason }
        const data = item?.response?.data ?? item?.httpResponse?.data
        const fields = [typeof item === 'string' ? item : item?.message,
            item?.code, data?.error, data?.error_description]
        const text = fields.filter(value => typeof value === 'string')
            .map(value => value.slice(0, 8192)).join('\n').toLowerCase()
        let reason
        if (/cannot find module|cannot find package|err_module_not_found|module_not_found/.test(text)) reason = 'runtime-module-missing'
        else if (/dynamic require of|require is not defined|err_require_esm|require\(\) of es module|__dirname is not defined/.test(text)) reason = 'runtime-module-incompatible'
        else if (/is not a function|is not a constructor|cannot read properties of (?:undefined|null)/.test(text)) reason = 'runtime-type-error'
        else if (/err_ossl_|decoder routines|pem routines|invalid pem|failed to parse private key|secretorprivatekey must/.test(text)) reason = 'credential-key-format'
        else if (/no key or keyfile set|no private key provided/.test(text)) reason = 'credential-key-missing'
        else if (/invalid access token generated|failed to parse google auth credential|no access, refresh token|no access token returned|could not refresh access token/.test(text)) reason = 'oauth-token-response-invalid'
        else if (/unable_to_verify_leaf_signature|cert_has_expired|self_signed_cert_in_chain|depth_zero_self_signed_cert|err_tls_cert_altname_invalid|unable_to_get_issuer_cert_locally/.test(text)) reason = 'network-tls'
        else if (/invalid jwt signature/.test(text)) reason = 'jwt-signature-invalid'
        else if (/token must be a short-lived token|reasonable timeframe|used too early|token has been expired or revoked/.test(text)) {
            // "expired or revoked" alone is ambiguous; do not label it a clock problem.
            reason = /token has been expired or revoked/.test(text) ? 'oauth-grant-rejected' : 'jwt-time-invalid'
        }
        else if (/service account (?:has been |is )?disabled|account has been disabled/.test(text)) reason = 'service-account-disabled'
        else if (/\bdisabled_client\b/.test(text)) reason = 'oauth-client-disabled'
        else if (/\bdeleted_client\b/.test(text)) reason = 'oauth-client-deleted'
        else if (/\binvalid_client\b/.test(text)) reason = 'oauth-client-invalid'
        else if (/\binvalid_scope\b/.test(text)) reason = 'oauth-scope-invalid'
        else if (/\bunauthorized_client\b/.test(text)) reason = 'oauth-client-unauthorized'
        else if (/\benotfound\b|\beai_again\b/.test(text)) reason = 'network-dns'
        else if (/\betimedout\b|\bund_err_connect_timeout\b|\babort_err\b|network-timeout|request timed out/.test(text)) reason = 'network-timeout'
        else if (/\beacces\b|\beperm\b/.test(text)) reason = 'network-access-denied'
        else if (/\beconnreset\b|\beconnrefused\b|\benetunreach\b|\behostunreach\b|network-error|fetch failed/.test(text)) reason = 'network-connection'
        else if (/\binvalid_grant\b/.test(text)) reason = 'oauth-grant-rejected'
        else {
            const status = item?.response?.status ?? item?.httpResponse?.status
            if (Number.isInteger(status) && status >= 500 && status <= 599) reason = 'upstream-unavailable'
        }
        if (reason) return { code, reason }
    }
    return { code, reason: 'unclassified' }
}

// Fixed structural hints remain useful when a provider introduces a new message.
// No message text, paths, stack frames or arbitrary class names leave this helper.
export function authenticationErrorShape(error) {
    const names = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'FirebaseAppError',
        'FirebaseError', 'GaxiosError', 'FetchError', 'AbortError', 'TimeoutError', 'AggregateError'])
    const types = [], seen = new Set()
    let current = error
    while (current && types.length < 5 && !seen.has(current)) {
        seen.add(current)
        const name = current?.name
        types.push(names.has(name) ? name : 'unknown')
        current = typeof current === 'object' ? current.cause : null
    }
    return { errorTypes: types, hasNestedCause: types.length > 1 }
}

/** Fixed gRPC labels only; transaction errors can contain document paths. */
export function quotaDiagnostic(error) {
    const reasons = { 4: 'database-timeout', 7: 'permission-denied', 8: 'database-exhausted',
        10: 'transaction-contention', 14: 'database-unavailable' }
    const code = error?.code
    return Object.hasOwn(reasons, code) ? { code: `firestore/${code}`, reason: reasons[code] }
        : authenticationDiagnostic(error)
}

export async function consumeQuota(db, uid, route, units = 1, now = Date.now()) {
    const policy = POLICIES[route]
    if (!policy || !Number.isSafeInteger(units) || units < 1) throw new Error('Invalid quota request')
    const minute = Math.floor(now / 60000), day = Math.floor(now / 86400000)
    const hash = createHash('sha256').update(uid).digest('hex')
    const refs = [db.doc(`apiUsage/${route}_${hash}`), db.doc(`apiUsage/${route}_global`)]
    return db.runTransaction(async transaction => {
        const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)))
        const values = snapshots.map(snap => snap.data() || {})
        const usedMinute = values[0].minute === minute ? values[0].minuteUnits || 0 : 0
        const usedDay = values[0].day === day ? values[0].dayUnits || 0 : 0
        const globalDay = values[1].day === day ? values[1].dayUnits || 0 : 0
        if (usedMinute + units > policy.minute || usedDay + units > policy.day || globalDay + units > policy.globalDay) {
            return usedDay + units > policy.day || globalDay + units > policy.globalDay
                ? Math.ceil(((day + 1) * 86400000 - now) / 1000) : Math.ceil(((minute + 1) * 60000 - now) / 1000)
        }
        transaction.set(refs[0], { minute, day, minuteUnits: usedMinute + units, dayUnits: usedDay + units })
        transaction.set(refs[1], { day, dayUnits: globalDay + units })
        return 0
    })
}

export function getProtectedApp() {
    const projectId = process.env.API_FIREBASE_PROJECT_ID
    if (!projectId || !process.env.API_FIREBASE_SERVICE_ACCOUNT) throw new Error('Missing configuration')
    const existing = getApps().find(app => app.name === 'protected-api')
    if (existing) return existing
    const account = JSON.parse(process.env.API_FIREBASE_SERVICE_ACCOUNT)
    if (account.project_id !== projectId) throw new Error('Project mismatch')
    return initializeApp({ credential: cert(account), projectId }, 'protected-api')
}

export async function authorizeApiIdentity(event, route, units = 1, method = 'GET') {
    if (event.httpMethod !== method) return apiError(405, `僅支援 ${method}`, { Allow: method })
    const authorization = event.headers?.authorization || event.headers?.Authorization || ''
    if (!/^Bearer \S+$/.test(authorization) || authorization.length > 8192) return apiError(401, '請先登入')
    let app, allowed
    try {
        const projectId = process.env.API_FIREBASE_PROJECT_ID
        allowed = new Set((process.env.API_ALLOWED_UIDS || '').split(',').map(id => id.trim()).filter(Boolean))
        if (!projectId || !allowed.size || !process.env.API_FIREBASE_SERVICE_ACCOUNT) throw new Error('Missing configuration')
        const isolated = route === 'meetings' || route === 'fubonSnapshot'
        const appName = isolated ? 'protected-meetings-api' : 'protected-api'
        app = getApps().find(app => app.name === appName)
        if (!app) {
            const account = JSON.parse(process.env.API_FIREBASE_SERVICE_ACCOUNT)
            if (account.project_id !== projectId) throw new Error('Project mismatch')
            const credential = isolated ? createMeetingsCredential(account) : cert(account)
            app = initializeApp({ credential, projectId }, appName)
        }
    } catch { return apiError(503, 'API 安全設定尚未完成，請聯絡管理者') }
    let user
    try { user = await getAuth(app).verifyIdToken(authorization.slice(7), true) }
    catch (error) {
        const invalid = ['auth/id-token-expired', 'auth/id-token-revoked', 'auth/invalid-id-token', 'auth/argument-error', 'auth/user-disabled', 'auth/user-not-found']
        // Firebase wraps public-key download failures as auth/argument-error too.
        // Keep verification closed, but do not tell a valid user to sign in again.
        const publicKeyFailure = error?.code === 'auth/argument-error' && typeof error.message === 'string'
            && /error in secret or public key callback:/i.test(error.message)
        if (invalid.includes(error?.code) && !publicKeyFailure) return apiError(401, '登入憑證失效，請重新登入')
        const { code, reason } = authenticationDiagnostic(error)
        console.error('[protected-api] authentication unavailable', {
            route: Object.hasOwn(POLICIES, route) ? route : 'unknown', code, reason,
            ...authenticationErrorShape(error),
        })
        const message = publicKeyFailure ? '登入驗證服務連線失敗，請檢查後端網路後重試'
            : code === 'auth/insufficient-permission' ? '驗證服務帳號權限不足，請聯絡管理者'
            : ['auth/invalid-credential', 'app/invalid-credential'].includes(code) ? '驗證服務憑證無法使用，請聯絡管理者'
            : '驗證服務暫時無法使用'
        return apiError(503, `${message}（${code}；${reason}）`)
    }
    if (!allowed.has(user.uid)) return apiError(403, '此帳號未獲授權使用 API')
    // AI uses its own combined fee/DB reservation transaction; do not duplicate
    // the generic quota's two reads and two writes on every chat turn.
    if (route === 'ai') return { uid: user.uid, authTime: user.auth_time, db: getFirestore(app) }
    try {
        const retryAfter = await consumeQuota(getFirestore(app), user.uid, route, units)
        if (retryAfter) return apiError(429, '已達請求額度，請稍後再試', { 'Retry-After': String(retryAfter) })
    } catch (error) {
        console.error('[protected-api] quota unavailable', {
            route: Object.hasOwn(POLICIES, route) ? route : 'unknown', ...quotaDiagnostic(error),
        })
        return apiError(503, '用量檢查暫時無法使用，請稍後再試')
    }
    return { uid: user.uid, authTime: user.auth_time, db: getFirestore(app) }
}

// Preserve the existing API for callers that only need a denial response.
export async function authorizeApi(event, route, units = 1, method = 'GET') {
    const result = await authorizeApiIdentity(event, route, units, method)
    return result.statusCode ? result : null
}

const entries = new Map()
/** Bounded warm-instance cache; quotas above remain shared across instances. */
export async function cachedApi(key, ttlMs, loader, forceRefresh = false) {
    const existing = entries.get(key)
    if (!forceRefresh && existing && existing.expires > Date.now()) return existing.promise
    const record = { expires: Date.now() + ttlMs, promise: null }
    record.promise = Promise.resolve().then(loader).catch(error => { if (entries.get(key) === record) entries.delete(key); throw error })
    entries.delete(key)
    entries.set(key, record)
    while (entries.size > 128) entries.delete(entries.keys().next().value)
    return record.promise
}
