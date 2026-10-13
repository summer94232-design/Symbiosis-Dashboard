export const FEE_RATE = 0.001425
export const FEE_DISCOUNT = 0.6  // 6折
export const MIN_FEE = 20        // 整股最低手續費
export const MIN_FEE_ODD = 1     // 零股最低手續費
export const TAX_RATE_STOCK = 0.003
export const TAX_RATE_ETF = 0.001
export const DEFAULT_MARGIN_INTEREST_RATE = 0.0625

const normalizedSecurityCode = (code: string) => code.trim().toUpperCase().replace(/\.(TW|TWO)$/, '')
export const isETF = (code: string) => normalizedSecurityCode(code).startsWith('00')

/** Passive bond ETFs (B, or their foreign-currency C listings), excluding L/R leverage/inverse. */
export function securityTaxRate(code: string, date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })): number {
    if (/^00\d{3}[BC]$/.test(normalizedSecurityCode(code)) && date >= '2017-01-01' && date <= '2026-12-31') return 0
    return isETF(code) ? TAX_RATE_ETF : TAX_RATE_STOCK
}

// 台灣券商的成交金額以「元」為單位，小數部分無條件捨去。
// 零股在單價含 0.5／0.05 時尤其容易出現 0.5～1 元的帳差。
export function calcGrossAmount(price: number, shares: number): number {
    const amount = (price || 0) * (shares || 0)
    // Repair binary multiplication noise (34.8 * 7000 = 243599.99999999997)
    // before truncating actual fractional dollars such as 29.11 * 29.
    return Math.floor(amount + Number.EPSILON * Math.max(1, Math.abs(amount)) * 2)
}

// 計算手續費（6折，無條件捨去）
// - 整股（shares >= 1000）：最低 20 元
// - 零股（shares < 1000）：最低 1 元
export function calcFee(price: number, shares: number): number {
    const amount = calcGrossAmount(price, shares)
    const fee = Math.floor(amount * FEE_RATE * FEE_DISCOUNT)
    const minFee = shares < 1000 ? MIN_FEE_ODD : MIN_FEE
    return Math.max(fee, minFee)
}

