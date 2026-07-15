/**
 * googleCalendar.ts — Google 行事曆串接共用邏輯
 *
 * 涵蓋範圍：
 * - Google OAuth2 授權（導頁、解析導回的 fragment）
 * - 連結狀態讀寫（存在 users/{uid}/settings/googleCalendarAuth）
 * - 組出「未來半年」要同步的 CalendarEvent[]（依已勾選的標籤篩選；
 *   法說會只取「持倉 + calendarWatchList 關注清單」的股票）
 * - 分批呼叫 netlify/functions/google-calendar-sync.js 寫入事件
 *
 * 放置位置：src/lib/googleCalendar.ts
 */

import { getDoc, setDoc, deleteDoc, getDocs, query, where, collection } from 'firebase/firestore'
import { investDB } from './firebase'
import { userDoc, userCol } from './userDB'
import { calcPositions, type TradeRecord } from './calc'
import { fetchTrades, fetchDividends } from './investData'
import { FOMC_DATES, TECH_EVENTS, getFuturesSettlementDates, type CalendarEvent } from './calendarData'

export type SyncEventType = CalendarEvent['type']

export interface GoogleCalendarAuth {
    refreshToken: string
    connectedAt: string
    syncTypes: SyncEventType[]
}

const AUTH_COLLECTION = 'settings'
const AUTH_DOC_ID = 'googleCalendarAuth'
export const DEFAULT_SYNC_TYPES: SyncEventType[] = ['investor', 'personal']
const SYNC_FUNCTION_URL = '/.netlify/functions/google-calendar-sync'
const SYNC_MONTHS_AHEAD = 6
const BATCH_SIZE = 30

// ── 1. Google OAuth 授權 URL ──────────────────────────────────────────────

