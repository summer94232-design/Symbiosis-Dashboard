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
 * 2. 今日已有快照（手動或自動）→ 不覆蓋、不動作。
 * 3. lastPrices._updatedAt 必須是「今天」更新的，避免用昨日收盤價寫出誤導快照。
 * 4. 任何持股缺現價 → 跳過（手動儲存允許以成本替代並顯示警告，自動模式不允許）。
 * 5. 空帳戶（無市值、無現金、無借款）→ 跳過。
 *
 * 計算口徑與 AssetTrend 手動「儲存今日快照」完全一致：
 * calcMarketValue 由本模組匯出、AssetTrend 改為引用，兩邊共用同一份程式碼；
 * cash 採方案 A（含現金股利）、totalAssets 已扣融資借款、dividendAdjusted: true。
 */

import { getDoc, setDoc } from 'firebase/firestore'
import { investDB } from './firebase'
import { userDoc, userDocNested } from './userDB'
import { calcPositions, calcAvailableCash, aggregateMarginDebt, type TradeRecord, type DividendRecord } from './calc'
import { fetchTrades, fetchDividends, fetchCashflow } from './investData'
import { toLocalDateString } from './date'

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
}

/**
 * 讀取資料並計算「今日快照」內容（不寫入）。
 * 與 AssetTrend.saveToday 的計算完全同口徑。
 */
export async function buildTodaySnapshot(): Promise<{ snapshot: SnapshotData; missing: string[] }> {
    const [trades, dividends, cashRecords] = await Promise.all([
        fetchTrades<TradeRecord>('asc'),
        fetchDividends<DividendRecord>('asc'),
        fetchCashflow<{ type: string; amount: number }>('asc'),
    ])
    const { holdings: positions } = calcPositions(trades, dividends)

    const priceDoc = await getDoc(userDocNested(investDB, 'settings', 'lastPrices'))
    const savedPrices = (priceDoc.exists() ? priceDoc.data() : {}) as Record<string, number>

    const { marketValue, missing } = calcMarketValue(positions, savedPrices)
    // ✅ 方案 A：可用現金含現金股利（全系統口徑）
    const cash = calcAvailableCash(cashRecords, trades, dividends)
    // ✅ 扣除融資借款，呈現真實淨值
    const marginDebt = aggregateMarginDebt(trades)
    const today = toLocalDateString()

    return {
        snapshot: {
            date: today,
            totalAssets: Math.round(marketValue + cash - marginDebt),
            marketValue: Math.round(marketValue),
            cash: Math.round(cash),
            marginDebt: Math.round(marginDebt),
            dividendAdjusted: true,
        },
        missing,
    }
}

// ── 自動每日快照 ──────────────────────────────────────────────────────────

/**
 * 判斷 lastPrices._updatedAt 是否為「今天」。
 * PriceContext 以 toLocaleString('zh-TW') 寫入（如「2026/6/11 下午2:30:05」），
 * 不能用字串前綴比對（6/1 會誤配 6/11），需以正則取出年月日逐項比對；
 * 同時相容 ISO 等可被 Date.parse 解析的格式。
 */
function isPriceUpdatedToday(updatedAt: unknown): boolean {
    if (typeof updatedAt !== 'string' || updatedAt === '') return false
    const now = new Date()
    const m = updatedAt.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/)
    if (m) {
        return parseInt(m[1], 10) === now.getFullYear()
            && parseInt(m[2], 10) === now.getMonth() + 1
            && parseInt(m[3], 10) === now.getDate()
    }
    const t = Date.parse(updatedAt)
    if (Number.isNaN(t)) return false
    const d = new Date(t)
    return d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate()
}

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

/** 同一個分頁 session 中，今日快照已確認存在（寫入成功或 DB 已有）就不再查 DB（非覆寫模式用） */
let coveredDate = ''
/** 上次自動寫入完成的時間戳（覆寫模式的節流基準） */
let lastAutoWriteTs = 0
/** 防重入：一次寫入進行中時，後到的觸發直接略過（例如 PriceContext 與頁面幾乎同時觸發） */
let autoSnapInFlight = false
/** 覆寫模式的最小寫入間隔：避免短時間內連續更新現價造成重複讀算寫 */
const AUTO_WRITE_MIN_INTERVAL_MS = 60_000

/** 自動快照運作時段：系統時間 08:00（含）～ 22:00（不含） */
function isWithinAutoWindow(now: Date = new Date()): boolean {
    const h = now.getHours()
    return h >= 8 && h < 22
}

