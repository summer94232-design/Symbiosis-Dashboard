/**
 * stockDict.ts — 股票名稱字典查詢（優化建議書 1-2）
 *
 * 放置位置：src/lib/stockDict.ts
 *
 * 原本 lookupStockName + dictCache 被複製在 Trades、Dividend、IndustryMap 三處，
 * 各頁的 dictCache 互相獨立（Trades 查過的代號，Dividend 還要再打一次 Firestore）。
 * 抽到本模組後三頁共用同一份 module-level 快取，同一個 session 內任何頁面
 * 查過的代號都不會重複查詢，順便解決原註解「並未共用」與期望不符的問題。
 *
 * 查詢順序：
 *   1. dictCache（記憶體，本次 session）
 *   2. stockDict（Firestore 常用字典）
 *   3. stockDictFull（Firestore 完整台股字典）→ 命中後回寫 stockDict，下次直接命中
 */

import { getDoc, setDoc, getDocs, query, orderBy, startAt, endAt, documentId, limit } from 'firebase/firestore'
import { investDB } from './firebase'
import { userDoc, userCol, getUID } from './userDB'
import { cache } from './cache'

// 全系統共用的 session 快取；key 內含 uid，避免切換帳號後沿用前一帳號的自訂名稱。
const dictCache: Record<string, string> = {}

function dictCacheKey(code: string): string {
    return `${getUID()}:${code}`
}

/** 單筆查詢：依序查快取 → stockDict → stockDictFull，查無回傳空字串 */
export async function lookupStockName(code: string): Promise<string> {
    const key = dictCacheKey(code)
    const cached = dictCache[key]
    if (cached) return cached

    const name = await cache.getOrLoad(`stock:lookup:${key}`, async () => {
        const shortDoc = await getDoc(userDoc(investDB, 'stockDict', code))
        if (shortDoc.exists()) return shortDoc.data().name as string
        const fullDoc = await getDoc(userDoc(investDB, 'stockDictFull', code))
        if (!fullDoc.exists()) return ''
        const fullName = fullDoc.data().name as string
        await setDoc(userDoc(investDB, 'stockDict', code), { name: fullName })
        return fullName
    }, 600)
    if (name) dictCache[key] = name
    return name
}

/**
 * 只寫入記憶體快取（不打 Firestore）。
 * 用於：編輯既有紀錄時把該筆的 code/name 帶入快取，避免 debounce 查詢覆蓋使用者輸入。
 */
export function cacheStockName(code: string, name: string): void {
    if (code && name) dictCache[dictCacheKey(code)] = name
}

/**
 * 寫入記憶體快取並同步寫回 Firestore 常用字典（stockDict）。
 * 用於：表單儲存、CSV 匯入時把使用者輸入的名稱固化下來。
 */
export async function saveStockName(code: string, name: string): Promise<void> {
    if (!code || !name) return
    dictCache[dictCacheKey(code)] = name
    await setDoc(userDoc(investDB, 'stockDict', code), { name })
    cache.invalidatePrefix('stock:')
}

export interface StockCandidate {
    code: string
    name: string
}

/**
 * 前綴模糊搜尋（新增功能：新增交易輸入代號時列出相關代號，例如輸入 00631
 * 列出 00631、00631L 等）。
 *
 * 用 Firestore 文件 ID 範圍查詢：orderBy(documentId()) + startAt(prefix) + endAt(prefix+'\uf8ff')，
 * 對 __name__（文件 ID）做前綴比對，不需要額外建立 composite index。
 *
 * 同時查 stockDictFull（完整字典，涵蓋範圍廣）與 stockDict（常用字典，可能有使用者自訂名稱），
 * 合併去重，stockDict 的名稱優先（使用者手動存過的名稱較準）。
 */
export async function searchStockByCodePrefix(prefix: string, max = 8): Promise<StockCandidate[]> {
    if (!prefix) return []
    const upper = prefix.toUpperCase()

    const runPrefixQuery = async (collectionName: string): Promise<StockCandidate[]> => {
        const collRef = userCol(investDB, collectionName)
        const q = query(
            collRef,
            orderBy(documentId()),
            startAt(upper),
            endAt(upper + '\uf8ff'),
            limit(max)
        )
        const snap = await getDocs(q)
        return snap.docs.map(d => ({ code: d.id, name: (d.data().name as string) || '' }))
    }

    const [fullResults, shortResults] = await cache.getOrLoad(`stock:code:${getUID()}:${upper}:${max}`, () => Promise.all([
        runPrefixQuery('stockDictFull'),
        runPrefixQuery('stockDict'),
    ]), 600)

    // 合併去重：stockDict（常用字典）優先，stockDictFull 補漏
    const merged = new Map<string, string>()
    for (const r of fullResults) merged.set(r.code, r.name)
    for (const r of shortResults) merged.set(r.code, r.name)

    // 一併寫入 session 快取，避免使用者點選候選後 debounce 又打一次 Firestore
    for (const [code, name] of merged) {
        if (name) dictCache[dictCacheKey(code)] = name
    }

    return Array.from(merged.entries())
        .map(([code, name]) => ({ code, name }))
        .sort((a, b) => a.code.localeCompare(b.code))
        .slice(0, max)
}

/**
 * 依股票名稱前綴反查代號。
 *
 * Firestore 對一般欄位可直接用 orderBy + startAt/endAt 做前綴查詢；同時查常用與
 * 完整字典，讓使用者輸入「台積」即可選到「2330 台積電」。名稱完全命中或只剩
 * 一個候選時，表單會直接帶回代號。
 */
export async function searchStockByNamePrefix(prefix: string, max = 8): Promise<StockCandidate[]> {
    const normalized = prefix.trim()
    if (!normalized) return []

    const runPrefixQuery = async (collectionName: string): Promise<StockCandidate[]> => {
        const q = query(
            userCol(investDB, collectionName),
            orderBy('name'),
            startAt(normalized),
            endAt(normalized + '\uf8ff'),
            limit(max)
        )
        const snap = await getDocs(q)
        return snap.docs.map(d => ({ code: d.id, name: (d.data().name as string) || '' }))
    }

    const [fullResults, shortResults] = await cache.getOrLoad(`stock:name:${getUID()}:${normalized}:${max}`, () => Promise.all([
        runPrefixQuery('stockDictFull'),
        runPrefixQuery('stockDict'),
    ]), 600)

    const merged = new Map<string, string>()
    for (const r of fullResults) merged.set(r.code, r.name)
    for (const r of shortResults) merged.set(r.code, r.name)
    for (const [code, name] of merged) {
        if (name) dictCache[dictCacheKey(code)] = name
    }

    return Array.from(merged.entries())
        .map(([code, name]) => ({ code, name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-TW') || a.code.localeCompare(b.code))
        .slice(0, max)
}
