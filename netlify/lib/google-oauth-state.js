import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { sameSecret } from './google-calendar-security.js'

export const OAUTH_COOKIE = '__Host-symbiosis-gcal'
export const OAUTH_TTL = 600
export const oauthCookie = (value, age = OAUTH_TTL) => `${OAUTH_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`
const stateKey = () => createHash('sha256').update('symbiosis-gcal-state:' + process.env.GOOGLE_CLIENT_SECRET).digest()
export function createOAuthState(uid, authTime, clientState, now = Date.now()) {
    if (!Number.isSafeInteger(authTime) || !/^[a-f0-9]{64}$/.test(clientState)) throw new Error('Invalid session')
    // Authenticated encryption keeps the Firebase identity out of Google's state URLs.
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', stateKey(), iv)
    const body = JSON.stringify({ uid, authTime, clientState, expires: now + OAUTH_TTL * 1000 })
    const encrypted = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()])
    return [iv, encrypted, cipher.getAuthTag()].map(bytes => bytes.toString('base64url')).join('.')
}
export function readOAuthState(state, cookieHeader, now = Date.now()) {
    if (typeof state !== 'string' || state.length > 2048) throw new Error('Invalid state')
    const cookies = String(cookieHeader || '').split(';').map(value => value.trim())
    const cookie = cookies.find(value => value.startsWith(OAUTH_COOKIE + '='))?.slice(OAUTH_COOKIE.length + 1)
    const [iv, body, tag, extra] = state.split('.')
    if (!iv || !body || !tag || extra || !sameSecret(cookie, state)) throw new Error('Invalid state')
    const decipher = createDecipheriv('aes-256-gcm', stateKey(), Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'))
    if (!value.uid || !Number.isSafeInteger(value.authTime) || !/^[a-f0-9]{64}$/.test(value.clientState) || !Number.isFinite(value.expires) || value.expires <= now || value.expires > now + OAUTH_TTL * 1000) throw new Error('Expired state')
    return value
}
