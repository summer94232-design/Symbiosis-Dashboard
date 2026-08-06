export const FEE_RATE = 0.001425
export const FEE_DISCOUNT = 0.6  // 6折
export const MIN_FEE = 20        // 整股最低手續費
export const MIN_FEE_ODD = 1     // 零股最低手續費
export const TAX_RATE_STOCK = 0.003
export const TAX_RATE_ETF = 0.001

export const isETF = (code: string) => code.replace('.TW', '').startsWith('00')

// 計算手續費（6折，無條件捨去）
// - 整股（shares >= 1000）：最低 20 元
// - 零股（shares < 1000）：最低 1 元
export function calcFee(price: number, shares: number): number {
    const amount = price * shares
    const fee = Math.floor(amount * FEE_RATE * FEE_DISCOUNT)
    const minFee = shares < 1000 ? MIN_FEE_ODD : MIN_FEE
    return Math.max(fee, minFee)
}

// 計算交易稅（賣出才有）
export function calcTax(price: number, shares: number, code: string): number {
    const amount = price * shares
    const rate = isETF(code) ? TAX_RATE_ETF : TAX_RATE_STOCK
    return Math.floor(amount * rate)
}

/**
 * 計算融資借款金額（無條件捨去至千元整數）
 * 券商實際撥款以千元為單位，多出的部分算入自備款
 */
export function calcMarginDebt(totalPrice: number, marginRatio: number): number {
    return Math.floor(totalPrice * marginRatio / 1000) * 1000
}

/**
 * 計算單筆交易的「收付金額」(total) ── 唯一真實來源。
 * 買賣紀錄表單、CSV 匯入都應呼叫此函式，避免各自實作而漂移。
 *
 *   現股買入：股票總價 + 手續費
 *   融資買入：自備款 + 手續費（= 股票總價 − 融資借款 + 手續費，借款由券商撥付不佔現金）
 *   現股賣出：股票總價 − 手續費 − 交易稅
 *   融資賣出：股票總價 − 手續費 − 交易稅 − 償還融資借款(本金＋利息)
 *             ⚠️ 償還金額含利息、且原始借款已捨去至千元，系統無法自動推算，
 *                故由 marginRepay 帶入（使用者依券商對帳單輸入）。
 */
export function calcTradeTotal(t: {
    type: 'buy' | 'sell'
    price: number
    shares: number
    fee?: number
    tax?: number
    isMargin?: boolean
    marginRatio?: number
    marginRepay?: number
}): number {
    const gross = (t.price || 0) * (t.shares || 0)
    const fee = t.fee || 0
    const tax = t.tax || 0
    if (t.type === 'buy') {
        if (t.isMargin) {
            // marginRatio 為 0 視同未設定（0 成數無意義；舊 CSV 匯入會把非融資交易存成 0），一律 fallback 0.6
            const debt = calcMarginDebt(gross, t.marginRatio || 0.6)
            return gross - debt + fee
        }
        return gross + fee
    }
    // 賣出
    if (t.isMargin) {
        return gross - fee - tax - (t.marginRepay ?? 0)
    }
    return gross - fee - tax
}

/**
 * 未實現損益率（%）——融資部位用「自備款」為分母，現股用全額成本。
 * （優化建議書 1-2：原本被複製在 Dashboard 與 Holdings 兩處，上移至此共用）
 * @param unrealizedPnL 未實現損益
 * @param totalCost     持倉全額成本（含手續費）
 * @param marginAmount  融資借款金額（0 = 現股）
 */
export function calcReturnRate(unrealizedPnL: number, totalCost: number, marginAmount: number): number {
    const equity = totalCost - marginAmount  // 自備款 = 全額成本 - 融資借款
    const denominator = marginAmount > 0 ? equity : totalCost
    return denominator > 0 ? (unrealizedPnL / denominator) * 100 : 0
}

