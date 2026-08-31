import type { DividendRecord, HoldingPosition } from './calc'
import type { BrokerTradeRow } from './brokerReconciliation'

export interface BrokerStatementHolding {
    code: string
    name: string
    shares: number
    referencePrice?: number
    marketValue?: number
}

export interface BrokerStatementDividend {
    date: string
    code: string
    name: string
    amount: number
    description: string
}

export interface BrokerMonthlyDetails {
    cashBalance?: number
    cashBalanceDate?: string
    holdings: BrokerStatementHolding[]
    dividends: BrokerStatementDividend[]
}

export type MonthlyCheckStatus = 'matched' | 'mismatch' | 'missing-system' | 'missing-broker' | 'pending-broker'

export interface HoldingCheck {
    key: string
    status: MonthlyCheckStatus
    code: string
    name: string
    brokerShares?: number
    systemShares?: number
    difference: number
}

export interface DividendCheck {
    key: string
    status: MonthlyCheckStatus
    date: string
    code: string
    name: string
    brokerAmount?: number
    systemAmount?: number
    difference: number
}

export interface CashCheck {
    status: 'matched' | 'mismatch' | 'unavailable'
    brokerBalance?: number
    systemProjectedCash: number
    unsettledNet: number
    systemExpectedSettledCash: number
    difference?: number
}

