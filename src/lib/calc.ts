export const FEE_RATE = 0.001425
export const FEE_DISCOUNT = 0.6  // 6折
export const MIN_FEE = 20
export const TAX_RATE_STOCK = 0.003
export const TAX_RATE_ETF = 0.001

export const isETF = (code: string) => code.replace('.TW', '').startsWith('00')

// 計算手續費（6折，無條件捨去，最低20元）
export function calcFee(price: number, shares: number): number {
  const amount = price * shares
  const fee = Math.floor(amount * FEE_RATE * FEE_DISCOUNT)
  return Math.max(fee, MIN_FEE)
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

export function calcPositions(trades: TradeRecord[]): CalcResult {
  const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date))
  const holdings: Record<string, HoldingPosition> = {}
  const realized: RealizedRecord[] = []

  for (const t of sorted) {
    const { code, name, type, price, shares, fee, tax } = t
    if (!holdings[code]) {
      holdings[code] = { code, name, shares: 0, avgCost: 0, totalCost: 0 }
    }
    const pos = holdings[code]

    if (type === 'buy') {
      const buyCost = price * shares + fee
      const newTotalCost = pos.totalCost + buyCost
      const newShares = pos.shares + shares
      pos.avgCost = newShares > 0 ? newTotalCost / newShares : 0
      pos.totalCost = newTotalCost
      pos.shares = newShares
      pos.name = name
    } else {
      const sellRevenue = price * shares - fee - tax
      const costBasis = pos.avgCost * shares
      const pnl = sellRevenue - costBasis
      const returnRate = costBasis > 0 ? (pnl / costBasis) * 100 : 0
      realized.push({
        date: t.date, code, name, shares,
        avgCost: pos.avgCost, sellPrice: price,
        realized: pnl, returnRate
      })
      pos.shares -= shares
      pos.totalCost = pos.avgCost * pos.shares
      if (pos.shares <= 0) {
        pos.shares = 0
        pos.totalCost = 0
        pos.avgCost = 0
      }
    }
  }

  const activeHoldings: Record<string, HoldingPosition> = {}
  Object.entries(holdings).forEach(([code, pos]) => {
    if (pos.shares > 0) activeHoldings[code] = pos
  })

  return { holdings: activeHoldings, realized: realized.reverse() }
}

export function calcAvailableCash(
  trades: TradeRecord[],
  cashRecords: { type: 'in' | 'out'; amount: number }[]
): number {
  const netCash = cashRecords.reduce((s, r) => r.type === 'in' ? s + r.amount : s - r.amount, 0)
  const buyTotal = trades.filter(t => t.type === 'buy').reduce((s, t) => s + t.total, 0)
  const sellTotal = trades.filter(t => t.type === 'sell').reduce((s, t) => s + t.total, 0)
  return netCash - buyTotal + sellTotal
}