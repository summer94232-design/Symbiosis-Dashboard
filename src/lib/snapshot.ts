/**
 * snapshot.ts — 資產快照共用邏輯與自動每日快照（優化建議書 5-1 前端版）
 *
 * 放置位置：src/lib/snapshot.ts
 *
 * 背景：資產趨勢原本只靠手動「儲存今日快照」，忘記按資料就斷線。
 * 建議書原提案為後端排程（GitHub Actions / Netlify Scheduled Function），
 * 但該方案需要 Firebase Admin 服務帳號與 Fugle key 上後端，與 4-1 綁定。
 * 本模組先落地「前端自動快照」：使用者當天首次開啟儀表板、或更新現價後，
 * 自動寫入當日快照。日後做 4-1 時可無痛升級為後端排程（同一份資料格式，
 * 以 date 為文件 ID，天然去重）。
 *
 * 自動快照的保守規則（寧缺勿錯，不污染趨勢資料）：
 * 1. settings/autoSnapshot.enabled 為 false 時不動作（預設開啟）。
 * 2. 背景已有今日快照時不重複寫入；明確更新現價可覆寫當日紀錄。
 * 3. 每檔持股必須成功取得當日有效報價，不要求最終收盤訊號。
 * 4. 任何持股缺現價 → 跳過；「儲存今日快照」亦採相同規則。
 * 5. 空帳戶（無市值、無現金、無借款）→ 跳過；僅現金帳戶可記錄當日數值。
 * 6. 保留原有來源品質資料，不把一般趨勢快照冒充已確認收盤。
 *
 * 計算口徑與 AssetTrend 手動「儲存今日快照」完全一致：
 * buildPortfolioSnapshot 與 buildTodaySnapshot 統一日期、現金及報價驗證；
 * cash 採方案 A（含現金股利）、totalAssets 已扣融資借款、dividendAdjusted: true。
 */

import { getDoc, getDocFromServer, runTransaction } from 'firebase/firestore'
import { investDB } from './firebase'
import { captureUserSession } from './userDB'
import type { TradeRecord, DividendRecord } from './calc'
import { buildPortfolioSnapshot, type CashflowRecord } from './portfolioSnapshot'
import { fetchTrades, fetchDividends, fetchCashflow, invalidateAssetSnapshots } from './investData'
import { toLocalDateString } from './date'
import { canRunAutoSnapshot, type AutoSnapshotTrigger } from './snapshotPolicy'
import { validateSnapshotForWrite } from './investmentValidation'
import { describeSnapshotPriceIssues, stalePriceCodes, type SavedPrices } from './pricePolicy'

interface SnapshotQuoteGuard { requestedAt: string; holdingPrices: Record<string, number> }

/** One daily record; foreground refreshes replace it, background captures preserve it. */
export async function saveValuationSnapshot(snapshot: SnapshotData & { auto?: boolean }, session = captureUserSession(), overwrite = true,
    guard?: SnapshotQuoteGuard): Promise<boolean> {
    session.assertActive()
    return runTransaction(investDB, async transaction => {
        const ref = session.doc(investDB, 'assetSnapshots', snapshot.date)
        const existing = await transaction.get(ref)
        if (guard) {
            const prices = await transaction.get(session.doc(investDB, 'settings', 'lastPrices'))
            const saved = prices.data() as SavedPrices | undefined
            if (!saved || saved._refresh?.requestedAt !== guard.requestedAt
                || stalePriceCodes(Object.keys(guard.holdingPrices), saved, snapshot.date).length
                || Object.entries(guard.holdingPrices).some(([code, price]) => saved[code] !== price)) {
                throw new Error('持股報價仍在更新，今日快照未儲存，請待更新完成後再試。')
            }
        }
        session.assertActive()
        if (existing.exists() && !overwrite) return false
        transaction.set(ref, snapshot)
        return true
    })
}

// ── 共用市值計算（原 AssetTrend 內部函式抽出）──────────────────────────────

