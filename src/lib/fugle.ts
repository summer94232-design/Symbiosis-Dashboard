const FUGLE_API_KEY = import.meta.env.VITE_FUGLE_API_KEY

// 取得單一股票報價
export async function getQuote(symbol: string) {
    try {
        const res = await fetch(
            `https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${symbol}`,
            { headers: { 'X-API-KEY': FUGLE_API_KEY } }
        )
        if (!res.ok) return null
        const data = await res.json()
        return data
    } catch {
        return null
    }
}

// 從報價資料取得最佳現價
// 優先順序：closePrice → lastPrice → referencePrice
export function extractPrice(quote: any): number | null {
    if (!quote) return null
    return quote.closePrice || quote.lastPrice || quote.referencePrice || null
}

// ── 批次取得多檔股票現價（優化建議書 3-2）─────────────────────────────────
//
// 原實作對 N 檔股票同時發 N 個請求，持倉＋賣出追蹤代號一多就會撞 Fugle
// rate limit（部分股票拿不到價）。改為：
//   1. 併發上限 5：以固定數量的 worker 消化佇列，同一時間最多 5 個請求在途。
//   2. 失敗單檔重試一次：第一次拿不到價（HTTP 錯誤 / 網路例外 / 無價格欄位）
//      時，等 300ms 讓限流窗口過去再試一次，仍失敗才回傳 null。
//
// 函式簽名與回傳格式完全不變，呼叫端（PriceContext）無需修改。
const MAX_CONCURRENT = 5
const RETRY_DELAY_MS = 300

export async function getMultipleQuotes(symbols: string[]): Promise<Record<string, number | null>> {
    const results: Record<string, number | null> = {}
    let cursor = 0

    const worker = async (): Promise<void> => {
        while (cursor < symbols.length) {
            const symbol = symbols[cursor]
            cursor += 1
            let price = extractPrice(await getQuote(symbol))
            if (price === null) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
                price = extractPrice(await getQuote(symbol))
            }
            results[symbol] = price
        }
    }

    const workerCount = Math.min(MAX_CONCURRENT, symbols.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    return results
}

// 取得歷史收盤價（升序排列，舊→新，確保 MA 計算正確）
export async function getHistoricalCandles(symbol: string, from: string, to: string) {
    try {
        const res = await fetch(
            `https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/${symbol}?from=${from}&to=${to}&sort=asc`,
            { headers: { 'X-API-KEY': FUGLE_API_KEY } }
        )
        if (!res.ok) return null
        return res.json()
    } catch {
        return null
    }
}