/**
 * googleCalendar.ts — Google 行事曆串接共用邏輯（含雙向同步）
 *
 * 整體流程：
 * 1. OAuth2 授權（導頁、解析導回的 fragment）→ 取得 refresh_token
 * 2. 確保「Symbiosis 財經行事曆」這個專屬行事曆存在（ensure）
 * 3. 讀出該行事曆目前所有事件（pull）
 * 4. 跟 Firestore `calendarEvents`（手動建立的個人行程／除權息／股東會等，
 *    以下稱 A 類）比對，算出：
 *      - Google 端有異動（改期／刪除）→ 寫回 Firestore
 *      - Google 端新增的全新事件（無 sourceId）→ 在 Firestore 建立新文件
 *      - Firestore 端有異動（新增／編輯）→ 準備推去 Google
 *      - Firestore 文件已被刪除但 Google 上還在 → 準備從 Google 刪除
 * 5. 法說會／除權息／FOMC／期貨結算日（以下稱 B 類，資料是算出來的，不是
 *    使用者手動維護的文件）維持單向；FOMC 官方改期會更新原本的系統事件。
 * 6. 把 4、5 算出的異動送去 push function，並把結果（googleEventId 對應、
 *    Firestore 端該做的異動）套用回 Firestore。
 *
 * 放置位置：src/lib/googleCalendar.ts
 */

import { getDoc, setDoc, deleteDoc, runTransaction, getDocs, getDocsFromServer, doc } from 'firebase/firestore'
import { investDB } from './firebase'
import { investAuth } from './auth'
import { captureUserSession } from './userDB'
import { calcPositions, type TradeRecord } from './calc'
import { fetchTrades, fetchDividends } from './investData'
import { FOMC_DATES, TECH_EVENTS, getFuturesSettlementDates, type CalendarEvent } from './calendarData'
import { fetchInvestorMeetings } from './investorMeetings'
import type { EventTiming } from './calendarTiming'

export type SyncEventType = CalendarEvent['type']

export interface GoogleCalendarAuth {
    refreshToken: string
    connectedAt: string
    syncTypes: SyncEventType[]
    calendarId?: string
}

/** Firestore 的 calendarEvents 文件，多帶雙向同步需要的兩個欄位 */
interface StoredCalendarEvent extends CalendarEvent {
    googleEventId?: string | null
    updatedAt?: string
    googlePendingLocalChange?: boolean
}

interface PullEvent extends EventTiming {
    needsSourceLink?: boolean
    etag?: string
    googleEventId: string
    sourceKind?: string
    sourceType?: string
    sourceId: string | null
    title: string
    date: string
    description: string
    updated: string
    cancelled: boolean
}

interface PushEventInput extends EventTiming {
    googleEtag?: string
    linkOnly?: boolean
    sourceKind?: 'manual' | 'generated'
    id: string
    date: string
    title: string
    type?: string
    description?: string
    url?: string
    googleEventId?: string
}

