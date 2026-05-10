// netlify/functions/foreign-quote.js
// 查詢外國股票報價（日股、美股）
// 使用 Yahoo Finance 非官方 API，不需要 API Key
//
// 呼叫方式：GET /.netlify/functions/foreign-quote?symbols=7203.T,AAPL,TSLA
// 回傳格式：{ "7203.T": 2800.5, "AAPL": 189.3, "TSLA": null }
//   → null 表示查詢失敗或無資料

export const handler = async (event) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    }

    const symbolsParam = event.queryStringParameters?.symbols || ''
    if (!symbolsParam) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: '缺少 symbols 參數，例如 ?symbols=7203.T,AAPL' }),
        }
    }

    const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean)

    // 並行查詢所有代號
    const results = {}
    await Promise.all(
        symbols.map(async (symbol) => {
            try {
                const res = await fetch(
                    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
                    {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        },
                    }
                )
                if (!res.ok) throw new Error(`HTTP ${res.status}`)

                const data = await res.json()
                const meta = data?.chart?.result?.[0]?.meta
                const price = meta?.regularMarketPrice ?? null

                results[symbol] = typeof price === 'number' ? price : null
                console.log(`[foreign-quote] ${symbol} → ${results[symbol]}`)
            } catch (err) {
                console.error(`[foreign-quote] ${symbol} 失敗:`, err.message)
                results[symbol] = null
            }
        })
    )

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify(results),
    }
}