export interface TradeRecord {
    id?: string
    date: string
    type: 'buy' | 'sell'
    code: string
    name: string
    price: number
    shares: number
    fee: number
    tax: number
    total: number          // 收付金額。買入=自備款+手續費；賣出=扣除歸還借款後的淨入帳金額
    note?: string
    isMargin?: boolean     // 是否為融資交易
    marginRatio?: number   // 融資成數（例：0.6）
    marginAmount?: number  // 融資借款金額（買入時）
    marginRepay?: number   // 融資賣出時償還的借款（本金＋利息，依券商對帳單）
    /** 同日交易排序時間；新資料一律寫入，舊資料沒有時退回 sequence / id */
    createdAt?: string
    /** CSV 等批次來源可提供的穩定原始順序 */
    sequence?: number
}

export interface DividendRecord {
    id?: string
    date: string
    code: string
    name: string
    cashDividend: number
    stockDividend: number
    note?: string
}

export interface HoldingPosition {
    code: string
    name: string
    shares: number
    avgCost: number
    totalCost: number
    marginAmount?: number  // 累計融資借款金額（用於計算自備款損益率）
}

export interface RealizedRecord {
    date: string
    code: string
    name: string
    shares: number
    avgCost: number
    sellPrice: number
    realized: number
    returnRate: number
}

export interface CalcResult {
    holdings: Record<string, HoldingPosition>
    realized: RealizedRecord[]
}

// 內部事件型別：把買賣交易與配股統一成「時間軸事件」一起依日期處理
type TimelineEvent =
    | { kind: 'trade'; date: string; trade: TradeRecord }
    | { kind: 'stockdiv'; date: string; div: DividendRecord }

/**
 * 交易的唯一穩定排序規則。
 *
 * Firestore 只 orderBy(date) 時，同一天文件的先後不應拿來決定財務結果；
 * 新資料以 createdAt / sequence 保存真實輸入順序，舊資料則以文件 ID 固定結果。
 * 完全相同時回傳 0，交由 ES stable sort 保留原始陣列順序。
 */
export function compareTradeRecords(a: TradeRecord, b: TradeRecord): number {
    const dateOrder = (a.date || '').localeCompare(b.date || '')
    if (dateOrder !== 0) return dateOrder

    const timeA = a.createdAt || ''
    const timeB = b.createdAt || ''
    if (timeA || timeB) {
        const timeOrder = timeA.localeCompare(timeB)
        if (timeOrder !== 0) return timeOrder
    }

    const sequenceA = Number.isFinite(a.sequence) ? a.sequence! : Number.MAX_SAFE_INTEGER
    const sequenceB = Number.isFinite(b.sequence) ? b.sequence! : Number.MAX_SAFE_INTEGER
    if (sequenceA !== sequenceB) return sequenceA - sequenceB

    return (a.id || '').localeCompare(b.id || '')
}

/** 計算某筆賣出「發生當下」可用的持股數，供表單與匯入阻擋超賣。 */
export function calcSharesBeforeTrade(
    target: TradeRecord,
    trades: TradeRecord[],
    dividends: DividendRecord[] = [],
): number {
    const priorTrades = trades.filter(t => {
        if (target.id && t.id === target.id) return false
        return compareTradeRecords(t, target) < 0
    })
    // 同日規則為所有交易先於配股，所以只有更早日期的股票股利能加入可賣股數。
    const priorDividends = dividends.filter(d => d.date < target.date)
    return calcPositions(priorTrades, priorDividends).holdings[target.code]?.shares ?? 0
}

