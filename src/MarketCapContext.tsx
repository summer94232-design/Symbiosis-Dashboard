/**
 * MarketCapContext.tsx
 * 全域已發行股數管理 Context — v1.0
 *
 * 放置位置：src/MarketCapContext.tsx（與 App.tsx、PriceContext.tsx 同層）
 *
 * 設計原則（比照 PriceContext.tsx）：
 * - updateShares 除了更新全域 state，也直接回傳本次取得的結果，
 *   讓各頁面 wrapper 可以同步拿到最新值，避免非同步 state 讀到舊值
 * - 股數資料為公開資料（來源：MOPS 上市/上櫃基本資料 CSV），變動極少，
 *   不需要跟 PriceContext 一樣寫回 Firebase 快取；同一個瀏覽器分頁內
 *   共用同一份 state 即可（不同頁面切換不會重複打 API）
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { getSharesOutstanding } from './lib/marketCap'

// ── Types ──────────────────────────────────────────────────────

export type SharesMap = Record<string, number | null>

interface MarketCapContextValue {
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

const MarketCapContext = createContext<MarketCapContextValue | null>(null)

// ── Provider ───────────────────────────────────────────────────

export function MarketCapProvider({ children }: { children: ReactNode }) {
    const [shares, setShares] = useState<SharesMap>({})
    const [sharesUpdatedAt, setSharesUpdatedAt] = useState('')
    const [sharesLoading, setSharesLoading] = useState(false)

    const updateShares = useCallback(async (codes: string[]): Promise<SharesMap> => {
        if (codes.length === 0) return {}
        setSharesLoading(true)

        let result: SharesMap = {}
        try {
            result = await getSharesOutstanding(codes)
            const now = new Date().toLocaleString('zh-TW')

            // 更新全域 state → 所有訂閱頁面重渲染
            setShares(prev => ({ ...prev, ...result }))
            setSharesUpdatedAt(now)
        } catch (err) {
            console.error('[MarketCapContext] updateShares error:', err)
        }

        setSharesLoading(false)
        return result   // ← 直接回傳本次結果，供頁面 wrapper 同步套用
    }, [])

    return (
        <MarketCapContext.Provider value={{ shares, sharesUpdatedAt, sharesLoading, updateShares }}>
            {children}
        </MarketCapContext.Provider>
    )
}

// ── Hook ───────────────────────────────────────────────────────

export function useMarketCap(): MarketCapContextValue {
    const ctx = useContext(MarketCapContext)
    if (!ctx) throw new Error('useMarketCap must be used within <MarketCapProvider>')
    return ctx
}