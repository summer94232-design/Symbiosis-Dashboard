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
 *    使用者手動維護的文件）維持單向：只會「新增缺少的」，不做更新／刪除。
 * 6. 把 4、5 算出的異動送去 push function，並把結果（googleEventId 對應、
 *    Firestore 端該做的異動）套用回 Firestore。
 *
 * 放置位置：src/lib/googleCalendar.ts
 */

import { getDoc, setDoc, deleteDoc, updateDoc, addDoc, getDocs, query, where, collection } from 'firebase/firestore'
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
    calendarId?: string
}

/** Firestore 的 calendarEvents 文件，多帶雙向同步需要的兩個欄位 */
interface StoredCalendarEvent extends CalendarEvent {
    googleEventId?: string
    updatedAt?: string
}

interface PullEvent {
    googleEventId: string
    sourceId: string | null
    title: string
    date: string
    description: string
    updated: string
    cancelled: boolean
}

interface PushEventInput {
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

// ── 1. Google OAuth 授權 URL ──────────────────────────────────────────────
// ⚠️ scope 用完整的 calendar（不是 calendar.events），因為要能建立專屬行事曆

export function getGoogleCalendarAuthUrl(): string {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string
    const redirectUri = `${window.location.origin}/.netlify/functions/google-calendar-auth`
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/calendar',
        access_type: 'offline',
        prompt: 'consent',
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

// ── 2. 解析 Google 導回的 URL fragment（在 CalendarSettings 掛載時呼叫）────

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

/** 確保專屬行事曆存在，回傳 calendarId（沒有就建立，並存回 Firestore） */
export async function ensureGoogleCalendarId(auth: GoogleCalendarAuth): Promise<string> {
    const res = await fetch(ENSURE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: auth.refreshToken, calendarId: auth.calendarId }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '建立／確認專屬行事曆失敗')

    if (data.calendarId !== auth.calendarId) {
        await setDoc(userDoc(investDB, AUTH_COLLECTION, AUTH_DOC_ID), { calendarId: data.calendarId }, { merge: true })
    }
    return data.calendarId as string
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

async function gatherUpcomingBTypeEvents(syncTypes: SyncEventType[]): Promise<CalendarEvent[]> {
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

// ── 6. A 類（calendarEvents collection）：雙向比對 ────────────────────

interface ReconcileResult {
    firestoreUpdates: { id: string; data: Partial<StoredCalendarEvent> }[]
    firestoreDeletes: string[]
    firestoreCreates: Omit<StoredCalendarEvent, 'id'>[]
    pushList: PushEventInput[]
    deleteGoogleEventIds: string[]
}

async function reconcileATypeEvents(syncTypes: SyncEventType[], pullEvents: PullEvent[]): Promise<ReconcileResult> {
    const today = new Date()
    const startISO = toISODate(today)
    const endISO = toISODate(addMonths(today, SYNC_MONTHS_AHEAD))
    const relevantTypes = A_TYPE_MANUAL_TYPES.filter(t => syncTypes.includes(t))

    const result: ReconcileResult = {
        firestoreUpdates: [],
        firestoreDeletes: [],
        firestoreCreates: [],
        pushList: [],
        deleteGoogleEventIds: [],
    }
    if (relevantTypes.length === 0) return result

    const snap = await getDocs(query(userCol(investDB, CALENDAR_EVENTS_COLLECTION), where('date', '>=', startISO)))
    const firestoreDocs = new Map<string, StoredCalendarEvent>()
    snap.docs.forEach(d => {
        const data = { id: d.id, ...d.data() } as StoredCalendarEvent
        if (relevantTypes.includes(data.type) && inRange(data.date, startISO, endISO)) {
            firestoreDocs.set(d.id, data)
        }
    })

    const googleBySourceId = new Map<string, PullEvent>()
    const googleNative: PullEvent[] = []
    pullEvents.forEach(ev => {
        if (ev.sourceId) googleBySourceId.set(ev.sourceId, ev)
        else if (!ev.cancelled) googleNative.push(ev)
    })

    // 6a. 有 sourceId 的 Google 事件：跟 Firestore 比對
    for (const [sourceId, gEvt] of googleBySourceId) {
        const localDoc = firestoreDocs.get(sourceId)

        if (!localDoc) {
            // Firestore 找不到這筆 → App 端已刪除，Google 端要跟著刪（除非本來就已經是 cancelled）
            if (!gEvt.cancelled) result.deleteGoogleEventIds.push(gEvt.googleEventId)
            continue
        }

        if (gEvt.cancelled) {
            // Google 端被刪除 → Firestore 也刪掉
            result.firestoreDeletes.push(sourceId)
            continue
        }

        const localUpdatedAt = localDoc.updatedAt || ''
        if (gEvt.updated > localUpdatedAt) {
            // Google 端比較新 → 覆蓋回 Firestore
            result.firestoreUpdates.push({
                id: sourceId,
                data: {
                    title: gEvt.title,
                    date: gEvt.date,
                    description: gEvt.description,
                    updatedAt: gEvt.updated,
                    googleEventId: gEvt.googleEventId,
                },
            })
        } else if (localUpdatedAt > gEvt.updated || !localDoc.googleEventId) {
            // Firestore 端比較新，或還沒連結過 → 推去 Google
            result.pushList.push({
                id: sourceId,
                date: localDoc.date,
                title: localDoc.title,
                type: localDoc.type,
                description: localDoc.description,
                url: localDoc.url,
                googleEventId: gEvt.googleEventId,
            })
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
        })
    }

    // 6c. Firestore 有、但完全沒被 Google 端提到（從未同步過）→ 推去 Google 新增
    for (const [id, localDoc] of firestoreDocs) {
        if (googleBySourceId.has(id)) continue // 已經在 6a 處理過
        result.pushList.push({
            id,
            date: localDoc.date,
            title: localDoc.title,
            type: localDoc.type,
            description: localDoc.description,
            url: localDoc.url,
        })
    }

    return result
}

// ── 7. 分批呼叫推送 function ──────────────────────────────────────────

export interface SyncSummary {
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
    const summary: SyncSummary = {
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
    const calendarId = await ensureGoogleCalendarId(auth)

    onProgress?.('讀取 Google 行事曆現有事件')
    const pullRes = await fetch(PULL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: auth.refreshToken, calendarId }),
    })
    const pullData = await pullRes.json()
    if (!pullRes.ok) throw new Error(pullData.error || '讀取 Google 行事曆事件失敗')
    const pullEvents: PullEvent[] = pullData.events || []

