import { createContext, useContext } from 'react'

export type SharesMap = Record<string, number | null>

interface MarketCapContextValue {
    sharesError: string
    /** 所有已知股票的已發行股數，null = 查無資料 */
    shares: SharesMap
    /** 最後更新時間（zh-TW 字串），空字串表示尚未更新 */
    sharesUpdatedAt: string
    /** 是否正在拉取股數資料 */
    sharesLoading: boolean
    /**
     * 更新指定代號的已發行股數（僅台股有資料，其他市場代號會回傳 null）。
     * @returns 本次取得的股數（供呼叫端同步使用，不需等 state 更新）
     */
    updateShares: (codes: string[]) => Promise<SharesMap>
}

// ── Context ────────────────────────────────────────────────────

export const MarketCapContext = createContext<MarketCapContextValue | null>(null)


export function useMarketCap(): MarketCapContextValue {
    const ctx = useContext(MarketCapContext)
    if (!ctx) throw new Error('useMarketCap must be used within <MarketCapProvider>')
    return ctx
}