/**
 * 嘗試寫入今日自動快照。設計為 fire-and-forget：
 * 永不拋出例外、所有失敗只記 console，呼叫端不需要 await 或 try/catch。
 *
 * 兩種模式：
 * - 預設（overwrite 未傳或 false）：今日已有快照就不動作。
 *   觸發點：Dashboard 核心資料載入完成後（確保每天至少有一筆）。
 * - overwrite: true：覆寫今日快照為最新計算值（doc id = 日期，覆寫不會增生文件）。
 *   觸發點：PriceContext.updatePrices 每次成功更新現價後。
 *   內建 60 秒節流＋防重入，短時間內多頁連續更新現價只會寫一次。
 *
 * 兩種模式都只在 08:00–22:00（系統時間）運作；
 * 該時段內 toISOString 的 UTC 日期與台灣本地日期必然一致，不會跨日錯置。
 *
 * 診斷：每次執行都會在 console 留下一行 [autoSnapshot] 狀態與原因，
 * 排查「為什麼沒寫入」時打開 DevTools Console 按一次「更新現價」即可看到。
 */
export async function maybeAutoSnapshotToday(options?: { overwrite?: boolean }): Promise<AutoSnapshotStatus> {
    const overwrite = options?.overwrite === true
    const today = toLocalDateString()
    const mode = overwrite ? '覆寫模式' : '補寫模式'
    const skip = (status: AutoSnapshotStatus, reason: string): AutoSnapshotStatus => {
        console.info(`[autoSnapshot] ${mode}略過（${status}）：${reason}`)
        return status
    }
    try {
        // 0. 運作時段檢查（零讀取）
        if (!isWithinAutoWindow()) {
            return skip('outside-window', `現在 ${new Date().getHours()} 點，僅 08:00–22:00 運作`)
        }

        // 1. 防重入 + 節流（零讀取）
        if (autoSnapInFlight) return skip('throttled', '另一次寫入正在進行')
        if (overwrite) {
            const since = Date.now() - lastAutoWriteTs
            if (since < AUTO_WRITE_MIN_INTERVAL_MS) {
                return skip('throttled', `距上次寫入僅 ${Math.round(since / 1000)} 秒（節流 60 秒）`)
            }
        } else {
            // 非覆寫模式：今日已有快照（手動或先前自動）→ 不覆蓋
            if (coveredDate === today) return skip('already-covered', '本 session 已確認今日有快照')
            const existing = await getDoc(userDoc(investDB, 'assetSnapshots', today))
            if (existing.exists()) {
                coveredDate = today
                return skip('already-covered', 'DB 已有今日快照（補寫模式不覆蓋；現價更新會走覆寫模式刷新）')
            }
        }

        autoSnapInFlight = true
        try {
            // 2. 設定開關（預設開啟；僅 enabled === false 視為關閉）
            const cfgDoc = await getDoc(userDocNested(investDB, 'settings', 'autoSnapshot'))
            if (cfgDoc.exists() && cfgDoc.data().enabled === false) {
                return skip('disabled', '自動快照已在資產趨勢頁關閉（settings/autoSnapshot.enabled = false）')
            }

            // 3. 現價必須是今天更新的（覆寫模式由 updatePrices 觸發，必然剛更新完）
            const priceDoc = await getDoc(userDocNested(investDB, 'settings', 'lastPrices'))
            const updatedAt = priceDoc.exists() ? (priceDoc.data() as Record<string, unknown>)._updatedAt : undefined
            if (!isPriceUpdatedToday(updatedAt)) {
                return skip('stale-prices', `lastPrices._updatedAt 不是今天（目前值：${String(updatedAt)}）`)
            }

            // 4. 計算（資料走 investData 共用快取，幾乎零額外讀取）
            const { snapshot, missing } = await buildTodaySnapshot()
            if (missing.length > 0) {
                return skip('missing-prices', `以下持股缺現價：${missing.join('、')}（每次都會被擋，請確認這些代號 Fugle 抓得到價）`)
            }
            if (snapshot.marketValue === 0 && snapshot.cash === 0 && snapshot.marginDebt === 0) {
                return skip('empty', '空帳戶（無市值、無現金、無借款）')
            }

            // 5. 寫入（doc id = 日期；覆寫模式會以最新值更新今日快照，口徑與手動完全一致）
            await setDoc(userDoc(investDB, 'assetSnapshots', today), { ...snapshot, auto: true })
            coveredDate = today
            lastAutoWriteTs = Date.now()
            console.info(`[autoSnapshot] ${mode}已${overwrite ? '更新' : '寫入'}今日快照（${today}）`, snapshot)
            return 'written'
        } finally {
            autoSnapInFlight = false
        }
    } catch (err) {
        console.error('[autoSnapshot] failed:', err)
        return 'error'   // 不標記 coveredDate / lastAutoWriteTs，下次觸發會再試
    }
}
