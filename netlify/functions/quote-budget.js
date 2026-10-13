import { invokeEventHandler } from '../lib/http-function.js'
import { authorizeApiIdentity, apiError, apiHeaders } from '../lib/api-access.js'
import { reserveQuoteBudget } from '../lib/quote-budget.js'

export async function handleEvent(event) {
    const identity = await authorizeApiIdentity(event, 'quoteBudget', 1, 'POST')
    if (identity.statusCode) return identity
    let count
    try { count = JSON.parse(event.body || '').count } catch { return apiError(400, '報價額度參數不正確') }
    if (!Number.isSafeInteger(count) || count < 1 || count > 3000) return apiError(400, '報價額度參數不正確')
    try {
        return { statusCode: 200, headers: apiHeaders, body: JSON.stringify(await reserveQuoteBudget(identity.db, count)) }
    } catch { return apiError(503, '報價額度暫時無法確認，請稍後再試') }
}
export default async function (request) { return invokeEventHandler(request, handleEvent) }
