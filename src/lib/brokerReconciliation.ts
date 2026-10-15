import type { TradeRecord } from './calc'

export type ReconciliationMode = 'interim' | 'monthly'

export interface BrokerTradeRow {
    id: string
    date: string
    type: 'buy' | 'sell'
    code: string
    name: string
    price: number
    shares: number
    fee?: number
    tax?: number
    total?: number
    isMargin?: boolean
    marginRepay?: number
    marginPrincipal?: number
    marginInterest?: number
    rawText: string
    sourceFile?: string
    settlementDate?: string
    brokerDayTrade?: boolean
    grossAmount?: number
}

export type ReconciliationStatus = 'matched' | 'mismatch' | 'missing-system' | 'missing-broker' | 'coverage-unknown'

export interface ReconciliationResult {
    key: string
    status: ReconciliationStatus
    broker?: BrokerTradeRow
    system?: AggregatedTrade
    differences: string[]
    marginCorrection?: {
        brokerRepay: number
        systemRepay: number
        brokerInterest?: number
        systemInterest?: number
        brokerPrincipal?: number
        systemPrincipal?: number
    }
}

export interface AggregatedTrade {
    date: string
    type: 'buy' | 'sell'
    code: string
    name: string
    price: number
    shares: number
    fee?: number
    tax?: number
    total?: number
    isMargin?: boolean
    marginRepay?: number
    marginPrincipal?: number
    marginInterest?: number
    sourceCount: number
}

const FULLWIDTH = '０１２３４５６７８９／．，：－'
const HALFWIDTH = '0123456789/.,:-'

function normalizeWidth(value: string): string {
    return [...value].map(char => {
        const index = FULLWIDTH.indexOf(char)
        return index >= 0 ? HALFWIDTH[index] : char
    }).join('')
}

