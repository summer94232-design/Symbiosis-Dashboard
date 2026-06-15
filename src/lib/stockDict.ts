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

import { getDoc, setDoc } from 'firebase/firestore'
import { investDB } from './firebase'
import { userDoc } from './userDB'

// 全系統共用的 session 快取
const dictCache: Record<string, string> = {}

/** 單筆查詢：依序查快取 → stockDict → stockDictFull，查無回傳空字串 */
export async function lookupStockName(code: string): Promise<string> {
    const cached = dictCache[code]
    if (cached) return cached

    // 先查常用字典
    const shortDoc = await getDoc(userDoc(investDB, 'stockDict', code))
    if (shortDoc.exists()) {
        const name = shortDoc.data().name as string
        dictCache[code] = name
        return name
    }

    // 找不到再查完整字典
    const fullDoc = await getDoc(userDoc(investDB, 'stockDictFull', code))
    if (fullDoc.exists()) {
        const name = fullDoc.data().name as string
        dictCache[code] = name
        // 找到後順便寫回 stockDict，下次直接命中
        await setDoc(userDoc(investDB, 'stockDict', code), { name })
        return name
    }

    return ''
}

/**
 * 只寫入記憶體快取（不打 Firestore）。
 * 用於：編輯既有紀錄時把該筆的 code/name 帶入快取，避免 debounce 查詢覆蓋使用者輸入。
 */
export function cacheStockName(code: string, name: string): void {
    if (code && name) dictCache[code] = name
}

/**
 * 寫入記憶體快取並同步寫回 Firestore 常用字典（stockDict）。
 * 用於：表單儲存、CSV 匯入時把使用者輸入的名稱固化下來。
 */
export async function saveStockName(code: string, name: string): Promise<void> {
    if (!code || !name) return
    dictCache[code] = name
    await setDoc(userDoc(investDB, 'stockDict', code), { name })
}