/**
 * PriceContext.tsx
 * 全域現價管理 Context — v1.0
 *
 * 放置位置：src/PriceContext.tsx（與 App.tsx 同層）
 *
 * 設計原則：
 * - updatePrices 除了更新全域 state，也直接回傳本次取得的 quotes
 *   讓各頁面 wrapper 可以同步拿到最新值，避免非同步 state 讀到舊值
 * - loadCachedPrices 供頁面 load() 初始化時呼叫，不打 Fugle API
 * - Firebase 寫入仍保持 merge:true，各頁面互不覆蓋
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { setDoc } from 'firebase/firestore'
import { investDB } from './lib/firebase'
import { userDocNested } from './lib/userDB'
import { getMultipleQuotes } from './lib/fugle'
import { maybeAutoSnapshotToday, type AutoSnapshotResult } from './lib/snapshot'

// ── Types ──────────────────────────────────────────────────────

export type PriceMap = Record<string, number | null>

export interface PriceUpdateOptions {
    onSnapshot?: (result: AutoSnapshotResult) => void
}

interface PriceContextValue {
    /** 所有已知股票現價，null = 無資料 */
    prices: PriceMap
    /** 最後更新時間（zh-TW 字串），空字串表示尚未更新 */
    lastUpdated: string
    /** 是否正在拉取報價 */
    priceLoading: boolean
    /**
     * 更新指定代號的現價。
     * - 呼叫 Fugle API
     * - merge 寫入 Firebase settings/lastPrices
     * - 更新全域 prices state
     * @returns 本次取得的 quotes（供呼叫端同步使用，不需等 state 更新）
     */
    updatePrices: (codes: string[], options?: PriceUpdateOptions) => Promise<PriceMap>
    /**
     * 從 Firebase lastPrices 快取初始化（不打 Fugle API）。
     * 各頁面 load() 讀完 Firebase 後呼叫此方法。
     */
    loadCachedPrices: (savedPrices: Record<string, any>, savedAt: string) => void
}

// ── Context ────────────────────────────────────────────────────

const PriceContext = createContext<PriceContextValue | null>(null)

// ── Provider ───────────────────────────────────────────────────

/**
 * 把 lastPrices._updatedAt 的時間字串轉成 timestamp 供比較。
 * ⚠️ 不能直接用字串字典序比較：toLocaleString('zh-TW') 產生「2026/2/1」，
 *    與「2026/10/1」做字典序比較時 2026/2 會被判定大於 2026/10。
 * 支援兩種格式：zh-TW（2026/2/1 下午3:04:05）與 ISO/其他可被 Date.parse 解析的字串。
 * 解析失敗回傳 0（視為最舊）。
 */
function parseUpdatedAt(s: string): number {
    if (!s) return 0
    const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s*(上午|下午)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
    if (m) {
        let h = m[5] !== undefined ? parseInt(m[5], 10) : 0
        if (m[4] === '下午' && h < 12) h += 12
        if (m[4] === '上午' && h === 12) h = 0
        return new Date(
            parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
            h, m[6] !== undefined ? parseInt(m[6], 10) : 0, m[7] !== undefined ? parseInt(m[7], 10) : 0
        ).getTime()
    }
    const t = Date.parse(s)
    return Number.isNaN(t) ? 0 : t
}

export function PriceProvider({ children }: { children: ReactNode }) {
    const [prices, setPrices] = useState<PriceMap>({})
    const [lastUpdated, setLastUpdated] = useState('')
    const [priceLoading, setPriceLoading] = useState(false)

    const loadCachedPrices = useCallback((savedPrices: Record<string, any>, savedAt: string) => {
        const parsed: PriceMap = {}
        Object.entries(savedPrices).forEach(([k, v]) => {
            if (k !== '_updatedAt' && typeof v === 'number' && v > 0) {
                parsed[k] = v
            }
        })
        setPrices(prev => ({ ...prev, ...parsed }))
        if (savedAt) setLastUpdated(prev => (parseUpdatedAt(savedAt) > parseUpdatedAt(prev) ? savedAt : prev))
    }, [])

    const updatePrices = useCallback(async (codes: string[], options?: PriceUpdateOptions): Promise<PriceMap> => {
        if (codes.length === 0) return {}
        setPriceLoading(true)

        const result: PriceMap = {}
        try {
            const quotes = await getMultipleQuotes(codes)
            const now = new Date().toLocaleString('zh-TW')

            // 寫入 Firebase（merge 避免蓋掉其他頁面快取的股票）
            const priceData: Record<string, number | string> = { _updatedAt: now }
            codes.forEach(c => {
                const raw = quotes[c]
                const val = (typeof raw === 'number' && raw > 0) ? raw : null
                result[c] = val
                if (val !== null) priceData[c] = val
            })
            await setDoc(userDocNested(investDB, 'settings', 'lastPrices'), priceData, { merge: true })

            // 更新全域 state → 所有訂閱頁面重渲染
            setPrices(prev => ({ ...prev, ...result }))
            setLastUpdated(now)

            // 使用者明確更新現價時全天都可刷新今日快照；等待結果，讓呼叫頁面能顯示原因。
            const hasValidQuote = Object.values(result).some(value => typeof value === 'number' && value > 0)
            if (hasValidQuote) {
                const snapshotResult = await maybeAutoSnapshotToday({
                    overwrite: true,
                    trigger: 'price-update',
                })
                options?.onSnapshot?.(snapshotResult)
            }
        } catch (err) {
            console.error('[PriceContext] updatePrices error:', err)
        }

        setPriceLoading(false)
        return result   // ← 直接回傳本次結果，供頁面 wrapper 同步套用
    }, [])

    return (
        <PriceContext.Provider value={{ prices, lastUpdated, priceLoading, updatePrices, loadCachedPrices }}>
            {children}
        </PriceContext.Provider>
    )
}

// ── Hook ───────────────────────────────────────────────────────

export function usePrices(): PriceContextValue {
    const ctx = useContext(PriceContext)
    if (!ctx) throw new Error('usePrices must be used within <PriceProvider>')
    return ctx
}
