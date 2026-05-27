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

export interface TradeRecord {
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
    marginAmount?: number  // 融資借款金額
}

export interface DividendRecord {
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

    // 同一天時：交易事件先於配股事件（除權息基準日當天的買賣仍以未配股股數計）
    const events = [...tradeEvents, ...divEvents].sort((a, b) => {
        const c = a.date.localeCompare(b.date)
        if (c !== 0) return c
        return a.kind === 'trade' ? -1 : 1
    })

    const holdings: Record<string, HoldingPosition> = {}
    const realized: RealizedRecord[] = []

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
        if (!code || !type || price == null || shares == null) continue

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

            // 若為融資買入，累加融資借款金額（捨去至千元）
            if (t.isMargin) {
                const stockVal = price * shares
                const mAmt = calcMarginDebt(stockVal, t.marginRatio ?? 0.6)
                pos.marginAmount = (pos.marginAmount ?? 0) + mAmt
            }
        } else if (type === 'sell') {
            const sellRevenue = price * shares - (fee || 0) - (tax || 0)
            const costBasis = pos.avgCost * shares
            const pnl = sellRevenue - costBasis
            const returnRate = costBasis > 0 ? pnl / costBasis : 0
            realized.push({
                date: t.date, code, name: name || pos.name, shares,
                avgCost: pos.avgCost, sellPrice: price, realized: pnl, returnRate
            })

            // 若為融資賣出，按比例歸還融資借款
            if (t.isMargin && pos.shares > 0 && (pos.marginAmount ?? 0) > 0) {
                const ratio = shares / pos.shares
                pos.marginAmount = (pos.marginAmount ?? 0) * (1 - ratio)
            }

            pos.shares -= shares
            pos.totalCost -= pos.avgCost * shares
            if (pos.shares <= 0) {
                pos.shares = 0
                pos.totalCost = 0
                pos.avgCost = 0
                pos.marginAmount = 0
            }
        }
    }

    return { holdings, realized }
}

/**
 * 計算可用現金。
 *
 * 可用現金 = 入金 − 出金 − 買入收付金額 + 賣出收付金額
 *
 * ⚠️ 本系統 total（收付金額）的定義：
 *   - 買入：自備款 + 手續費（融資買入只記自備款，不含券商撥款的借款部分）
 *   - 賣出：扣除歸還券商借款後「實際入帳的淨額」（融資賣出已先還掉借款本金）
 *
 * 因為賣出 total 已是淨入帳，直接 + sellTotal 即為正確可用現金，
 * 不需要、也不可以再額外扣「歸還的借款本金」（否則融資賣出後現金會被低估）。
 */
export function calcAvailableCash(
    cashflows: { type: string; amount: number }[],
    trades: TradeRecord[]
): number {
    const cashIn = cashflows.filter(c => c.type === 'in').reduce((s, c) => s + (c.amount || 0), 0)
    const cashOut = cashflows.filter(c => c.type === 'out').reduce((s, c) => s + (c.amount || 0), 0)
    const buyTotal = trades.filter(t => t.type === 'buy').reduce((s, t) => s + (t.total || 0), 0)
    const sellTotal = trades.filter(t => t.type === 'sell').reduce((s, t) => s + (t.total || 0), 0)
    return cashIn - cashOut - buyTotal + sellTotal
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