/**
 * 以快取現價計算持倉總市值。
 * 缺價的持股以成本計入並回報於 missing（與 AssetTrend 手動流程行為一致；
 * 自動快照看到 missing 非空會直接跳過，不會用成本混入趨勢資料）。
 */
export function calcMarketValue(
    positions: Record<string, { code: string; shares: number; totalCost: number }>,
    savedPrices: Record<string, number>
): { marketValue: number; missing: string[] } {
    let marketValue = 0
    const missing: string[] = []
    Object.values(positions).forEach(pos => {
        // ✅ 修正：跳過已平倉（shares <= 0）的部位。
        // calcPositions 對「全部賣出」的股票會保留 shares=0、totalCost=0 的紀錄，
        // 而這些代號不會出現在 lastPrices（各頁只抓現有持股的現價），
        // 原寫法會把它們誤判為「持股缺現價」，導致自動快照永遠被 missing-prices 擋下。
        // 已平倉部位對市值的貢獻本來就是 0（totalCost 已歸零），跳過不影響任何數字。
        if (pos.shares <= 0) return
        const price = savedPrices[pos.code]
        if (price !== undefined && price > 0) {
            marketValue += price * pos.shares
        } else {
            marketValue += pos.totalCost
            missing.push(pos.code)
        }
    })
    return { marketValue, missing }
}

// ── 快照資料 ──────────────────────────────────────────────────────────────

export interface SnapshotData {
    date: string
    totalAssets: number
    marketValue: number
    cash: number
    marginDebt: number
    /** 新口徑快照（cash 已含股利），與 AssetTrend 一致 */
    dividendAdjusted: true
    /** 由自動快照寫入時為 true（手動儲存無此欄位） */
    auto?: boolean
    cashflowBasis?: 'after-close-v1'
    cashflowNetAtCapture?: number
    valuationQuality?: 'closing' | 'intraday' | 'manual-unverified'
    valuationAt?: string
}

/**
 * 讀取資料並計算「今日快照」內容（不寫入）。
 * 與 AssetTrend.saveToday 的計算完全同口徑。
 */
export async function buildTodaySnapshot(): Promise<{ snapshot: SnapshotData; missing: string[]; stale: string[]; staleReason: string; guard?: SnapshotQuoteGuard }> {
    const session = captureUserSession()
    const priceRef = session.doc(investDB, 'settings', 'lastPrices')
    const today = toLocalDateString()
    const [trades, dividends, cashflow, priceDoc] = await Promise.all([
        fetchTrades<TradeRecord>('asc'), fetchDividends<DividendRecord>('asc'),
        fetchCashflow<CashflowRecord>('asc'), getDocFromServer(priceRef),
    ])
    session.assertActive()
    const savedPrices: SavedPrices = priceDoc.exists() ? priceDoc.data() : {}
    const portfolio = buildPortfolioSnapshot({ trades, dividends, cashflow, savedPrices, asOf: today })
    const closing = portfolio.holdings.length > 0
        && !portfolio.missingPriceCodes.length && !portfolio.stalePriceCodes.length
        && portfolio.holdings.every(h => portfolio.savedPriceData._quotes?.[h.code]?.priceType === 'trade'
            && portfolio.savedPriceData._quotes?.[h.code]?.isFinalClose === true)
    if (portfolio.cashflow.some(row => !['in', 'out'].includes(row.type) || !Number.isFinite(row.amount) || row.amount < 0)) throw new Error('出入金資料無效，無法保存快照基準')
    return {
        snapshot: { date: today, totalAssets: Math.round(portfolio.netAssets),
            valuationAt: new Date().toISOString(), valuationQuality: closing ? 'closing' : 'intraday',
            marketValue: Math.round(portfolio.marketValue), cash: Math.round(portfolio.cash),
            marginDebt: Math.round(portfolio.marginDebt), dividendAdjusted: true,
            cashflowBasis: 'after-close-v1',
            cashflowNetAtCapture: portfolio.cashflow.reduce((sum, row) => sum + (row.type === 'in' ? row.amount : -row.amount), 0) },
        missing: portfolio.missingPriceCodes, stale: portfolio.stalePriceCodes,
        staleReason: portfolio.stalePriceCodes.length ? describeSnapshotPriceIssues(portfolio.stalePriceCodes, savedPrices, today) : '',
        ...(savedPrices._refresh ? { guard: { requestedAt: savedPrices._refresh.requestedAt,
            holdingPrices: Object.fromEntries(portfolio.holdings.map(h => [h.code, savedPrices[h.code] as number])) } } : {}),
    }
}

