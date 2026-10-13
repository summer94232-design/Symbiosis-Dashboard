import { authorizeApi, apiError, apiHeaders, cachedApi } from './api-access.js'

export const handler = async event => {
    const params = event.queryStringParameters || {}, type = params.type || 'quote'
    const raw = type === 'chart' ? params.symbol || '' : params.symbols || ''
    if (!['quote', 'chart'].includes(type) || raw.length > 500) return apiError(400, '報價參數不正確')
    const symbols = [...new Set(raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean))]
    if (!symbols.length || symbols.length > (type === 'chart' ? 1 : 20) || symbols.some(s => !/^[A-Z0-9^][A-Z0-9.^=-]{0,19}$/.test(s))) return apiError(400, '單次報價限 1–20 個有效代號；走勢限 1 個')
    const denied = await authorizeApi(event, 'foreign', symbols.length)
    if (denied) return denied
    const results = {}
    let failures = 0
    for (let offset = 0; offset < symbols.length; offset += 4) {
        await Promise.all(symbols.slice(offset, offset + 4).map(async symbol => {
            try {
                results[symbol] = await cachedApi(`foreign:${type}:${symbol}`, 60000, async () => {
                    const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${type === 'chart' ? '1mo' : '1d'}`, {
                        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000),
                    })
                    if (!response.ok) throw new Error('upstream unavailable')
                    const result = (await response.json())?.chart?.result?.[0]
                    if (type === 'quote') {
                        const value = result?.meta?.regularMarketPrice
                        if (!Number.isFinite(value) || value <= 0) throw new Error('missing price')
                        return value
                    }
                    const quote = result?.indicators?.quote?.[0]
                    const bars = (result?.timestamp || []).map((timestamp, index) => ({ date: new Date(timestamp * 1000).toISOString().slice(0, 10), close: quote?.close?.[index], volume: quote?.volume?.[index] || 0 }))
                        .filter(bar => Number.isFinite(bar.close) && bar.close > 0).slice(-20)
                    if (!bars.length) throw new Error('missing bars')
                    return { bars }
                })
            } catch { failures++; results[symbol] = null }
        }))
    }
    if (failures === symbols.length) return apiError(502, '海外報價服務暫時無法使用')
    return { statusCode: 200, headers: apiHeaders, body: JSON.stringify(type === 'chart' ? results[symbols[0]] : results) }
}
