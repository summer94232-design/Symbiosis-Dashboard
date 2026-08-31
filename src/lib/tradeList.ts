import type { TradeRecord } from './calc'

const stockCodeOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const stockCode = (code: string) => (code || '').trim().toUpperCase().replace(/\.TW$/, '')
const createdTime = (value?: string) => {
    const timestamp = value ? Date.parse(value) : NaN
    return Number.isFinite(timestamp) ? timestamp : null
}

/** 僅供列表顯示，不改變庫存成本與當沖配對使用的計算順序。 */
export function compareTradeListRecords(a: TradeRecord, b: TradeRecord): number {
    const dateOrder = (b.date || '').localeCompare(a.date || '')
    if (dateOrder) return dateOrder
    const codeOrder = stockCodeOrder.compare(stockCode(a.code), stockCode(b.code))
    if (codeOrder) return codeOrder

    const timeA = createdTime(a.createdAt), timeB = createdTime(b.createdAt)
    if (timeA !== timeB) {
        if (timeA === null) return 1
        if (timeB === null) return -1
        return timeB - timeA
    }
    const sequenceA = Number.isFinite(a.sequence) ? a.sequence! : null
    const sequenceB = Number.isFinite(b.sequence) ? b.sequence! : null
    if (sequenceA !== sequenceB) {
        if (sequenceA === null) return 1
        if (sequenceB === null) return -1
        return sequenceB - sequenceA
    }
    // 舊紀錄沒有新增時間與來源順序時，ID 只作穩定排序，不視為成交時間。
    return (b.id || '').localeCompare(a.id || '')
}

export function getTradeDayTradeBadge(shares: number, matchedShares: number) {
    if (!Number.isFinite(matchedShares) || !Number.isFinite(shares) || matchedShares <= 0 || shares <= 0) return null
    const matched = Math.min(matchedShares, shares)
    const remaining = shares - matched
    return {
        label: remaining > 0 ? '部分當沖' : '當沖',
        description: `依帳本配對沖抵 ${matched.toLocaleString('zh-TW')} 股${remaining > 0 ? `；其餘 ${remaining.toLocaleString('zh-TW')} 股按一般庫存計算` : ''}。券商認列以對帳單為準。`,
    }
}