// ── 自動每日快照 ──────────────────────────────────────────────────────────

export type AutoSnapshotStatus =
    | 'written'          // 已寫入今日快照
    | 'already-covered'  // 今日已有快照（僅非覆寫模式：session 已確認過或 DB 已存在）
    | 'outside-window'   // 不在自動快照運作時段（08:00–22:00 系統時間）
    | 'throttled'        // 距上次自動寫入未滿節流間隔，或另一次寫入正在進行
    | 'disabled'         // 使用者關閉自動快照
    | 'stale-prices'     // 現價不是今天更新的
    | 'missing-prices'   // 有持股缺現價
    | 'empty'            // 空帳戶
    | 'error'            // 過程出錯（已記 console，不影響頁面）

export interface AutoSnapshotResult {
    status: AutoSnapshotStatus
    date: string
    reason: string
    missing?: string[]
}

export function formatAutoSnapshotFeedback(result: AutoSnapshotResult): {
    type: 'success' | 'info' | 'error'
    message: string
} {
    switch (result.status) {
        case 'written':
            return { type: 'success', message: `${result.date} 資產快照已更新。` }
        case 'already-covered':
            return { type: 'success', message: `${result.date} 資產快照已存在。` }
        case 'throttled':
            return { type: 'info', message: '今日快照剛更新過，本次不重複寫入。' }
        case 'disabled':
            return { type: 'info', message: '自動快照目前為關閉，未儲存快照。' }
        case 'missing-prices':
            return {
                type: 'info',
                message: `${result.missing?.join('、') || '部分持股'} 缺少有效現價，快照未儲存。`,
            }
        case 'empty':
            return { type: 'info', message: '帳戶目前沒有可記錄的資產，快照未儲存。' }
        case 'outside-window':
            return { type: 'info', message: '目前不在背景快照時段，快照未儲存。' }
        case 'stale-prices':
            return { type: 'info', message: `快照未儲存：${result.reason || '部分持股尚未取得今日有效成交價'}。` }
        case 'error':
            return { type: 'error', message: `快照更新失敗：${result.reason}` }
    }
}

// State is isolated by account and date; existence is rechecked to allow deleted snapshots to be rebuilt.
const autoSnapshotStates = new Map<string, { lastWriteTs: number; inFlight: boolean }>()
/** 覆寫模式的最小寫入間隔：避免短時間內連續更新現價造成重複讀算寫 */
const AUTO_WRITE_MIN_INTERVAL_MS = 60_000

/**
 * 嘗試寫入今日自動快照。永不拋出例外，並回傳可供介面顯示的結果。
 *
 * 兩種模式：
 * - 預設（overwrite 未傳或 false）：今日已有快照就不動作。
 *   觸發點：Dashboard 核心資料載入完成後（確保每天至少有一筆）。
 * - overwrite: true：覆寫今日快照為最新計算值（doc id = 日期，覆寫不會增生文件）。
 *   觸發點：PriceContext.updatePrices 每次成功更新現價後。
 *   內建 60 秒節流＋防重入，短時間內多頁連續更新現價只會寫一次。
 *
 * 背景補寫只在 08:00–22:00（裝置本地時間）運作；使用者明確更新現價
 * 時不受時段限制，仍使用 toLocalDateString 寫入裝置本地日期。
 *
 * 診斷：每次執行都會在 console 留下一行 [autoSnapshot] 狀態與原因，
 * 排查「為什麼沒寫入」時打開 DevTools Console 按一次「更新現價」即可看到。
 */