export function calcPositions(trades: TradeRecord[], dividends?: DividendRecord[]): CalcResult {
    // 過濾掉 date 為 undefined/null/空字串的異常資料，避免 localeCompare crash
    const tradeEvents: TimelineEvent[] = trades
        .filter(t => t && t.date && typeof t.date === 'string')
        .map(t => ({ kind: 'trade', date: t.date, trade: t }))

    // 配股（股票股利）依「配股日期」插入時間軸，而非全部交易跑完才一次處理。
    //   若配股日早於某次賣出日，賣出時用到的均價/股數必須是「已配股」狀態，
    //   依時序處理才能讓已實現損益正確。
    const divEvents: TimelineEvent[] = (dividends ?? [])
        .filter(d => d && d.code && typeof d.date === 'string' && d.stockDividend > 0)
        .map(d => ({ kind: 'stockdiv', date: d.date, div: d }))

    // 同一天時：交易事件先於配股事件（除權息基準日當天的買賣仍以未配股股數計）。
    // 同類事件必須回傳對稱且穩定的比較結果，否則同日買賣順序會改變成本與損益。
    const events = [...tradeEvents, ...divEvents].sort((a, b) => {
        const c = a.date.localeCompare(b.date)
        if (c !== 0) return c
        if (a.kind !== b.kind) return a.kind === 'trade' ? -1 : 1
        if (a.kind === 'trade' && b.kind === 'trade') return compareTradeRecords(a.trade, b.trade)
        if (a.kind === 'stockdiv' && b.kind === 'stockdiv') {
            return (a.div.id || '').localeCompare(b.div.id || '')
        }
        return 0
    })

    const holdings: Record<string, HoldingPosition> = {}
    const realized: RealizedRecord[] = []
    // 各代號目前的「融資股數」。融資歸還比例 = 賣出股數 / 融資股數，
    // 與 aggregateMarginPositions 同一口徑，避免混合持倉（現股+融資）時兩邊算出不同的 marginAmount。
    const marginShares: Record<string, number> = {}

    for (const ev of events) {
        if (ev.kind === 'stockdiv') {
            // ── 配股：增加股數，攤薄均價，成本不變 ──
            const div = ev.div
            const pos = holdings[div.code]
            if (!pos || pos.shares <= 0) continue
            const newShares = pos.shares + div.stockDividend
            pos.avgCost = pos.totalCost / newShares
            pos.shares = newShares
            continue
        }

        const t = ev.trade
        const { code, name, type, price, shares, fee, tax } = t

        // 防呆：跳過欄位不完整的紀錄
        if (!code || !type || !Number.isFinite(price) || !Number.isFinite(shares) || price <= 0 || shares <= 0) continue

        if (!holdings[code]) {
            holdings[code] = { code, name, shares: 0, avgCost: 0, totalCost: 0, marginAmount: 0 }
        }
        const pos = holdings[code]

        if (type === 'buy') {
            const buyCost = price * shares + (fee || 0)
            const newTotalCost = pos.totalCost + buyCost
            const newShares = pos.shares + shares
            pos.avgCost = newShares > 0 ? newTotalCost / newShares : 0
            pos.totalCost = newTotalCost
            pos.shares = newShares
            pos.name = name || pos.name

            // 若為融資買入，累加融資借款金額（捨去至千元）與融資股數
            if (t.isMargin) {
                const stockVal = price * shares
                const mAmt = calcMarginDebt(stockVal, t.marginRatio || 0.6)
                pos.marginAmount = (pos.marginAmount ?? 0) + mAmt
                marginShares[code] = (marginShares[code] ?? 0) + shares
            }
        } else if (type === 'sell') {
            // 超賣不是合法的多頭交易。直接略過，避免舊資料或繞過 UI 的匯入資料
            // 以不存在的均價產生已實現損益、再被歸零而污染後續所有報表。
            if (pos.shares <= 0 || shares > pos.shares) continue
            const sellRevenue = price * shares - (fee || 0) - (tax || 0)
            const costBasis = pos.avgCost * shares
            const pnl = sellRevenue - costBasis
            const returnRate = costBasis > 0 ? pnl / costBasis : 0
            realized.push({
                date: t.date, code, name: name || pos.name, shares,
                avgCost: pos.avgCost, sellPrice: price, realized: pnl, returnRate
            })

            // 若為融資賣出，按「賣出股數 / 融資股數」比例歸還融資借款（與 aggregateMarginPositions 對齊）
            if (t.isMargin && (marginShares[code] ?? 0) > 0 && (pos.marginAmount ?? 0) > 0) {
                const mSh = marginShares[code] ?? 0
                const ratio = Math.min(shares / mSh, 1)
                pos.marginAmount = (pos.marginAmount ?? 0) * (1 - ratio)
                marginShares[code] = Math.max(mSh - shares, 0)
            }

            pos.shares -= shares
            pos.totalCost -= pos.avgCost * shares
            if (pos.shares <= 0) {
                pos.shares = 0
                pos.totalCost = 0
                pos.avgCost = 0
                pos.marginAmount = 0
                marginShares[code] = 0
            }
        }
    }

    return { holdings, realized }
}

