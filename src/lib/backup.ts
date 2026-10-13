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
 *   完整台股字典）與 kmsDB 的 notes / trash / noteBodies / settings。
 * - 還原採「同 ID setDoc 覆蓋、無則新增」(upsert)：可重複執行（冪等），
 *   不會產生重複資料；備份中沒有的既有文件保留不動（非鏡像刪除）。
 * - 還原只寫入白名單內的 collection，並逐筆檢查 id 合法性（防止竄改過的
 *   備份檔寫入任意路徑）。
 * - 以 writeBatch 每 400 筆一批寫入（Firestore 上限 500），大量資料
 *   （如 stockDictFull）也能順利還原，並回報進度。
 * - ⚠️ 限制：KMS 筆記中的圖片存於 Firebase Storage，僅 URL 在備份內，
 *   圖片檔案本身不在備份範圍。
 */

import { getDocs, getDocsFromServer, writeBatch } from 'firebase/firestore'
import type { Firestore } from 'firebase/firestore'
import { investDB, kmsDB } from './firebase'
import { captureUserSession } from './userDB'
import { invalidateAllInvestData } from './investData'
import { analyzeDayTrades, type TradeRecord, type DividendRecord } from './calc'
import { commitLedgerRestore, type LedgerWrite } from './ledgerWrites'
import { assertNoNewOversells } from './ledgerIntegrity'
import { validateTradeForWrite, validateCashflowForWrite, validateDividendForWrite, validateSnapshotForWrite } from './investmentValidation'

// ── 格式定義 ───────────────────────────────────────────────────────────────

export const BACKUP_FORMAT = 'symbiosis-full-backup' as const
export const BACKUP_VERSION = 2

export interface BackupDoc {
    /** Firestore 文件 ID */
    id: string
    /** 文件原始內容（原樣存取，零失真） */
    data: Record<string, unknown>
}

export interface FullBackup {
    format: typeof BACKUP_FORMAT
    version: number
    media?: { binariesIncluded: false }
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
    'sentiments', 'watchlist', 'industryMap', 'industryRelations',
    'calendarEvents', 'calendarWatchList',
    'investorMeetingOverrides',
    'reconciliationReports',
    'tasks', 'taskProjects',
    'settings',
] as const

export const KMS_COLLECTIONS = ['notes', 'trash', 'noteBodies', 'noteImports', 'settings'] as const

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
    industryRelations: '產業脈絡關係',
    calendarEvents: '行事曆事件',
    calendarWatchList: '行事曆關注',
    investorMeetingOverrides: '個人法說會修正',
    reconciliationReports: '月結對帳紀錄',
    tasks: '任務',
    taskProjects: '任務專案',
    settings: '系統設定',
    notes: 'KMS 筆記',
    trash: 'KMS 回收桶',
    noteBodies: 'KMS 正文與附件引用',
    noteImports: 'KMS 匯入紀錄',
}

// ── 匯出 ──────────────────────────────────────────────────────────────────

async function dumpCollections(db: Firestore, names: readonly string[], session: ReturnType<typeof captureUserSession>): Promise<Record<string, BackupDoc[]>> {
    const result: Record<string, BackupDoc[]> = {}
    // 並行讀取所有 collection
    await Promise.all(names.map(async name => {
        const snap = await getDocs(session.col(db, name))
        result[name] = snap.docs.map(d => ({ id: d.id, data: d.data() as Record<string, unknown> }))
    }))
    return result
}

/** 讀取全系統資料，組成備份物件（不下載；下載請接著呼叫 downloadBackup） */
export async function buildFullBackup(): Promise<FullBackup> {
    const session = captureUserSession()
    const [invest, kms] = await Promise.all([
        dumpCollections(investDB, INVEST_COLLECTIONS, session),
        dumpCollections(kmsDB, KMS_COLLECTIONS, session),
    ])
    session.assertActive()
    return {
        media: { binariesIncluded: false },
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        uid: session.uid,
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
    if (!Number.isInteger(b.version) || typeof b.version !== 'number' || b.version < 1 || b.version > BACKUP_VERSION) {
        throw new Error(`備份版本（${String(b.version)}）不受目前系統支援（支援至 v${BACKUP_VERSION}）`)
    }
    if (!isDocArrayRecord(b.invest)) {
        throw new Error('備份內容缺少投資資料區段（invest）')
    }
    return {
        format: BACKUP_FORMAT,
        version: b.version,
        media: { binariesIncluded: false },
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

export interface RestoreCollectionDiff {
    key: string
    label: string
    added: number
    overwritten: number
    unchanged: number
    retained: number
    skipped: number
    repeated: number
}

export interface RestoreAmountDiff {
    label: string
    before: number | null
    after: number | null
    beforeDate?: string
    afterDate?: string
}

export interface RestorePreview {
    uid: string
    checkedAt: string
    collections: RestoreCollectionDiff[]
    amounts: RestoreAmountDiff[]
}

// Baselines stay in memory and are never rendered or persisted with credentials/settings.
const previewBaselines = new WeakMap<RestorePreview, {
    session: ReturnType<typeof captureUserSession>
    backup: string
    current: string
}>()

interface RestoreJob { db: Firestore; section: 'invest' | 'kms'; col: string; docs: BackupDoc[] }

function restoreJobs(backup: FullBackup): RestoreJob[] {
    const jobs: RestoreJob[] = []
    for (const [section, db, names] of [['invest', investDB, INVEST_COLLECTIONS], ['kms', kmsDB, KMS_COLLECTIONS]] as const) {
        for (const col of names) {
            const docs = backup[section][col]
            if (Array.isArray(docs) && docs.length) jobs.push({ db, section, col, docs })
        }
    }
    return jobs
}

/** Normalize JSON-compatible values, then compare objects without depending on key order. */
function comparable(value: unknown): string {
    const sort = (item: unknown): unknown => {
        if (Array.isArray(item)) return item.map(sort)
        if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, data]) => [key, sort(data)]))
        return item
    }
    return JSON.stringify(sort(JSON.parse(JSON.stringify(value))))
}

