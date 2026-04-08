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
}

// ✅ 新增：DividendRecord 型別（供 HistoryPnL、Holdings、DailyBrief 共用）
export interface DividendRecord {
    id?: string
    date: string
    code: string
    name: string
    cashDividend: number
    stockDividend: number  // 配股股數（加入持倉，成本為 0）
    note?: string
}

export interface HoldingPosition {
    code: string
    name: string
    shares: number
    avgCost: number   // FIFO：剩餘批次的加權平均成本（含手續費）
    totalCost: number // 剩餘持股總成本
}

export interface RealizedRecord {
    date: string
    code: string
    name: string
    shares: number
    avgCost: number   // 賣出時消耗批次的加權平均成本
    sellPrice: number
    realized: number
    returnRate: number
}

export interface CalcResult {
    holdings: Record<string, HoldingPosition>
    realized: RealizedRecord[]
}

// ── FIFO 批次結構 ──
interface Lot {
    date: string
    shares: number
    unitCost: number  // 含手續費的每股成本
}

// ✅ 修正：calcPositions 接受可選的 dividends 參數
// 配股（stockDividend > 0）會在對應日期後加入持倉，成本為 0，並攤薄 avgCost
export function calcPositions(trades: TradeRecord[], dividends: DividendRecord[] = []): CalcResult {
    const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date))

    // 每支股票維護一個 lots queue（先進先出）
    const lots: Record<string, Lot[]> = {}
    const holdings: Record<string, HoldingPosition> = {}
    const realized: RealizedRecord[] = []

    for (const t of sorted) {
        const { code, name, type, price, shares, fee, tax } = t

        if (!lots[code]) lots[code] = []
        if (!holdings[code]) {
            holdings[code] = { code, name, shares: 0, avgCost: 0, totalCost: 0 }
        }
        const pos = holdings[code]

        if (type === 'buy') {
            // 買進：每股成本 = (成交金額 + 手續費) / 股數，手續費含入成本
            const unitCost = (price * shares + fee) / shares
            lots[code].push({ date: t.date, shares, unitCost })

            pos.shares += shares
            pos.totalCost += price * shares + fee
            pos.name = name
            // avgCost = 剩餘批次加權平均（此時就是 totalCost / shares）
            pos.avgCost = pos.totalCost / pos.shares

        } else {
            // 賣出：FIFO 消耗最早批次
            let remaining = shares
            let costBasis = 0

            const queue = lots[code]
            while (remaining > 0 && queue.length > 0) {
                const lot = queue[0]
                if (lot.shares <= remaining) {
                    // 整批消耗
                    costBasis += lot.unitCost * lot.shares
                    remaining -= lot.shares
                    queue.shift()
                } else {
                    // 部分消耗
                    costBasis += lot.unitCost * remaining
                    lot.shares -= remaining
                    remaining = 0
                }
            }

            const sellRevenue = price * shares - fee - tax
            const pnl = sellRevenue - costBasis
            const returnRate = costBasis > 0 ? pnl / costBasis : 0
            const avgCostOfSold = shares > 0 ? costBasis / shares : 0

            realized.push({
                date: t.date, code, name, shares,
                avgCost: avgCostOfSold,
                sellPrice: price,
                realized: pnl,
                returnRate
            })

            pos.shares -= shares
            pos.totalCost -= costBasis

            if (pos.shares <= 0) {
                pos.shares = 0
                pos.totalCost = 0
                pos.avgCost = 0
                lots[code] = []
            } else {
                // 重新計算剩餘批次的加權平均成本
                const remaining_lots = lots[code]
                const remainingCost = remaining_lots.reduce((s, l) => s + l.unitCost * l.shares, 0)
                const remainingShares = remaining_lots.reduce((s, l) => s + l.shares, 0)
                pos.totalCost = remainingCost
                pos.avgCost = remainingShares > 0 ? remainingCost / remainingShares : 0
            }
        }
    }

    // ✅ 套用配股：stockDividend > 0 時加入股數，成本為 0，攤薄 avgCost
    // 依日期排序，確保配股按時間順序處理
    const sortedDividends = [...dividends].sort((a, b) => a.date.localeCompare(b.date))
    for (const d of sortedDividends) {
        if (d.stockDividend <= 0) continue
        if (!holdings[d.code]) continue  // 配股時已無持倉則略過
        const pos = holdings[d.code]
        pos.shares += d.stockDividend
        // totalCost 不變（配股成本為 0），avgCost 攤薄重算
        pos.avgCost = pos.totalCost / pos.shares
    }

    // 過濾掉空倉
    Object.keys(holdings).forEach(code => {
        if (holdings[code].shares <= 0) delete holdings[code]
    })

    return { holdings, realized }
}

export function calcAvailableCash(
    cashflows: { type: string; amount: number }[],
    trades: TradeRecord[]
): number {
    const cashIn = cashflows.filter(c => c.type === 'in').reduce((s, c) => s + c.amount, 0)
    const cashOut = cashflows.filter(c => c.type === 'out').reduce((s, c) => s + c.amount, 0)
    const buyTotal = trades.filter(t => t.type === 'buy').reduce((s, t) => s + t.total, 0)
    const sellTotal = trades.filter(t => t.type === 'sell').reduce((s, t) => s + t.total, 0)
    return cashIn - cashOut - buyTotal + sellTotal
}