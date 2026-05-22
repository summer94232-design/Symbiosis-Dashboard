/**
 * accountStore.ts
 * 多帳號管理：加密儲存 credentials，支援無縫切換
 *
 * 加密方式：AES-GCM（Web Crypto API，瀏覽器原生）
 * 儲存位置：localStorage key = 'saved_accounts'
 */

const STORAGE_KEY = 'saved_accounts'
// 固定的衍生鹽（混淆用，非高安全場景夠用）
const SALT = 'personal-dashboard-v1'

export interface SavedAccount {
    email: string
    displayName: string   // 顯示用名稱（可自訂，預設取 email @ 前段）
    encryptedPassword: string
    iv: string            // Base64 IV
    savedAt: number       // timestamp
}

// ── 工具：ArrayBuffer | Uint8Array <-> Base64 ─────────────────
function bufToBase64(buf: ArrayBuffer | Uint8Array): string {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    return btoa(String.fromCharCode(...u8))
}
function base64ToBuf(b64: string): Uint8Array {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

// ── 從固定 SALT 衍生 AES-GCM key ─────────────────────────────
async function deriveKey(): Promise<CryptoKey> {
    const enc = new TextEncoder()
    const keyMaterial = await crypto.subtle.importKey(
        'raw', enc.encode(SALT), 'PBKDF2', false, ['deriveKey']
    )
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: enc.encode('iv-salt'), iterations: 100_000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    )
}

// ── 加密 ──────────────────────────────────────────────────────
async function encrypt(plaintext: string): Promise<{ cipher: string; iv: string }> {
    const key = await deriveKey()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const enc = new TextEncoder()
    const cipherBuf = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        enc.encode(plaintext)
    )
    return { cipher: bufToBase64(cipherBuf), iv: bufToBase64(iv) }
}

// ── 解密 ──────────────────────────────────────────────────────
async function decrypt(cipher: string, ivB64: string): Promise<string> {
    const key = await deriveKey()
    const decBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBuf(ivB64) },
        key,
        base64ToBuf(cipher).buffer as ArrayBuffer
    )
    return new TextDecoder().decode(decBuf)
}

// ── 讀取全部已儲存帳號 ────────────────────────────────────────
export function loadAccounts(): SavedAccount[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        return raw ? JSON.parse(raw) : []
    } catch {
        return []
    }
}

// ── 儲存（或更新）一組帳號 ───────────────────────────────────
export async function saveAccount(email: string, password: string, displayName?: string): Promise<void> {
    const { cipher, iv } = await encrypt(password)
    const accounts = loadAccounts().filter(a => a.email !== email) // 同 email 覆蓋
    accounts.push({
        email,
        displayName: displayName ?? email.split('@')[0],
        encryptedPassword: cipher,
        iv,
        savedAt: Date.now(),
    })
    localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts))
}

// ── 取得某帳號的明文密碼 ──────────────────────────────────────
export async function getPassword(email: string): Promise<string | null> {
    const account = loadAccounts().find(a => a.email === email)
    if (!account) return null
    try {
        return await decrypt(account.encryptedPassword, account.iv)
    } catch {
        return null
    }
}

// ── 移除帳號 ──────────────────────────────────────────────────
export function removeAccount(email: string): void {
    const accounts = loadAccounts().filter(a => a.email !== email)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts))
}