import { authenticatedFetch } from './authenticatedFetch'
import { captureUserSession } from './userDB'
import { isPositivePrice, type QuoteObservation, type QuoteObservations } from './pricePolicy'
import { QUOTE_PROXY_TIMEOUT_MS, QUOTE_REFRESH_TIMEOUT_MS } from './quoteTiming'

// Fugle credentials live only in the authenticated server proxy.

type QuoteData = Record<string, unknown>
interface QuoteResult { quote: QuoteData | null; error?: string; fetchedAt?: string }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
// Concurrency alone does not enforce Fugle's rolling per-minute quota. Share a
// budget across batches and callers, leaving headroom for other open devices.
const REQUESTS_PER_MINUTE = 55
const WINDOW_MS = 61000
const requestStarts: number[] = []
let cooldownUntil = 0
let slotQueue: Promise<void> = Promise.resolve()
const inFlight = new Map<string, Promise<QuoteResult>>()
// Only fixed, known server messages may reach persisted quote observations.
// Never display arbitrary response bodies (which may contain provider details).
async function quoteServiceFailure(response: Response, history = false): Promise<{ message: string; retry: boolean }> {
    const prefix = history ? '歷史行情' : '報價'
    let body: { error?: unknown } = {}
    try { body = await response.json() } catch { /* Non-JSON infrastructure errors retain their HTTP status. */ }
    const messages = [
        'API 安全設定尚未完成，請聯絡管理者', '伺服器尚未設定 Fugle 報價金鑰',
        '報價額度暫時無法確認', '用量檢查暫時無法使用，請稍後再試',
        '登入驗證服務連線失敗，請檢查後端網路後重試',
        '驗證服務帳號權限不足，請聯絡管理者', '驗證服務憑證無法使用，請聯絡管理者',
        '驗證服務暫時無法使用',
    ]
    const known = typeof body?.error === 'string' ? messages.find(message => body.error === message
        || (body.error as string).startsWith(message + '（')) : undefined
    // Firebase may wrap token-exchange network failures as invalid-credential.
    // A classified network outage remains retryable, while malformed keys do not.
    const transientCredential = typeof body?.error === 'string'
        && /；(?:network-connection|network-dns|network-timeout|upstream-unavailable|oauth-token-response-invalid)）$/.test(body.error)
    const permanent = known && (/尚未|權限不足/.test(known) || /憑證無法使用/.test(known) && !transientCredential)
    return { message: response.status === 401 || response.status === 403 ? `${prefix}登入驗證失敗或無存取權限`
        : `${prefix}服務 HTTP ${response.status}${known ? `：${known}` : ''}`,
        retry: response.status >= 500 && !permanent }
}

const serviceRetryDelay = (attempt: number) => (attempt === 0 ? 1500 : 3500) + Math.floor(Math.random() * 500)

function reserveQuoteSlot(): Promise<void> {
    const slot = slotQueue.then(async () => {
        while (true) {
            const now = Date.now()
            while (requestStarts.length && requestStarts[0] <= now - WINDOW_MS) requestStarts.shift()
            const waitUntil = Math.max(cooldownUntil,
                requestStarts.length >= REQUESTS_PER_MINUTE ? requestStarts[0] + WINDOW_MS : 0)
            if (waitUntil <= now) break
            await sleep(waitUntil - now)
        }
        requestStarts.push(Date.now())
    })
    slotQueue = slot.catch(() => {})
    return slot
}

// Foreground refreshes fail promptly at the quota boundary. Historical downloads
// retain their queued retries; both paths still consume the same rolling budget.
function tryReserveQuoteSlot(): boolean {
    const now = Date.now()
    while (requestStarts.length && requestStarts[0] <= now - WINDOW_MS) requestStarts.shift()
    if (now < cooldownUntil || requestStarts.length >= REQUESTS_PER_MINUTE) return false
    requestStarts.push(now)
    return true
}

// Admission is local; the proxy atomically reserves the cross-device quota
// immediately before every upstream call, including history and retries.
async function reserveSharedBudget(count: number, deadline: number): Promise<number> {
    return Date.now() >= deadline || Date.now() < cooldownUntil ? 0 : Math.min(count, 55)
}

async function proxy(kind: 'quote' | 'history', symbol: string, signal: AbortSignal, dates?: {from: string; to: string}): Promise<Response> {
    const session = captureUserSession()
    const response = await authenticatedFetch('/.netlify/functions/fugle-proxy', session, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({kind, symbol, ...dates}), signal,
    }, true)
    session.assertActive()
    return response
}

