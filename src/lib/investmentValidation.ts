import { calcTradeTotal, inferTradingSession, type TradeRecord } from './calc'

export interface InvestmentValidationResult {
    valid: boolean
    errors: string[]
    warnings: string[]
}

type CashflowInput = { date: string; type: string; amount: number }
type DividendInput = { sourceAnnouncementId?: string; status?: string; cashPaymentDate?: string; stockDistributionDate?: string; stockDividendMarginShares?: number; date: string; code: string; name?: string; cashDividend: number; stockDividend: number }
type SnapshotInput = { date: string; totalAssets: number; marketValue: number; cash: number; marginDebt?: number; valuationQuality?: string }

function result(errors: string[], warnings: string[] = []): InvestmentValidationResult {
    return { valid: errors.length === 0, errors, warnings }
}

function isRealIsoDate(value: string): boolean {
    const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!match) return false
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    return date.getUTCFullYear() === Number(match[1])
        && date.getUTCMonth() === Number(match[2]) - 1
        && date.getUTCDate() === Number(match[3])
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

export function normalizeTaiwanStockCode(value: string): string {
    return String(value ?? '').trim().toUpperCase().replace(/\.TW$/, '')
}

export function validateTradeForWrite(trade: TradeRecord): InvestmentValidationResult {
    const errors: string[] = []
    const warnings: string[] = []
    const code = normalizeTaiwanStockCode(trade.code)

    if (!isRealIsoDate(trade.date)) errors.push('日期不是有效的西元日期')
    if (trade.type !== 'buy' && trade.type !== 'sell') errors.push('交易類型必須是買入或賣出')
    if (!/^\d{4,6}[A-Z]?$/.test(code)) errors.push('股票代號格式不正確')
    if (!isFiniteNumber(trade.price) || trade.price <= 0) errors.push('價格必須大於 0')
    if (!isFiniteNumber(trade.shares) || trade.shares <= 0 || !Number.isInteger(trade.shares)) errors.push('股數必須是大於 0 的整數')
    if (!isFiniteNumber(trade.fee) || (trade.fee ?? 0) < 0 || !Number.isInteger(trade.fee ?? 0)) errors.push('手續費必須是非負整數')
    if (!isFiniteNumber(trade.tax) || (trade.tax ?? 0) < 0 || !Number.isInteger(trade.tax ?? 0)) errors.push('交易稅必須是非負整數')
    if (!isFiniteNumber(trade.total) || (trade.total ?? 0) < 0 || !Number.isInteger(trade.total ?? 0)) errors.push('收付金額必須是非負整數')
    if (trade.brokerAccount !== undefined && typeof trade.brokerAccount !== 'string') errors.push('券商帳戶識別必須是文字')
    if (trade.tradingSession && !['regular', 'odd', 'block'].includes(trade.tradingSession)) errors.push('交易市場格式錯誤')
    if (trade.dayTradeMode && !['auto', 'manual'].includes(trade.dayTradeMode)) errors.push('當沖計算方式格式錯誤')
    for (const flag of [trade.dayTradePending, trade.dayTradeExcluded]) {
        if (flag !== undefined && typeof flag !== 'boolean') errors.push('當沖狀態必須是布林值')
    }
    if (trade.dayTradePending && (trade.isMargin || trade.type !== 'sell' || trade.dayTradeExcluded || inferTradingSession(trade) !== 'regular')) errors.push('待回補僅適用於未排除當沖的普通現股整張賣出')
    if (trade.dayTradeMatches !== undefined) {
        if (!Array.isArray(trade.dayTradeMatches)) errors.push('當沖配對必須是陣列')
        else if (trade.dayTradeMatches.length > 0) {
            if (trade.type !== 'sell' || trade.isMargin || trade.dayTradeExcluded || trade.tradingSession === 'odd' || trade.tradingSession === 'block') errors.push('此交易不能設定現股當沖配對')
            if (trade.dayTradeMatches.some(link => !link || typeof link.buyId !== 'string' || !link.buyId.trim() || !Number.isInteger(link.shares) || link.shares <= 0 || link.shares % 1000 !== 0)) errors.push('當沖配對需有買入紀錄 ID 與正整張股數')
            if (trade.dayTradeMatches.reduce((sum, link) => sum + (link?.shares || 0), 0) > trade.shares) errors.push('沖抵股數不可超過賣出股數')
        }
    }

    if (trade.inventoryMatches !== undefined) {
        const links = trade.inventoryMatches
        if (trade.type !== 'sell' || trade.isMargin || !Array.isArray(links) || !links.length) errors.push('券商庫存沖抵必須是現股賣出紀錄的非空批次清單')
        else if (links.some(link => !link || typeof link.buyId !== 'string' || !link.buyId.trim()
            || !Number.isInteger(link.shares) || link.shares <= 0)) errors.push('券商庫存沖抵需有買入紀錄 ID 與正整數股數')
        else if (new Set(links.map(link => link.buyId)).size !== links.length) errors.push('券商庫存沖抵不可重複指定同一買進批次')
        else if (links.reduce((sum, link) => sum + link.shares, 0) > trade.shares) errors.push('券商庫存沖抵股數不可超過賣出股數')
    }

    if (trade.isMargin) {
        if (!isFiniteNumber(trade.marginRatio) || (trade.marginRatio ?? 0) <= 0 || (trade.marginRatio ?? 0) > 1) {
            errors.push('融資成數必須大於 0 且不超過 1')
        }
        if (trade.type === 'sell') {
            const repay = trade.marginRepay ?? 0
            const principal = trade.marginPrincipal ?? 0
            const interest = trade.marginInterest ?? 0
            if (![repay, principal, interest].every(value => isFiniteNumber(value) && value >= 0 && Number.isInteger(value))) {
                errors.push('融資本金、利息與償還金額必須是非負整數')
            }
            if (repay <= 0) warnings.push('融資賣出尚未填入償還金額，可用現金可能被高估')
            if (principal + interest > 0 && repay !== principal + interest) {
                errors.push('融資償還金額必須等於本金加利息')
            }
        }
    }

    if (errors.length === 0 && isFiniteNumber(trade.total)) {
        const expected = calcTradeTotal(trade)
        if (Math.abs(expected - trade.total) > 2) {
            errors.push(`收付金額與費稅／融資資料不一致（依目前欄位應為 ${expected.toLocaleString()} 元）`)
        }
    }
    return result(errors, warnings)
}

