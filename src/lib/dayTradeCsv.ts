import type { TradeRecord } from './calc'

export function exportDayTradeFields(t: Pick<TradeRecord, 'brokerAccount' | 'tradingSession' | 'dayTradeExcluded' | 'dayTradePending' | 'dayTradeMatches' | 'dayTradeMode' | 'inventoryMatches'>) {
    return {
        '券商帳戶': t.brokerAccount || '',
        '交易市場': t.tradingSession || '',
        '不參與當沖': t.dayTradeExcluded ? 'true' : 'false',
        '當沖待回補': t.dayTradePending ? 'true' : 'false',
        '當沖配對': JSON.stringify(t.dayTradeMatches || []),
        '當沖計算方式': t.dayTradeMode || '',
        '指定庫存沖抵': t.inventoryMatches === undefined ? '' : JSON.stringify(t.inventoryMatches),
    }
}

export function importDayTradeFields(row: Record<string, string>): Pick<TradeRecord,
    'brokerAccount' | 'tradingSession' | 'dayTradeExcluded' | 'dayTradePending' | 'dayTradeMatches' | 'dayTradeMode' | 'inventoryMatches'> {
    const booleanField = (key: string) => {
        const value = (row[key] || '').trim()
        if (!['', 'true', 'false'].includes(value)) throw new Error(`${key} 格式錯誤`)
        return value === 'true'
    }
    const session = (row['交易市場'] || '').trim()
    const mode = (row['當沖計算方式'] || '').trim()
    if (!['', 'auto', 'manual'].includes(mode)) throw new Error('當沖計算方式格式錯誤')
    if (!['', 'regular', 'odd', 'block'].includes(session)) throw new Error('交易市場格式錯誤')
    const matches = JSON.parse(row['當沖配對'] || '[]')
    if (!Array.isArray(matches) || matches.some(link => !link || typeof link.buyId !== 'string'
        || !link.buyId.trim() || !Number.isInteger(link.shares) || link.shares <= 0 || link.shares % 1000 !== 0)) {
        throw new Error('當沖配對格式錯誤')
    }
    const inventoryText = (row['指定庫存沖抵'] || '').trim()
    const inventory = inventoryText ? JSON.parse(inventoryText) : undefined
    if (inventory !== undefined && (!Array.isArray(inventory) || !inventory.length
        || inventory.some(link => !link || typeof link.buyId !== 'string' || !link.buyId.trim()
            || link.buyId.includes('/') || !Number.isSafeInteger(link.shares) || link.shares <= 0)
        || new Set(inventory.map(link => link.buyId)).size !== inventory.length)) throw new Error('指定庫存沖抵格式錯誤')
    return { brokerAccount: (row['券商帳戶'] || '').trim(),
        ...(mode ? { dayTradeMode: mode as TradeRecord['dayTradeMode'] } : {}),
        ...(session ? { tradingSession: session as TradeRecord['tradingSession'] } : {}),
        dayTradeExcluded: booleanField('不參與當沖'), dayTradePending: booleanField('當沖待回補'),
        dayTradeMatches: matches.map(link => ({ buyId: link.buyId, shares: link.shares })),
        ...(inventory ? { inventoryMatches: inventory.map((link: { buyId: string; shares: number }) => ({ buyId: link.buyId, shares: link.shares })) } : {}) }
}

/** 先建立所有買入 ID，再匯入賣出連結；sourceIndex 保留原始同日順序。 */
export function orderTradeImportRows(rows: { row: Record<string, string>; sourceIndex: number }[]) {
    const isSell = (row: Record<string, string>) => ['賣出', '現貨賣出', '融資賣出'].includes(row['類型'])
    return [...rows].sort((a, b) => Number(isSell(a.row)) - Number(isSell(b.row))
        || (a.row['日期'] || '').localeCompare(b.row['日期'] || '')
        || (a.row['建立時間'] || '').localeCompare(b.row['建立時間'] || '')
        || (Number(a.row['同日順序'] || a.sourceIndex) - Number(b.row['同日順序'] || b.sourceIndex))
        || a.sourceIndex - b.sourceIndex)
}