/** Same KMS reconstruction and validation for preview and actual restore. */
function prepareRestore(backup: FullBackup): FullBackup {
    // Check array shapes before attempting to iterate legacy bodies.
    for (const [section, names] of [[backup.invest, INVEST_COLLECTIONS], [backup.kms, KMS_COLLECTIONS]] as const) {
        for (const col of names) if (section[col] !== undefined && !Array.isArray(section[col])) throw new Error(`${COLLECTION_LABELS[col] || col} 必須是資料陣列`)
    }
    const bodies = new Map((backup.kms.noteBodies || []).filter(isValidBackupDoc).map(d => [d.id, d]))
    for (const col of ['notes', 'trash']) {
        for (const d of backup.kms[col] || []) {
            if (!isValidBackupDoc(d) || bodies.has(d.id)) continue
            if (!d.data.content && !d.data.contentDoc) throw new Error(`KMS 筆記 ${d.id} 缺少正文，已中止還原且尚未寫入。請使用包含 noteBodies 的新版備份。`)
            bodies.set(d.id, { id: d.id, data: {
                content: d.data.content || '',
                ...(d.data.contentDoc ? { contentDoc: d.data.contentDoc } : {}),
                assets: d.data.assets || [],
            } })
        }
    }
    const prepared = { ...backup, kms: { ...backup.kms, noteBodies: [...bodies.values()] } }
    validateRestoreAccounting(prepared)
    return prepared
}

type RestoreCurrent = Record<string, BackupDoc[]>

async function readRestoreCurrent(backup: FullBackup, session: ReturnType<typeof captureUserSession>): Promise<RestoreCurrent> {
    const jobs = restoreJobs(backup)
    // Ledger checks also need retained trades/dividends when only one is in the file.
    if (backup.invest.trades?.length || backup.invest.dividends?.length) {
        for (const col of ['trades', 'dividends']) if (!jobs.some(job => job.section === 'invest' && job.col === col)) jobs.push({ db: investDB, section: 'invest', col, docs: [] })
    }
    const entries = await Promise.all(jobs.map(async job => {
        const snap = await getDocsFromServer(session.col(job.db, job.col))
        session.assertActive()
        return [`${job.section}/${job.col}`, snap.docs.map(d => ({ id: d.id, data: d.data() as Record<string, unknown> })).sort((a, b) => a.id.localeCompare(b.id))] as const
    }))
    session.assertActive()
    return Object.fromEntries(entries)
}

function amountDiffs(col: string, before: BackupDoc[], after: BackupDoc[]): RestoreAmountDiff[] {
    const sum = (rows: BackupDoc[], field: string, type?: string): number | null => {
        let total = 0
        for (const row of rows) {
            if (type && row.data.type !== type) {
                if ((col === 'trades' && !['buy', 'sell'].includes(String(row.data.type))) || (col === 'cashflow' && !['in', 'out'].includes(String(row.data.type)))) return null
                continue
            }
            const amount = row.data[field]
            if (typeof amount !== 'number' || !Number.isFinite(amount)) return null
            total += amount
        }
        return Number.isFinite(total) ? total : null
    }
    const metrics: [string, string, string?][] = col === 'trades' ? [['買入付款合計', 'total', 'buy'], ['賣出收款合計', 'total', 'sell']]
        : col === 'cashflow' ? [['入金合計', 'amount', 'in'], ['出金合計', 'amount', 'out']]
        : col === 'dividends' ? [['現金股利紀錄合計', 'cashDividend', undefined]] : []
    if (col !== 'assetSnapshots') return metrics.map(([label, field, type]) => ({ label, before: sum(before, field, type), after: sum(after, field, type) }))
    const latest = (rows: BackupDoc[]) => {
        if (rows.some(row => typeof row.data.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.data.date))) return { amount: null }
        const row = [...rows].sort((a, b) => String(b.data.date).localeCompare(String(a.data.date)) || a.id.localeCompare(b.id))[0]
        return { amount: row && typeof row.data.totalAssets === 'number' && Number.isFinite(row.data.totalAssets) ? row.data.totalAssets : null, date: row?.data.date as string | undefined }
    }
    const old = latest(before), next = latest(after)
    return [{ label: '最新快照總資產', before: old.amount, after: next.amount, beforeDate: old.date, afterDate: next.date }]
}

