// Public exchange announcements only. No private holdings, payment assumptions or user writes.
export const DIVIDEND_SOURCES = {
    TWSE: 'https://www.twse.com.tw/exchangeReport/TWT48U?response=json',
    TPEX: 'https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost',
}
const plain = value => String(value ?? '').replace(/<[^>]*>/g, '').trim()
const validIso = value => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
function dateOf(value) {
    const text = plain(value)
    if (validIso(text)) return text
    const match = text.match(/^(\d{3})年(\d{2})月(\d{2})日$/) || text.match(/^(\d{3})(\d{2})(\d{2})$/)
    if (!match) throw new Error('Invalid dividend date')
    const iso = `${Number(match[1]) + 1911}-${match[2]}-${match[3]}`
    if (!validIso(iso)) throw new Error('Invalid dividend date')
    return iso
}
function amount(value, unknownAllowed = false) {
    const text = plain(value).replace(/,/g, '')
    if (unknownAllowed && (!text || /^(?:待公告實際收益分配金額|待公告|尚未公告|--|N\/A)$/.test(text))) return null
    if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('Invalid dividend amount')
    const result = Number(text)
    if (!Number.isFinite(result) || result > 100000) throw new Error('Invalid dividend amount')
    return result
}
export function validateDividendAnnouncement(row) {
    if (!row || !Object.hasOwn(DIVIDEND_SOURCES, row.market) || row.source !== DIVIDEND_SOURCES[row.market]
        || !validIso(row.date) || !/^\d{4,6}[A-Z]?$/.test(row.code) || typeof row.name !== 'string'
        || !row.name.trim() || row.name.length > 100 || (typeof row.checkedAt !== 'string' || !Number.isFinite(Date.parse(row.checkedAt)))
        || row.id !== `${row.market}-${row.code}-${row.date}` || typeof row.active !== 'boolean'
        || !(row.cashPerShare === null || (Number.isFinite(row.cashPerShare) && row.cashPerShare >= 0 && row.cashPerShare <= 100000))
        || !Number.isFinite(row.stockRatio) || row.stockRatio < 0 || row.stockRatio > 100) throw new Error('Invalid dividend announcement')
    return { id: row.id, market: row.market, date: row.date, code: row.code, name: row.name.trim(),
        cashPerShare: row.cashPerShare, stockRatio: row.stockRatio, source: row.source,
        checkedAt: new Date(row.checkedAt).toISOString(), active: row.active }
}
export function parseDividendAnnouncements(market, data, now = new Date()) {
    let rows
    if (market === 'TWSE') {
        const required = ['除權除息日期', '股票代號', '名稱', '無償配股率', '現金股利']
        if (String(data?.stat).toLowerCase() !== 'ok' || !String(data.title).includes('除權除息預告表') || !Array.isArray(data.fields)
            || required.some(field => !data.fields.includes(field)) || !Array.isArray(data.data)) throw new Error('Invalid TWSE dividend response')
        const indexes = required.map(field => data.fields.indexOf(field))
        rows = data.data.map(row => {
            if (!Array.isArray(row) || indexes.some(index => row[index] === undefined)) throw new Error('Invalid TWSE dividend row')
            return indexes.map(index => row[index])
        })
    } else if (market === 'TPEX' && Array.isArray(data)) {
        rows = data.map(row => [row.ExRrightsExDividendDate, row.SecuritiesCompanyCode, row.CompanyName, row.StockDividendRatio, row.CashDividend])
    } else throw new Error('Invalid dividend market response')
    if (rows.length > 5000) throw new Error('Dividend response too large')
    const entries = new Map()
    for (const [rawDate, rawCode, rawName, rawStock, rawCash] of rows) {
        const date = dateOf(rawDate), code = plain(rawCode), name = plain(rawName)
        const row = validateDividendAnnouncement({ id: `${market}-${code}-${date}`, market, date, code, name,
            cashPerShare: amount(rawCash, true), stockRatio: amount(rawStock),
            source: DIVIDEND_SOURCES[market], checkedAt: now.toISOString(), active: true })
        // Capital subscriptions are not free stock dividends. Only StockDividendRatio is used.
        const previous = entries.get(row.id)
        if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error('Conflicting dividend rows')
        entries.set(row.id, row)
    }
    return [...entries.values()]
}
export function publicDividendCatalog(data) {
    if (!data || !Array.isArray(data.entries) || data.entries.length > 2000) return null
    const entries = data.entries.map(validateDividendAnnouncement)
    if (new Set(entries.map(row => row.id)).size !== entries.length) throw new Error('Duplicate dividend announcements')
    const marketCheckedAt = Object.fromEntries(Object.keys(DIVIDEND_SOURCES).flatMap(market => {
        const time = data.marketCheckedAt?.[market]
        return typeof time === 'string' && Number.isFinite(Date.parse(time)) ? [[market, new Date(time).toISOString()]] : []
    }))
    return { entries, marketCheckedAt }
}
export async function refreshDividendAnnouncements(db, fetcher = fetch, now = new Date()) {
    const ref = db.doc('sharedData/dividendAnnouncements'), timestamp = now.toISOString()
    // Persistent global cooldown also bounds failures and cold/parallel instances to one attempt/day.
    const claimed = await db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data() || {}
        if (Number.isFinite(Date.parse(current.lastAttemptAt)) && now.getTime() - Date.parse(current.lastAttemptAt) < 86400000) return false
        tx.set(ref, { lastAttemptAt: timestamp }, { merge: true })
        return true
    })
    if (!claimed) {
        const stored = (await ref.get()).data() || {}
        if (stored.completedAttemptAt !== stored.lastAttemptAt) return { refreshed: false, pending: true, failures: ['TWSE', 'TPEX'] }
        return { refreshed: false, failures: Array.isArray(stored.lastFailures) ? stored.lastFailures.filter(market => Object.hasOwn(DIVIDEND_SOURCES, market)) : [] }
    }
    const markets = Object.keys(DIVIDEND_SOURCES)
    const results = await Promise.allSettled(markets.map(async market => {
        const response = await fetcher(DIVIDEND_SOURCES[market], { signal: AbortSignal.timeout(3500), headers: { Accept: 'application/json' } })
        if (!response.ok) throw new Error('Dividend source unavailable')
        return parseDividendAnnouncements(market, await response.json(), now)
    }))
    const failures = markets.filter((_, index) => results[index].status === 'rejected')
    if (failures.length === markets.length) {
        await db.runTransaction(async tx => {
            const previous = (await tx.get(ref)).data() || {}
            if (previous.lastAttemptAt === timestamp) tx.set(ref, { lastFailures: failures, completedAttemptAt: timestamp }, { merge: true })
        })
        return { refreshed: false, failures }
    }
    await db.runTransaction(async tx => {
        const previous = (await tx.get(ref)).data() || {}, current = publicDividendCatalog(previous) || { entries: [], marketCheckedAt: {} }
        const entries = new Map(current.entries.map(row => [row.id, row]))
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
        results.forEach((result, index) => {
            const market = markets[index]
            if (result.status !== 'fulfilled' || (current.marketCheckedAt[market] && current.marketCheckedAt[market] > timestamp)) return
            const incoming = new Set(result.value.map(row => row.id))
            // A missing future entry needs review; it must never silently become a payment.
            for (const [id, row] of entries) if (row.market === market && row.date >= today && !incoming.has(id)) entries.set(id, { ...row, active: false, checkedAt: timestamp })
            result.value.forEach(row => entries.set(row.id, row))
            current.marketCheckedAt[market] = timestamp
        })
        const cutoff = new Date(now.getTime() - 550 * 86400000).toISOString().slice(0, 10)
        const next = { entries: [...entries.values()].filter(row => row.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)), marketCheckedAt: current.marketCheckedAt }
        if (next.entries.length > 2000 || new TextEncoder().encode(JSON.stringify(next)).length > 800000) throw new Error('Dividend catalog too large; previous data retained')
        tx.set(ref, { ...next, lastAttemptAt: previous.lastAttemptAt || timestamp, lastFailures: previous.lastAttemptAt === timestamp ? failures : previous.lastFailures || [], completedAttemptAt: previous.lastAttemptAt === timestamp ? timestamp : previous.completedAttemptAt || timestamp })
    })
    return { refreshed: true, failures }
}