    onProgress?.('比對異動')
    const reconciled = await reconcileATypeEvents(auth.syncTypes, pullEvents)
    const bTypeEvents = await gatherUpcomingBTypeEvents(auth.syncTypes)
    const bTypePushList: PushEventInput[] = bTypeEvents.map(e => ({
        id: e.id,
        date: e.date,
        title: e.title,
        type: e.type,
        description: e.description,
        url: e.url,
    }))

    const fullPushList = [...reconciled.pushList, ...bTypePushList]

    // ── 套用 pull 端算出的 Firestore 異動 ──────────────────────────────
    onProgress?.('寫回 Firestore（Google 端異動）')
    for (const del of reconciled.firestoreDeletes) {
        try {
            await deleteDoc(userDoc(investDB, CALENDAR_EVENTS_COLLECTION, del))
            summary.pulledDeleted++
        } catch (err) {
            summary.failed++
            summary.errors.push(`刪除 Firestore 文件 ${del} 失敗：${err instanceof Error ? err.message : '未知錯誤'}`)
        }
    }
    for (const upd of reconciled.firestoreUpdates) {
        try {
            await updateDoc(userDoc(investDB, CALENDAR_EVENTS_COLLECTION, upd.id), upd.data)
            summary.pulledUpdated++
        } catch (err) {
            summary.failed++
            summary.errors.push(`更新 Firestore 文件 ${upd.id} 失敗：${err instanceof Error ? err.message : '未知錯誤'}`)
        }
    }
    const createdLinkTargets: { docId: string; googleEventId: string }[] = []
    for (const create of reconciled.firestoreCreates) {
        try {
            const ref = await addDoc(userCol(investDB, CALENDAR_EVENTS_COLLECTION), create)
            summary.pulledCreated++
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
        fullPushList.push({ id: t.docId, date: '', title: '', googleEventId: t.googleEventId })
    })
    // 上面這筆 link-only 的 push 不需要真的改標題/日期，補回原始內容避免被清空
    for (const t of createdLinkTargets) {
        const src = reconciled.firestoreCreates.find(c => c.googleEventId === t.googleEventId)
        const item = fullPushList.find(p => p.id === t.docId && p.googleEventId === t.googleEventId)
        if (src && item) {
            item.date = src.date
            item.title = src.title
            item.description = src.description
            item.type = src.type
        }
    }

    // ── 推送到 Google（新增／更新／刪除）────────────────────────────────
    onProgress?.('推送到 Google 行事曆')
    const linkResults: { id: string; googleEventId: string }[] = []

    // 即使沒有新增／更新，只要有待刪除事件，也必須送出一個空 events 批次。
    const pushBatchCount = Math.max(
        Math.ceil(fullPushList.length / BATCH_SIZE),
        reconciled.deleteGoogleEventIds.length > 0 ? 1 : 0,
    )

    for (let batchIndex = 0; batchIndex < pushBatchCount; batchIndex++) {
        const i = batchIndex * BATCH_SIZE
        const batch = fullPushList.slice(i, i + BATCH_SIZE)
        const deleteBatch = batchIndex === 0 ? reconciled.deleteGoogleEventIds : []
        const res = await fetch(SYNC_URL, {
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
        linkResults.push(...(data.links ?? []))
    }

    // ── 把 push 結果的 googleEventId／updatedAt 寫回 Firestore（僅 A 類）──
    onProgress?.('更新連結狀態')
    const aTypeIds = new Set(reconciled.pushList.map(p => p.id))
    createdLinkTargets.forEach(t => aTypeIds.add(t.docId))
    const now = new Date().toISOString()
    for (const link of linkResults) {
        if (!aTypeIds.has(link.id)) continue
        try {
            await updateDoc(userDoc(investDB, CALENDAR_EVENTS_COLLECTION, link.id), {
                googleEventId: link.googleEventId,
                updatedAt: now,
            })
        } catch {
            // 寫回連結狀態失敗不影響本次同步結果，下次同步會再嘗試
        }
    }

    return summary
}
