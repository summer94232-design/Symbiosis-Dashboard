import { invalidateCalendarEvents, invalidateTasks, invalidateTaskProjects } from './lib/plannerData'
import DisclosureNote from './components/DisclosureNote'
import { formatSyncTime } from './lib/syncPresentation'
import { invalidateQuoteUniverse } from './lib/quoteUniverse'
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
    reconnect: () => void
    version: number
    status: SyncStatus
    lastSyncedAt: string
    changedCollection: string
}

const COLLECTIONS = [
    'trades', 'dividends', 'cashflow', 'assetSnapshots', 'settings',
    'tasks', 'taskProjects', 'calendarEvents',
    'calendarWatchList', 'investorMeetingOverrides',
    'watchlist', 'sentiments', 'industryMap', 'industryRelations',
] as const
type SyncedCollection = typeof COLLECTIONS[number]

const LABELS: Record<SyncedCollection, string> = {
    calendarWatchList: '行事曆關注清單', investorMeetingOverrides: '個人法說會',
    tasks: '任務', taskProjects: '任務專案', calendarEvents: '行事曆',
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
    reconnect: () => {},
    version: 0,
    status: 'connecting',
    lastSyncedAt: '',
    changedCollection: '',
})

function invalidateCollection(name: SyncedCollection) {
    if (['trades', 'watchlist', 'sentiments', 'industryMap'].includes(name)) invalidateQuoteUniverse()
    if (name === 'tasks') invalidateTasks()
    else if (name === 'taskProjects') invalidateTaskProjects()
    else if (name === 'calendarEvents') invalidateCalendarEvents()
    else if (name === 'trades') invalidateTrades()
    else if (name === 'dividends') invalidateDividends()
    else if (name === 'cashflow') invalidateCashflow()
    else if (name === 'assetSnapshots') invalidateAssetSnapshots()
}

export function InvestSyncProvider({ children }: { children: ReactNode }) {
    const [connectionAttempt, setConnectionAttempt] = useState(0)
    const [version, setVersion] = useState(0)
    const [status, setStatus] = useState<SyncStatus>('connecting')
    const [lastSyncedAt, setLastSyncedAt] = useState('')
    const [changedCollection, setChangedCollection] = useState('')
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const pendingCollectionsRef = useRef(new Set<SyncedCollection>())

    useEffect(() => {
        let collectionUnsubs: Unsubscribe[] = []
        let generation = 0

        const stopCollections = () => {
            generation++
            if (timerRef.current) clearTimeout(timerRef.current)
            pendingCollectionsRef.current.clear()
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
            const currentGeneration = generation
            const errors = new Set<SyncedCollection>()
            const serverReady = new Set<SyncedCollection>()
            collectionUnsubs = COLLECTIONS.map(name => {
                let initialSnapshot = true
                return onSnapshot(userCol(investDB, name), { includeMetadataChanges: true }, snapshot => {
                    if (generation !== currentGeneration) return
                    errors.delete(name)
                    if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) serverReady.delete(name)
                    else serverReady.add(name)
                    setStatus(errors.size ? 'error' : serverReady.size === COLLECTIONS.length ? 'live' : 'connecting')
                    const initial = initialSnapshot
                    if (initialSnapshot) {
                        initialSnapshot = false
                        readyCount += 1
                        if (serverReady.size === COLLECTIONS.length) {
                            setLastSyncedAt(new Date().toISOString())
                        }
                    }
                    if (!initial && snapshot.docChanges().length === 0) return

                    invalidateCollection(name)
                    pendingCollectionsRef.current.add(name)
                    if (timerRef.current) clearTimeout(timerRef.current)
                    timerRef.current = setTimeout(() => {
                        if (generation !== currentGeneration) return
                        const changed = [...pendingCollectionsRef.current]
                        pendingCollectionsRef.current.clear()
                        setChangedCollection(changed.map(item => LABELS[item]).join('、'))
                        if (serverReady.size === COLLECTIONS.length) setLastSyncedAt(new Date().toISOString())
                        setVersion(current => current + 1)
                        setStatus(errors.size ? 'error' : readyCount === COLLECTIONS.length && serverReady.size === COLLECTIONS.length ? 'live' : 'connecting')
                    }, 120)
                }, error => {
                    if (generation !== currentGeneration) return
                    errors.add(name)
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
    }, [connectionAttempt])

    const value = useMemo(() => ({ version, status, lastSyncedAt, changedCollection, reconnect: () => setConnectionAttempt(value => value + 1) }), [changedCollection, lastSyncedAt, status, version])
    return <InvestSyncContext.Provider value={value}>{children}</InvestSyncContext.Provider>
}

export function useInvestSync() {
    return useContext(InvestSyncContext)
}

export function InvestSyncStatus({ quoteUpdatedAt }: { quoteUpdatedAt?: string } = {}) {
    const { status, lastSyncedAt, changedCollection } = useInvestSync()
    const color = status === 'live' ? 'var(--c-positive)' : status === 'error' ? 'var(--c-danger)' : 'var(--c-warning)'
    const label = status === 'live' ? '資料已同步' : status === 'error' ? '資料同步異常' : '資料連線中'
    const time = formatSyncTime(lastSyncedAt)
    const indicator = <span className="invest-sync-status__dot" aria-hidden="true" style={{ backgroundColor: color, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 12%, transparent)` }} />
    return (
        <div className={`invest-sync-status${quoteUpdatedAt !== undefined ? ' invest-sync-status--with-quote' : ''}`} title={changedCollection ? `最近更新：${changedCollection}` : '投資資料同步狀態'}>
            {time ? <DisclosureNote className="invest-sync-status__note" summary={<>{indicator}<span>{`${label} · ${status === 'live' ? '' : '上次 '}${time.short}`}</span></>} style={{ margin: 0, fontSize: quoteUpdatedAt !== undefined ? 'inherit' : '10px', lineHeight: quoteUpdatedAt !== undefined ? 'inherit' : 1.6, maxWidth: '100%' }}>
                最後資料同步：{time.full}（台灣時間）
            </DisclosureNote> : <span className="invest-sync-status__label">{indicator}<span>{label}</span></span>}
            {quoteUpdatedAt !== undefined && <div className="invest-sync-status__quote-time">
                {quoteUpdatedAt ? `報價更新時間：${quoteUpdatedAt}` : '尚未取得報價，點「更新現價」取得最新報價'}
            </div>}
        </div>
    )
}