export function getGoogleCalendarAuthUrl(): string {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string
    const redirectUri = `${window.location.origin}/.netlify/functions/google-calendar-auth`
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/calendar.events',
        access_type: 'offline',
        prompt: 'consent',
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

// ── 2. 解析 Google 導回的 URL fragment（在 /calendar 頁面掛載時呼叫）──────

export interface GoogleAuthRedirectResult {
    refreshToken?: string
    error?: string
}

export function parseGoogleAuthRedirect(): GoogleAuthRedirectResult | null {
    const hash = window.location.hash
    if (!hash || (!hash.includes('gcal_refresh_token') && !hash.includes('gcal_error'))) {
        return null
    }

    const params = new URLSearchParams(hash.replace(/^#/, ''))
    const refreshToken = params.get('gcal_refresh_token') ?? undefined
    const error = params.get('gcal_error') ?? undefined

    // 處理完立刻清掉網址上的 fragment：避免重整頁面時重複處理，也避免 token 留在網址列
    window.history.replaceState(null, '', window.location.pathname + window.location.search)

    if (!refreshToken && !error) return null
    return { refreshToken, error }
}

// ── 3. 連結狀態讀寫（users/{uid}/settings/googleCalendarAuth）───────────

export async function getGoogleCalendarAuth(): Promise<GoogleCalendarAuth | null> {
    const snap = await getDoc(userDoc(investDB, AUTH_COLLECTION, AUTH_DOC_ID))
    if (!snap.exists()) return null
    return snap.data() as GoogleCalendarAuth
}

export async function saveGoogleCalendarAuth(refreshToken: string): Promise<void> {
    const data: GoogleCalendarAuth = {
        refreshToken,
        connectedAt: new Date().toISOString(),
        syncTypes: DEFAULT_SYNC_TYPES,
    }
    await setDoc(userDoc(investDB, AUTH_COLLECTION, AUTH_DOC_ID), data)
}

export async function disconnectGoogleCalendar(): Promise<void> {
    await deleteDoc(userDoc(investDB, AUTH_COLLECTION, AUTH_DOC_ID))
}

export async function setGoogleCalendarSyncTypes(types: SyncEventType[]): Promise<void> {
    await setDoc(userDoc(investDB, AUTH_COLLECTION, AUTH_DOC_ID), { syncTypes: types }, { merge: true })
}

// ── 4. 組出「未來半年」要同步的事件 ────────────────────────────────────

function addMonths(base: Date, months: number): Date {
    return new Date(base.getFullYear(), base.getMonth() + months, base.getDate())
}

function toISODate(d: Date): string {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

function inRange(dateStr: string, startISO: string, endISO: string): boolean {
    return dateStr >= startISO && dateStr <= endISO
}

export async function gatherUpcomingCalendarEvents(syncTypes: SyncEventType[]): Promise<CalendarEvent[]> {
    const today = new Date()
    const startISO = toISODate(today)
    const endISO = toISODate(addMonths(today, SYNC_MONTHS_AHEAD))
    const typeSet = new Set(syncTypes)

    const results: CalendarEvent[] = []

    // 4a. 靜態資料：FOMC、科技活動
    if (typeSet.has('fomc')) {
        results.push(...FOMC_DATES.filter(e => inRange(e.date, startISO, endISO)))
    }
    if (typeSet.has('tech')) {
        results.push(...TECH_EVENTS.filter(e => inRange(e.date, startISO, endISO)))
    }

    // 4b. 期貨結算日：逐月計算涵蓋範圍內的每個月
    if (typeSet.has('futures')) {
        let cursor = new Date(today.getFullYear(), today.getMonth(), 1)
        const end = addMonths(today, SYNC_MONTHS_AHEAD)
        while (cursor <= end) {
            results.push(
                ...getFuturesSettlementDates(cursor.getFullYear(), cursor.getMonth() + 1).filter(e =>
                    inRange(e.date, startISO, endISO)
                )
            )
            cursor = addMonths(cursor, 1)
        }
    }

    // 4c. 手動建立的行程（personal / tech / fomc / dividend / shareholder 皆可能存在這個 collection）
    const manualTypes: SyncEventType[] = ['personal', 'dividend', 'shareholder', 'tech', 'fomc']
    if (manualTypes.some(t => typeSet.has(t))) {
        const snap = await getDocs(query(userCol(investDB, 'calendarEvents'), where('date', '>=', startISO)))
        snap.docs.forEach(d => {
            const data = { id: d.id, ...d.data() } as CalendarEvent
            if (typeSet.has(data.type) && inRange(data.date, startISO, endISO)) {
                results.push(data)
            }
        })
    }

    // 4d. 除權息（來自 trades/dividends 共用快取層）
    if (typeSet.has('dividend')) {
        const divs = await fetchDividends<{ code: string; name?: string; date: string; cashDividend?: number }>('asc')
        divs
            .filter(d => d.date && inRange(d.date, startISO, endISO))
            .forEach(d => {
                results.push({
                    id: `div-${d.code}-${d.date}`,
                    date: d.date,
                    title: `${d.name || d.code} 除權息`,
                    type: 'dividend',
                    stockCode: d.code,
                    description: `現金股利：${d.cashDividend || 0} 元`,
                })
            })
    }

    // 4e. 法說會：只取「持倉 + calendarWatchList 關注清單」股票，範圍限縮在未來半年涵蓋的 yearMonth
    if (typeSet.has('investor')) {
        const [watchSnap, trades] = await Promise.all([
            getDocs(userCol(investDB, 'calendarWatchList')),
            fetchTrades<TradeRecord>('asc'),
        ])
        const watchCodes = watchSnap.docs.map(d => (d.data().code as string) || d.id)
        const { holdings } = calcPositions(trades)
        const holdingCodes = Object.keys(holdings).filter(c => holdings[c].shares > 0)
        const myCodes = new Set([...holdingCodes, ...watchCodes])

        const yearMonths = new Set<string>()
        let cursor = new Date(today.getFullYear(), today.getMonth(), 1)
        const end = addMonths(today, SYNC_MONTHS_AHEAD)
        while (cursor <= end) {
            yearMonths.add(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`)
            cursor = addMonths(cursor, 1)
        }

        const evtMap = new Map<string, CalendarEvent>()
        for (const ym of yearMonths) {
            const snap = await getDocs(query(collection(investDB, 'investorMeetings'), where('yearMonth', '==', ym)))
            snap.docs.forEach(docSnap => {
                const data = docSnap.data() as { stockCode: string; stockName?: string; dates?: string[] }
                if (!myCodes.has(data.stockCode)) return
                const dates = Array.isArray(data.dates) ? data.dates : []
                dates.forEach(isoDate => {
                    if (!inRange(isoDate, startISO, endISO)) return
                    const id = `investor-${data.stockCode}-${isoDate}`
                    if (!evtMap.has(id)) {
                        evtMap.set(id, {
                            id,
                            date: isoDate,
                            title: `${data.stockName || data.stockCode} 法說會`,
                            type: 'investor',
                            stockCode: data.stockCode,
                            description: `${data.stockName || data.stockCode}（${data.stockCode}）法人說明會`,
                        })
                    }
                })
            })
        }
        results.push(...evtMap.values())
    }

    return results
}

// ── 5. 分批呼叫 Netlify Function 寫入 Google Calendar ──────────────────

export interface SyncSummary {
    created: number
    skipped: number
    failed: number
    errors: string[]
}

export async function syncEventsToGoogleCalendar(
    refreshToken: string,
    events: CalendarEvent[],
    onProgress?: (done: number, total: number) => void
): Promise<SyncSummary> {
    const summary: SyncSummary = { created: 0, skipped: 0, failed: 0, errors: [] }

    for (let i = 0; i < events.length; i += BATCH_SIZE) {
        const batch = events.slice(i, i + BATCH_SIZE)
        const res = await fetch(SYNC_FUNCTION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken, events: batch }),
        })
        const data = await res.json()

        if (!res.ok) {
            summary.failed += batch.length
            summary.errors.push(data.error || `批次 ${Math.floor(i / BATCH_SIZE) + 1} 失敗（HTTP ${res.status}）`)
            if (res.status === 401) break // 憑證失效，後面的批次不用再打了
            continue
        }

        summary.created += data.created ?? 0
        summary.skipped += data.skipped ?? 0
        summary.failed += data.failed ?? 0
        summary.errors.push(...(data.errors ?? []))

        onProgress?.(Math.min(i + BATCH_SIZE, events.length), events.length)
    }

    return summary
}