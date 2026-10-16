import { apiError, apiHeaders } from './api-access.js'
import { reserveQuoteBudget } from './quote-budget.js'

export function parseBatchSymbols(value) {
    return Array.isArray(value) && value.length > 0 && value.length <= 20
        && value.every(symbol => typeof symbol === 'string' && /^[A-Z0-9]{4,12}$/.test(symbol))
        ? [...new Set(value)] : null
}

const fields = ['date', 'symbol', 'name', 'closePrice', 'lastPrice', 'referencePrice', 'lastTrade', 'lastUpdated', 'changePercent', 'isClose', 'isTrial', 'isDelayedClose']

/** One access check and one rolling reservation, still charged per stock. */
export async function handleQuoteBatch(symbols, identity, deps = {}) {
    const key = (deps.env || process.env).FUGLE_API_KEY
    if (!key) return apiError(503, '伺服器尚未設定 Fugle 報價金鑰')
    let budget
    try { budget = await (deps.reserveQuoteBudget || reserveQuoteBudget)(identity.db, symbols.length, undefined, 'quote') }
    catch { return apiError(503, '報價額度暫時無法確認') }
    if (!budget.granted) return apiError(429, '報價共用額度已達上限，請稍後再試', { 'Retry-After': String(budget.retryAfter) })
    const abort = new AbortController(), encoder = new TextEncoder()
    let cancelled = false, cursor = 0
    const body = new ReadableStream({
        start(controller) {
            const emit = row => { if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(row) + '\n')) }
            const worker = async () => {
                while (!cancelled && cursor < symbols.length) {
                    const index = cursor++, symbol = symbols[index]
                    if (index >= budget.granted) { emit({ symbol, status: 429 }); continue }
                    try {
                        const response = await (deps.fetch || fetch)(`https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${symbol}`, {
                            headers: { 'X-API-KEY': key }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(7000)]),
                        })
                        if (!response.ok) {
                            emit({ symbol, status: [401, 403, 429].includes(response.status) ? response.status : 502 })
                            continue
                        }
                        const payload = await response.json()
                        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { emit({ symbol, status: 502 }); continue }
                        emit({ symbol, status: 200, quote: Object.fromEntries(fields.filter(field => field in payload).map(field => [field, payload[field]])) })
                    } catch { emit({ symbol, status: 502 }) }
                }
            }
            void Promise.all(Array.from({ length: Math.min(5, symbols.length) }, worker)).then(() => {
                if (!cancelled) { emit({ done: true }); controller.close() }
            }).catch(() => {
                if (!cancelled) { controller.error(new Error('報價串流中斷')); cancelled = true; abort.abort() }
            })
        },
        cancel() { cancelled = true; abort.abort() },
    })
    return { statusCode: 200, headers: { ...apiHeaders, 'Content-Type': 'application/x-ndjson; charset=utf-8' }, body }
}