/**
 * 計算可用現金。
 *
 * 可用現金 = 入金 − 出金 − 買入收付金額 + 賣出收付金額 + 現金股利
 *
 * ⚠️ 本系統 total（收付金額）的定義：
 *   - 買入：自備款 + 手續費（融資買入只記自備款，不含券商撥款的借款部分）
 *   - 賣出：扣除歸還券商借款後「實際入帳的淨額」（融資賣出已先還掉借款本金）
 *
 * 因為賣出 total 已是淨入帳，直接 + sellTotal 即為正確可用現金，
 * 不需要、也不可以再額外扣「歸還的借款本金」（否則融資賣出後現金會被低估）。
 *
 * ⚠️ 現金股利口徑（全系統統一，方案 A）：
 *   股利視同匯入交割戶、留在可用現金內（+ Σ cashDividend）。
 *   因此凡是以「期末總淨值（持倉市值＋可用現金）」收尾的 XIRR/CAGR 現金流，
 *   一律【不可】再把股利列為獨立正向流，否則會重複計算；
 *   快照式 XIRR 同理（資產快照的 cash 已含股利）。
 *   例外：YearReview 的「自訂區間 XIRR」期末值只含持倉市值、不含現金，
 *   該處的股利（與賣出收益）必須保留為獨立流，這是刻意的口徑差異。
 */
export function calcAvailableCash(
    cashflows: { type: string; amount: number }[],
    trades: TradeRecord[],
    dividends: { cashDividend?: number }[]
): number {
    const cashIn = cashflows.filter(c => c.type === 'in').reduce((s, c) => s + (c.amount || 0), 0)
    const cashOut = cashflows.filter(c => c.type === 'out').reduce((s, c) => s + (c.amount || 0), 0)
    const buyTotal = trades.filter(t => t.type === 'buy').reduce((s, t) => s + (t.total || 0), 0)
    const sellTotal = trades.filter(t => t.type === 'sell').reduce((s, t) => s + (t.total || 0), 0)
    const divTotal = dividends.reduce((s, d) => s + (d.cashDividend || 0), 0)
    return cashIn - cashOut - buyTotal + sellTotal + divTotal
}

// ── 融資部位彙總（唯一真實來源）─────────────────────────────────────────────
// 儀表板的維持率、資產趨勢的負債扣除都應呼叫此函式，避免各頁各自實作而對不上。
//   - 借款一律用 calcMarginDebt 重算（捨去至千元，與券商撥款一致），不採信舊存的 marginAmount
//   - 賣出時按「賣出股數 / 當時持股」比例歸還借款與成本

export interface PositionAdjustmentResult {
    action: 'buy' | 'sell' | 'hold'
    currentPct: number
    targetPct: number
    amount: number
    targetMarketValue: number
}

/**
 * 計算把股票倉位調整到目標水位所需的交易金額。
 *
 * 倉位口徑與儀表板一致：股票市值 ÷ 自有資金。假設以現金買賣且暫不計
 * 手續費、證交稅與成交滑價，因此交易前後的自有資金不變。
 */
export function calcPositionAdjustment(
    currentMarketValue: number,
    equityCapital: number,
    targetPct: number,
): PositionAdjustmentResult | null {
    if (
        !Number.isFinite(currentMarketValue)
        || !Number.isFinite(equityCapital)
        || !Number.isFinite(targetPct)
        || currentMarketValue < 0
        || equityCapital <= 0
        || targetPct < 0
    ) return null

    const currentPct = (currentMarketValue / equityCapital) * 100
    const targetMarketValue = equityCapital * targetPct / 100
    const difference = targetMarketValue - currentMarketValue
    const amount = Math.abs(difference)
    const action = amount < 0.005 ? 'hold' : difference > 0 ? 'buy' : 'sell'

    return { action, currentPct, targetPct, amount, targetMarketValue }
}