function parseNumber(value: string | undefined): number | undefined {
    if (!value) return undefined
    const cleaned = normalizeWidth(value).replace(/[$,元股\s]/g, '')
    if (!cleaned || !/^-?\d+(?:\.\d+)?$/.test(cleaned)) return undefined
    const parsed = Number(cleaned)
    return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeDate(block: string): string | null {
    const normalized = normalizeWidth(block)
    const match = normalized.match(/(?:^|\D)(\d{2,4})[/\-.\u5e74](\d{1,2})[/\-.\u6708](\d{1,2})(?:\u65e5|\D|$)/)
    if (!match) return null
    let year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    if (year < 1911) year += 1911
    if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return null
    return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

function labelledNumber(block: string, labels: string): number | undefined {
    const match = normalizeWidth(block).match(new RegExp(`(?:${labels})\\s*[:：]?\\s*([\\d,]+(?:\\.\\d+)?)`, 'i'))
    return parseNumber(match?.[1])
}

function parseBlock(block: string, index: number): BrokerTradeRow | null {
    const text = normalizeWidth(block).replace(/[\t\u00a0]+/g, ' ').replace(/ +/g, ' ').trim()
    const date = normalizeDate(text)
    const typeMatch = text.match(/(融資)?\s*(買進|買入|買|賣出|賣)/)
    if (!date || !typeMatch) return null

    const withoutDate = text.replace(/\d{2,4}[/\-.\u5e74]\d{1,2}[/\-.\u6708]\d{1,2}\u65e5?/, ' ')
    const codeMatch = withoutDate.match(/(?:證券代號|股票代號|代號)?\s*[:：]?\s*\b(\d{4,6}[A-Z]?)\b/i)
    if (!codeMatch) return null

    const code = codeMatch[1].toUpperCase()
    const type: 'buy' | 'sell' = /\u8ce3/.test(typeMatch[2]) ? 'sell' : 'buy'
    const isMargin = /融資/.test(text)
    const afterCode = withoutDate.slice((codeMatch.index ?? 0) + codeMatch[0].length)
    const numericTokens = [...afterCode.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)]
        .map(match => ({ value: parseNumber(match[0]), index: match.index ?? 0 }))
        .filter((token): token is { value: number; index: number } => token.value !== undefined)

    let price = labelledNumber(text, '成交價|價格|成交均價|均價')
    let shares = labelledNumber(text, '股數|成交股數|數量')
    const fee = labelledNumber(text, '手續費')
    const tax = labelledNumber(text, '交易稅|證交稅')
    const total = labelledNumber(text, '交割金額|淨收付|收付金額|成交金額')

    if (price === undefined || shares === undefined) {
        const priceTokenIndex = numericTokens.findIndex(token => token.value > 0 && token.value < 100_000 && String(token.value).includes('.'))
        const fallbackPriceIndex = priceTokenIndex >= 0 ? priceTokenIndex : numericTokens.findIndex(token => token.value > 0 && token.value < 100_000)
        if (price === undefined && fallbackPriceIndex >= 0) price = numericTokens[fallbackPriceIndex].value
        if (shares === undefined && fallbackPriceIndex >= 0) {
            const shareToken = numericTokens.slice(fallbackPriceIndex + 1).find(token => Number.isInteger(token.value) && token.value > 0)
            shares = shareToken?.value
        }
    }

    if (!price || !shares) return null
    const detailStart = afterCode.search(/(?:成交價|價格|成交均價|均價|股數|成交股數|數量|手續費|交易稅|證交稅|\s+-?\d[\d,]*(?:\.\d+)?)/)
    const name = afterCode.slice(0, detailStart >= 0 ? detailStart : afterCode.length)
        .replace(/(融資)?\s*(買進|買入|買|賣出|賣)/g, '')
        .replace(/[|:：]/g, ' ')
        .trim()

    return {
        id: `broker-${index}`,
        date,
        type,
        code,
        name,
        price,
        shares: Math.round(shares),
        fee,
        tax,
        total,
        isMargin,
        rawText: block.trim(),
    }
}

function compactOcrText(value: string): string {
    return normalizeWidth(value)
        .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
        .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
}

function yuantaMonthlyTradeSection(rawText: string): string | null {
    const normalized = normalizeWidth(rawText).replace(/[\t\u00a0]+/g, ' ').replace(/\s+/g, ' ')
    const start = normalized.indexOf('上市、上櫃、興櫃交易明細')
    if (start < 0) return null
    const afterStart = normalized.slice(start)
    const endMarkers = ['上市/櫃(TWD)合計', '上市、上櫃、興櫃庫存明細']
    const end = endMarkers
        .map(marker => afterStart.indexOf(marker))
        .filter(index => index >= 0)
        .sort((left, right) => left - right)[0]
    return end === undefined ? afterStart : afterStart.slice(0, end)
}

export function isYuantaMonthlyStatement(rawText: string): boolean {
    return yuantaMonthlyTradeSection(rawText) !== null
}

export function extractBrokerStatementPeriod(rawText: string): { from: string; to: string } | null {
    const normalized = normalizeWidth(rawText)
    const match = normalized.match(/對帳單期間\s*[:：]?\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s*[~～至-]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/)
    if (!match) return null
    const format = (year: string, month: string, day: string) => `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    return { from: format(match[1], match[2], match[3]), to: format(match[4], match[5], match[6]) }
}

function parseSignedYuantaTotal(value: string | undefined, type: 'buy' | 'sell'): number | undefined {
    if (!value) return undefined
    const amount = parseNumber(value.replace(/[()]/g, ''))
    if (amount === undefined) return undefined
    return type === 'buy' || value.includes('(') ? -Math.abs(amount) : Math.abs(amount)
}

/** Parses Yuanta's monthly PDF table, whose first date is the trade date and second date is settlement. */
function parseYuantaMonthlyStatement(rawText: string): BrokerTradeRow[] | null {
    const section = yuantaMonthlyTradeSection(rawText)
    if (!section) return null

    const rowStart = /(?=\d{4}\/\d{2}\/\d{2}\s+\d{4}\/\d{2}\/\d{2}\s+(?:集中|櫃檯|融資|融券|借券|興櫃)\s+TWD\s+[買賣]沖?\s+)/g
    const blocks = section.split(rowStart).map(block => block.trim()).filter(block => /^\d{4}\//.test(block))
    return blocks.map((block, index): BrokerTradeRow | null => {
        const head = block.match(/^(\d{4}\/\d{2}\/\d{2})\s+(\d{4}\/\d{2}\/\d{2})\s+(集中|櫃檯|融資|融券|借券|興櫃)\s+TWD\s+([買賣]沖?)\s+(\d{4,6}[A-Z]?)\s+(.+?)\s+([\d,]+)\s+([\d,]+\.\d+)\s+([\d,]+)(?:\s+|$)(.*)$/)
        if (!head) return null
        const type: 'buy' | 'sell' = head[4].startsWith('賣') ? 'sell' : 'buy'
        const shares = parseNumber(head[7])
        const price = parseNumber(head[8])
        if (!shares || !price) return null

        // Stop at page furniture; otherwise a zero-tax sale at a page end can
        // mistake the page number for its net amount or financing interest.
        const tailText = head[10].replace(/\s+\d+\/\d+(?:\s|$)[\s\S]*$/, '').split('---')[0]
        const tail = tailText.match(/^(?:\s*(?:\([\d,]+\)|[\d,]+)(?=\s|$))+/)?.[0].match(/\([\d,]+\)|[\d,]+/g) ?? []
        const fee = parseNumber(tail[0])
        const hasSellTax = type === 'sell' && tail.length >= 3
        const tax = hasSellTax ? parseNumber(tail[1]) : type === 'sell' ? 0 : undefined
        const totalToken = tail[hasSellTax ? 2 : 1]
        const total = parseSignedYuantaTotal(totalToken, type)
        const isMargin = head[3] === '融資'
        const marginRepay = isMargin && type === 'sell' && total !== undefined
            ? Math.max((parseNumber(head[9]) ?? 0) - (fee ?? 0) - (tax ?? 0) - total, 0)
            : undefined
        const statedPrincipal = isMargin && type === 'sell' && tail.length >= 5 ? parseNumber(tail[tail.length - 2]) : undefined
        const statedInterest = isMargin && type === 'sell' && tail.length >= 5 ? parseNumber(tail[tail.length - 1]) : undefined
        const hasValidatedBreakdown = marginRepay !== undefined && statedPrincipal !== undefined && statedInterest !== undefined
            && Math.abs(statedPrincipal + statedInterest - marginRepay) <= 2
        return {
            id: `broker-yuanta-monthly-${index}`,
            date: head[1].replaceAll('/', '-'),
            settlementDate: head[2].replaceAll('/', '-'),
            type,
            brokerDayTrade: head[4].endsWith('沖'),
            code: head[5].toUpperCase(),
            name: head[6].trim(),
            price,
            shares: Math.round(shares),
            grossAmount: parseNumber(head[9]),
            fee,
            tax,
            total,
            isMargin,
            marginRepay,
            marginPrincipal: hasValidatedBreakdown ? statedPrincipal : undefined,
            marginInterest: hasValidatedBreakdown ? statedInterest : undefined,
            rawText: block,
        }
    }).filter((row): row is BrokerTradeRow => row !== null)
}

/** Parses Yuanta's mobile trade-detail layout where OCR separates `2026/` and `08/19`. */
function parseSplitDateBlock(block: string, index: number): BrokerTradeRow | null {
    const text = compactOcrText(block)
    const yearMatch = text.match(/^(\d{4})[/)]/)
    const actionMatch = text.match(/\b(\d{2})\s*[/|Iil1]?\s*(\d{2})\s+(?:\u76e4\u4e2d\u96f6\u80a1\s*)?(?:\u666e\u901a\s*)?(\u8cb7\u9032|\u8cb7\u5165|\u8ce3\u51fa)/)
    if (!yearMatch || !actionMatch) return null

    const detail = text.slice(yearMatch[0].length, actionMatch.index ?? text.length).replace(/\s*[\u8aaa設]\s*$/, '').trim()
    const priceAndAmount = detail.match(/^(.*?)\s+(\d[\d,]*\.\d+)\s+[-~〜−]?\s*([\d,]+)/)
    if (!priceAndAmount) return null
    const sharesMatch = text.slice((actionMatch.index ?? 0) + actionMatch[0].length).match(/([\d,]+)/)
    const price = parseNumber(priceAndAmount[2])
    const shares = parseNumber(sharesMatch?.[1])
    if (!price || !shares) return null

    const rawName = priceAndAmount[1]
        .replace(/\s+([a-z])\s+/g, ' ')
        .replace(/\s+/g, '')
        .replace(/^[^0-9A-Z\u3400-\u9fff]+/i, '')
        .trim()
    const month = Number(actionMatch[1])
    const day = Number(actionMatch[2])
    return {
        id: `broker-split-${index}`,
        date: `${yearMatch[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        type: /\u8ce3/.test(actionMatch[3]) ? 'sell' : 'buy',
        code: '',
        name: rawName,
        price,
        shares: Math.round(shares),
        total: parseNumber(priceAndAmount[3]),
        isMargin: /\u878d\u8cc7/.test(text),
        rawText: block.trim(),
    }
}

/**
 * Parses common Taiwanese broker table/list layouts. A row may span multiple OCR lines;
 * each detected date starts a new candidate block. Uncertain rows are deliberately skipped
 * so the UI can ask the user to correct the extracted text instead of inventing a trade.
 */
export function parseBrokerStatementText(rawText: string): BrokerTradeRow[] {
    const monthlyRows = parseYuantaMonthlyStatement(rawText)
    if (monthlyRows) return monthlyRows

    const normalizedText = normalizeWidth(rawText)
    const splitDateText = normalizedText.replace(/\s+(?=\d{4}[/)])/g, '\n')
    const splitDateBlocks = splitDateText
        .split(/(?=^\s*\d{4}[/)])/gm)
        .map(block => block.trim())
        .filter(Boolean)
        .map(parseSplitDateBlock)
        .filter((row): row is BrokerTradeRow => row !== null)
    if (splitDateBlocks.length > 0) return splitDateBlocks

    const lines = normalizedText
        .replace(/\s+(?=\d{2,4}[/\-.\u5e74]\d{1,2}[/\-.\u6708]\d{1,2})/g, '\n')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
    const blocks: string[] = []
    let current = ''

    for (const line of lines) {
        const hasDate = normalizeDate(line) !== null
        if (hasDate && current) {
            blocks.push(current)
            current = line
            continue
        }
        current = current ? `${current} ${line}` : line
    }
    if (current) blocks.push(current)

    return blocks.map(parseBlock).filter((row): row is BrokerTradeRow => row !== null)
}