export function validateCashflowForWrite(row: CashflowInput): InvestmentValidationResult {
    const errors: string[] = []
    if (!isRealIsoDate(row.date)) errors.push('日期不是有效的西元日期')
    if (row.type !== 'in' && row.type !== 'out') errors.push('類型必須是入金或出金')
    if (!isFiniteNumber(row.amount) || row.amount <= 0 || !Number.isInteger(row.amount)) errors.push('金額必須是大於 0 的整數')
    return result(errors)
}

export function validateDividendForWrite(row: DividendInput): InvestmentValidationResult {
    const errors: string[] = []
    if (row.sourceAnnouncementId !== undefined && (typeof row.sourceAnnouncementId !== 'string'
        || !['TWSE', 'TPEX'].some(market => row.sourceAnnouncementId === `${market}-${normalizeTaiwanStockCode(row.code)}-${row.date}`))) errors.push('來源公告與股票／除權息日期不一致')
    if (row.status !== undefined && !['announced', 'confirmed'].includes(row.status)) errors.push('股利狀態不正確')
    for (const [label, date] of [['現金入帳', row.cashPaymentDate], ['股票配發', row.stockDistributionDate]]) {
        if (date && (!isRealIsoDate(date) || date < row.date)) errors.push(label + '日期必須有效且不得早於除權息日期')
    }
    if (row.status === 'confirmed') {
        if (row.cashDividend > 0 && !row.cashPaymentDate) errors.push('已確認現金股利請填入帳日期')
        if (row.stockDividend > 0 && !row.stockDistributionDate) errors.push('已確認股票股利請填配發日期')
    }
    if (!isRealIsoDate(row.date)) errors.push('日期不是有效的西元日期')
    if (!/^\d{4,6}[A-Z]?$/.test(normalizeTaiwanStockCode(row.code))) errors.push('股票代號格式不正確')
    if (!row.name?.trim()) errors.push('股票名稱不可空白')
    if (!isFiniteNumber(row.cashDividend) || row.cashDividend < 0) errors.push('現金股利不可為負數')
    if (!isFiniteNumber(row.stockDividend) || row.stockDividend < 0) errors.push('股票股利不可為負數')
    if (row.stockDividendMarginShares !== undefined && (!Number.isInteger(row.stockDividendMarginShares)
        || row.stockDividendMarginShares < 0 || row.stockDividendMarginShares > row.stockDividend)) errors.push('配股中的融資股數須為 0 至股票股利股數的整數')
    if ((row.cashDividend || 0) === 0 && (row.stockDividend || 0) === 0) errors.push('現金股利與股票股利至少一項必須大於 0')
    return result(errors)
}

export function validateSnapshotForWrite(row: SnapshotInput): InvestmentValidationResult {
    if (row.valuationQuality !== undefined && !['closing', 'intraday', 'manual-unverified'].includes(row.valuationQuality)) return result(['快照估值狀態不正確'])
    const errors: string[] = []
    const debt = row.marginDebt ?? 0
    if (!isRealIsoDate(row.date)) errors.push('日期不是有效的西元日期')
    if (!isFiniteNumber(row.totalAssets)) errors.push('總資產必須是有效數字')
    if (!isFiniteNumber(row.marketValue) || row.marketValue < 0) errors.push('股票市值必須是非負數字')
    if (!isFiniteNumber(row.cash)) errors.push('現金必須是有效數字')
    if (!isFiniteNumber(debt) || debt < 0) errors.push('融資負債必須是非負數字')
    if (errors.length === 0 && Math.abs(row.totalAssets - (row.marketValue + row.cash - debt)) > 2) {
        errors.push('總資產必須等於股票市值加現金再扣除融資負債')
    }
    return result(errors)
}