function normalizeWidth(value: string): string {
    return value.normalize('NFKC').replace(/[\t\u00a0]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function normalizeSecurityName(value: string): string {
    return value.normalize('NFKC').toUpperCase()
        .replace(/股份有限公司|有限公司/g, '')
        .replace(/[^0-9A-Z\u3400-\u9fff]/g, '')
}

function numberValue(value: string | undefined): number | undefined {
    if (!value) return undefined
    const parsed = Number(value.replace(/[,()\s]/g, ''))
    return Number.isFinite(parsed) ? parsed : undefined
}

function sectionBetween(text: string, startMarker: string, endMarkers: string[]): string | null {
    const start = text.indexOf(startMarker)
    if (start < 0) return null
    const afterStart = text.slice(start + startMarker.length)
    const end = endMarkers.map(marker => afterStart.indexOf(marker)).filter(index => index >= 0).sort((a, b) => a - b)[0]
    return end === undefined ? afterStart : afterStart.slice(0, end)
}

function parseHoldings(text: string): BrokerStatementHolding[] {
    const section = sectionBetween(text, '上市、上櫃、興櫃庫存明細', ['合計:', '合計：', '※截至', '訊息通知'])?.trim()
    if (!section) return []
    return [...section.matchAll(/(?:^|\s)(\d{4,6}[A-Z]?)\s+([^\s]+)\s+((?:[\d,]+\s+)+)([\d,]+\.\d+)\s+([\d,]+)(?=\s+\d{4,6}[A-Z]?\s+|\s+合計|$)/g)].map(match => {
        const shares = (match[3].match(/[\d,]+/g) ?? []).reduce((sum, value) => sum + (numberValue(value) ?? 0), 0)
        return { code: match[1].toUpperCase(), name: match[2].trim(), shares, referencePrice: numberValue(match[4]), marketValue: numberValue(match[5]) }
    }).filter(row => row.shares > 0)
}

function parseCashSection(text: string): Pick<BrokerMonthlyDetails, 'cashBalance' | 'cashBalanceDate' | 'dividends'> {
    const section = sectionBetween(text, 'CMA(資金管理帳戶)交易明細及帳面餘額', ['合計 ', '訊息通知'])
    if (!section) return { dividends: [] }
    const rowStart = /(?=\d{4}\/\d{2}\/\d{2}\s+TWD\s+)/g
    const blocks = section.split(rowStart).map(block => block.trim()).filter(block => /^\d{4}\//.test(block))
    let cashBalance: number | undefined
    let cashBalanceDate: string | undefined
    const dividends: BrokerStatementDividend[] = []

    blocks.forEach(block => {
        const match = block.match(/^(\d{4}\/\d{2}\/\d{2})\s+TWD\s+(.+?)(?=\s+[\d,]+(?:\s|$))\s+(.+)$/)
        if (!match) return
        const date = match[1].replaceAll('/', '-')
        const description = match[2].trim()
        const values = match[3].match(/[\d,]+/g)?.map(value => numberValue(value)).filter((value): value is number => value !== undefined) ?? []
        if (description.includes('月底結餘') && values[0] !== undefined) {
            cashBalance = values[0]
            cashBalanceDate = date
        }
        if ((description.includes('現金股息') || description.includes('基金配')) && values[0] !== undefined) {
            const name = description.replace(/\((?:現金股息|基金配).*$/, '').trim()
            dividends.push({ date, code: '', name, amount: values[0], description })
        }
    })
    return { cashBalance, cashBalanceDate, dividends }
}

export function parseYuantaMonthlyDetails(rawText: string): BrokerMonthlyDetails {
    const text = normalizeWidth(rawText)
    const cash = parseCashSection(text)
    return { ...cash, holdings: parseHoldings(text) }
}

export function resolveBrokerDividendCodes(
    rows: BrokerStatementDividend[],
    systemDividends: DividendRecord[],
    holdings: BrokerStatementHolding[],
): BrokerStatementDividend[] {
    const names = new Map<string, string>()
    systemDividends.forEach(row => names.set(normalizeSecurityName(row.name), row.code.toUpperCase()))
    holdings.forEach(row => names.set(normalizeSecurityName(row.name), row.code.toUpperCase()))
    return rows.map(row => ({ ...row, code: row.code || names.get(normalizeSecurityName(row.name)) || '' }))
}

export function reconcileMonthlyHoldings(
    brokerRows: BrokerStatementHolding[],
    systemHoldings: Record<string, HoldingPosition>,
): HoldingCheck[] {
    const broker = new Map(brokerRows.map(row => [row.code.toUpperCase(), row]))
    const system = new Map(Object.values(systemHoldings).filter(row => row.shares > 0).map(row => [row.code.toUpperCase(), row]))
    return [...new Set([...broker.keys(), ...system.keys()])].sort().map(code => {
        const brokerRow = broker.get(code)
        const systemRow = system.get(code)
        const brokerShares = brokerRow?.shares
        const systemShares = systemRow?.shares
        const difference = (brokerShares ?? 0) - (systemShares ?? 0)
        const status: MonthlyCheckStatus = !systemRow ? 'missing-system' : !brokerRow ? 'missing-broker' : difference === 0 ? 'matched' : 'mismatch'
        return { key: code, status, code, name: brokerRow?.name || systemRow?.name || '', brokerShares, systemShares, difference }
    })
}

function dividendKey(row: { date: string; code: string; name: string }): string {
    return `${row.date}|${row.code.toUpperCase() || `name:${normalizeSecurityName(row.name)}`}`
}

export function reconcileMonthlyDividends(
    brokerRows: BrokerStatementDividend[],
    systemRows: DividendRecord[],
    periodStart?: string,
    periodEnd?: string,
): DividendCheck[] {
    const systemCandidates = systemRows.filter(row => row.cashDividend > 0)
    const usedSystem = new Set<number>()
    const checks: DividendCheck[] = brokerRows.map((brokerRow, brokerIndex) => {
        const brokerSecurity = brokerRow.code.toUpperCase() || `name:${normalizeSecurityName(brokerRow.name)}`
        const candidates = systemCandidates.map((row, index) => ({ row, index }))
            .filter(({ row, index }) => !usedSystem.has(index)
                && (row.code.toUpperCase() || `name:${normalizeSecurityName(row.name)}`) === brokerSecurity)
            .sort((left, right) => Math.abs(Date.parse(left.row.date) - Date.parse(brokerRow.date)) - Math.abs(Date.parse(right.row.date) - Date.parse(brokerRow.date)))
        const exact = candidates.find(({ row }) => Math.abs(row.cashDividend - brokerRow.amount) <= 1)
        const selected = exact ?? candidates[0]
        if (!selected) return {
            key: `broker-${brokerIndex}-${dividendKey(brokerRow)}`, status: 'missing-system' as const,
            date: brokerRow.date, code: brokerRow.code, name: brokerRow.name,
            brokerAmount: brokerRow.amount, systemAmount: undefined, difference: brokerRow.amount,
        }
        usedSystem.add(selected.index)
        const difference = brokerRow.amount - selected.row.cashDividend
        return {
            key: `broker-${brokerIndex}-${dividendKey(brokerRow)}`,
            status: Math.abs(difference) <= 1 ? 'matched' as const : 'mismatch' as const,
            date: brokerRow.date, code: brokerRow.code || selected.row.code, name: brokerRow.name || selected.row.name,
            brokerAmount: brokerRow.amount, systemAmount: selected.row.cashDividend, difference,
        }
    })

    systemCandidates.forEach((row, index) => {
        if (usedSystem.has(index)) return
        if (periodStart && row.date < periodStart) return
        if (periodEnd && row.date > periodEnd) return
        checks.push({
            key: `system-${index}-${dividendKey(row)}`, status: 'pending-broker',
            date: row.date, code: row.code, name: row.name,
            brokerAmount: undefined, systemAmount: row.cashDividend, difference: -row.cashDividend,
        })
    })
    return checks.sort((left, right) => left.date.localeCompare(right.date) || left.code.localeCompare(right.code))
}

export function reconcileMonthlyCash(
    brokerBalance: number | undefined,
    systemProjectedCash: number,
    periodEnd: string,
    brokerTrades: BrokerTradeRow[],
): CashCheck {
    const unsettledNet = brokerTrades
        .filter(row => row.settlementDate && row.settlementDate > periodEnd)
        .reduce((sum, row) => sum + (row.total ?? 0), 0)
    const systemExpectedSettledCash = systemProjectedCash - unsettledNet
    if (brokerBalance === undefined) return { status: 'unavailable', systemProjectedCash, unsettledNet, systemExpectedSettledCash }
    const difference = brokerBalance - systemExpectedSettledCash
    return {
        status: Math.abs(difference) <= 2 ? 'matched' : 'mismatch',
        brokerBalance, systemProjectedCash, unsettledNet, systemExpectedSettledCash, difference,
    }
}