/** Counts possible rows before strict parsing, so cropped screenshots cannot look fully reconciled. */
export function countBrokerTradeCandidates(rawText: string): number {
    const monthlySection = yuantaMonthlyTradeSection(rawText)
    if (monthlySection) {
        return monthlySection.match(/\d{4}\/\d{2}\/\d{2}\s+\d{4}\/\d{2}\/\d{2}\s+(?:集中|櫃檯|融資|融券|借券|興櫃)\s+TWD\s+[買賣]沖?\s+/g)?.length ?? 0
    }
    const normalized = normalizeWidth(rawText)
    return normalized.match(/\b\d{4}[/)]/g)?.length ?? 0
}

/** Independent printed controls catch missed rows even if the row counter shares a parser bug. */
export function verifyBrokerStatementTotals(rawText: string, rows: BrokerTradeRow[]): string[] {
    const text = normalizeWidth(rawText).replace(/\s+/g, ' ')
    const summary = text.match(/上市\/櫃\(TWD\)合計\s+成交金額[:：]\s*([\d,]+)\s+手續費[:：]\s*([\d,]+)\s+代繳交易稅[:：]\s*([\d,]+).*?客戶淨收\(付\)[:：]\s*(\([\d,]+\)|[\d,]+)/)
    if (!summary) return ['未辨識到券商成交合計，尚無法驗證交易明細完整性。']
    const expected = summary.slice(1).map(value => Number(value.replace(/[(),]/g, '')) * (value.includes('(') ? -1 : 1))
    const actual = [
        rows.reduce((sum, row) => sum + (row.grossAmount ?? 0), 0),
        rows.reduce((sum, row) => sum + (row.fee ?? 0), 0),
        rows.reduce((sum, row) => sum + (row.tax ?? 0), 0),
        rows.reduce((sum, row) => sum + (row.total ?? 0), 0),
    ]
    return ['成交金額', '手續費', '交易稅', '淨收付'].flatMap((label, index) =>
        Math.abs(expected[index] - actual[index]) > 0.000001
            ? [`${label}合計不符：券商 ${expected[index].toLocaleString()}／已解析 ${actual[index].toLocaleString()}。`] : [])
}

