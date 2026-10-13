import { authorizeApi, apiError, apiHeaders, cachedApi } from '../lib/api-access.js'
import { readFubonMarket } from '../lib/fubon-sdk.js'
import { fubonDiagnostic, fubonStage } from '../lib/fubon-diagnostic.js'

const allowedCode = /^[0-9A-Z]{2,10}$/

export async function handleFubonSnapshot(event, dependencies = { authorizeApi, readFubonMarket, cachedApi }) {
    if (event.httpMethod !== 'POST') return apiError(405, '僅支援 POST', { Allow: 'POST' })
    const denied = await dependencies.authorizeApi(event, 'fubonSnapshot', 1, 'POST')
    if (denied) return denied
    let codes
    try { codes = JSON.parse(event.body || '').codes } catch { return apiError(400, '報價參數不正確') }
    if (!Array.isArray(codes) || codes.length < 1 || codes.length > 3000
        || codes.some(code => typeof code !== 'string' || !allowedCode.test(code))) return apiError(400, '報價代號不正確')
    const wanted = new Set(codes)
    const results = await Promise.allSettled(['TSE', 'OTC'].map(async market => {
        const snapshot = await dependencies.cachedApi(`fubon:snapshot:${market}`, 10000, async () => {
            const response = await dependencies.readFubonMarket(market)
            await fubonStage('response', () => {
                if (!response || !Array.isArray(response.data) || typeof response.date !== 'string') throw new Error('fubon-response-invalid')
            })
            return { response, fetchedAt: new Date().toISOString() }
        })
        return { market, date: snapshot.response.date, fetchedAt: snapshot.fetchedAt,
            data: snapshot.response.data.filter(row => row && wanted.has(row.symbol)).map(row => ({
                symbol: row.symbol, lastPrice: row.lastPrice, closePrice: row.closePrice,
                isTrial: row.isTrial, changePercent: row.changePercent,
            })) }
    }))
    const snapshots = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    const diagnostics = results.flatMap((result, index) => result.status === 'rejected'
        ? [{ market: ['TSE', 'OTC'][index], ...fubonDiagnostic(result.reason) }] : [])
    if (!snapshots.length) return { statusCode: 502, headers: apiHeaders,
        body: JSON.stringify({ error: '富邦行情快照暫時無法使用', diagnostics }) }
    return { statusCode: 200, headers: apiHeaders, body: JSON.stringify({ snapshots,
        failedMarkets: results.flatMap((result, index) => result.status === 'rejected' ? [['TSE', 'OTC'][index]] : []), diagnostics }) }
}

export default async function fubonSnapshot(request) {
    const event = {
        httpMethod: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.method === 'POST' ? await request.text() : '',
    }
    const result = await handleFubonSnapshot(event)
    return new Response(result.body || '', { status: result.statusCode, headers: result.headers })
}
