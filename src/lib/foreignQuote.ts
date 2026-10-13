import { authenticatedFetch } from './authenticatedFetch'
import { captureUserSession } from './userDB'
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

    const session = captureUserSession()
    const result: Record<string, number | null> = {}
    const unique = [...new Set(symbols)]
    const signal = AbortSignal.timeout(8000)
    for (let start = 0; start < unique.length; start += 20) {
        try {
            const res = await authenticatedFetch(
                `/.netlify/functions/foreign-quote?type=quote&symbols=${encodeURIComponent(unique.slice(start, start + 20).join(','))}`, session, { signal }
            )
            if (!res.ok) throw new Error(`foreign-quote HTTP ${res.status}`)
            const data = await res.json()
            Object.assign(result, data)
        } catch (error) {
            session.assertActive()
            if (!Object.keys(result).length) throw error
            break // A later timeout must not erase earlier successful batches.
        }
    }
    return result
}