export function normalizeSecurityName(value: string): string {
    return normalizeWidth(value)
        .toUpperCase()
        .replace(/\u80a1\u4efd\u6709\u9650\u516c\u53f8|\u6709\u9650\u516c\u53f8/g, '')
        .replace(/[^0-9A-Z\u3400-\u9fff]/g, '')
}

function editDistance(left: string, right: string): number {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex]
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            current[rightIndex] = Math.min(
                current[rightIndex - 1] + 1,
                previous[rightIndex] + 1,
                previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
            )
        }
        previous.splice(0, previous.length, ...current)
    }
    return previous[right.length]
}

/** Resolves screenshots that show only stock names by matching names already present in the ledger. */
export function resolveBrokerTradeCodes(rows: BrokerTradeRow[], systemRows: TradeRecord[]): BrokerTradeRow[] {
    const securities = [...new Map(systemRows
        .filter(row => row.code && row.name)
        .map(row => [row.code.toUpperCase(), { code: row.code.toUpperCase(), name: row.name, normalized: normalizeSecurityName(row.name) }])).values()]

    return rows.map(row => {
        if (row.code) return row
        const exactTradeMatches = [...new Map(systemRows
            .filter(system => system.date === row.date
                && system.type === row.type
                && system.shares === row.shares
                && Math.abs(system.price - row.price) <= 0.05)
            .map(system => [system.code.toUpperCase(), system])).values()]
        if (exactTradeMatches.length === 1) {
            return { ...row, code: exactTradeMatches[0].code.toUpperCase(), name: exactTradeMatches[0].name }
        }
        const normalized = normalizeSecurityName(row.name)
        if (!normalized) return row
        const candidates = securities.map(security => ({
            ...security,
            distance: editDistance(normalized, security.normalized),
        })).sort((a, b) => a.distance - b.distance)
        const best = candidates[0]
        const allowedDistance = Math.max(1, Math.floor(Math.max(normalized.length, best?.normalized.length ?? 0) * 0.3))
        return best && best.distance <= allowedDistance ? { ...row, code: best.code, name: best.name } : row
    })
}