// 計算交易稅（賣出才有）
export function calcTax(price: number, shares: number, code: string, date?: string): number {
    const amount = calcGrossAmount(price, shares)
    const rate = securityTaxRate(code, date || undefined)
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
 *             系統可先依歷史融資批次估算，再由 marginRepay 接受券商實際金額覆寫。
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
    const gross = calcGrossAmount(t.price, t.shares)
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

/**
 * 持倉畫面的賣出費用估值，與成交記帳的 calcFee（電子交易 6 折）分開。
 * 元大庫存截圖以未折扣費率預估；零股最低費依使用者確認的 1 元，
 * 不複製券商畫面把小額零股按 20 元估算的問題。按每檔總持股估算一次。
 * 此處是賣出既有庫存，不適用現股當沖稅率；不寫入現金或成交成本。
 */
export function calcHoldingValuation(position: {
    code: string
    shares: number
    totalCost: number
    marginAmount?: number
}, quote: number | null | undefined, asOf?: string) {
    const currentPrice = typeof quote === 'number' && Number.isFinite(quote) && quote > 0 ? quote : null
    const hasPosition = Number.isFinite(position.shares) && position.shares > 0
    // 市值不是已成交價金，保留角分；例如 47.70 元的一股不能先捨去成 47 元。
    const marketValue = currentPrice === null ? position.totalCost
        : hasPosition ? Number((currentPrice * position.shares).toFixed(8)) : 0
    const estimatedSellFee = currentPrice !== null && hasPosition
        ? Math.max(Math.floor(marketValue * FEE_RATE), position.shares < 1000 ? MIN_FEE_ODD : MIN_FEE) : 0
    const estimatedSellTax = currentPrice !== null && hasPosition
        ? Math.floor(marketValue * securityTaxRate(position.code, asOf)) : 0
    const bookPnL = currentPrice !== null && hasPosition
        ? Number((marketValue - position.totalCost).toFixed(8)) : 0
    const unrealizedPnL = Number((bookPnL - estimatedSellFee - estimatedSellTax).toFixed(8))
    return {
        currentPrice, marketValue, estimatedSellFee, estimatedSellTax, bookPnL, unrealizedPnL,
        returnRate: calcReturnRate(unrealizedPnL, position.totalCost, position.marginAmount ?? 0),
    }
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
    marginPrincipal?: number // 融資賣出時歸還的本金（系統估算或人工確認）
    marginInterest?: number  // 融資賣出時支付的利息（實現損益應扣除）
    marginInterestRate?: number // 年利率，小數表示（例：0.0625 = 6.25%）
    marginRepayManual?: boolean // 償還總額是否曾依券商資料手動覆寫
    /** 同日交易排序時間；新資料一律寫入，舊資料沒有時退回 sequence / id */
    createdAt?: string
    /** CSV 等批次來源可提供的穩定原始順序 */
    sequence?: number
    brokerAccount?: string // 券商帳戶識別；空白代表既有預設帳戶
    tradingSession?: 'regular' | 'odd' | 'block'
    dayTradeExcluded?: boolean
    dayTradePending?: boolean // 先賣後買尚待補登回補，不能視為已沖銷
    dayTradeMatches?: { buyId: string; shares: number }[] // 僅存於賣出，保留明確配對
    dayTradeMode?: 'auto' | 'manual' // 未設定預設自動；既有非空明確配對仍優先
    /** 券商已確認的既有庫存沖抵批次；與同日當沖配對分開，數量須涵蓋全部非當沖賣出。 */
    inventoryMatches?: { buyId: string; shares: number }[]
}

export interface DividendRecord {
    sourceAnnouncementId?: string
    status?: 'announced' | 'confirmed'
    cashPaymentDate?: string
    stockDistributionDate?: string
    /** Actual distributed shares retained in the credit account, confirmed from Yuanta. */
    stockDividendMarginShares?: number
    id?: string
    date: string
    code: string
    name: string
    cashDividend: number
    stockDividend: number
    note?: string
}

/** Cash income is recognized on receipt, not on the ex-dividend date. */
export function receivedCashDividends<T extends { date?: string; cashPaymentDate?: string; status?: string; cashDividend?: number }>(
    dividends: T[], asOf?: string,
): (T & { date: string })[] {
    return dividends.filter(d => d.status !== 'announced' && (d.cashDividend ?? 0) > 0)
        .map(d => ({ ...d, date: d.cashPaymentDate || d.date || '' }))
        .filter(d => !!d.date && (!asOf || isEffectiveOn(d.date, asOf)))
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
    tradeId?: string
    category?: 'dayTrade' | 'inventory'
    holdingDays?: number // 非當沖按股數加權持有天數
}

export interface CalcResult {
    holdings: Record<string, HoldingPosition>
    realized: RealizedRecord[]
    dailyHoldings?: Record<string, Record<string, HoldingPosition>>
    inventoryLots?: Record<string, InventoryLot[]>
}

interface InventoryLot {
    buyId?: string; date: string; shares: number; cost: number
    grossCost?: number
    isMargin: boolean; account: string; session: ReturnType<typeof inferTradingSession>
    source?: 'stock-dividend'
    classificationPending?: boolean
    stockDividendAdjusted?: boolean
}

export interface DayTradePair { buy: TradeRecord; sell: TradeRecord; shares: number }
export interface DayTradeAnalysis {
    confirmed: DayTradePair[]
    automatic: DayTradePair[]
    candidates: DayTradePair[]
    uncertain: TradeRecord[]
    matchedShares: Map<TradeRecord, number>
    issues: { trade: TradeRecord; message: string }[]
}

/** 沒有來源市場註記時，只將完整整張視為一般現股；混合股數不猜市場。 */
export function inferTradingSession(t: Pick<TradeRecord, 'tradingSession' | 'shares'>): 'regular' | 'odd' | 'block' | 'unknown' {
    if (t.tradingSession) return t.tradingSession
    if (!Number.isInteger(t.shares) || t.shares <= 0) return 'unknown'
    if (t.shares < 1000) return 'odd'
    return t.shares % 1000 === 0 ? 'regular' : 'unknown'
}

export function usesManualDayTradeMatching(t: TradeRecord): boolean {
    return t.dayTradeMode === 'manual'
        || (t.dayTradeMode !== 'auto' && Array.isArray(t.dayTradeMatches) && t.dayTradeMatches.length > 0)
}

/** 自動沖抵是帳本成本歸屬，不代表已向券商確認資格、申報或優惠稅率。 */
export function analyzeDayTrades(trades: TradeRecord[], includeCandidates = true): DayTradeAnalysis {
    const confirmed: DayTradePair[] = [], automatic: DayTradePair[] = [], candidates: DayTradePair[] = []
    const uncertain: TradeRecord[] = []
    const issues: DayTradeAnalysis['issues'] = []
    const matchedShares = new Map<TradeRecord, number>()
    const ordered = [...trades].filter(Boolean).sort((a, b) => compareTradeRecords(a, b)
        || a.price - b.price || a.shares - b.shares || a.fee - b.fee || a.tax - b.tax)
    const ids = new Map<string, TradeRecord>()
    const duplicateIds = new Set<string>()
    for (const t of ordered) if (t.id) {
        if (ids.has(t.id)) duplicateIds.add(t.id)
        ids.set(t.id, t)
    }
    const eligible = (t: TradeRecord) => Boolean((!t.id || !duplicateIds.has(t.id)) && t.date && t.code
        && !t.isMargin && !t.dayTradeExcluded && t.tradingSession !== 'odd' && t.tradingSession !== 'block'
        && Number.isFinite(t.price) && t.price > 0 && Number.isInteger(t.shares) && t.shares >= 1000
        && Number.isFinite(t.fee) && t.fee >= 0 && Number.isFinite(t.tax) && t.tax >= 0)
    const sameGroup = (a: TradeRecord, b: TradeRecord) => a.date === b.date && a.code === b.code
        && (a.brokerAccount || '').trim() === (b.brokerAccount || '').trim()
    // 已指定為舊庫存的股數不可再被自動或手動當沖重複使用。
    const capacity = (t: TradeRecord) => {
        const inventoryShares = t.type === 'sell' && Array.isArray(t.inventoryMatches)
            ? t.inventoryMatches.reduce((sum, link) => sum + (Number.isInteger(link?.shares) && link.shares > 0 ? link.shares : 0), 0) : 0
        return Math.floor(Math.max(0, t.shares - inventoryShares) / 1000) * 1000
    }
    for (const sell of ordered) {
        if (sell.dayTradeMode === 'auto') continue
        if (sell.dayTradeMatches === undefined) continue
        if (!Array.isArray(sell.dayTradeMatches)) {
            issues.push({ trade: sell, message: '當沖配對格式錯誤，請重新確認。' }); continue
        }
        // 單筆賣出的配對採全有或全無；不默默縮減已確認數量。
        const local = new Map<TradeRecord, number>()
        let total = 0, invalid = false
        for (const link of sell.dayTradeMatches) {
            const buy = link && ids.get(link.buyId)
            const qty = link?.shares
            if (!buy || buy.type !== 'buy' || sell.type !== 'sell' || !eligible(buy) || !eligible(sell)
                || !sameGroup(buy, sell) || !Number.isInteger(qty) || qty <= 0 || qty % 1000 !== 0) {
                invalid = true; break
            }
            local.set(buy, (local.get(buy) || 0) + qty)
            total += qty
            if ((local.get(buy) || 0) + (matchedShares.get(buy) || 0) > capacity(buy)) invalid = true
        }
        if (total > capacity(sell)) invalid = true
        if (invalid) {
            issues.push({ trade: sell, message: '當沖配對失效：請核對買入紀錄、日期、帳戶、交易類別與股數，再重新確認。' })
            continue
        }
        for (const [buy, shares] of local) {
            confirmed.push({ buy, sell, shares })
            matchedShares.set(buy, (matchedShares.get(buy) || 0) + shares)
        }
        matchedShares.set(sell, total)
    }
    const invalid = new Set(issues.map(issue => issue.trade))
    const buys = ordered.filter(t => t.type === 'buy' && eligible(t))
    // 先保留人工指定配對，再使用剩餘股數自動配對；不受輸入先買或先賣影響。
    for (const sell of ordered.filter(t => t.type === 'sell' && eligible(t))) {
        if (invalid.has(sell)) continue
        const matchingBuys = buys.filter(buy => sameGroup(buy, sell))
        if (matchingBuys.length && !usesManualDayTradeMatching(sell)
            && (inferTradingSession(sell) === 'unknown' || matchingBuys.some(buy => inferTradingSession(buy) === 'unknown'))) {
            uncertain.push(sell)
        }
        if (usesManualDayTradeMatching(sell) || inferTradingSession(sell) !== 'regular') continue
        let remaining = capacity(sell) - (matchedShares.get(sell) || 0)
        for (const buy of matchingBuys.filter(t => inferTradingSession(t) === 'regular')) {
            const shares = Math.min(remaining, capacity(buy) - (matchedShares.get(buy) || 0))
            if (shares <= 0) continue
            automatic.push({ buy, sell, shares })
            matchedShares.set(buy, (matchedShares.get(buy) || 0) + shares)
            matchedShares.set(sell, (matchedShares.get(sell) || 0) + shares)
            remaining -= shares
        }
    }
    if (!includeCandidates) return { confirmed, automatic, candidates, uncertain, matchedShares, issues }
    const reserved = new Map(matchedShares)
    for (const sell of ordered.filter(t => t.type === 'sell' && eligible(t))) {
        if (issues.some(issue => issue.trade === sell)) continue
        let remaining = capacity(sell) - (reserved.get(sell) || 0)
        for (const buy of ordered.filter(t => t.type === 'buy' && eligible(t) && sameGroup(t, sell))) {
            const shares = Math.min(remaining, capacity(buy) - (reserved.get(buy) || 0))
            if (shares <= 0) continue
            candidates.push({ buy, sell, shares })
            reserved.set(buy, (reserved.get(buy) || 0) + shares)
            remaining -= shares
        }
    }
    return { confirmed, automatic, candidates, uncertain, matchedShares, issues }
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
    const allTrades = [...trades.filter(t => t !== target && (!target.id || t.id !== target.id)), target]
    // 明確配發日當天即可出售；舊版只記除權息日期則保留隔日可用規則。
    const priorDividends = dividends.filter(d => d.stockDistributionDate
        ? d.stockDistributionDate <= target.date : d.date < target.date)
    // Availability checks must be able to inspect and repair an already incomplete
    // ledger. Normal portfolio calculations remain strict about unmatched sells.
    const result = calcPositions(allTrades, priorDividends, { beforeTrade: target, includeInventoryLots: true, skipUnmatchedSells: true })
    const held = (result.inventoryLots?.[target.code] || []).filter(lot => {
        // 元大現股與融資是不同交易類別，不能借用另一類的庫存。
        if (lot.classificationPending || lot.isMargin !== !!target.isMargin || lot.account !== (target.brokerAccount || '')) return false
        // 零股不適用當沖；今日零股買入不能補足今日賣出，次一交易日才可使用。
        if (!target.isMargin && lot.source !== 'stock-dividend' && lot.date === target.date
            && (inferTradingSession(target) === 'odd' || lot.session === 'odd' || target.dayTradeExcluded)) return false
        return true
    }).reduce((sum, lot) => sum + lot.shares, 0)
    return held + (analyzeDayTrades(allTrades, false).matchedShares.get(target) || 0)
}

export interface MarginRepaymentEstimate {
    principal: number
    interest: number
    total: number
    matchedShares: number
    unmatchedShares: number
}

interface OpenMarginLot {
    shares: number
    debt: number
    date: string
    annualRate: number
    cost: number
}

// 證交所 115 年行事曆中「不辦理結算交割」的工作日。
// 2026-02-12、02-13 雖無交易但仍辦理結算，故不列入。
export const TWSE_SETTLEMENT_COVERED_YEARS: number[] = [2026]
const TWSE_SETTLEMENT_HOLIDAYS = new Set([
    '2026-01-01',
    '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
    '2026-02-27',
    '2026-04-03', '2026-04-06',
    '2026-05-01', '2026-06-19',
    '2026-09-25', '2026-09-28',
    '2026-10-09', '2026-10-26',
    '2026-12-25',
])

/** Annual data is validated before any settlement calculation can consume it. */
export function applySettlementCalendar(year: number, dates: string[]) {
    for (const date of TWSE_SETTLEMENT_HOLIDAYS) if (date.startsWith(`${year}-`)) TWSE_SETTLEMENT_HOLIDAYS.delete(date)
    dates.forEach(date => TWSE_SETTLEMENT_HOLIDAYS.add(date))
    if (!TWSE_SETTLEMENT_COVERED_YEARS.includes(year)) TWSE_SETTLEMENT_COVERED_YEARS.push(year)
    TWSE_SETTLEMENT_COVERED_YEARS.sort((a, b) => a - b)
}

function addTwseSettlementDays(isoDate: string, count: number): Date | null {
    const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!match) return null
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    if (Number.isNaN(date.getTime())) return null
    let added = 0
    while (added < count) {
        date.setUTCDate(date.getUTCDate() + 1)
        const day = date.getUTCDay()
        const dateKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
        if (day !== 0 && day !== 6 && !TWSE_SETTLEMENT_HOLIDAYS.has(dateKey)) added += 1
    }
    return date
}

