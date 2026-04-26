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

export interface TradeRecord {
    date: string
    type: 'buy' | 'sell'
    code: string
    name: string
    price: number
    shares: number
    fee: number
    tax: number
    total: number
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

export function calcPositions(trades: TradeRecord[], dividends?: DividendRecord[]): CalcResult {
    // ✅ 修正：過濾掉 date 為 undefined/null/空字串的異常資料，避免 localeCompare crash
    const validTrades = trades.filter(t => t && t.date && typeof t.date === 'string')
    const sorted = [...validTrades].sort((a, b) => a.date.localeCompare(b.date))

    const holdings: Record<string, HoldingPosition> = {}
    const realized: RealizedRecord[] = []

    for (const t of sorted) {
        const { code, name, type, price, shares, fee, tax } = t

        // 防呆：跳過欄位不完整的紀錄
        if (!code || !type || price == null || shares == null) continue

        if (!holdings[code]) {
            holdings[code] = { code, name, shares: 0, avgCost: 0, totalCost: 0 }
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
        } else if (type === 'sell') {
            const sellRevenue = price * shares - (fee || 0) - (tax || 0)
            const costBasis = pos.avgCost * shares
            const pnl = sellRevenue - costBasis
            const returnRate = costBasis > 0 ? pnl / costBasis : 0
            realized.push({
                date: t.date, code, name: name || pos.name, shares,
                avgCost: pos.avgCost, sellPrice: price, realized: pnl, returnRate
            })
            pos.shares -= shares
            pos.totalCost -= pos.avgCost * shares
            if (pos.shares <= 0) {
                pos.shares = 0
                pos.totalCost = 0
                pos.avgCost = 0
            }
        }
    }

    // ✅ 支援股票股利（配股）：增加股數，攤薄均價，成本不變
    if (dividends && dividends.length > 0) {
        const validDivs = dividends.filter(d => d && d.code && d.stockDividend)
        for (const div of validDivs) {
            const pos = holdings[div.code]
            if (!pos || pos.shares <= 0) continue
            if (div.stockDividend > 0) {
                const newShares = pos.shares + div.stockDividend
                // 成本不變，均價攤薄
                pos.avgCost = pos.totalCost / newShares
                pos.shares = newShares
            }
        }
    }

    return { holdings, realized }
}

// ✅ 修正：參數順序為 (cashflows, trades)，與原始 calc.ts 一致
// Dashboard.tsx 呼叫時需改為 calcAvailableCash(cashRecords, trades)
export function calcAvailableCash(
    cashflows: { type: string; amount: number }[],
    trades: TradeRecord[]
): number {
    const cashIn = cashflows.filter(c => c.type === 'in').reduce((s, c) => s + (c.amount || 0), 0)
    const cashOut = cashflows.filter(c => c.type === 'out').reduce((s, c) => s + (c.amount || 0), 0)
    // 融資買入只算自備款（total = 自備款 + 手續費），不算融資借款部分
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
 */
export function simulateMarginBuy(
    currentMarketValue: number,
    currentDebt: number,
    buyPrice: number,
    buyShares: number,
    marginRatio: number = 0.6
): MarginSimResult {
    const totalPrice = buyPrice * buyShares
    const addedDebt = totalPrice * marginRatio
    const fee = calcFee(buyPrice, buyShares)
    const addedEquity = totalPrice * (1 - marginRatio) + fee

    const newMarketValue = currentMarketValue + totalPrice
    const newDebt = currentDebt + addedDebt
    const newMarginRatio = newDebt > 0 ? (newMarketValue / newDebt) * 100 : 0

    // bufferTo130 = newMarketValue - (newDebt × 1.30)
    // 正數代表市值還有這麼多空間才會觸線
    const bufferTo130 = newMarketValue - newDebt * 1.30
    const bufferTo120 = newMarketValue - newDebt * 1.20

    return { newMarginRatio, newMarketValue, newDebt, addedDebt, addedEquity, bufferTo130, bufferTo120 }
}