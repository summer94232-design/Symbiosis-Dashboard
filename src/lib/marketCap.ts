import { authenticatedFetch } from './authenticatedFetch'
import { captureUserSession } from './userDB'
// src/lib/marketCap.ts
// 台股市值查詢與計算工具
// 已發行股數資料透過 Netlify Function market-cap-proxy 取得（來源：MOPS 公開資料 CSV）
//
// 使用方式：
//   import { getSharesOutstanding, calcMarketCap, formatMarketCap } from '../../lib/marketCap'
//
//   const shares = await getSharesOutstanding(['2330', '2317'])
//   // 回傳：{ '2330': 25930380458, '2317': 13812779518 }
//
//   const cap = calcMarketCap(currentPrice, shares['2330'])   // 市值（新台幣元）
//   formatMarketCap(cap)                                       // "XX,XXX億"

/**
 * 批次查詢台股已發行股數
 * @param codes 股票代號陣列（如 ['2330', '2317']）
 * @returns Record<代號, 已發行股數 | null>
 */
export async function getSharesOutstanding(
    codes: string[]
): Promise<Record<string, number | null>> {
    if (codes.length === 0) return {}

    const session = captureUserSession()
    const result: Record<string, number | null> = {}
    const unique = [...new Set(codes)]
    for (let start = 0; start < unique.length; start += 100) {
        const res = await authenticatedFetch(
            `/.netlify/functions/market-cap-proxy?codes=${encodeURIComponent(unique.slice(start, start + 100).join(','))}`, session
        )
        if (!res.ok) throw new Error(`market-cap-proxy HTTP ${res.status}`)
        const data = await res.json()
        Object.assign(result, data)
    }
    return result
}

/**
 * 計算市值（新台幣元）
 * @param price 現價
 * @param shares 已發行股數
 * @returns 市值（元），任一參數缺失則回傳 null
 */
export function calcMarketCap(
    price: number | null | undefined,
    shares: number | null | undefined
): number | null {
    if (price == null || shares == null) return null
    if (!Number.isFinite(price) || !Number.isFinite(shares)) return null
    return price * shares
}

/**
 * 將市值（元）格式化為「億」為單位的字串
 * @param marketCap 市值（新台幣元）
 * @param digits 小數位數，預設 1 位
 */
export function formatMarketCap(marketCap: number | null | undefined, digits = 1): string {
    if (marketCap == null || !Number.isFinite(marketCap)) return '—'
    const inYi = marketCap / 1e8
    return `${inYi.toLocaleString('zh-TW', { maximumFractionDigits: digits, minimumFractionDigits: digits })}億`
}