/** Include the T+2 tail, which can enter next year even for a December trade. */
export function getSettlementCalendarYears(fromDate: string, toDate: string): number[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate) || fromDate > toDate) return []
    const start = new Date(`${fromDate}T00:00:00Z`), end = new Date(`${toDate}T00:00:00Z`)
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
        || start.toISOString().slice(0, 10) !== fromDate || end.toISOString().slice(0, 10) !== toDate) return []
    const settlement = addTwseSettlementDays(toDate, 2)
    if (!settlement) return []
    const years: number[] = []
    for (let year = start.getUTCFullYear(); year <= settlement.getUTCFullYear(); year++) years.push(year)
    return years
}

function settlementDays(fromDate: string, toDate: string): number {
    const from = addTwseSettlementDays(fromDate, 2)
    const to = addTwseSettlementDays(toDate, 2)
    if (!from || !to) return 0
    return Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000))
}

/**
 * 依該代號尚未償還的融資買進批次（FIFO）估算本金與利息。
 * 交割日以 T+2 證交所結算日推算；週末與已登錄的休市日都會排除，
 * 因此表單保留「償還總額」人工覆寫。
 */
export function estimateMarginRepayment(
    target: TradeRecord,
    trades: TradeRecord[],
    dividends: DividendRecord[] = [],
): MarginRepaymentEstimate {
    if (target.type !== 'sell' || !target.isMargin || !target.code || target.shares <= 0) {
        return { principal: 0, interest: 0, total: 0, matchedShares: 0, unmatchedShares: Math.max(target.shares || 0, 0) }
    }

    const priorTrades = trades.filter(t => t && t.code === target.code
        && (t.brokerAccount || '') === (target.brokerAccount || '')
        && t !== target && (!target.id || t.id !== target.id) && compareTradeRecords(t, target) < 0)
    const priorDividends = dividends.filter(d => d.code === target.code && ((d.stockDistributionDate || d.date) < target.date
        || (d.stockDistributionDate === target.date)))
    const ledger = buildMarginLedger(priorTrades, priorDividends)
    return ledger.estimate(target)
}

function recordedPrincipal(trade: TradeRecord): number | undefined {
    // Older CSV imports used 0 for a missing breakdown. Only a confirmed
    // interest-only repayment makes zero an explicit principal repayment.
    const value = trade.marginPrincipal
    return typeof value === 'number' && Number.isFinite(value)
        && (value > 0 || (value === 0 && (trade.marginRepay ?? 0) > 0 && trade.marginRepay === trade.marginInterest))
        ? value : undefined
}

/** Integer allocation with the remainder kept on the final lot, shared by both ledgers. */
function allocateByWeight(total: number, weights: number[]): number[] {
    const sum = weights.reduce((value, weight) => value + weight, 0)
    if (total === sum) return [...weights]
    let remaining = total
    return weights.map((weight, i) => {
        const value = i === weights.length - 1 ? remaining : sum > 0 ? Math.floor(total * weight / sum) : 0
        remaining -= value
        return value
    })
}

/** One FIFO ledger for estimates and debt; accounts never repay each other's lots. */
class MarginLedger {
    private accounts = new Map<string, { code: string; name: string; lots: OpenMarginLot[] }>()

    private account(trade: TradeRecord) {
        const key = JSON.stringify([trade.code, trade.brokerAccount || ''])
        let account = this.accounts.get(key)
        if (!account) {
            account = { code: trade.code, name: trade.name, lots: [] }
            this.accounts.set(key, account)
        }
        return account
    }

    estimate(trade: TradeRecord): MarginRepaymentEstimate {
        const lots = this.account(trade).lots
        let remaining = Math.max(trade.shares, 0), principal = 0, interest = 0
        for (const lot of lots) {
            if (remaining <= 0) break
            const taken = Math.min(remaining, lot.shares)
            const debt = lot.shares > 0 ? lot.debt * taken / lot.shares : lot.debt
            principal += debt
            interest += debt * lot.annualRate * settlementDays(lot.date, trade.date) / 365
            remaining -= taken
        }
        principal = Math.round(principal)
        interest = Math.round(interest)
        return { principal, interest, total: principal + interest,
            matchedShares: trade.shares - remaining, unmatchedShares: remaining }
    }

