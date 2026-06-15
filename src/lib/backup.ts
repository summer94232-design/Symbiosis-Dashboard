/**
 * backup.ts — 完整 JSON 備份與還原（優化建議書 2-4）
 *
 * 放置位置：src/lib/backup.ts
 *
 * 與 xlsx「完整備份」的分工：
 * - xlsx：給人看、丟 Excel 分析（中文欄名、可套日期區間）→ 保留不動
 * - 本模組：機器災難復原 → 原始欄位零失真、永遠全量、以文件 ID 精確還原
 *
 * 設計原則：
 * - 涵蓋 investDB 全部 collection（含 settings 整個 collection、stockDictFull
 *   完整台股字典）與 kmsDB 的 notes / trash。
 * - 還原採「同 ID setDoc 覆蓋、無則新增」(upsert)：可重複執行（冪等），
 *   不會產生重複資料；備份中沒有的既有文件保留不動（非鏡像刪除）。
 * - 還原只寫入白名單內的 collection，並逐筆檢查 id 合法性（防止竄改過的
 *   備份檔寫入任意路徑）。
 * - 以 writeBatch 每 400 筆一批寫入（Firestore 上限 500），大量資料
 *   （如 stockDictFull）也能順利還原，並回報進度。
 * - ⚠️ 限制：KMS 筆記中的圖片存於 Firebase Storage，僅 URL 在備份內，
 *   圖片檔案本身不在備份範圍。
 */

import { getDocs, writeBatch } from 'firebase/firestore'
import type { Firestore } from 'firebase/firestore'
import { investDB, kmsDB } from './firebase'
import { userCol, userDoc, getUID } from './userDB'
import { invalidateAllInvestData } from './investData'

// ── 格式定義 ───────────────────────────────────────────────────────────────

export const BACKUP_FORMAT = 'symbiosis-full-backup' as const
export const BACKUP_VERSION = 1

export interface BackupDoc {
    /** Firestore 文件 ID */
    id: string
    /** 文件原始內容（原樣存取，零失真） */
    data: Record<string, unknown>
}

export interface FullBackup {
    format: typeof BACKUP_FORMAT
    version: number
    exportedAt: string
    /** 匯出當下的 investAuth uid（還原到不同帳號時供 UI 提示） */
    uid: string
    invest: Record<string, BackupDoc[]>
    kms: Record<string, BackupDoc[]>
}

// ── 白名單（新增 collection 時記得同步維護）────────────────────────────────

export const INVEST_COLLECTIONS = [
    'trades', 'cashflow', 'dividends',
    'stockDict', 'stockDictFull', 'assetSnapshots',
    'sentiments', 'watchlist', 'industryMap',
    'calendarEvents', 'calendarWatchList',
    'tasks', 'taskProjects',
    'settings',
] as const

export const KMS_COLLECTIONS = ['notes', 'trash'] as const

const COLLECTION_LABELS: Record<string, string> = {
    trades: '買賣紀錄',
    cashflow: '出入金',
    dividends: '除權息',
    stockDict: '股票字典',
    stockDictFull: '完整台股字典',
    assetSnapshots: '資產快照',
    sentiments: '情緒追蹤',
    watchlist: '選股追蹤',
    industryMap: '產業地圖',
    calendarEvents: '行事曆事件',
    calendarWatchList: '行事曆關注',
    tasks: '任務',
    taskProjects: '任務專案',
    settings: '系統設定',
    notes: 'KMS 筆記',
    trash: 'KMS 回收桶',
}

// ── 匯出 ──────────────────────────────────────────────────────────────────

async function dumpCollections(db: Firestore, names: readonly string[]): Promise<Record<string, BackupDoc[]>> {
    const result: Record<string, BackupDoc[]> = {}
    // 並行讀取所有 collection
    await Promise.all(names.map(async name => {
        const snap = await getDocs(userCol(db, name))
        result[name] = snap.docs.map(d => ({ id: d.id, data: d.data() as Record<string, unknown> }))
    }))
    return result
}

/** 讀取全系統資料，組成備份物件（不下載；下載請接著呼叫 downloadBackup） */
export async function buildFullBackup(): Promise<FullBackup> {
    const [invest, kms] = await Promise.all([
        dumpCollections(investDB, INVEST_COLLECTIONS),
        dumpCollections(kmsDB, KMS_COLLECTIONS),
    ])
    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        uid: getUID(),
        invest,
        kms,
    }
}