async function fetchQuote(symbol: string, deadline: number, reserved: boolean): Promise<QuoteResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
        if (Date.now() >= deadline) return { quote: null, error: '報價等待逾時，請稍後再試' }
        if (!reserved || attempt > 0) {
            try {
                if (!await reserveSharedBudget(1, deadline)) return { quote: null, error: '報價共用額度已達上限，請稍後再試' }
            } catch { return { quote: null, error: '報價額度無法確認，請稍後再試' } }
        }
        if (Date.now() >= deadline) return { quote: null, error: '報價等待逾時，請稍後再試' }
        if (!tryReserveQuoteSlot()) return { quote: null, error: '報價服務限流，請稍後再試' }
        try {
            const res = await proxy('quote', symbol, AbortSignal.timeout(Math.max(1, Math.min(QUOTE_PROXY_TIMEOUT_MS, deadline - Date.now()))))
            if (res.status === 429) {
                const retry = res.headers.get('Retry-After')
                const delay = retry && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000
                    : retry ? Date.parse(retry) - Date.now() : WINDOW_MS
                const waitMs = Number.isFinite(delay) ? Math.max(1000, delay) : WINDOW_MS
                // Do not keep a foreground refresh waiting for a daily quota reset.
                cooldownUntil = Math.max(cooldownUntil, Date.now() + waitMs)
                if (waitMs > 120000) return { quote: null, error: '報價額度已用完，請稍後再試' }
                return { quote: null, error: '報價服務限流，請稍後再試' }
            }
            if (!res.ok) {
                const failure = await quoteServiceFailure(res)
                // A 503 is returned before the Fugle call. Allow one extra recovery
                // attempt; keep upstream/metered failures at their existing bound.
                const delay = serviceRetryDelay(attempt)
                if (failure.retry && attempt < (res.status === 503 ? 2 : 1) && Date.now() + delay < deadline) { await sleep(delay); continue }
                return { quote: null, error: failure.message }
            }
            const quote = await res.json() as QuoteData
            if (Date.now() >= deadline) return { quote: null, error: '報價等待逾時，請稍後再試' }
            if (extractPrice(quote) === null && attempt === 0 && Date.now() + 1000 < deadline) { await sleep(1000); continue }
            return { quote, ...(extractPrice(quote) === null ? { error: '此股票暫無有效報價' } : {}) }
        } catch {
            // An interrupted proxy can still be reserving quota or reading upstream.
            // Do not start a duplicate metered request when its outcome is unknown.
            return { quote: null, error: '報價連線失敗或逾時' }
        }
    }
    return { quote: null, error: '此股票暫無有效報價' }
}

function getQuoteResult(symbol: string, deadline = Date.now() + QUOTE_REFRESH_TIMEOUT_MS, reserved = false): Promise<QuoteResult> {
    const existing = inFlight.get(symbol)
    if (existing) return existing
    const request = fetchQuote(symbol, deadline, reserved)
        .then(result => ({ ...result, fetchedAt: new Date().toISOString() }))
        .finally(() => inFlight.delete(symbol))
    inFlight.set(symbol, request)
    return request
}

// 取得單一股票報價，與批次查詢共用限流及進行中的請求。
export async function getQuote(symbol: string) {
    return (await getQuoteResult(symbol)).quote
}

// 從報價資料取得最佳現價
// 優先使用成交價；referencePrice 僅供估值，不認定為當日成交價。
function tradePrices(quote: QuoteData) {
    const lastTrade = quote.lastTrade as { price?: unknown } | undefined
    return [quote.closePrice, lastTrade?.price, quote.lastPrice]
}
export function extractPrice(quote: Record<string, unknown> | null): number | null {
    if (!quote) return null
    return [...tradePrices(quote), quote.referencePrice].find(isPositivePrice) ?? null
}

// ── 批次取得多檔股票現價（優化建議書 3-2）─────────────────────────────────
//
// 併發上限搭配共用分鐘配額；429 記住冷卻時間，立即回報，不阻塞畫面。
const MAX_CONCURRENT = 5