    apply(trade: TradeRecord): boolean {
        if (!trade.isMargin || !trade.code || !trade.date || !Number.isFinite(trade.shares) || trade.shares <= 0
            || !Number.isFinite(trade.price) || trade.price <= 0) return false
        const account = this.account(trade)
        const lots = account.lots
        if (trade.type === 'buy') {
            const cost = calcGrossAmount(trade.price, trade.shares)
            lots.push({ shares: trade.shares, cost,
                debt: trade.marginAmount ?? calcMarginDebt(cost, trade.marginRatio || 0.6),
                date: trade.date, annualRate: trade.marginInterestRate ?? DEFAULT_MARGIN_INTEREST_RATE })
            account.name = trade.name || account.name
            return true
        }
        const estimate = this.estimate(trade)
        if (estimate.unmatchedShares > 0) return false
        let remainingShares = trade.shares
        let remainingPrincipal = recordedPrincipal(trade) ?? estimate.principal
        const debt = lots.reduce((sum, lot) => sum + lot.debt, 0)
        if (remainingPrincipal > debt) throw new Error('融資償還本金超過該帳戶剩餘借款，請核對交易紀錄')
        for (const lot of lots) {
            const taken = Math.min(remainingShares, lot.shares)
            if (lot.shares > 0) lot.cost *= (lot.shares - taken) / lot.shares
            lot.shares -= taken
            remainingShares -= taken
            const repaid = Math.min(remainingPrincipal, lot.debt)
            lot.debt -= repaid
            remainingPrincipal -= repaid
        }
        // Keep any explicitly underpaid debt, even after all shares are sold.
        // It must not disappear merely because the position has closed.
        account.lots = lots.filter(lot => lot.shares > 0 || lot.debt > 0)
        return true
    }

    positions(): MarginPositionAgg[] {
        const result = new Map<string, MarginPositionAgg>()
        for (const { code, name, lots } of this.accounts.values()) {
            const pos = result.get(code) || { code, name, shares: 0, marginAmount: 0, marginCost: 0 }
            for (const lot of lots) {
                pos.shares += lot.shares
                pos.marginAmount += lot.debt
                pos.marginCost += lot.cost
            }
            result.set(code, pos)
        }
        return [...result.values()].filter(p => p.shares > 0 || p.marginAmount > 0)
    }

    distribute(code: string, shares: number): void {
        if (!(shares > 0)) return
        const lots = [...this.accounts.values()].filter(a => a.code === code).flatMap(a => a.lots).filter(l => l.shares > 0)
        const held = lots.reduce((sum, lot) => sum + lot.shares, 0)
        if (!held) throw new Error(`${code} 配股指定融資庫存，但配發日沒有融資部位；請核對元大配股紀錄`)
        const extras = allocateByWeight(shares, lots.map(lot => lot.shares))
        lots.forEach((lot, i) => { lot.shares += extras[i] })
    }

    debt(code: string): number {
        return this.positions().find(p => p.code === code)?.marginAmount ?? 0
    }
}

function buildMarginLedger(trades: TradeRecord[], dividends: DividendRecord[]): MarginLedger {
    const ledger = new MarginLedger()
    const events = [
        ...trades.map(trade => ({ date: trade.date, trade, dividend: null as DividendRecord | null })),
        ...dividends.filter(d => d.status !== 'announced' && (d.stockDividendMarginShares ?? 0) > 0)
            .map(dividend => ({ date: dividend.stockDistributionDate || dividend.date, trade: null as TradeRecord | null, dividend })),
    ].sort((a, b) => a.date.localeCompare(b.date)
        || ((a.dividend?.stockDistributionDate ? 0 : a.trade ? 1 : 2) - (b.dividend?.stockDistributionDate ? 0 : b.trade ? 1 : 2))
        || (a.trade && b.trade ? compareTradeRecords(a.trade, b.trade) : (a.dividend?.id || '').localeCompare(b.dividend?.id || '')))
    events.forEach(e => e.trade ? ledger.apply(e.trade) : ledger.distribute(e.dividend!.code, e.dividend!.stockDividendMarginShares!))
    return ledger
}

