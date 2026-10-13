import { cert } from 'firebase-admin/app'
import { sign } from 'node:crypto'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/identitytoolkit'
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const failure = reason => Object.assign(new Error('法說會服務憑證無法使用'), {
    code: 'app/invalid-credential', credentialReason: reason,
})

/** Replace only the meetings app's token exchange, retaining the certificate
 * identity required by Firestore. Never mutate cert(): Firebase caches it and
 * the news app may be using the same instance.
 */
export function createMeetingsCredential(account) {
    const base = cert(account)
    let pending
    const exchange = async () => {
        let assertion
        try {
            const now = Math.floor(Date.now() / 1000)
            const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
                iss: base.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
            })}`
            assertion = `${input}.${sign('RSA-SHA256', Buffer.from(input), base.privateKey).toString('base64url')}`
        } catch { throw failure('credential-key-format') }
        let response, data
        try {
            response = await fetch(TOKEN_URL, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
            })
        } catch { throw failure('network-connection') }
        try { data = await response.json() }
        catch { throw failure('oauth-token-response-invalid') }
        if (!response.ok) {
            // Select fixed labels; never attach Google responses, signed JWTs or keys.
            const description = typeof data?.error_description === 'string' ? data.error_description.slice(0, 2048) : ''
            const reasons = { invalid_grant: 'oauth-grant-rejected', invalid_client: 'oauth-client-invalid',
                disabled_client: 'oauth-client-disabled', deleted_client: 'oauth-client-deleted',
                unauthorized_client: 'oauth-client-unauthorized', invalid_scope: 'oauth-scope-invalid' }
            const reason = /invalid jwt signature/i.test(description) ? 'jwt-signature-invalid'
                : /short-lived token|reasonable timeframe/i.test(description) ? 'jwt-time-invalid'
                : Object.hasOwn(reasons, data?.error) ? reasons[data.error]
                : response.status >= 500 ? 'upstream-unavailable' : 'oauth-grant-rejected'
            throw failure(reason)
        }
        if (typeof data?.access_token !== 'string' || !data.access_token.trim()
            || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer'
            || !Number.isFinite(data.expires_in) || data.expires_in <= 60 || data.expires_in > 3600) {
            throw failure('oauth-token-response-invalid')
        }
        return { access_token: data.access_token, expires_in: data.expires_in }
    }
    // FirebaseApp caches successful tokens and refreshes them before expiry.
    // Only merge concurrent exchanges here; rejected requests remain retryable.
    return Object.create(base, { getAccessToken: { value: () => {
        pending ??= exchange().finally(() => { pending = undefined })
        return pending
    } } })
}