export async function maybeAutoSnapshotToday(options?: {
    overwrite?: boolean
    trigger?: AutoSnapshotTrigger
}): Promise<AutoSnapshotResult> {
    const overwrite = options?.overwrite === true
    const trigger = options?.trigger ?? 'background'
    const today = toLocalDateString()
    const mode = overwrite ? '覆寫模式' : '補寫模式'
    const skip = (status: AutoSnapshotStatus, reason: string, missing?: string[]): AutoSnapshotResult => {
        console.info(`[autoSnapshot] ${mode}略過（${status}）：${reason}`)
        return { status, date: today, reason, ...(missing?.length ? { missing } : {}) }
    }
    try {
        const session = captureUserSession()
        // 0. 運作時段檢查（零讀取）
        if (!canRunAutoSnapshot(trigger)) {
            return skip('outside-window', `現在 ${new Date().getHours()} 點，背景快照僅 08:00–22:00 運作`)
        }

        const stateKey = JSON.stringify([session.uid, today])
        let state = autoSnapshotStates.get(stateKey)
        if (!state) {
            state = { lastWriteTs: 0, inFlight: false }
            autoSnapshotStates.set(stateKey, state)
        }
        // Lock before the first await so simultaneous existence checks cannot both write.
        if (state.inFlight) return skip('throttled', '另一次寫入正在進行')
        if (overwrite) {
            const since = Date.now() - state.lastWriteTs
            if (since < AUTO_WRITE_MIN_INTERVAL_MS) {
                return skip('throttled', `距上次寫入僅 ${Math.round(since / 1000)} 秒（節流 60 秒）`)
            }
        }
        state.inFlight = true
        try {
            if (!overwrite) {
                const existing = await getDoc(session.doc(investDB, 'assetSnapshots', today))
                session.assertActive()
                if (existing.exists()) return skip('already-covered', 'DB 已有今日快照')
            }
            // 2. 設定開關（預設開啟；僅 enabled === false 視為關閉）
            const cfgDoc = await getDoc(session.doc(investDB, 'settings', 'autoSnapshot'))
            if (cfgDoc.exists() && cfgDoc.data().enabled === false) {
                return skip('disabled', '自動快照已在資產趨勢頁關閉（settings/autoSnapshot.enabled = false）')
            }

            // Compute and validate against one server price document; never an unrelated table timestamp.
            session.assertActive()
            const { snapshot, missing, stale, staleReason, guard } = await buildTodaySnapshot()
            session.assertActive()
            if (snapshot.date !== today) return skip('error', '日期已跨日，請重新更新現價')
            if (missing.length > 0) {
                return skip(
                    'missing-prices',
                    `以下持股缺現價：${missing.join('、')}（每次都會被擋，請確認這些代號 Fugle 抓得到價）`,
                    missing,
                )
            }
            if (stale.length > 0) return skip('stale-prices', staleReason, stale)
            if (snapshot.marketValue === 0 && snapshot.cash === 0 && snapshot.marginDebt === 0) {
                return skip('empty', '空帳戶（無市值、無現金、無借款）')
            }

            // 5. 寫入（doc id = 日期；覆寫模式會以最新值更新今日快照，口徑與手動完全一致）
            const validation = validateSnapshotForWrite(snapshot)
            if (!validation.valid) throw new Error(`快照資料驗證失敗：${validation.errors.join('；')}`)
            session.assertActive()
            const written = await saveValuationSnapshot({ ...snapshot, auto: true }, session, overwrite, guard)
            if (!written) return skip('already-covered', 'DB 已有今日快照')
            invalidateAssetSnapshots()
            session.assertActive()
            state.lastWriteTs = Date.now()
            console.info(`[autoSnapshot] ${mode}已${overwrite ? '更新' : '寫入'}今日快照（${today}）`, snapshot)
            return { status: 'written', date: today, reason: overwrite ? '今日快照已更新' : '今日快照已寫入' }
        } finally {
            state.inFlight = false
        }
    } catch (err) {
        console.error('[autoSnapshot] failed:', err)
        return {
            status: 'error',
            date: today,
            reason: err instanceof Error ? err.message : '未知錯誤',
        }
    }
}
