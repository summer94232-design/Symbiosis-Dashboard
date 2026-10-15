import { authorizeApiIdentity, apiError, apiHeaders, cachedApi } from '../lib/api-access.js'
import { reserveQuoteBudget } from '../lib/quote-budget.js'
import { readFubonHistory } from '../lib/fubon-sdk.js'
import { invokeEventHandler } from '../lib/http-function.js'

const date = value => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
export async function handleFubonHistory(event, deps = { authorizeApiIdentity, reserveQuoteBudget, readFubonHistory, cachedApi }) {
    const identity = await deps.authorizeApiIdentity(event, 'fubonHistory', 1, 'POST')
    if (identity.statusCode) return identity
    let input
    try { input = JSON.parse(event.body || '') } catch { return apiError(400, '歷史行情參數不正確') }
    if (!input || typeof input.symbol !== 'string' || !/^[A-Z0-9]{4,12}$/.test(input.symbol)
        || !date(input.from) || !date(input.to) || input.from > input.to
        || Date.parse(input.to) - Date.parse(input.from) >= 365 * 86400000) return apiError(400, '歷史行情日期或代號不正確')
    try {
        const key = `fubon:history:unadjusted:${input.symbol}:${input.from}:${input.to}`
        const result = await deps.cachedApi(key, 300000, async () => {
            const budget = await deps.reserveQuoteBudget(identity.db, 1, undefined, 'fubonHistory')
            if (!budget.granted) throw Object.assign(new Error('limited'), { retryAfter: budget.retryAfter })
            const result = await deps.readFubonHistory(input.symbol, input.from, input.to)
            if (!Array.isArray(result?.data)) throw new Error('invalid-history')
            const data = result.data.map(row => Object.fromEntries(['date', 'open', 'high', 'low', 'close', 'volume']
                .filter(field => row && Object.hasOwn(row, field)).map(field => [field, row[field]])))
            if (data.some(row => !date(row.date) || row.date < input.from || row.date > input.to
                || ![row.open, row.high, row.low, row.close].every(n => Number.isFinite(n) && n > 0)
                || row.high < Math.max(row.open, row.close, row.low) || row.low > Math.min(row.open, row.close, row.high)
                || row.volume !== undefined && (!Number.isFinite(row.volume) || row.volume < 0))) throw new Error('invalid-history')
            return { data: data.sort((a, b) => a.date.localeCompare(b.date)) }
        })
        return { statusCode: 200, headers: apiHeaders, body: JSON.stringify(result) }
    } catch (error) {
        if (Number.isInteger(error?.retryAfter)) return apiError(429, '歷史行情額度已達上限', { 'Retry-After': String(error.retryAfter) })
        return apiError(502, '富邦歷史行情暫時無法使用')
    }
}
export default async function(request) { return invokeEventHandler(request, handleFubonHistory) }