export function reconciliationGroupKey(row: BrokerTradeRow | TradeRecord): string {
    const securityKey = row.code ? row.code.toUpperCase() : `name:${normalizeSecurityName(row.name)}`
    return `${row.date}|${row.type}|${securityKey}|${row.isMargin ? 'margin' : 'spot'}`
}

function aggregate(rows: Array<BrokerTradeRow | TradeRecord>): Map<string, AggregatedTrade> {
    const groups = new Map<string, AggregatedTrade & { weightedPrice: number }>()
    for (const row of rows) {
        const key = reconciliationGroupKey(row)
        const existing = groups.get(key) ?? {
            date: row.date,
            type: row.type,
            code: row.code.toUpperCase(),
            name: row.name || '',
            price: 0,
            shares: 0,
            fee: undefined,
            tax: undefined,
            total: undefined,
            isMargin: Boolean(row.isMargin),
            marginRepay: undefined,
            marginPrincipal: undefined,
            marginInterest: undefined,
            sourceCount: 0,
            weightedPrice: 0,
        }
        existing.weightedPrice += row.price * row.shares
        existing.shares += row.shares
        existing.sourceCount += 1
        if (row.name && !existing.name) existing.name = row.name
        if (row.fee !== undefined) existing.fee = (existing.fee ?? 0) + row.fee
        if (row.tax !== undefined) existing.tax = (existing.tax ?? 0) + row.tax
        if (row.total !== undefined) existing.total = (existing.total ?? 0) + row.total
        if (row.marginRepay !== undefined) existing.marginRepay = (existing.marginRepay ?? 0) + row.marginRepay
        if (row.marginPrincipal !== undefined) existing.marginPrincipal = (existing.marginPrincipal ?? 0) + row.marginPrincipal
        if (row.marginInterest !== undefined) existing.marginInterest = (existing.marginInterest ?? 0) + row.marginInterest
        groups.set(key, existing)
    }
    return new Map([...groups.entries()].map(([key, value]) => [key, {
        ...value,
        price: value.shares ? value.weightedPrice / value.shares : 0,
    }]))
}

const moneyText = (value: number) => value.toLocaleString('zh-TW', { maximumFractionDigits: 2 })

