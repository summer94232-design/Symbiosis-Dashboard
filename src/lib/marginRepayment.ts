import { calcTradeTotal, type TradeRecord } from './calc'

export type MarginRepaymentField = 'marginPrincipal' | 'marginInterest' | 'marginRepay'

/** Broker principal and interest are independent amounts; their sum drives cash. */
export function updateMarginRepayment<T extends TradeRecord>(trade: T, field: MarginRepaymentField, value: number): T {
    if (trade.type !== 'sell' || !trade.isMargin) return trade
    const principal = field === 'marginPrincipal' ? value : trade.marginPrincipal ?? 0
    const interest = field === 'marginInterest' ? value
        : field === 'marginRepay' ? value - principal : trade.marginInterest ?? 0
    const updated = { ...trade, marginPrincipal: principal, marginInterest: interest,
        marginRepay: principal + interest, marginRepayManual: true }
    return { ...updated, total: calcTradeTotal(updated) }
}

/** Preserve a broker breakdown (including explicit zero) in both CSV import paths. */
export function importMarginRepaymentCsv(row: Record<string, string>, enabled: boolean): Pick<TradeRecord,
    'marginRepay' | 'marginPrincipal' | 'marginInterest' | 'marginRepayManual'> {
    if (!enabled) return { marginRepay: 0, marginRepayManual: false }
    const amount = (key: string) => row[key]?.trim() ? Number(row[key].replaceAll(',', '').trim()) : undefined
    const total = amount('融資償還金額')
    let principal = amount('融資本金'), interest = amount('融資利息')
    if (principal === undefined && interest !== undefined && total !== undefined) principal = total - interest
    if (interest === undefined && principal !== undefined && total !== undefined) interest = total - principal
    const marginRepay = total ?? (principal !== undefined && interest !== undefined ? principal + interest : 0)
    return { marginRepay, marginRepayManual: marginRepay > 0 || principal !== undefined || interest !== undefined,
        ...(principal !== undefined ? { marginPrincipal: principal } : {}),
        ...(interest !== undefined ? { marginInterest: interest } : {}) }
}
