/**
 * investData.ts — 投資資料共用快取層（優化建議書 1-1）
 *
 * 放置位置：src/lib/investData.ts
 *
 * 目的：trades / dividends / cashflow 過去在 7+ 個頁面各自 getDocs 全量讀取，
 * 造成 Firestore 讀取費用倍增、各頁資料時間點不一致。
 * 本模組以 lib/cache.ts 的 TTL 快取包住讀取，全系統共用同一份資料。
 *
 * 設計原則：
 * - 快取 key 內含 uid：切換帳號後自動視為不同快取，絕不會讀到前一個帳號的資料。
 * - Firestore 端一律以 orderBy('date', 'asc') 讀取（與多數頁面原行為一致），
 *   需要 desc 的頁面由本模組回傳反轉副本，不再各自下不同 query。
 *   ⚠️ 注意：orderBy('date') 會排除「沒有 date 欄位」的文件——這與原本
 *   大多數頁面的行為相同（三個表單的 date 皆為必填，實務上不影響）。
 * - 一律回傳「淺拷貝陣列」：頁面對陣列做 sort/reverse 不會污染快取。
 *   但請勿直接修改陣列內的物件（各頁原本就以 map 產生新物件，維持此慣例即可）。
 * - 寫入（新增/編輯/刪除/匯入）後，呼叫端必須呼叫對應的 invalidateXxx()，
 *   下次讀取就會重新向 Firestore 取得最新資料。
 * - 每筆資料都附上 Firestore 文件 id（與各頁原本 { id: d.id, ...d.data() } 的
 *   寫法一致；原本只取 d.data() 的頁面多出 id 欄位不影響既有計算）。
 */

import { getDocs, query, orderBy } from 'firebase/firestore'
import { investDB } from './firebase'
import { userCol, getUID } from './userDB'
import { cache } from './cache'
import { alignSnapshotCashflows, type CashflowBasisSnapshot } from './performanceReturns'

/** 快取存活秒數：在此秒數內重複進入各頁面不會重打 Firestore */
const TTL_SECONDS = 90

type InvestCollection = 'trades' | 'dividends' | 'cashflow' | 'assetSnapshots'
export type SortOrder = 'asc' | 'desc'

function cacheKey(name: InvestCollection): string {
    // 格式：invest:{collection}:{uid}
    // invalidate 時以 'invest:{collection}:' 前綴清除，不需呼叫 getUID()（避免未登入時拋錯）
    return `invest:${name}:${getUID()}`
}

async function fetchCollection<T>(name: InvestCollection, order: SortOrder): Promise<T[]> {
    const key = cacheKey(name)
    const docs = await cache.getOrLoad<Record<string, unknown>[]>(key, async () => {
        const snap = await getDocs(query(userCol(investDB, name), orderBy('date', 'asc')))
        return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    }, TTL_SECONDS)
    // 永遠回傳副本，避免呼叫端 in-place sort 污染快取順序
    const result = order === 'asc' ? [...docs] : [...docs].reverse()
    return result as unknown as T[]
}

/** 讀取全部買賣紀錄（預設日期升冪）。型別參數沿用各頁自己的介面，例如 fetchTrades<Trade>('desc') */
export function fetchTrades<T = Record<string, unknown>>(order: SortOrder = 'asc'): Promise<T[]> {
    return fetchCollection<T>('trades', order)
}

/** 讀取全部除權息紀錄（預設日期升冪） */
export function fetchDividends<T = Record<string, unknown>>(order: SortOrder = 'asc'): Promise<T[]> {
    return fetchCollection<T>('dividends', order)
}

/** 讀取全部出入金紀錄（預設日期升冪） */
export function fetchCashflow<T = Record<string, unknown>>(order: SortOrder = 'asc'): Promise<T[]> {
    return fetchCollection<T>('cashflow', order)
}

/** Reads asset history through the same cache and request-deduplication path. */
export async function fetchAssetSnapshots<T = Record<string, unknown>>(order: SortOrder = 'asc'): Promise<T[]> {
    const uid = getUID()
    const [snapshots, flows] = await Promise.all([
        fetchCollection<CashflowBasisSnapshot>('assetSnapshots', order),
        fetchCashflow<{ date: string; type: string; amount: number }>(),
    ])
    if (getUID() !== uid) throw new Error('帳號已變更，請重新讀取快照')
    if (flows.some(flow => !['in', 'out'].includes(flow.type) || !Number.isFinite(flow.amount) || flow.amount < 0)) throw new Error('出入金資料無效')
    return alignSnapshotCashflows(snapshots, flows.map(flow => ({ date: flow.date, amount: flow.type === 'in' ? flow.amount : -flow.amount }))) as unknown as T[]
}

/** 買賣紀錄有任何寫入（新增/編輯/刪除/匯入）後呼叫 */
export function invalidateTrades(): void {
    cache.invalidatePrefix('invest:trades:')
}

/** 除權息紀錄有任何寫入後呼叫 */
export function invalidateDividends(): void {
    cache.invalidatePrefix('invest:dividends:')
}

/** 出入金紀錄有任何寫入後呼叫 */
export function invalidateCashflow(): void {
    cache.invalidatePrefix('invest:cashflow:')
}

/** 一次清除三種快取（完整備份還原等大量寫入場景使用） */
export function invalidateAllInvestData(): void {
    cache.invalidatePrefix('invest:')
}

export function invalidateAssetSnapshots(): void {
    cache.invalidatePrefix('invest:assetSnapshots:')
}
