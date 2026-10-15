import { invokeEventHandler } from '../lib/http-function.js'
import { authorizeApiIdentity, apiError, apiHeaders, quotaDiagnostic } from '../lib/api-access.js'
import { reserveQuoteBudget } from '../lib/quote-budget.js'

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value

export async function handleEvent(event) {
    const identity = await authorizeApiIdentity(event, 'fugle', 1, 'POST')
    if (identity.statusCode) return identity
    let input
    try { input = JSON.parse(event.body || '') } catch { return apiError(400, '報價參數不正確') }
    if (!input || !['quote', 'history'].includes(input.kind) || typeof input.symbol !== 'string'
        || !/^[A-Z0-9]{4,12}$/.test(input.symbol)) return apiError(400, '報價參數不正確')
    if (input.kind === 'history' && (!validDate(input.from) || !validDate(input.to)
        || input.from > input.to)) return apiError(400, '歷史行情日期不正確')
    const key = process.env.FUGLE_API_KEY
    if (!key) return apiError(503, '伺服器尚未設定 Fugle 報價金鑰')
    let budget
    try { budget = await reserveQuoteBudget(identity.db, 1) }
    catch (error) {
        console.error('[fugle-proxy] quote budget unavailable', quotaDiagnostic(error))
        return apiError(503, '報價額度暫時無法確認')
    }
    if (!budget.granted) return apiError(429, '報價共用額度已達上限，請稍後再試', { 'Retry-After': String(budget.retryAfter) })
    const path = input.kind === 'quote' ? 'intraday/quote' : 'historical/candles'
    const url = new URL(`https://api.fugle.tw/marketdata/v1.0/stock/${path}/${input.symbol}`)
    if (input.kind === 'history') url.search = new URLSearchParams({ from: input.from, to: input.to, sort: 'asc' }).toString()
    try {
        const response = await fetch(url, { headers: { 'X-API-KEY': key }, signal: AbortSignal.timeout(7000) })
        if (!response.ok) {
            const status = [401, 403, 429].includes(response.status) ? response.status : 502
            // Never relay provider messages, headers or request configuration containing secrets.
            return apiError(status, status === 429 ? '報價服務限流，請稍後再試' : '報價來源暫時無法提供資料', status === 429 ? { 'Retry-After': '70' } : {})
        }
        const payload = await response.json()
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return apiError(502, '報價資料格式異常')
        // Whitelist data fields: an upstream response must not be able to echo credentials.
        const quoteFields = ['date', 'symbol', 'name', 'closePrice', 'lastPrice', 'referencePrice', 'lastTrade', 'lastUpdated', 'changePercent', 'isClose', 'isTrial', 'isDelayedClose']
        const body = input.kind === 'quote' ? Object.fromEntries(quoteFields.filter(k => k in payload).map(k => [k, payload[k]]))
            : { data: Array.isArray(payload.data) ? payload.data.map(row => Object.fromEntries(['date', 'open', 'high', 'low', 'close', 'volume'].filter(k => k in row).map(k => [k, row[k]]))) : null }
        return { statusCode: 200, headers: apiHeaders, body: JSON.stringify(body) }
    } catch { return apiError(502, '報價連線失敗或逾時') }
}
export default async function(request) { return invokeEventHandler(request, handleEvent) }