/** 將備份物件以 .json 檔下載到使用者裝置 */
export function downloadBackup(backup: FullBackup): void {
    const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `系統完整備份_${backup.exportedAt.slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
}

// ── 摘要（還原前預覽用）────────────────────────────────────────────────────

export interface BackupSummaryItem { label: string; count: number }

/** 列出備份內各類資料的筆數（依白名單順序，只列有資料的） */
export function backupSummary(backup: FullBackup): BackupSummaryItem[] {
    const items: BackupSummaryItem[] = []
    for (const col of INVEST_COLLECTIONS) {
        const docs = backup.invest[col]
        if (Array.isArray(docs) && docs.length > 0) items.push({ label: COLLECTION_LABELS[col] ?? col, count: docs.length })
    }
    for (const col of KMS_COLLECTIONS) {
        const docs = backup.kms[col]
        if (Array.isArray(docs) && docs.length > 0) items.push({ label: COLLECTION_LABELS[col] ?? col, count: docs.length })
    }
    return items
}

/** 備份內文件總數 */
export function countBackupDocs(backup: FullBackup): number {
    return backupSummary(backup).reduce((s, i) => s + i.count, 0)
}

// ── 解析與驗證 ─────────────────────────────────────────────────────────────

function isDocArrayRecord(v: unknown): v is Record<string, BackupDoc[]> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 解析並驗證使用者選擇的備份檔內容。
 * 格式不符時拋出帶中文訊息的 Error，UI 直接顯示 err.message 即可。
 */
export function parseBackup(text: string): FullBackup {
    let obj: unknown
    try {
        obj = JSON.parse(text)
    } catch {
        throw new Error('檔案不是有效的 JSON')
    }
    const b = obj as Partial<FullBackup>
    if (!b || typeof b !== 'object' || b.format !== BACKUP_FORMAT) {
        throw new Error('格式不符：這不是本系統的 JSON 完整備份檔')
    }
    if (typeof b.version !== 'number' || b.version < 1 || b.version > BACKUP_VERSION) {
        throw new Error(`備份版本（${String(b.version)}）不受目前系統支援（支援至 v${BACKUP_VERSION}）`)
    }
    if (!isDocArrayRecord(b.invest)) {
        throw new Error('備份內容缺少投資資料區段（invest）')
    }
    return {
        format: BACKUP_FORMAT,
        version: b.version,
        exportedAt: typeof b.exportedAt === 'string' ? b.exportedAt : '',
        uid: typeof b.uid === 'string' ? b.uid : '',
        invest: b.invest,
        kms: isDocArrayRecord(b.kms) ? b.kms : {},
    }
}

// ── 還原 ──────────────────────────────────────────────────────────────────

export interface RestoreResult {
    /** 成功寫入的文件數 */
    written: number
    /** 因 id / data 異常而略過的文件數 */
    skipped: number
}

/** Firestore 批次寫入上限為 500，保守取 400 */
const BATCH_SIZE = 400

function isValidBackupDoc(d: unknown): d is BackupDoc {
    if (!d || typeof d !== 'object') return false
    const doc = d as Partial<BackupDoc>
    return typeof doc.id === 'string'
        && doc.id.length > 0
        && !doc.id.includes('/')          // 防止寫入巢狀路徑
        && typeof doc.data === 'object'
        && doc.data !== null
        && !Array.isArray(doc.data)
}

/**
 * 將備份還原到「目前登入帳號」。
 * - 同 ID 覆蓋、無則新增；備份外的既有文件保留不動。
 * - 只寫入白名單 collection；異常文件略過並計數。
 * - 完成後自動清除 investData 共用快取。
 * - ⚠️ 跨批次非交易性：中途失敗時已寫入的批次不會回復（重跑一次即可補齊，冪等）。
 */
export async function restoreFullBackup(
    backup: FullBackup,
    onProgress?: (done: number, total: number) => void,
): Promise<RestoreResult> {
    interface Job { db: Firestore; col: string; docs: BackupDoc[] }
    const jobs: Job[] = []
    for (const col of INVEST_COLLECTIONS) {
        const docs = backup.invest[col]
        if (Array.isArray(docs) && docs.length > 0) jobs.push({ db: investDB, col, docs })
    }
    for (const col of KMS_COLLECTIONS) {
        const docs = backup.kms[col]
        if (Array.isArray(docs) && docs.length > 0) jobs.push({ db: kmsDB, col, docs })
    }

    const total = jobs.reduce((s, j) => s + j.docs.length, 0)
    let written = 0
    let skipped = 0

    for (const job of jobs) {
        for (let i = 0; i < job.docs.length; i += BATCH_SIZE) {
            const chunk = job.docs.slice(i, i + BATCH_SIZE)
            const batch = writeBatch(job.db)
            let inBatch = 0
            for (const d of chunk) {
                if (!isValidBackupDoc(d)) { skipped++; continue }
                batch.set(userDoc(job.db, job.col, d.id), d.data)
                inBatch++
            }
            if (inBatch > 0) await batch.commit()
            written += inBatch
            onProgress?.(written + skipped, total)
        }
    }

    // 還原大量寫入後，所有共用快取一律重抓
    invalidateAllInvestData()
    return { written, skipped }
}