export interface MarginPositionAgg {
    code: string
    name: string
    shares: number
    marginAmount: number   // 目前累計融資借款（捨去至千元）
    marginCost: number     // 目前融資部位買入時的股票市值合計
}

export function aggregateMarginPositions(trades: TradeRecord[]): MarginPositionAgg[] {
    const map: Record<string, MarginPositionAgg> = {}
    // 依日期排序，確保賣出歸還比例以「賣出當下」的持股為基準
    const sorted = [...trades]
        .filter(t => t && t.isMargin && t.date)
        .sort(compareTradeRecords)
    for (const t of sorted) {
        if (!map[t.code]) {
            map[t.code] = { code: t.code, name: t.name, shares: 0, marginAmount: 0, marginCost: 0 }
        }
        const pos = map[t.code]
        if (t.type === 'buy') {
            const stockVal = t.price * t.shares
            pos.shares += t.shares
            pos.marginAmount += calcMarginDebt(stockVal, t.marginRatio || 0.6)
            pos.marginCost += stockVal
            pos.name = t.name || pos.name
        } else if (t.type === 'sell' && pos.shares > 0) {
            const ratio = t.shares / pos.shares
            pos.marginAmount -= pos.marginAmount * ratio
            pos.marginCost -= pos.marginCost * ratio
            pos.shares -= t.shares
            if (pos.shares <= 0) { pos.shares = 0; pos.marginAmount = 0; pos.marginCost = 0 }
        }
    }
    return Object.values(map).filter(m => m.shares > 0 && m.marginAmount > 0)
}

export function aggregateMarginDebt(trades: TradeRecord[]): number {
    return aggregateMarginPositions(trades).reduce((s, m) => s + m.marginAmount, 0)
}

// ── 融資加碼試算 ──────────────────────────────────────────────────────────────
// 試算「若現在加碼 X 股，整戶維持率會變成多少」
// 完全 pure function，不依賴任何外部狀態，可在任何元件中直接呼叫。

export interface MarginSimResult {
    /** 加碼後整戶維持率（%） */
    newMarginRatio: number
    /** 加碼後融資股票市值總和 */
    newMarketValue: number
    /** 加碼後融資借款總和 */
    newDebt: number
    /** 本次新增借款金額 */
    addedDebt: number
    /** 本次自備款（含手續費） */
    addedEquity: number
    /** 加碼後距追繳線(130%)尚有多少緩衝（正數=還有空間，負數=已超線） */
    bufferTo130: number
    /** 加碼後距斷頭線(120%)尚有多少緩衝 */
    bufferTo120: number
}

/**
 * simulateMarginBuy
 * @param currentMarketValue  現有融資股票市值合計
 * @param currentDebt         現有融資借款合計
 * @param buyPrice            試算買入價格
 * @param buyShares           試算加碼股數
 * @param marginRatio         融資成數（預設 0.6 = 六成）
 *
 * 融資借款金額無條件捨去至千元整數，與券商實際撥款邏輯一致
 *    例：75.50 × 2000 × 0.6 = 90,600 → 實際借款 90,000，差額 600 歸入自備款
 */
export function simulateMarginBuy(
    currentMarketValue: number,
    currentDebt: number,
    buyPrice: number,
    buyShares: number,
    marginRatio: number = 0.6
): MarginSimResult {
    const totalPrice = buyPrice * buyShares
    const addedDebt = calcMarginDebt(totalPrice, marginRatio)  // 捨去至千元
    const fee = calcFee(buyPrice, buyShares)
    const addedEquity = totalPrice - addedDebt + fee            // 自備款 = 總價 - 實際借款 + 手續費

    const newMarketValue = currentMarketValue + totalPrice
    const newDebt = currentDebt + addedDebt
    const newMarginRatio = newDebt > 0 ? (newMarketValue / newDebt) * 100 : 0

    // bufferTo130 = newMarketValue - (newDebt × 1.30)
    // 正數代表市值還有這麼多空間才會觸線
    const bufferTo130 = newMarketValue - newDebt * 1.30
    const bufferTo120 = newMarketValue - newDebt * 1.20

    return { newMarginRatio, newMarketValue, newDebt, addedDebt, addedEquity, bufferTo130, bufferTo120 }
}