/** Read-only: show the effective upsert result using current server data. */
export async function previewFullRestore(backup: FullBackup): Promise<RestorePreview> {
    const session = captureUserSession()
    const prepared = prepareRestore(backup)
    const current = await readRestoreCurrent(prepared, session)
    await validateRestoreLedger(prepared, session, current)
    const collections: RestoreCollectionDiff[] = [], amounts: RestoreAmountDiff[] = []
    for (const job of restoreJobs(prepared)) {
        const key = `${job.section}/${job.col}`, before = current[key]
        const existing = new Map(before.map(row => [row.id, row]))
        const valid = job.docs.filter(isValidBackupDoc), incoming = new Map(valid.map(row => [row.id, row]))
        const label = COLLECTION_LABELS[job.col] || job.col
        const diff: RestoreCollectionDiff = { key, label: `${job.section === 'kms' && !label.startsWith('KMS') ? 'KMS · ' : ''}${label}`,
            added: 0, overwritten: 0, unchanged: 0, retained: before.filter(row => !incoming.has(row.id)).length,
            skipped: job.docs.length - valid.length, repeated: valid.length - incoming.size }
        for (const [id, row] of incoming) {
            const old = existing.get(id)
            if (!old) diff.added++
            else if (comparable(old.data) === comparable(row.data)) diff.unchanged++
            else diff.overwritten++
            existing.set(id, row)
        }
        collections.push(diff)
        if (job.section === 'invest') amounts.push(...amountDiffs(job.col, before, [...existing.values()]))
    }
    session.assertActive()
    const preview: RestorePreview = { uid: session.uid, checkedAt: new Date().toISOString(), collections, amounts }
    previewBaselines.set(preview, { session, backup: comparable(prepared), current: comparable(current) })
    return preview
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

/** Validate every accounting row before creating even the first write batch. */
function validateRestoreAccounting(backup: FullBackup): void {
    for (const [section, collections] of [[backup.invest, INVEST_COLLECTIONS], [backup.kms, KMS_COLLECTIONS]] as const) {
        for (const col of collections) {
            if (section[col] !== undefined && !Array.isArray(section[col])) {
                throw new Error(`${COLLECTION_LABELS[col] || col} 必須是資料陣列`)
            }
        }
    }
    for (const col of ['trades', 'cashflow', 'dividends', 'assetSnapshots'] as const) {
        const ids = new Set<string>()
        for (const [index, row] of (backup.invest[col] || []).entries()) {
            const label = `${COLLECTION_LABELS[col]} 第 ${index + 1} 筆`
            if (!isValidBackupDoc(row)) throw new Error(`${label} 的文件 ID 或資料格式不正確`)
            if (ids.has(row.id)) throw new Error(`${label} 的文件 ID 重複（${row.id}）`)
            ids.add(row.id)
            try {
                // Old records may omit fee/tax; calculations have always treated those as zero.
                // Validate that interpretation without changing the saved historical payload.
                const data = { fee: 0, tax: 0, ...row.data }
                const validation = col === 'trades' ? validateTradeForWrite(data as unknown as TradeRecord)
                    : col === 'cashflow' ? validateCashflowForWrite(data as unknown as Parameters<typeof validateCashflowForWrite>[0])
                    : col === 'dividends' ? validateDividendForWrite(data as unknown as DividendRecord)
                    : validateSnapshotForWrite(data as unknown as Parameters<typeof validateSnapshotForWrite>[0])
                if (!validation.valid) throw new Error(validation.errors.join('；'))
            } catch (error) {
                throw new Error(`${label}（${row.id}）：${error instanceof Error ? error.message : '內容無效'}`)
            }
        }
    }
}

/** Check the upsert result, including documents that are absent from this backup. */
async function validateRestoreLedger(backup: FullBackup, session: ReturnType<typeof captureUserSession>, current?: RestoreCurrent): Promise<void> {
    if (!backup.invest.trades?.length && !backup.invest.dividends?.length) return
    const rows: RestoreCurrent = current || Object.fromEntries(await Promise.all(['trades', 'dividends'].map(async col => {
        const snap = await getDocsFromServer(session.col(investDB, col))
        return [`invest/${col}`, snap.docs.map(d => ({ id: d.id, data: d.data() as Record<string, unknown> }))]
    })))
    session.assertActive()
    const before = {
        trades: rows['invest/trades'].map(d => ({ ...d.data, id: d.id }) as TradeRecord),
        dividends: rows['invest/dividends'].map(d => ({ ...d.data, id: d.id }) as DividendRecord),
    }
    const merge = <T extends { id?: string }>(current: T[], incoming: BackupDoc[]): T[] => {
        const rows = new Map(current.map(row => [row.id, row]))
        for (const row of incoming) rows.set(row.id, { ...row.data, id: row.id } as T)
        return [...rows.values()]
    }
    const after = {
        trades: merge(before.trades, backup.invest.trades || []),
        dividends: merge(before.dividends, backup.invest.dividends || []),
    }
    assertNoNewOversells(before, after)
    const previousIssues = new Set(analyzeDayTrades(before.trades, false).issues.map(issue => issue.trade.id))
    const invalid = analyzeDayTrades(after.trades, false).issues.find(issue => !previousIssues.has(issue.trade.id))
    if (invalid) throw new Error(`${invalid.trade.date} ${invalid.trade.code}：${invalid.message}`)
}

/**
 * 將備份還原到「目前登入帳號」。
 * - 同 ID 覆蓋、無則新增；備份外的既有文件保留不動。
 * - 全份帳務先檢查格式、金額與合併後股數／配對；失敗時尚未寫入。
 * - 只寫入白名單 collection；非帳務異常文件略過並計數。
 * - 完成後自動清除 investData 共用快取。
 * - ⚠️ 跨批次非交易性：中途失敗時已寫入的批次不會回復（重跑一次即可補齊，冪等）。
 * - 交易與股利共用帳本版本交易，分批前檢查每個中間狀態，並在提交時重新驗證庫存。
 * - 傳入差異預覽時，寫入前重查帳號、檔案與相關集合；變更即中止。
 */
export async function restoreFullBackup(
    backup: FullBackup,
    onProgress?: (done: number, total: number) => void,
    preview?: RestorePreview,
): Promise<RestoreResult> {
    const session = captureUserSession()
    try {
        backup = prepareRestore(backup)
        let current: RestoreCurrent | undefined
        if (preview) {
            const baseline = previewBaselines.get(preview)
            if (!baseline) throw new Error('預覽已失效，請重新選擇備份檔產生差異預覽')
            baseline.session.assertActive()
            if (preview.uid !== session.uid || baseline.backup !== comparable(backup)) throw new Error('帳號或備份已變更，請重新選擇備份檔產生差異預覽')
            current = await readRestoreCurrent(backup, session)
            if (baseline.current !== comparable(current)) throw new Error('雲端資料已變更，請重新選擇備份檔產生差異預覽')
        }
        await validateRestoreLedger(backup, session, current)
        session.assertActive()
    } catch (error) {
        throw new Error(`還原前檢查未通過，尚未寫入任何資料：${error instanceof Error ? error.message : '請確認備份內容後重試'}`)
    }
    const jobs = restoreJobs(backup)

    const total = jobs.reduce((s, j) => s + j.docs.length, 0)
    let written = 0
    let skipped = 0

    const ledgerWrites: LedgerWrite[] = jobs.filter(job => job.db === investDB && (job.col === 'trades' || job.col === 'dividends'))
        .flatMap(job => job.docs.map(d => ({ collection: job.col as 'trades' | 'dividends', id: d.id, data: d.data, mode: 'upsert' as const })))
    if (ledgerWrites.length) await commitLedgerRestore(ledgerWrites, session, count => { written += count; onProgress?.(written + skipped, total) })
    for (const job of jobs) {
        if (job.db === investDB && (job.col === 'trades' || job.col === 'dividends')) continue
        for (let i = 0; i < job.docs.length; i += BATCH_SIZE) {
            session.assertActive()
            const chunk = job.docs.slice(i, i + BATCH_SIZE)
            const batch = writeBatch(job.db)
            let inBatch = 0
            for (const d of chunk) {
                if (!isValidBackupDoc(d)) { skipped++; continue }
                batch.set(session.doc(job.db, job.col, d.id), d.data)
                inBatch++
            }
            session.assertActive()
            if (inBatch > 0) await batch.commit()
            session.assertActive()
            written += inBatch
            onProgress?.(written + skipped, total)
        }
    }

    // 還原大量寫入後，所有共用快取一律重抓
    invalidateAllInvestData()
    return { written, skipped }
}