export function reconcileBrokerTrades(
    brokerRows: BrokerTradeRow[],
    systemRows: TradeRecord[],
    mode: ReconciliationMode,
): ReconciliationResult[] {
    const moneyTolerance = mode === 'monthly' ? 0.000001 : 1
    const totalTolerance = mode === 'monthly' ? 0.000001 : 2
    const priceTolerance = mode === 'monthly' ? 0.000001 : 0.05
    const broker = aggregate(brokerRows)
    const system = aggregate(systemRows)
    const keys = new Set([...broker.keys(), ...system.keys()])

    return [...keys].sort().map(key => {
        const brokerRow = broker.get(key)
        const systemRow = system.get(key)
        if (!systemRow && brokerRow) {
            return { key, status: 'missing-system' as const, broker: { ...brokerRow, id: key, rawText: '' }, differences: ['券商有這筆，系統沒有'] }
        }
        if (!brokerRow && systemRow) {
            const status = mode === 'interim' ? 'coverage-unknown' as const : 'missing-broker' as const
            return {
                key,
                status,
                system: systemRow,
                differences: [mode === 'interim' ? '未出現在本次截圖（截圖可能未涵蓋）' : '系統有這筆，月結對帳單沒有'],
            }
        }

        const differences: string[] = []
        let marginCorrection: ReconciliationResult['marginCorrection']
        if (brokerRow && systemRow) {
            if (brokerRow.shares !== systemRow.shares) differences.push(`股數：券商 ${brokerRow.shares.toLocaleString()} / 系統 ${systemRow.shares.toLocaleString()}`)
            if (Math.abs(brokerRow.price - systemRow.price) > priceTolerance) differences.push(`均價：券商 ${brokerRow.price.toFixed(4)} / 系統 ${systemRow.price.toFixed(4)}`)
            if (brokerRow.fee !== undefined && systemRow.fee !== undefined && Math.abs(brokerRow.fee - systemRow.fee) > moneyTolerance) differences.push(`手續費：券商 ${brokerRow.fee} / 系統 ${systemRow.fee}`)
            if (brokerRow.tax !== undefined && systemRow.tax !== undefined && Math.abs(brokerRow.tax - systemRow.tax) > moneyTolerance) differences.push(`交易稅：券商 ${brokerRow.tax} / 系統 ${systemRow.tax}`)
            if (brokerRow.isMargin && brokerRow.type === 'sell'
                && brokerRow.marginRepay !== undefined && systemRow.marginRepay !== undefined) {
                const brokerInterest = brokerRow.marginInterest ?? (brokerRow.marginPrincipal !== undefined
                    ? brokerRow.marginRepay - brokerRow.marginPrincipal
                    : undefined)
                const systemInterest = systemRow.marginInterest ?? (systemRow.marginPrincipal !== undefined
                    ? systemRow.marginRepay - systemRow.marginPrincipal
                    : undefined)
                const principalMismatch = brokerRow.marginPrincipal !== undefined && systemRow.marginPrincipal !== undefined
                    && Math.abs(brokerRow.marginPrincipal - systemRow.marginPrincipal) > moneyTolerance
                if (principalMismatch || Math.abs(brokerRow.marginRepay - systemRow.marginRepay) > moneyTolerance
                    || (brokerInterest !== undefined && systemInterest !== undefined && Math.abs(brokerInterest - systemInterest) > moneyTolerance)) {
                    if (principalMismatch) differences.push(`融資本金：券商 ${brokerRow.marginPrincipal!.toLocaleString()} / 系統 ${systemRow.marginPrincipal!.toLocaleString()}`)
                    differences.push(brokerInterest !== undefined && systemInterest !== undefined
                        ? `融資利息：券商 ${Math.round(brokerInterest).toLocaleString()} / 系統 ${Math.round(systemInterest).toLocaleString()}`
                        : `融資償還：券商 ${brokerRow.marginRepay.toLocaleString()} / 系統 ${systemRow.marginRepay.toLocaleString()}`)
                    marginCorrection = {
                        brokerRepay: brokerRow.marginRepay,
                        systemRepay: systemRow.marginRepay,
                        brokerInterest,
                        systemInterest,
                        ...(principalMismatch ? { brokerPrincipal: brokerRow.marginPrincipal, systemPrincipal: systemRow.marginPrincipal } : {}),
                    }
                }
            }
            if (brokerRow.total !== undefined && systemRow.total !== undefined && Math.abs(mode === 'monthly'
                ? (brokerRow.type === 'buy' ? -brokerRow.total : brokerRow.total) - systemRow.total
                : Math.abs(brokerRow.total) - Math.abs(systemRow.total)) > totalTolerance) {
                differences.push(`淨收付：券商 ${moneyText(brokerRow.total)} / 系統 ${moneyText(systemRow.total)}`)
            }
        }
        return {
            key,
            status: differences.length ? 'mismatch' as const : 'matched' as const,
            broker: brokerRow ? { ...brokerRow, id: key, rawText: '' } : undefined,
            system: systemRow,
            differences,
            marginCorrection,
        }
    })
}