const AUTH_COLLECTION = 'settings'
const AUTH_DOC_ID = 'googleCalendarAuth'
const CALENDAR_EVENTS_COLLECTION = 'calendarEvents'
export const DEFAULT_SYNC_TYPES: SyncEventType[] = ['investor', 'personal']
const A_TYPE_MANUAL_TYPES: SyncEventType[] = ['personal', 'tech', 'fomc', 'shareholder', 'dividend']
const ENSURE_URL = '/.netlify/functions/google-calendar-ensure'
const PULL_URL = '/.netlify/functions/google-calendar-pull'
const SYNC_URL = '/.netlify/functions/google-calendar-sync'
const SYNC_MONTHS_AHEAD = 6
const BATCH_SIZE = 25
type SyncSession = ReturnType<typeof captureUserSession>
async function syncFetch(session: SyncSession, url: string, init: RequestInit) {
    session.assertActive()
    const user = investAuth.currentUser
    if (!user || user.uid !== session.uid) throw new Error('請先登入')
    const token = await user.getIdToken()
    session.assertActive()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    const response = await fetch(url, { ...init, headers })
    session.assertActive()
    return response
}
async function importedEventId(calendarId: string, eventId: string) {
    const bytes = new TextEncoder().encode(JSON.stringify([calendarId, eventId]))
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    return 'google-' + [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── 1. Google OAuth 授權 URL ──────────────────────────────────────────────
// ⚠️ scope 用完整的 calendar（不是 calendar.events），因為要能建立專屬行事曆

const GOOGLE_PENDING_KEY = 'symbiosis.google.oauth.pending'
export async function getGoogleCalendarAuthUrl(): Promise<string> {
    const session = captureUserSession()
    const user = investAuth.currentUser
    if (!user) throw new Error('請先登入')
    const token = await user.getIdTokenResult()
    session.assertActive()
    const authTime = Number(token.claims.auth_time)
    if (!Number.isSafeInteger(authTime)) throw new Error('請重新登入後連結 Google')
    const clientState = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('')
    const pending = { uid: session.uid, authTime, clientState, expires: Date.now() + 600000 }
    sessionStorage.setItem(GOOGLE_PENDING_KEY, JSON.stringify(pending))
    try {
        const response = await syncFetch(session, '/.netlify/functions/google-calendar-auth?action=connect', {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(15000), body: JSON.stringify({ clientState }),
        })
        const result = await response.json()
        session.assertActive()
        if (!response.ok) throw new Error(result.error || 'Google 授權啟動失敗')
        const url = new URL(result.url)
        if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw new Error('Google 授權網址無效')
        return url.href
    } catch (error) {
        // Do not erase another authorization started while this request was pending.
        if (sessionStorage.getItem(GOOGLE_PENDING_KEY) === JSON.stringify(pending)) sessionStorage.removeItem(GOOGLE_PENDING_KEY)
        throw error
    }
}

// ── 2. 解析 Google 導回的 URL fragment（在 CalendarSettings 掛載時呼叫）────

export interface GoogleAuthRedirectResult {
    refreshToken?: string
    error?: string
}

export async function parseGoogleAuthRedirect(): Promise<GoogleAuthRedirectResult | null> {
    const hash = window.location.hash
    if (!hash || !hash.includes('gcal_')) {
        return null
    }

    const params = new URLSearchParams(hash.replace(/^#/, ''))
    const refreshToken = params.get('gcal_refresh_token') ?? undefined
    const error = params.get('gcal_error') ?? undefined

    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    const raw = sessionStorage.getItem(GOOGLE_PENDING_KEY)
    sessionStorage.removeItem(GOOGLE_PENDING_KEY)
    if (error) return { error }
    try {
        const session = captureUserSession(), pending = JSON.parse(raw || 'null')
        const user = investAuth.currentUser
        if (!user || !pending || pending.uid !== session.uid || pending.uid !== params.get('gcal_uid')
            || pending.clientState !== params.get('gcal_state') || pending.expires <= Date.now()
            || String(pending.authTime) !== params.get('gcal_auth_time') || !refreshToken || refreshToken.length > 8192) throw new Error('Invalid callback')
        const token = await user.getIdTokenResult()
        session.assertActive()
        if (Number(token.claims.auth_time) !== pending.authTime) throw new Error('Session changed')
        return { refreshToken }
    } catch { return { error: 'Google 授權與目前登入狀態不符或已逾時，請重新連結' } }
}

// ── 3. 連結狀態讀寫（users/{uid}/settings/googleCalendarAuth）───────────

export async function getGoogleCalendarAuth(): Promise<GoogleCalendarAuth | null> {
    const session = captureUserSession()
    const snap = await getDoc(session.doc(investDB, AUTH_COLLECTION, AUTH_DOC_ID))
    session.assertActive()
    if (!snap.exists()) return null
    return snap.data() as GoogleCalendarAuth
}

/** Keep the local event on any remote failure so deletion can be retried. */
export async function deleteCalendarEventWithGoogle(id: string, session = captureUserSession()): Promise<void> {
    const ref = session.doc(investDB, CALENDAR_EVENTS_COLLECTION, id)
    const snapshot = await getDoc(ref)
    session.assertActive()
    if (!snapshot.exists()) return
    const original = snapshot.data()
    if (original.googleEventId) {
        const authSnapshot = await getDoc(session.doc(investDB, AUTH_COLLECTION, AUTH_DOC_ID))
        session.assertActive()
        const auth = authSnapshot.exists() ? authSnapshot.data() as GoogleCalendarAuth : null
        if (!auth?.refreshToken || !auth.calendarId) {
            throw new Error('此行程已連結 Google，請先重新授權後再刪除；系統行程已保留。')
        }
        try {
            const response = await syncFetch(session, SYNC_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(15000),
                body: JSON.stringify({ refreshToken: auth.refreshToken, calendarId: auth.calendarId,
                    events: [], deleteGoogleEventIds: [original.googleEventId] }),
            })
            const result = await response.json()
            if (!response.ok || result.failed > 0 || result.deleted !== 1) {
                throw new Error(result.error || result.errors?.[0] || 'Google 未確認刪除成功')
            }
        } catch (error) {
            session.assertActive()
            throw new Error(`Google 刪除未完成，系統行程已保留，請再按刪除重試：${error instanceof Error ? error.message : '連線失敗'}`)
        }
    }
    await runTransaction(investDB, async transaction => {
        const current = await transaction.get(ref)
        session.assertActive()
        if (!current.exists()) return
        if (calendarRevision(current.data()) !== calendarRevision(original)) {
            throw new Error('行程在刪除期間已變更，系統資料已保留，請重新確認。')
        }
        transaction.delete(ref)
    })
    session.assertActive()
}

export async function saveGoogleCalendarAuth(refreshToken: string, session = captureUserSession()): Promise<void> {
    session.assertActive()
    const ref = session.doc(investDB, AUTH_COLLECTION, AUTH_DOC_ID)
    // Reauthorization preserves both the calendar and the user's selected sync types.
    await runTransaction(investDB, async transaction => {
        const existing = await transaction.get(ref)
        session.assertActive()
        transaction.set(ref, {
            refreshToken,
            connectedAt: new Date().toISOString(),
            ...(!existing.exists() || !Array.isArray(existing.data()?.syncTypes) ? { syncTypes: DEFAULT_SYNC_TYPES } : {}),
        }, { merge: true })
    })
    session.assertActive()
}

export async function disconnectGoogleCalendar(): Promise<void> {
    const session = captureUserSession()
    await deleteDoc(session.doc(investDB, AUTH_COLLECTION, AUTH_DOC_ID))
    session.assertActive()
}

export async function setGoogleCalendarSyncTypes(types: SyncEventType[]): Promise<void> {
    const session = captureUserSession()
    await setDoc(session.doc(investDB, AUTH_COLLECTION, AUTH_DOC_ID), { syncTypes: types }, { merge: true })
    session.assertActive()
}

/** 確保專屬行事曆存在，回傳 calendarId（沒有就建立，並存回 Firestore） */
export async function ensureGoogleCalendarId(auth: GoogleCalendarAuth, session = captureUserSession()): Promise<string> {
    const res = await syncFetch(session, ENSURE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: auth.refreshToken, calendarId: auth.calendarId }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '建立／確認專屬行事曆失敗')

    if (data.calendarId !== auth.calendarId) {
        await setDoc(session.doc(investDB, AUTH_COLLECTION, AUTH_DOC_ID), { calendarId: data.calendarId }, { merge: true })
    }
    session.assertActive()
    return data.calendarId as string
}

/** Only system-generated FOMC dates may be revised from the official schedule. */
export function generatedFomcRevision(event: CalendarEvent, remote: PullEvent | undefined): Partial<PushEventInput> {
    if (event.type !== 'fomc' || !remote || remote.cancelled || remote.date === event.date
        || remote.sourceType !== 'fomc' || (remote.sourceKind && remote.sourceKind !== 'generated')
        || remote.recurringEventId || remote.start?.dateTime || !remote.etag
        || remote.sourceId !== event.id || !/^fomc-\d{4}-\d{2}$/.test(event.id)) return {}
    return { googleEventId: remote.googleEventId, googleEtag: remote.etag,
        start: { date: event.date }, end: { date: new Date(Date.parse(event.date) + 86400000).toISOString().slice(0, 10) } }
}

// ── 4. 共用日期工具 ────────────────────────────────────────────────────

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

// ── 5. B 類（法說會／除權息／FOMC／期貨）：單向，只新增缺少的 ────────────

async function gatherUpcomingBTypeEvents(syncTypes: SyncEventType[], session = captureUserSession()): Promise<CalendarEvent[]> {
    const today = new Date()
    const startISO = toISODate(today)
    const endISO = toISODate(addMonths(today, SYNC_MONTHS_AHEAD))
    const typeSet = new Set(syncTypes)
    const results: CalendarEvent[] = []

    if (typeSet.has('fomc')) {
        results.push(...FOMC_DATES.filter(e => inRange(e.date, startISO, endISO)))
    }
    if (typeSet.has('tech')) {
        results.push(...TECH_EVENTS.filter(e => inRange(e.date, startISO, endISO)))
    }

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

    if (typeSet.has('investor')) {
        const [watchSnap, trades] = await Promise.all([
            getDocs(session.col(investDB, 'calendarWatchList')),
            fetchTrades<TradeRecord>('asc'),
        ])
        const watchCodes = watchSnap.docs.map(d => (d.data().code as string) || d.id)
        const { holdings } = calcPositions(trades, [], { asOf: startISO })
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
        const meetings = await fetchInvestorMeetings([...yearMonths])
        meetings.forEach(data => {
            if (!myCodes.has(data.stockCode)) return
            data.dates.forEach(isoDate => {
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
        results.push(...evtMap.values())
    }

    session.assertActive()
    return results
}

// ── 6. A 類（calendarEvents collection）：雙向比對 ────────────────────

interface ReconcileResult {
    baselines: Record<string, string>
    warnings: string[]
    firestoreUpdates: { id: string; data: Partial<StoredCalendarEvent> }[]
    firestoreDeletes: string[]
    firestoreCreates: Omit<StoredCalendarEvent, 'id'>[]
    pushList: PushEventInput[]
    deleteGoogleEventIds: string[]
}

async function reconcileATypeEvents(syncTypes: SyncEventType[], pullEvents: PullEvent[], session = captureUserSession()): Promise<ReconcileResult> {
    const today = new Date()
    const startISO = toISODate(today)
    const endISO = toISODate(addMonths(today, SYNC_MONTHS_AHEAD))
    const relevantTypes = A_TYPE_MANUAL_TYPES.filter(t => syncTypes.includes(t))

    const result: ReconcileResult = {
        baselines: {},
        warnings: [],
        firestoreUpdates: [],
        firestoreDeletes: [],
        firestoreCreates: [],
        pushList: [],
        deleteGoogleEventIds: [],
    }
    if (relevantTypes.length === 0) return result

    const snap = await getDocsFromServer(session.col(investDB, CALENDAR_EVENTS_COLLECTION))
    session.assertActive()
    const allIds = new Set(snap.docs.map(d => d.id))
    // Retain links for excluded types too, so they cannot be mistaken for new events.
    const firestoreIdByGoogleEventId = new Map<string, string>()
    const firestoreDocs = new Map<string, StoredCalendarEvent>()
    snap.docs.forEach(d => {
        const data = { id: d.id, ...d.data() } as StoredCalendarEvent
        if (data.googleEventId) firestoreIdByGoogleEventId.set(data.googleEventId, d.id)
        if (relevantTypes.includes(data.type)) {
            firestoreDocs.set(d.id, data)
            result.baselines[d.id] = calendarRevision(d.data())
        }
    })

    const googleBySourceId = new Map<string, PullEvent>()
    const googleNative: PullEvent[] = []
    pullEvents.forEach(ev => {
        // Google 的 cancelled event 有時不再帶 extendedProperties；此時用先前保存的
        // googleEventId 反查 Firestore 文件，仍能正確辨識為 Google 端刪除。
        const sourceId = firestoreIdByGoogleEventId.get(ev.googleEventId) ?? ev.sourceId ?? null
        if (sourceId) googleBySourceId.set(sourceId, { ...ev, sourceId, needsSourceLink: ev.sourceId !== sourceId })
        else if (!ev.cancelled && relevantTypes.includes('personal') && ev.sourceKind !== 'generated') googleNative.push(ev)
    })

    // When Google converts a linked single event into a series, replace the old
    // local parent with its expanded occurrences, without deleting the Google series.
    firestoreDocs.forEach((local, id) => {
        if (local.googleEventId && !googleBySourceId.has(id)
            && pullEvents.some(event => !event.cancelled && event.recurringEventId === local.googleEventId)) {
            if (local.googlePendingLocalChange || local.googleSyncConflict) {
                result.warnings.push(`「${local.title}」在 Google 已改為重複行程，本機尚未同步的修改已保留；請在編輯行程中處理衝突。`)
                if (!local.googleSyncConflict) result.firestoreUpdates.push({ id, data: { googleSyncConflict: 'remote-deleted', updatedAt: new Date().toISOString() } })
            } else result.firestoreDeletes.push(id)
        }
    })

    // 6a. 有 sourceId 的 Google 事件：跟 Firestore 比對
    for (const [sourceId, gEvt] of googleBySourceId) {
        if (gEvt.sourceKind === 'generated') continue
        const localDoc = firestoreDocs.get(sourceId)

        if (!localDoc) {
            // 必須有手動來源標記且完整集合也不存在，才可推導刪除。
            // 舊事件缺少來源標記時保留；未勾選類型不處理。
            if (!allIds.has(sourceId) && gEvt.sourceKind === 'manual'
                && relevantTypes.includes(gEvt.sourceType as SyncEventType) && !gEvt.cancelled) {
                result.deleteGoogleEventIds.push(gEvt.googleEventId)
            }
            continue
        }

        if (gEvt.cancelled) {
            if (localDoc.googlePendingLocalChange || localDoc.googleSyncConflict) {
                result.warnings.push(`「${localDoc.title}」在 Google 已刪除，但本機仍有未同步修改；已保留本機行程，請在編輯行程中選擇保留並重新同步，或接受刪除。`)
                if (!localDoc.googleSyncConflict) result.firestoreUpdates.push({ id: sourceId, data: { googleSyncConflict: 'remote-deleted', updatedAt: new Date().toISOString() } })
                continue
            }
            // Google 端被刪除 → Firestore 也刪掉
            result.firestoreDeletes.push(sourceId)
            continue
        }

        if (localDoc.googleSyncConflict) continue
        const localUpdatedAt = localDoc.updatedAt || ''
        if (gEvt.updated > localUpdatedAt && !localDoc.googlePendingLocalChange) {
            // Google 端比較新 → 覆蓋回 Firestore
            result.firestoreUpdates.push({
                id: sourceId,
                data: {
                    title: gEvt.title,
                    date: gEvt.date,
                    description: gEvt.description,
                    updatedAt: gEvt.updated,
                    googleEventId: gEvt.googleEventId,
                    start: gEvt.start || null, end: gEvt.end || null,
                    recurringEventId: gEvt.recurringEventId || null, originalStartTime: gEvt.originalStartTime || null,
                },
            })
        } else if (localUpdatedAt > gEvt.updated || !localDoc.googleEventId || localDoc.googlePendingLocalChange) {
            // Firestore 端比較新，或還沒連結過 → 推去 Google
            result.pushList.push({
                id: sourceId,
                date: localDoc.date,
                title: localDoc.title,
                type: localDoc.type,
                description: localDoc.description,
                url: localDoc.url,
                googleEventId: gEvt.googleEventId,
                googleEtag: gEvt.etag,
                start: localDoc.start, end: localDoc.end,
                recurringEventId: localDoc.recurringEventId, originalStartTime: localDoc.originalStartTime,
            })
        }
        if (gEvt.needsSourceLink && !result.pushList.some(event => event.id === sourceId)) {
            result.pushList.push({ id: sourceId, date: '', title: '', type: localDoc.type, googleEventId: gEvt.googleEventId, linkOnly: true })
        }
    }

    // 6b. Google 端全新建立的事件（沒有 sourceId）→ 在 Firestore 建立新文件
    for (const gEvt of googleNative) {
        result.firestoreCreates.push({
            date: gEvt.date,
            title: gEvt.title || '（未命名行程）',
            description: gEvt.description,
            type: 'personal',
            updatedAt: gEvt.updated,
            googleEventId: gEvt.googleEventId,
            start: gEvt.start || null, end: gEvt.end || null,
            recurringEventId: gEvt.recurringEventId || null, originalStartTime: gEvt.originalStartTime || null,
        })
    }

    // 6c. Firestore 有、但完全沒被 Google 端提到（從未同步過）→ 推去 Google 新增
    for (const [id, localDoc] of firestoreDocs) {
        if (localDoc.googleSyncConflict || googleBySourceId.has(id) || !inRange(localDoc.date, startISO, endISO)) continue
        // A linked event absent from this bounded pull may have moved outside the window. Never recreate it.
        if (localDoc.googleEventId) continue
        result.pushList.push({
            id,
            date: localDoc.date,
            title: localDoc.title,
            type: localDoc.type,
            description: localDoc.description,
            url: localDoc.url,
            start: localDoc.start, end: localDoc.end,
        })
    }

    return result
}

function calendarRevision(data: Record<string, unknown>): string {
    return JSON.stringify(data, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)
}

/** Resolve a deletion explicitly; retaining the draft gives it a new source ID. */
export async function resolveGoogleDeletionConflict(event: CalendarEvent, keep?: Record<string, unknown>, session = captureUserSession()): Promise<void> {
    const ref = session.doc(investDB, CALENDAR_EVENTS_COLLECTION, event.id)
    const replacement = keep ? doc(session.col(investDB, CALENDAR_EVENTS_COLLECTION)) : null
    await runTransaction(investDB, async transaction => {
        const current = await transaction.get(ref)
        session.assertActive()
        if (!current.exists() || current.data()?.googleSyncConflict !== 'remote-deleted'
            || (current.data()?.updatedAt || '') !== (event.updatedAt || '')) throw new Error('行程已變更或衝突已處理，請重新載入。')
        if (keep && replacement) {
            const data = { ...current.data(), ...keep }
            for (const field of ['id', 'googleEventId', 'googleSyncConflict', 'recurringEventId', 'originalStartTime']) delete data[field]
            transaction.set(replacement, { ...data, updatedAt: new Date().toISOString(), googlePendingLocalChange: true })
        }
        transaction.delete(ref)
    })
    session.assertActive()
}

// ── 7. 分批呼叫推送 function ──────────────────────────────────────────

export interface SyncSummary {
    warnings: string[]
    pushedCreated: number
    pushedUpdated: number
    pushedSkipped: number
    pushedDeleted: number
    pulledUpdated: number
    pulledCreated: number
    pulledDeleted: number
    failed: number
    errors: string[]
}

/**
 * 執行一次完整的雙向同步：ensure 行事曆 → pull → 比對 → push →
 * 把結果套用回 Firestore。
 */
export async function performGoogleCalendarSync(
    auth: GoogleCalendarAuth,
    onProgress?: (stage: string) => void
): Promise<SyncSummary> {
    const session = captureUserSession()
    const summary: SyncSummary = {
        warnings: [],
        pushedCreated: 0,
        pushedUpdated: 0,
        pushedSkipped: 0,
        pushedDeleted: 0,
        pulledUpdated: 0,
        pulledCreated: 0,
        pulledDeleted: 0,
        failed: 0,
        errors: [],
    }

    onProgress?.('確認專屬行事曆')
    const calendarId = await ensureGoogleCalendarId(auth, session)

    onProgress?.('讀取 Google 行事曆現有事件')
    const pullRes = await syncFetch(session, PULL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: auth.refreshToken, calendarId }),
    })
    const pullData = await pullRes.json()
    if (!pullRes.ok) throw new Error(pullData.error || '讀取 Google 行事曆事件失敗')
    session.assertActive()
    const pullEvents: PullEvent[] = pullData.events || []

    onProgress?.('比對異動')
    const reconciled = await reconcileATypeEvents(auth.syncTypes, pullEvents, session)
    summary.warnings.push(...reconciled.warnings)
    const bTypeEvents = await gatherUpcomingBTypeEvents(auth.syncTypes, session)
    session.assertActive()
    const bTypePushList: PushEventInput[] = bTypeEvents.map(e => ({
        sourceKind: 'generated',
        id: e.id,
        date: e.date,
        title: e.title,
        type: e.type,
        description: e.description,
        url: e.url,
        ...generatedFomcRevision(e, pullEvents.find(remote => remote.sourceId === e.id)),
    }))

    const fullPushList: PushEventInput[] = [...reconciled.pushList.map(e => ({ ...e, sourceKind: 'manual' as const })), ...bTypePushList]

    // ── 套用 pull 端算出的 Firestore 異動 ──────────────────────────────
    onProgress?.('寫回 Firestore（Google 端異動）')
    const applyPull = async (id: string, data?: Partial<StoredCalendarEvent>) => {
        const ref = session.doc(investDB, CALENDAR_EVENTS_COLLECTION, id)
        await runTransaction(investDB, async transaction => {
            const current = await transaction.get(ref)
            session.assertActive()
            if (!current.exists() || calendarRevision(current.data()) !== reconciled.baselines[id]) throw new Error('行程在同步期間已變更，保留目前資料，請重新同步')
            if (data) transaction.update(ref, data)
            else transaction.delete(ref)
        })
        session.assertActive()
    }
    for (const del of reconciled.firestoreDeletes) {
        try {
            await applyPull(del)
            summary.pulledDeleted++
        } catch (err) {
            session.assertActive()
            summary.failed++
            summary.errors.push(`刪除 Firestore 文件 ${del} 失敗：${err instanceof Error ? err.message : '未知錯誤'}`)
        }
    }
    for (const upd of reconciled.firestoreUpdates) {
        try {
            await applyPull(upd.id, upd.data)
            const original = JSON.parse(reconciled.baselines[upd.id]) as Record<string, unknown>
            reconciled.baselines[upd.id] = calendarRevision({ ...original, ...upd.data })
            summary.pulledUpdated++
        } catch (err) {
            summary.failed++
            summary.errors.push(`更新 Firestore 文件 ${upd.id} 失敗：${err instanceof Error ? err.message : '未知錯誤'}`)
        }
    }
    const createdLinkTargets: { docId: string; googleEventId: string }[] = []
    for (const create of reconciled.firestoreCreates) {
        try {
            const id = await importedEventId(calendarId, create.googleEventId!)
            const ref = session.doc(investDB, CALENDAR_EVENTS_COLLECTION, id)
            const inserted = await runTransaction(investDB, async transaction => {
                session.assertActive()
                const existing = await transaction.get(ref)
                session.assertActive()
                if (existing.exists()) return false
                transaction.set(ref, create)
                return true
            })
            if (inserted) summary.pulledCreated++
            if (inserted) reconciled.baselines[id] = calendarRevision(create)
            if (create.googleEventId) {
                createdLinkTargets.push({ docId: ref.id, googleEventId: create.googleEventId })
            }
        } catch (err) {
            summary.failed++
            summary.errors.push(`建立 Firestore 文件失敗：${err instanceof Error ? err.message : '未知錯誤'}`)
        }
    }
    // Google 端新建的事件，回填 sourceId（用新產生的 Firestore 文件 id）
    createdLinkTargets.forEach(t => {
        fullPushList.push({ id: t.docId, date: '', title: '', googleEventId: t.googleEventId, linkOnly: true, sourceKind: 'manual', type: 'personal' })
    })

    // ── 推送到 Google（新增／更新／刪除）────────────────────────────────
    onProgress?.('推送到 Google 行事曆')
    const linkResults: { id: string; googleEventId: string; updatedAt?: string }[] = []

    // 即使沒有新增／更新，只要有待刪除事件，也必須送出一個空 events 批次。
    const pushBatchCount = Math.max(
        Math.ceil(fullPushList.length / BATCH_SIZE),
        reconciled.deleteGoogleEventIds.length > 0 ? 1 : 0,
    )

    for (let batchIndex = 0; batchIndex < pushBatchCount; batchIndex++) {
        const i = batchIndex * BATCH_SIZE
        const batch = fullPushList.slice(i, i + BATCH_SIZE)
        const deleteBatch = batchIndex === 0 ? reconciled.deleteGoogleEventIds : []
        const res = await syncFetch(session, SYNC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                refreshToken: auth.refreshToken,
                calendarId,
                events: batch,
                deleteGoogleEventIds: deleteBatch,
            }),
        })
        const data = await res.json()
        if (!res.ok) {
            summary.failed += Math.max(batch.length, deleteBatch.length)
            summary.errors.push(data.error || `批次 ${batchIndex + 1} 失敗（HTTP ${res.status}）`)
            if (res.status === 401) break
            continue
        }
        summary.pushedCreated += data.created ?? 0
        summary.pushedUpdated += data.updated ?? 0
        summary.pushedSkipped += data.skipped ?? 0
        summary.pushedDeleted += data.deleted ?? 0
        summary.failed += data.failed ?? 0
        summary.errors.push(...(data.errors ?? []))
        summary.warnings.push(...(data.warnings ?? []))
        linkResults.push(...(data.links ?? []))
    }

    // ── 把 push 結果的 googleEventId／updatedAt 寫回 Firestore（僅 A 類）──
    onProgress?.('更新連結狀態')
    const aTypeIds = new Set(reconciled.pushList.map(p => p.id))
    createdLinkTargets.forEach(t => aTypeIds.add(t.docId))
    for (const link of linkResults) {
        if (!aTypeIds.has(link.id)) continue
        try {
            await runTransaction(investDB, async transaction => {
                const ref = session.doc(investDB, CALENDAR_EVENTS_COLLECTION, link.id)
                const current = await transaction.get(ref)
                session.assertActive()
                if (!current.exists()) throw new Error('行程已刪除')
                const unchanged = calendarRevision(current.data()) === reconciled.baselines[link.id]
                transaction.update(ref, {
                    googleEventId: link.googleEventId,
                    googlePendingLocalChange: !unchanged,
                    ...(unchanged && link.updatedAt ? { updatedAt: link.updatedAt } : {}),
                })
            })
        } catch {
            session.assertActive()
            summary.failed++
            summary.errors.push(`連結狀態 ${link.id} 寫回失敗，下次同步會重試`)
            // 寫回連結狀態失敗不影響本次同步結果，下次同步會再嘗試
        }
    }

    session.assertActive()
    return summary
}