export function calcPositions(trades: TradeRecord[], dividends?: DividendRecord[], options: {
    beforeTrade?: TradeRecord; includeDailyHoldings?: boolean; includeInventoryLots?: boolean; asOf?: string
    costMethod?: 'moving-average' | 'fifo'
    /** Only for availability/repair preflight; never use for portfolio or PnL. */
    skipUnmatchedSells?: boolean
} = {}): CalcResult {
    if (options.asOf) trades = trades.filter(t => t && isEffectiveOn(t.date, options.asOf!))
    dividends = (dividends ?? []).filter(d => d && d.status !== 'announced').map(d => ({
        ...d, date: d.stockDistributionDate || d.date,
    })).filter(d => !options.asOf || isEffectiveOn(d.date, options.asOf))
    const dayTrades = analyzeDayTrades(trades, false)
    const dayCosts = new Map<TradeRecord, number>()
    for (const pair of [...dayTrades.confirmed, ...dayTrades.automatic]) {
        dayCosts.set(pair.sell, (dayCosts.get(pair.sell) || 0)
            + (calcGrossAmount(pair.buy.price, pair.buy.shares) + pair.buy.fee) * pair.shares / pair.buy.shares)
    }
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

    // 明確的實際配發日：當日可用股數先入帳；舊版只記除權息日期則保留交易優先規則。
    // 同類事件必須回傳對稱且穩定的比較結果，否則同日買賣順序會改變成本與損益。
    const events = [...tradeEvents, ...divEvents].sort((a, b) => {
        const c = a.date.localeCompare(b.date)
        if (c !== 0) return c
        const priority = (event: TimelineEvent) => event.kind === 'stockdiv' && event.div.stockDistributionDate ? 0 : event.kind === 'trade' ? 1 : 2
        const order = priority(a) - priority(b)
        if (order !== 0) return order
        if (a.kind === 'trade' && b.kind === 'trade') return compareTradeRecords(a.trade, b.trade)
        if (a.kind === 'stockdiv' && b.kind === 'stockdiv') {
            return (a.div.id || '').localeCompare(b.div.id || '')
        }
        return 0
    })

    const holdings: Record<string, HoldingPosition> = {}
    const realized: RealizedRecord[] = []
    const acquisitionTime: Record<string, number> = {}
    // 元大剩餘庫存與歷史成交交叉核對採 FIFO；移動平均僅供舊結果比較。
    const useFifo = options.costMethod !== 'moving-average'
    const inventoryLots: Record<string, InventoryLot[]> = {}
    const dailyHoldings: NonNullable<CalcResult['dailyHoldings']> = {}
    let lastDate = ''
    const snapshot = () => {
        if (options.includeDailyHoldings && lastDate) dailyHoldings[lastDate] = Object.fromEntries(
            Object.entries(holdings).map(([code, pos]) => [code, { ...pos }]))
    }
    // 舊資料只存「本金＋利息」總額。券商若把同日同股的多筆融資賣出合併計息，
    // 單筆總額可能暫時低於估算本金；必須先以整組總額扣除整組本金，再分攤利息。
    const legacyMarginInterest = new Map<TradeRecord, number>()
    const legacyGroups = new Map<string, TradeRecord[]>()
    for (const trade of trades) {
        if (trade?.type !== 'sell' || !trade.isMargin || trade.marginInterest !== undefined || !(trade.marginRepay && trade.marginRepay > 0)) continue
        const key = JSON.stringify([trade.date, trade.code, trade.brokerAccount || ''])
        legacyGroups.set(key, [...(legacyGroups.get(key) ?? []), trade])
    }
    for (const group of legacyGroups.values()) {
        const totalRepay = group.reduce((sum, trade) => sum + (trade.marginRepay || 0), 0)
        const totalPrincipal = group.reduce((sum, trade) => sum + (recordedPrincipal(trade) ?? estimateMarginRepayment(trade, trades, dividends).principal), 0)
        const totalInterest = Math.max(Math.round(totalRepay - totalPrincipal), 0)
        let allocated = 0
        group.forEach((trade, index) => {
            const interest = index === group.length - 1
                ? totalInterest - allocated
                : Math.round(totalInterest * (trade.marginRepay || 0) / totalRepay)
            legacyMarginInterest.set(trade, interest)
            allocated += interest
        })
    }
    const marginLedger = new MarginLedger()

    for (const ev of events) {
        if (options.beforeTrade && (ev.date > options.beforeTrade.date
            || (ev.date === options.beforeTrade.date && (ev.kind === 'trade' ? compareTradeRecords(ev.trade, options.beforeTrade) >= 0 : !ev.div.stockDistributionDate)))) break
        if (ev.date !== lastDate) { snapshot(); lastDate = ev.date }
        if (ev.kind === 'stockdiv') {
            // ── 配股：增加股數，攤薄均價，成本不變 ──
            const div = ev.div
            if (div.stockDividendMarginShares !== undefined && (!Number.isInteger(div.stockDividendMarginShares)
                || div.stockDividendMarginShares < 0 || div.stockDividendMarginShares > div.stockDividend)) {
                throw new Error(`${div.code} 配股中的融資股數必須是 0 至配股總股數的整數`)
            }
            let pos = holdings[div.code]
            if (!pos || pos.shares <= 0) {
                if ((div.stockDividendMarginShares ?? 0) > 0) throw new Error(`${div.code} 配股指定融資庫存，但配發日沒有融資部位`)
                // 除權後賣掉原股票不會喪失配股權利；確認配發的股份仍應入帳。
                // 缺少實際配發日的舊紀錄不憑空建立新持倉。
                if (!div.stockDistributionDate) continue
                pos = holdings[div.code] = { code: div.code, name: div.name || pos?.name || div.code,
                    shares: 0, avgCost: 0, totalCost: 0, marginAmount: marginLedger.debt(div.code) }
                if (useFifo) (inventoryLots[div.code] ??= []).push({ date: div.date, shares: div.stockDividend,
                    cost: 0, isMargin: false, account: '', session: 'unknown', source: 'stock-dividend' })
                pos.shares = div.stockDividend
                acquisitionTime[div.code] = Date.parse(div.date)
                continue
            }
            const newShares = pos.shares + div.stockDividend
            if (useFifo) {
                const lots = (inventoryLots[div.code] || []).filter(lot => lot.shares > 0)
                const marginShares = div.stockDividendMarginShares ?? 0
                const marginHeld = lots.some(lot => lot.isMargin)
                if (marginHeld || marginShares > 0) {
                    // Credit-account dividends need actual custody classification; never borrow
                    // their shares to validate a margin sale based on total holdings alone.
                    if (marginShares > 0 && !marginHeld) throw new Error(`${div.code} 配股指定融資庫存，但配發日沒有融資部位`)
                    const accounts = [...new Set(lots.map(lot => lot.account))]
                    if (accounts.length > 1) throw new Error(`${div.code} 配股前的元大帳戶標記不一致，請先核對原買入紀錄`)
                    const account = accounts[0] || ''
                    let movedCost = 0, movedGrossCost = 0
                    const shifted = lots.map(lot => {
                        const gross = lot.grossCost ?? lot.cost
                        const retained = Math.floor(lot.cost * pos.shares / newShares)
                        const cost = lot.cost - retained
                        movedCost += cost
                        lot.cost = retained
                        const retainedGross = Math.floor(gross * pos.shares / newShares)
                        const grossCost = gross - retainedGross
                        movedGrossCost += grossCost
                        lot.grossCost = retainedGross
                        lot.stockDividendAdjusted = true
                        return { lot, cost, grossCost }
                    })
                    const cashShares = div.stockDividend - marginShares
                    const marginCost = cashShares ? Math.floor(movedCost * marginShares / div.stockDividend) : movedCost
                    const marginGrossCost = cashShares ? Math.floor(movedGrossCost * marginShares / div.stockDividend) : movedGrossCost
                    if (marginShares) {
                        // The debt ledger expands the original credit lots. Expand the same
                        // FIFO inventory lots too, retaining their buy IDs and holding dates.
                        const credit = shifted.filter(item => item.lot.isMargin)
                        const weights = credit.map(item => item.lot.shares)
                        const extras = allocateByWeight(marginShares, weights)
                        const costs = allocateByWeight(marginCost, credit.some(item => item.cost > 0) ? credit.map(item => item.cost) : weights)
                        const grossCosts = allocateByWeight(marginGrossCost, credit.some(item => item.grossCost > 0) ? credit.map(item => item.grossCost) : weights)
                        credit.forEach(({ lot }, i) => {
                            lot.shares += extras[i]
                            lot.cost += costs[i]
                            lot.grossCost = (lot.grossCost ?? 0) + grossCosts[i]
                        })
                    }
                    if (cashShares) inventoryLots[div.code].push({ date: div.date, shares: cashShares, cost: movedCost - marginCost,
                        grossCost: movedGrossCost - marginGrossCost,
                        isMargin: false, account, session: 'unknown', source: 'stock-dividend',
                        classificationPending: div.stockDividendMarginShares === undefined })
                    marginLedger.distribute(div.code, marginShares)
                } else {
                    let remaining = div.stockDividend
                    lots.forEach((lot, index) => {
                        const extra = index === lots.length - 1 ? remaining : Math.floor(div.stockDividend * lot.shares / pos.shares)
                        lot.shares += extra
                        remaining -= extra
                    })
                }
            } else {
                marginLedger.distribute(div.code, div.stockDividendMarginShares ?? 0)
            }
            pos.avgCost = pos.totalCost / newShares
            pos.shares = newShares
            continue
        }

        const t = ev.trade
        const { code, name, type, price, fee, tax } = t
        const matched = dayTrades.matchedShares.get(t) || 0
        const shares = t.shares - matched
        if (useFifo && t.inventoryMatches !== undefined && (t.type !== 'sell' || t.isMargin || shares <= 0)) {
            throw new Error(`${t.date} ${code} 的券商庫存沖抵僅適用有剩餘庫存股數的現股賣出`)
        }
        const remainingRatio = shares / t.shares
        if (type === 'sell' && matched > 0) {
            const cost = dayCosts.get(t) || 0
            const pnl = (calcGrossAmount(price, t.shares) - fee - tax) * matched / t.shares - cost
            realized.push({ date: t.date, code, name, shares: matched, avgCost: cost / matched,
                sellPrice: price, realized: pnl, returnRate: cost > 0 ? pnl / cost : 0,
                tradeId: t.id, category: 'dayTrade', holdingDays: 0 })
        }

        // 防呆：跳過欄位不完整的紀錄
        if (!code || !type || !Number.isFinite(price) || !Number.isFinite(shares) || price <= 0 || shares <= 0) continue

        if (!holdings[code]) {
            holdings[code] = { code, name, shares: 0, avgCost: 0, totalCost: 0, marginAmount: 0 }
        }
        const pos = holdings[code]

        if (type === 'buy') {
            const buyCost = (calcGrossAmount(price, t.shares) + (fee || 0)) * remainingRatio
            const newTotalCost = pos.totalCost + buyCost
            const newShares = pos.shares + shares
            acquisitionTime[code] = ((acquisitionTime[code] || 0) * pos.shares + Date.parse(t.date) * shares) / newShares
            pos.avgCost = newShares > 0 ? newTotalCost / newShares : 0
            pos.totalCost = newTotalCost
            pos.shares = newShares
            pos.name = name || pos.name
            if (useFifo) (inventoryLots[code] ??= []).push({ buyId: t.id, date: t.date, shares, cost: buyCost,
                grossCost: calcGrossAmount(price, t.shares) * remainingRatio,
                isMargin: !!t.isMargin, account: t.brokerAccount || '', session: inferTradingSession(t) })

            if (t.isMargin) {
                marginLedger.apply(t)
                pos.marginAmount = marginLedger.debt(code)
            }
        } else if (type === 'sell') {
            // 超賣不是合法的多頭交易。直接略過，避免舊資料或繞過 UI 的匯入資料
            // 以不存在的均價產生已實現損益、再被歸零而污染後續所有報表。
            if (pos.shares <= 0 || shares > pos.shares) {
                if (useFifo && t.inventoryMatches !== undefined) throw new Error(`${t.date} ${code} 的券商庫存沖抵批次剩餘股數不足`)
                continue
            }
            const eligibleLots = useFifo ? (inventoryLots[code] || []).filter(lot => lot.shares > 0 && !lot.classificationPending
                && lot.isMargin === !!t.isMargin && lot.account === (t.brokerAccount || '')) : []
            const links = t.inventoryMatches
            const specifiedLots = useFifo && links !== undefined ? (() => {
                // 指定批次失效不能默默改扣 FIFO：必須讓使用者修復來源連結。
                if (!Array.isArray(links) || !links.length || links.some(link => !link || typeof link.buyId !== 'string'
                    || !link.buyId || !Number.isInteger(link.shares) || link.shares <= 0)
                    || new Set(links.map(link => link.buyId)).size !== links.length
                    || links.reduce((sum, link) => sum + link.shares, 0) !== shares) {
                    throw new Error(`${t.date} ${code} 的券商庫存沖抵股數或批次格式錯誤`)
                }
                return links.map(link => {
                    const candidates = eligibleLots.filter(lot => lot.buyId === link.buyId)
                    const lot = candidates[0]
                    if (candidates.length !== 1 || lot.shares < link.shares) throw new Error(`${t.date} ${code} 的券商庫存沖抵批次不存在、重複或剩餘股數不足`)
                    return { lot, shares: link.shares }
                })
            })() : null
            if (useFifo && eligibleLots.reduce((sum, lot) => sum + lot.shares, 0) < shares) {
                if (!options.skipUnmatchedSells && (inventoryLots[code] || []).some(lot => lot.shares > 0 && (lot.source === 'stock-dividend' || lot.stockDividendAdjusted))) {
                    throw new Error(`${t.date} ${code} 賣出超過該類別可用庫存，請在股利頁核對元大配股中的融資股數`)
                }
                continue
            }
            if (t.isMargin && !marginLedger.apply(t)) {
                if (options.skipUnmatchedSells) continue
                throw new Error(`${t.date} ${code} 的融資庫存與配股分類不一致，請核對元大配股及償還紀錄；未將此賣出計入持倉損益`)
            }
            // 融資利息是交易成本；本金只是償還負債，不影響投資損益。
            const financingInterest = t.isMargin ? Math.max(t.marginInterest ?? legacyMarginInterest.get(t) ?? 0, 0) : 0
            const sellRevenue = (calcGrossAmount(price, t.shares) - (fee || 0) - (tax || 0)) * remainingRatio - financingInterest
            let costBasis = pos.avgCost * shares
            let soldAcquisitionTime = acquisitionTime[code] || Date.parse(t.date)
            if (useFifo) {
                let remaining = shares
                costBasis = 0
                soldAcquisitionTime = 0
                for (const item of specifiedLots ?? eligibleLots.map(lot => ({ lot, shares: lot.shares }))) {
                    if (remaining <= 0) break
                    const { lot } = item
                    const taken = Math.min(remaining, item.shares)
                    // 部分沖銷成本捨去元以下，尾差留在尚未賣出的批次；全數賣出取完剩餘成本。
                    const allocatedCost = taken === lot.shares ? lot.cost : calcGrossAmount(lot.cost / lot.shares, taken)
                    if (lot.grossCost !== undefined) lot.grossCost -= taken === lot.shares ? lot.grossCost : calcGrossAmount(lot.grossCost / lot.shares, taken)
                    costBasis += allocatedCost
                    soldAcquisitionTime += Date.parse(lot.date) * taken / shares
                    lot.cost -= allocatedCost
                    lot.shares -= taken
                    remaining -= taken
                }
            }
            const pnl = sellRevenue - costBasis
            const returnRate = costBasis > 0 ? pnl / costBasis : 0
            realized.push({
                date: t.date, code, name: name || pos.name, shares,
                avgCost: costBasis / shares, sellPrice: price, realized: pnl, returnRate,
                tradeId: t.id, category: 'inventory',
                holdingDays: Math.max(0, (Date.parse(t.date) - soldAcquisitionTime) / 86400000)
            })

            if (t.isMargin) pos.marginAmount = marginLedger.debt(code)

            pos.shares -= shares
            pos.totalCost -= costBasis
            if (useFifo && pos.shares > 0) pos.avgCost = pos.totalCost / pos.shares
            if (pos.shares <= 0) {
                pos.shares = 0
                pos.totalCost = 0
                pos.avgCost = 0
                pos.marginAmount = marginLedger.debt(code)
            }
        }
    }

    snapshot()
    return { holdings, realized, ...(options.includeDailyHoldings ? { dailyHoldings } : {}),
        ...(options.includeInventoryLots ? { inventoryLots } : {}) }
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
    cashflows: { date?: string; type: string; amount: number }[],
    trades: TradeRecord[],
    dividends: { date?: string; cashDividend?: number; cashPaymentDate?: string; status?: string }[],
    asOf?: string
): number {
    if (asOf) {
        cashflows = cashflows.filter(c => isEffectiveOn(c.date, asOf))
        trades = trades.filter(t => isEffectiveOn(t.date, asOf))
    }
    dividends = dividends.filter(d => d.status !== 'announced' && (!asOf || isEffectiveOn(d.cashPaymentDate || d.date, asOf)))
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

export interface PortfolioAllocationInput {
    code: string
    name?: string
    currentMarketValue: number
    currentShares: number
    price: number | null
    /** 這檔股票占「股票部位」的目標比重，而非占總資產的比重。 */
    targetWeightPct: number
}

export interface PortfolioRebalanceRow extends PortfolioAllocationInput {
    action: 'buy' | 'sell' | 'hold'
    targetMarketValue: number
    adjustmentAmount: number
    estimatedShares: number | null
    estimatedTradeValue: number
    estimatedFee: number
    estimatedTax: number
    projectedMarketValue: number
    limitedByMode: boolean
    limitedByHoldings: boolean
}

export interface PortfolioRebalanceOptions {
    mode?: 'full' | 'buy-only' | 'sell-only'
    lotSize?: 1 | 1000
    includeFees?: boolean
}

export interface PortfolioRebalanceResult {
    equityCapital: number
    targetPositionPct: number
    targetStockMarketValue: number
    allocatedWeightPct: number
    rows: PortfolioRebalanceRow[]
    totalBuy: number
    totalSell: number
    totalFees: number
    totalTaxes: number
    netCashRequired: number
}

/**
 * 多檔投資組合再平衡試算。
 *
 * 先用「自有資金 × 目標倉位」決定整體股票水位，再依每檔股票占股票部位的
 * 目標比重拆分。交易股數以參考價四捨五入到整股；沒有有效價格時仍會回傳
 * 應調整金額，但 estimatedShares 為 null，讓 UI 明確提示補價格。
 */
export function calcPortfolioRebalance(
    equityCapital: number,
    targetPositionPct: number,
    inputs: PortfolioAllocationInput[],
    options: PortfolioRebalanceOptions = {},
): PortfolioRebalanceResult | null {
    if (
        !Number.isFinite(equityCapital)
        || equityCapital <= 0
        || !Number.isFinite(targetPositionPct)
        || targetPositionPct < 0
    ) return null

    const targetStockMarketValue = equityCapital * targetPositionPct / 100
    const mode = options.mode ?? 'full'
    const lotSize = options.lotSize ?? 1
    const safeInputs = inputs.filter(row => (
        row
        && row.code.trim() !== ''
        && Number.isFinite(row.currentMarketValue)
        && row.currentMarketValue >= 0
        && Number.isFinite(row.currentShares)
        && row.currentShares >= 0
        && Number.isFinite(row.targetWeightPct)
        && row.targetWeightPct >= 0
    ))
    const allocatedWeightPct = safeInputs.reduce((sum, row) => sum + row.targetWeightPct, 0)

    const rows = safeInputs.map(row => {
        const targetMarketValue = targetStockMarketValue * row.targetWeightPct / 100
        const difference = targetMarketValue - row.currentMarketValue
        const adjustmentAmount = Math.abs(difference)
        const desiredAction: PortfolioRebalanceRow['action'] = adjustmentAmount < 0.005
            ? 'hold'
            : difference > 0 ? 'buy' : 'sell'
        const limitedByMode = (mode === 'buy-only' && desiredAction === 'sell')
            || (mode === 'sell-only' && desiredAction === 'buy')
        const action: PortfolioRebalanceRow['action'] = limitedByMode ? 'hold' : desiredAction
        const validPrice = typeof row.price === 'number' && Number.isFinite(row.price) && row.price > 0
        const requestedShares = action === 'hold' || !validPrice
            ? action === 'hold' ? 0 : null
            : Math.max(lotSize, Math.round(adjustmentAmount / row.price! / lotSize) * lotSize)
        const availableShares = Math.floor(row.currentShares / lotSize) * lotSize
        const limitedByHoldings = action === 'sell' && requestedShares !== null && requestedShares > availableShares
        const estimatedShares = limitedByHoldings ? availableShares : requestedShares
        const estimatedTradeValue = estimatedShares === null
            ? 0
            : estimatedShares * (validPrice ? row.price! : 0)
        const estimatedFee = options.includeFees && action !== 'hold' && estimatedShares !== null && estimatedShares > 0 && validPrice
            ? calcFee(row.price!, estimatedShares)
            : 0
        const estimatedTax = options.includeFees && action === 'sell' && estimatedShares !== null && estimatedShares > 0 && validPrice
            ? calcTax(row.price!, estimatedShares, row.code)
            : 0
        const signedShares = estimatedShares === null
            ? 0
            : (action === 'buy' ? estimatedShares : action === 'sell' ? -estimatedShares : 0)
        const projectedMarketValue = Math.max(0, row.currentMarketValue + signedShares * (validPrice ? row.price! : 0))

        return {
            ...row,
            action,
            targetMarketValue,
            adjustmentAmount,
            estimatedShares,
            estimatedTradeValue,
            estimatedFee,
            estimatedTax,
            projectedMarketValue,
            limitedByMode,
            limitedByHoldings,
        }
    })

    const totalBuy = rows.filter(row => row.action === 'buy').reduce((sum, row) => sum + row.estimatedTradeValue, 0)
    const totalSell = rows.filter(row => row.action === 'sell').reduce((sum, row) => sum + row.estimatedTradeValue, 0)
    const totalFees = rows.reduce((sum, row) => sum + row.estimatedFee, 0)
    const totalTaxes = rows.reduce((sum, row) => sum + row.estimatedTax, 0)

    return {
        equityCapital,
        targetPositionPct,
        targetStockMarketValue,
        allocatedWeightPct,
        rows,
        totalBuy,
        totalSell,
        totalFees,
        totalTaxes,
        netCashRequired: totalBuy - totalSell + totalFees + totalTaxes,
    }
}

export interface PortfolioRiskRow {
    code: string
    group?: string
    projectedMarketValue: number
}

export interface PortfolioRiskLimits {
    maxSingleWeightPct: number
    maxGroupWeightPct: number
    minCashPct: number
    maxMarginPct: number
    minEtfWeightPct: number
    maxStressLoss: number
}

export interface PortfolioRiskIssue {
    id: string
    severity: 'warning' | 'danger'
    message: string
}

export interface PortfolioRiskResult {
    projectedMarketValue: number
    projectedNetAssets: number
    cashPct: number
    marginPct: number
    etfWeightPct: number
    groupWeights: Array<{ group: string; weightPct: number; marketValue: number }>
    stressDropPct: number
    stressLoss: number
    stressedMarketValue: number
    stressedNetAssets: number
    stressedPositionPct: number | null
    issues: PortfolioRiskIssue[]
}

/** 組合試算後的集中度、資金與壓力風險檢查。 */
export function calcPortfolioRisk(
    rows: PortfolioRiskRow[],
    cashAfter: number,
    marginDebt: number,
    stressDropPct: number,
    limits: PortfolioRiskLimits,
): PortfolioRiskResult {
    const validRows = rows.filter(row => Number.isFinite(row.projectedMarketValue) && row.projectedMarketValue >= 0)
    const projectedMarketValue = validRows.reduce((sum, row) => sum + row.projectedMarketValue, 0)
    const projectedNetAssets = projectedMarketValue + cashAfter - marginDebt
    const cashPct = projectedNetAssets > 0 ? cashAfter / projectedNetAssets * 100 : 0
    const marginPct = projectedNetAssets > 0 ? marginDebt / projectedNetAssets * 100 : marginDebt > 0 ? Infinity : 0
    const etfValue = validRows.filter(row => isETF(row.code)).reduce((sum, row) => sum + row.projectedMarketValue, 0)
    const etfWeightPct = projectedMarketValue > 0 ? etfValue / projectedMarketValue * 100 : 0

    const groupMap = new Map<string, number>()
    validRows.forEach(row => {
        const group = row.group?.trim() || '未分類'
        groupMap.set(group, (groupMap.get(group) ?? 0) + row.projectedMarketValue)
    })
    const groupWeights = [...groupMap.entries()]
        .map(([group, marketValue]) => ({ group, marketValue, weightPct: projectedMarketValue > 0 ? marketValue / projectedMarketValue * 100 : 0 }))
        .sort((a, b) => b.marketValue - a.marketValue)

    const safeDrop = Number.isFinite(stressDropPct) ? Math.min(Math.max(stressDropPct, 0), 100) : 0
    const stressLoss = projectedMarketValue * safeDrop / 100
    const stressedMarketValue = projectedMarketValue - stressLoss
    const stressedNetAssets = stressedMarketValue + cashAfter - marginDebt
    const stressedPositionPct = stressedNetAssets > 0 ? stressedMarketValue / stressedNetAssets * 100 : null
    const issues: PortfolioRiskIssue[] = []

    validRows.forEach(row => {
        const weight = projectedMarketValue > 0 ? row.projectedMarketValue / projectedMarketValue * 100 : 0
        if (limits.maxSingleWeightPct > 0 && weight > limits.maxSingleWeightPct + 0.05) {
            issues.push({ id: `single-${row.code}`, severity: 'warning', message: `${row.code} 試算後占股票部位 ${weight.toFixed(1)}%，超過單一個股上限 ${limits.maxSingleWeightPct.toFixed(1)}%。` })
        }
    })
    groupWeights.forEach(group => {
        if (limits.maxGroupWeightPct > 0 && group.weightPct > limits.maxGroupWeightPct + 0.05) {
            issues.push({ id: `group-${group.group}`, severity: 'warning', message: `${group.group} 占股票部位 ${group.weightPct.toFixed(1)}%，超過產業上限 ${limits.maxGroupWeightPct.toFixed(1)}%。` })
        }
    })
    if (cashPct < limits.minCashPct - 0.05) issues.push({ id: 'cash-floor', severity: cashAfter < 0 ? 'danger' : 'warning', message: `試算後現金水位 ${cashPct.toFixed(1)}%，低於安全水位 ${limits.minCashPct.toFixed(1)}%。` })
    if (marginPct > limits.maxMarginPct + 0.05) issues.push({ id: 'margin-cap', severity: 'danger', message: `融資負債占淨資產 ${Number.isFinite(marginPct) ? marginPct.toFixed(1) : '∞'}%，超過上限 ${limits.maxMarginPct.toFixed(1)}%。` })
    if (etfWeightPct < limits.minEtfWeightPct - 0.05) issues.push({ id: 'etf-floor', severity: 'warning', message: `ETF 占股票部位 ${etfWeightPct.toFixed(1)}%，低於設定下限 ${limits.minEtfWeightPct.toFixed(1)}%。` })
    if (limits.maxStressLoss > 0 && stressLoss > limits.maxStressLoss) issues.push({ id: 'stress-loss', severity: 'danger', message: `下跌 ${safeDrop.toFixed(1)}% 時預估損失 ${Math.round(stressLoss).toLocaleString()} 元，超過可承受上限 ${Math.round(limits.maxStressLoss).toLocaleString()} 元。` })
    if (stressedNetAssets <= 0) issues.push({ id: 'negative-equity', severity: 'danger', message: `壓力情境下淨資產降至 ${Math.round(stressedNetAssets).toLocaleString()} 元，應降低槓桿或股票水位。` })

    return {
        projectedMarketValue, projectedNetAssets, cashPct, marginPct, etfWeightPct,
        groupWeights, stressDropPct: safeDrop, stressLoss, stressedMarketValue,
        stressedNetAssets, stressedPositionPct, issues,
    }
}

export interface MarginPositionAgg {
    code: string
    name: string
    shares: number
    marginAmount: number   // FIFO 批次剩餘本金（買入借款採實際值或千元估算）
    marginCost: number     // FIFO 尚未售出融資批次的原始股票市值
}

export function aggregateMarginPositions(trades: TradeRecord[], asOf?: string, dividends: DividendRecord[] = []): MarginPositionAgg[] {
    const ledger = buildMarginLedger(trades.filter(t => t && t.date && (!asOf || isEffectiveOn(t.date, asOf))),
        dividends.filter(d => !asOf || isEffectiveOn(d.stockDistributionDate || d.date, asOf)))
    const positions = ledger.positions()
    if (dividends.some(d => d.status !== 'announced' && d.stockDividend > 0 && (!asOf || isEffectiveOn(d.stockDistributionDate || d.date, asOf)))) {
        const inventory = calcPositions(trades, dividends, { asOf, includeInventoryLots: true }).inventoryLots || {}
        for (const position of positions) position.marginCost = (inventory[position.code] || [])
            .filter(lot => lot.isMargin && lot.shares > 0).reduce((sum, lot) => sum + (lot.grossCost ?? lot.cost), 0)
    }
    return positions
}

export function aggregateMarginDebt(trades: TradeRecord[], asOf?: string, dividends: DividendRecord[] = []): number {
    return aggregateMarginPositions(trades, asOf, dividends).reduce((sum, pos) => sum + pos.marginAmount, 0)
}

export interface ReconciledAssetSnapshot {
    date: string
    totalAssets: number
    marketValue: number
    cash: number
    marginDebt?: number
}

/**
 * Rebuild the auditable cash/debt breakdown of stored historical snapshots.
 *
 * `totalAssets` is deliberately preserved because it is the point-in-time NAV
 * used by the performance chart. Backdated ledger edits can be replayed
 * exactly for cash and margin debt, but historical per-stock closing prices are
 * not stored. Market value therefore becomes the balancing component so the
 * corrected breakdown cannot create a fake investment return.
 */
export function reconcileSnapshotBreakdowns<T extends ReconciledAssetSnapshot>(
    snapshots: T[],
    trades: TradeRecord[],
    dividends: DividendRecord[],
    cashflows: { date: string; type: string; amount: number }[],
): T[] {
    return snapshots.map(snapshot => {
        const datedTrades = trades.filter(row => row.date <= snapshot.date)
        const datedDividends = dividends
        const datedCashflows = cashflows.filter(row => row.date <= snapshot.date)
        const cash = Math.round(calcAvailableCash(datedCashflows, datedTrades, datedDividends, snapshot.date))
        const marginDebt = Math.round(aggregateMarginDebt(datedTrades, snapshot.date, datedDividends))
        const marketValue = Math.round(snapshot.totalAssets - cash + marginDebt)
        return { ...snapshot, cash, marginDebt, marketValue }
    })
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

export interface MarginRiskThresholds {
    safeRatio: number
    maintenanceRatio: number
    liquidationRatio: number
}

export const DEFAULT_MARGIN_RISK_THRESHOLDS: MarginRiskThresholds = {
    safeRatio: 160,
    maintenanceRatio: 130,
    liquidationRatio: 120,
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
    marginRatio: number = 0.6,
    thresholds: MarginRiskThresholds = DEFAULT_MARGIN_RISK_THRESHOLDS,
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
    const bufferTo130 = newMarketValue - newDebt * (thresholds.maintenanceRatio / 100)
    const bufferTo120 = newMarketValue - newDebt * (thresholds.liquidationRatio / 100)

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

export function calcMarginStress(
    stocks: MarginStressStock[],
    totalDebt: number,
    dropPcts: number[] = [0.10, 0.15, 0.20],
    thresholds: MarginRiskThresholds = DEFAULT_MARGIN_RISK_THRESHOLDS,
): MarginStressResult {
    const totalMarketValue = stocks.reduce((s, x) => s + (x.marketValue || 0), 0)

    if (totalDebt <= 0 || totalMarketValue <= 0) {
        return { totalMarketValue, totalDebt, currentRatio: null, dropTo130: null, dropTo120: null, scenarios: [], perStock: [] }
    }

    const currentRatio = (totalMarketValue / totalDebt) * 100

    // 整戶均勻跌：反解觸線跌幅 d* = 1 − 線 × 借款 / 市值
    const maintenanceCall = thresholds.maintenanceRatio / 100
    const liquidationLine = thresholds.liquidationRatio / 100
    const dropTo130 = 1 - (maintenanceCall * totalDebt) / totalMarketValue
    const dropTo120 = 1 - (liquidationLine * totalDebt) / totalMarketValue

    const scenarios: MarginStressScenario[] = dropPcts.map(d => {
        const ratio = currentRatio * (1 - d)
        return { drop: d, ratio, gapTo130: ratio - thresholds.maintenanceRatio }
    })

    // 單檔獨自跌：整戶市值少掉 (Vᵢ × dᵢ)，令整戶維持率 = 追繳線
    //   → dᵢ = (整戶市值 − 追繳線 × 借款) / Vᵢ。分子為共用緩衝，分母越大（越集中）能撐的跌幅越小。
    const buffer = totalMarketValue - maintenanceCall * totalDebt
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

/** A missing/invalid effective date is never evidence that money has arrived. */
export function isEffectiveOn(date: string | undefined, asOf: string): boolean {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
    const parsed = new Date(date + 'T00:00:00Z')
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date && date <= asOf
}
