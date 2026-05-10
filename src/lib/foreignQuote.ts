// src/lib/foreignQuote.ts
// 外國股票（日股、美股）報價查詢
// 透過 Netlify Function foreign-quote 呼叫 Yahoo Finance，避免 CORS 問題
//
// 使用方式：
//   import { getForeignQuotes } from '../../lib/foreignQuote'
//
//   // symbols 傳入 Yahoo Finance 格式的代號
//   // 日股：7203.T  美股：AAPL
//   const quotes = await getForeignQuotes(['7203.T', 'AAPL'])
//   // 回傳：{ '7203.T': 2800.5, 'AAPL': 189.3 }

/**
 * 批次查詢外股即時報價
 * @param symbols Yahoo Finance 格式代號陣列（日股加 .T，美股直接代號）
 * @returns Record<symbol, 現價 | null>
 */
export async function getForeignQuotes(
    symbols: string[]
): Promise<Record<string, number | null>> {
    if (symbols.length === 0) return {}

    try {
        const res = await fetch(
            `/.netlify/functions/foreign-quote?type=quote&symbols=${encodeURIComponent(symbols.join(','))}`
        )
        if (!res.ok) throw new Error(`foreign-quote HTTP ${res.status}`)
        const data = await res.json()
        return data as Record<string, number | null>
    } catch (err) {
        console.error('[foreignQuote] 查詢失敗:', err)
        return Object.fromEntries(symbols.map(s => [s, null]))
    }
}