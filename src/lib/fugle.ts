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

// 批次取得多檔股票現價
export async function getMultipleQuotes(symbols: string[]): Promise<Record<string, number | null>> {
  const results: Record<string, number | null> = {}
  await Promise.all(
    symbols.map(async (symbol) => {
      const quote = await getQuote(symbol)
      results[symbol] = extractPrice(quote)
    })
  )
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