export async function getMultipleQuoteObservations(symbols: string[], requestedAt: string, deadline = Date.now() + QUOTE_REFRESH_TIMEOUT_MS): Promise<QuoteObservations> {
    const results: QuoteObservations = {}
    symbols = [...new Set(symbols)]
    if (!symbols.length) return {}

    const requests = new Map<string, Promise<QuoteResult>>()
    const owned: { symbol: string; request: Promise<QuoteResult>; resolve: (result: QuoteResult) => void }[] = []
    // Claim every new symbol synchronously, including queued work, before the first
    // quota await. Other batches and single reads reuse these promises without
    // reserving another slot, even when the first quota response is still pending.
    for (const symbol of symbols) {
        let request = inFlight.get(symbol)
        if (!request) {
            let resolve!: (result: QuoteResult) => void
            request = new Promise<QuoteResult>(done => { resolve = done })
            inFlight.set(symbol, request)
            owned.push({ symbol, request, resolve })
        }
        requests.set(symbol, request)
    }

    try {
        if (owned.length) {
            let cursor = 0
            let granted = 0, budgetError = '報價共用額度已達上限，請稍後再試'
            try { granted = await reserveSharedBudget(owned.length, deadline) }
            catch { budgetError = '報價額度無法確認，請稍後再試' }
            const worker = async (): Promise<void> => {
                while (cursor < owned.length) {
                    const index = cursor++, item = owned[index]
                    let result: QuoteResult = { quote: null, error: budgetError }
                    if (index < granted) {
                        try { result = await fetchQuote(item.symbol, deadline, true) }
                        catch { result = { quote: null, error: '報價連線失敗或逾時' } }
                    }
                    item.resolve({ ...result, fetchedAt: new Date().toISOString() })
                }
            }
            await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, owned.length) }, () => worker()))
        }
        await Promise.all(symbols.map(async symbol => {
            const { quote, error, fetchedAt } = await requests.get(symbol)!
            const price = extractPrice(quote)
            const priceType: QuoteObservation['priceType'] = price === null ? 'missing'
                : quote && tradePrices(quote).some(isPositivePrice) ? 'trade' : 'reference'
            results[symbol] = { price, requestedAt, fetchedAt: fetchedAt || new Date().toISOString(),
                sourceDate: typeof quote?.date === 'string' ? quote.date : '',
                sourceUpdatedAt: typeof quote?.lastUpdated === 'number' && Number.isFinite(quote.lastUpdated) ? quote.lastUpdated : null,
                priceType, status: price === null ? 'failed' : 'success', ...(error ? { error } : {}),
                isFinalClose: quote?.isClose === true && quote.isTrial !== true && quote.isDelayedClose !== true && quote.closePrice === price,
                ...(typeof quote?.changePercent === 'number' && Number.isFinite(quote.changePercent) ? { changePercent: quote.changePercent } : {}) }
        }))
        return results
    } finally {
        // Retain fulfilled queued work for the lifetime of its batch; a late
        // overlapping caller can still reuse it. Failure never leaves a stale claim.
        for (const item of owned) if (inFlight.get(item.symbol) === item.request) inFlight.delete(item.symbol)
    }
}

export interface HistoricalCandle {
    date: string
    open: number
    high: number
    low: number
    close: number
    volume?: number
}
interface HistoricalResult { data: HistoricalCandle[] }
const historicalInFlight = new Map<string, Promise<HistoricalResult>>()
const historicalWaiters: Array<() => void> = []
let historicalActive = 0

async function fetchHistoricalCandles(symbol: string, from: string, to: string): Promise<HistoricalResult> {
    // The provider lists separate endpoint quotas. Sharing our conservative budget
    // also prevents history refreshes from bypassing this tab's request protection.
    if (historicalActive >= 4) await new Promise<void>(resolve => historicalWaiters.push(resolve))
    else historicalActive++
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            await reserveQuoteSlot()
            let res: Response
            let payload: unknown
            try {
                res = await proxy('history', symbol, AbortSignal.timeout(QUOTE_PROXY_TIMEOUT_MS), {from, to})
                if (res.ok) payload = await res.json()
            } catch {
                if (attempt === 0) { await sleep(1000); continue }
                throw new Error('歷史行情連線失敗或逾時，請重試')
            }
            if (res.status === 429) {
                const retry = res.headers.get('Retry-After')
                const delay = retry && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000
                    : retry ? Date.parse(retry) - Date.now() : WINDOW_MS
                const waitMs = Number.isFinite(delay) ? Math.max(1000, delay) : WINDOW_MS
                if (waitMs > 120000) throw new Error('歷史行情額度已用完，請稍後再試')
                cooldownUntil = Math.max(cooldownUntil, Date.now() + waitMs)
                if (attempt === 0) continue
                throw new Error('歷史行情服務限流，請稍後重試')
            }
            if (!res.ok) {
                const failure = await quoteServiceFailure(res, true)
                if (failure.retry && attempt < (res.status === 503 ? 2 : 1)) { await sleep(serviceRetryDelay(attempt)); continue }
                throw new Error(failure.message)
            }
            const data = (payload as Partial<HistoricalResult> | null)?.data
            if (!Array.isArray(data) || data.some(bar => !bar || typeof bar.date !== 'string'
                || !/^\d{4}-\d{2}-\d{2}$/.test(bar.date)
                || ![bar.open, bar.high, bar.low, bar.close].every(isPositivePrice))) {
                throw new Error('歷史行情資料格式異常，請重試')
            }
            return { data: [...data].sort((a, b) => a.date.localeCompare(b.date)) }
        }
        throw new Error('歷史行情載入失敗，請重試')
    } finally {
        const next = historicalWaiters.shift()
        if (next) next()
        else historicalActive--
    }
}

// All history consumers share concurrency, rate limits and identical in-flight requests.
// Empty data is a successful response; failures reject so UI can offer a retry.
export function getHistoricalCandles(symbol: string, from: string, to: string): Promise<HistoricalResult> {
    const key = JSON.stringify([symbol, from, to])
    const existing = historicalInFlight.get(key)
    if (existing) return existing
    const request = fetchHistoricalCandles(symbol, from, to).finally(() => historicalInFlight.delete(key))
    historicalInFlight.set(key, request)
    return request
}
/** Compatibility for consumers that only need the fetched numeric prices. */
export async function getMultipleQuotes(symbols: string[]): Promise<Record<string, number | null>> {
    const quotes = await getMultipleQuoteObservations(symbols, new Date().toISOString())
    return Object.fromEntries(Object.entries(quotes).map(([code, quote]) => [code, quote.price]))
}
