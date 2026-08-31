/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { onSnapshot, type Unsubscribe } from 'firebase/firestore'
import { investAuth } from './lib/auth'
import { investDB } from './lib/firebase'
import { userCol } from './lib/userDB'
import {
    invalidateAssetSnapshots,
    invalidateCashflow,
    invalidateDividends,
    invalidateTrades,
} from './lib/investData'

type SyncStatus = 'connecting' | 'live' | 'error'

interface InvestSyncValue {
    version: number
    status: SyncStatus
    lastSyncedAt: string
    changedCollection: string
}

const COLLECTIONS = [
    'trades', 'dividends', 'cashflow', 'assetSnapshots', 'settings',
    'watchlist', 'sentiments', 'industryMap', 'industryRelations',
] as const
type SyncedCollection = typeof COLLECTIONS[number]

const LABELS: Record<SyncedCollection, string> = {
    trades: '買賣紀錄',
    dividends: '除權息',
    cashflow: '出入金',
    assetSnapshots: '資產快照',
    settings: '投資設定',
    watchlist: '選股追蹤',
    sentiments: '觀點追蹤',
    industryMap: '產業地圖',
    industryRelations: '產業關聯',
}

const InvestSyncContext = createContext<InvestSyncValue>({
    version: 0,
    status: 'connecting',
    lastSyncedAt: '',
    changedCollection: '',
})

function invalidateCollection(name: SyncedCollection) {
    if (name === 'trades') invalidateTrades()
    else if (name === 'dividends') invalidateDividends()
    else if (name === 'cashflow') invalidateCashflow()
    else if (name === 'assetSnapshots') invalidateAssetSnapshots()
}

export function InvestSyncProvider({ children }: { children: ReactNode }) {
    const [version, setVersion] = useState(0)
    const [status, setStatus] = useState<SyncStatus>('connecting')
    const [lastSyncedAt, setLastSyncedAt] = useState('')
    const [changedCollection, setChangedCollection] = useState('')
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const pendingCollectionsRef = useRef(new Set<SyncedCollection>())

    useEffect(() => {
        let collectionUnsubs: Unsubscribe[] = []

        const stopCollections = () => {
            collectionUnsubs.forEach(unsubscribe => unsubscribe())
            collectionUnsubs = []
        }

        const authUnsub = investAuth.onAuthStateChanged(user => {
            stopCollections()
            if (!user) {
                setStatus('connecting')
                return
            }

            setStatus('connecting')
            let readyCount = 0
            collectionUnsubs = COLLECTIONS.map(name => {
                let initialSnapshot = true
                return onSnapshot(userCol(investDB, name), () => {
                    if (initialSnapshot) {
                        initialSnapshot = false
                        readyCount += 1
                        if (readyCount === COLLECTIONS.length) {
                            setStatus('live')
                            setLastSyncedAt(new Date().toLocaleString('zh-TW'))
                        }
                        return
                    }

                    invalidateCollection(name)
                    pendingCollectionsRef.current.add(name)
                    if (timerRef.current) clearTimeout(timerRef.current)
                    timerRef.current = setTimeout(() => {
                        const changed = [...pendingCollectionsRef.current]
                        pendingCollectionsRef.current.clear()
                        setChangedCollection(changed.map(item => LABELS[item]).join('、'))
                        setLastSyncedAt(new Date().toLocaleString('zh-TW'))
                        setVersion(current => current + 1)
                        setStatus('live')
                    }, 120)
                }, error => {
                    console.error(`[InvestSync] ${name} subscription failed`, error)
                    setStatus('error')
                })
            })
        })

        return () => {
            authUnsub()
            stopCollections()
            if (timerRef.current) clearTimeout(timerRef.current)
        }
    }, [])

    const value = useMemo(() => ({ version, status, lastSyncedAt, changedCollection }), [changedCollection, lastSyncedAt, status, version])
    return <InvestSyncContext.Provider value={value}>{children}</InvestSyncContext.Provider>
}

export function useInvestSync() {
    return useContext(InvestSyncContext)
}

export function InvestSyncStatus() {
    const { version, status, lastSyncedAt, changedCollection } = useInvestSync()
    const color = status === 'live' ? 'var(--c-positive)' : status === 'error' ? 'var(--c-danger)' : 'var(--c-warning)'
    const label = status === 'live' ? '即時同步' : status === 'error' ? '同步異常' : '連線中'
    return (
        <div title={changedCollection ? `最近更新：${changedCollection}` : '投資資料同步狀態'} style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '6px', padding: '6px clamp(16px, 3vw, 32px) 0', color: 'var(--c-muted)', fontSize: '10px' }}>
            <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: color, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 12%, transparent)` }} />
            <span>{label} v{version}{lastSyncedAt ? ` · ${lastSyncedAt}` : ''}</span>
        </div>
    )
}