// ── 融資壓力測試 ──────────────────────────────────────────────────────────────
// 純函式。回答兩種不同的風險：
//   (1) 整戶一起跌  → 維持率掉到哪、距追繳線多遠、整體最多還能跌幾%才追繳/斷頭
//   (2) 單一個股獨自跌（其他不動）→ 該檔自己跌幾%就把「整戶維持率」拉到追繳線
// 維持率皆為整戶口徑：整戶融資股票市值 ÷ 整戶融資借款 × 100%。
// 因借款不隨股價變動，整戶均勻跌 d 時：新維持率 = 目前維持率 ×(1−d)，為精確關係。
export interface MarginStressStock {
    code: string
    name?: string
    marketValue: number   // 該檔目前融資股票市值
}

export interface MarginStressScenario {
    drop: number          // 假設整體跌幅（小數，0.10 = 跌 10%）
    ratio: number         // 跌後整戶維持率（%）
    gapTo130: number      // 距追繳線的百分點（正 = 尚有，負 = 已跌破）
}

export interface MarginStressPerStock {
    code: string
    name?: string
    marketValue: number
    weight: number              // 佔整戶融資市值比例（小數）
    dropTo130: number | null    // 該檔獨自跌多少觸整戶追繳（小數）；null = 跌到 0 都不足以觸線
}

export interface MarginStressResult {
    totalMarketValue: number
    totalDebt: number
    currentRatio: number | null
    dropTo130: number | null    // 整戶一起最多還能跌多少觸追繳（小數）；<=0 代表已在追繳線下
    dropTo120: number | null
    scenarios: MarginStressScenario[]
    perStock: MarginStressPerStock[]
}

const MAINTENANCE_CALL = 1.30   // 追繳線 130%
const LIQUIDATION_LINE = 1.20   // 斷頭線 120%

export function calcMarginStress(
    stocks: MarginStressStock[],
    totalDebt: number,
    dropPcts: number[] = [0.10, 0.15, 0.20],
): MarginStressResult {
    const totalMarketValue = stocks.reduce((s, x) => s + (x.marketValue || 0), 0)

    if (totalDebt <= 0 || totalMarketValue <= 0) {
        return { totalMarketValue, totalDebt, currentRatio: null, dropTo130: null, dropTo120: null, scenarios: [], perStock: [] }
    }

    const currentRatio = (totalMarketValue / totalDebt) * 100

    // 整戶均勻跌：反解觸線跌幅 d* = 1 − 線 × 借款 / 市值
    const dropTo130 = 1 - (MAINTENANCE_CALL * totalDebt) / totalMarketValue
    const dropTo120 = 1 - (LIQUIDATION_LINE * totalDebt) / totalMarketValue

    const scenarios: MarginStressScenario[] = dropPcts.map(d => {
        const ratio = currentRatio * (1 - d)
        return { drop: d, ratio, gapTo130: ratio - MAINTENANCE_CALL * 100 }
    })

    // 單檔獨自跌：整戶市值少掉 (Vᵢ × dᵢ)，令整戶維持率 = 追繳線
    //   → dᵢ = (整戶市值 − 追繳線 × 借款) / Vᵢ。分子為共用緩衝，分母越大（越集中）能撐的跌幅越小。
    const buffer = totalMarketValue - MAINTENANCE_CALL * totalDebt
    const perStock: MarginStressPerStock[] = stocks.map(x => {
        const mv = x.marketValue || 0
        let dropTo130Single: number | null = mv > 0 ? buffer / mv : null
        // 跌幅 > 1（殺到 0 都不夠）視為單檔不足以觸線
        if (dropTo130Single !== null && dropTo130Single > 1) dropTo130Single = null
        return {
            code: x.code,
            name: x.name,
            marketValue: mv,
            weight: totalMarketValue > 0 ? mv / totalMarketValue : 0,
            dropTo130: dropTo130Single,
        }
    })

    return { totalMarketValue, totalDebt, currentRatio, dropTo130, dropTo120, scenarios, perStock }
}
