import { getDocsFromServer, runTransaction } from 'firebase/firestore'
import { investAuth } from './auth'
import { investDB } from './firebase'
import { captureUserSession } from './userDB'
import { getGoogleCalendarAuth, performGoogleCalendarSync, type GoogleCalendarAuth } from './googleCalendar'
import { invalidateCalendarEvents } from './plannerData'
import { calendarDate, type EventTime } from './calendarTiming'
import { ledgerSignature } from './exactTwr'

export interface GoogleSeries {
    id: string; etag: string; summary: string; description: string
    recurrence: string[]; start: EventTime; end: EventTime
}
type Session = ReturnType<typeof captureUserSession>
export async function seriesRequest<T>(action: 'read' | 'update' | 'inspect', seriesId: string, payload: Record<string, unknown> = {}, session = captureUserSession(), auth?: GoogleCalendarAuth): Promise<T> {
    const connection = auth || await getGoogleCalendarAuth()
    session.assertActive()
    if (!connection?.calendarId) throw new Error('請先連結 Google 並完成一次同步。')
    const token = await investAuth.currentUser?.getIdToken()
    session.assertActive()
    if (!token) throw new Error('請先登入。')
    const response = await fetch('/.netlify/functions/google-calendar-series', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000), body: JSON.stringify({ ...payload, action, seriesId, calendarId: connection.calendarId, refreshToken: connection.refreshToken }) })
    session.assertActive()
    const data = await response.json()
    session.assertActive()
    if (!response.ok) throw new Error(`${data.error || '系列操作失敗'}${response.status === 429 ? `（${response.headers.get('Retry-After') || '?'} 秒後重試）` : ''}`)
    return data as T
}

/** Explicit GET results, never absence from a bounded list, authorize local cleanup. */
export async function refreshGoogleSeries(seriesId: string, session: Session = captureUserSession()) {
    const auth = await getGoogleCalendarAuth()
    session.assertActive()
    if (!auth?.calendarId) throw new Error('Google 尚未連結。')
    const snapshot = await getDocsFromServer(session.col(investDB, 'calendarEvents'))
    session.assertActive()
    const locals = snapshot.docs.filter(d => d.data().recurringEventId === seriesId && d.data().googleEventId)
    type Instance = { id: string; status: string; summary?: string; description?: string; start?: EventTime; end?: EventTime; updated?: string }
    for (let offset = 0; offset < locals.length; offset += 50) {
        const batch = locals.slice(offset, offset + 50)
        const result = await seriesRequest<{ instances: Instance[] }>('inspect', seriesId, { ids: batch.map(d => d.data().googleEventId) }, session, auth)
        for (const local of batch) {
            const remote = result.instances.find(row => row.id === local.data().googleEventId)
            if (!remote) throw new Error('Google 未完整回覆舊行程，已保留未確認的資料。')
            await runTransaction(investDB, async tx => {
                const current = await tx.get(local.ref)
                session.assertActive()
                if (!current.exists()) return
                if (ledgerSignature(current.data()) !== ledgerSignature(local.data()) || current.data().googlePendingLocalChange) throw new Error('本機行程同時被修改，請先處理單次行程的同步，再重新刷新整組。')
                if (remote.status === 'cancelled') tx.delete(local.ref)
                else {
                    if (!remote.start || !remote.end || !remote.updated || !calendarDate(remote.start)) throw new Error('Google 行程資料不完整，已保留本機資料。')
                    // Preserve pending local edits even if their timestamp is newer than Google.
                    if ((current.data().updatedAt || '') > remote.updated) throw new Error('本機有較新的單次行程，請先同步後再刷新整組。')
                    tx.update(local.ref, { title: remote.summary || '（未命名行程）', description: remote.description || '', date: calendarDate(remote.start), start: remote.start, end: remote.end, updatedAt: remote.updated })
                }
            })
            session.assertActive()
        }
    }
    invalidateCalendarEvents()
    // Pull newly generated occurrences through the existing version-checked synchronization.
    const summary = await performGoogleCalendarSync({ ...auth, syncTypes: [...new Set([...auth.syncTypes, 'personal' as const])] })
    session.assertActive()
    invalidateCalendarEvents()
    if (summary.failed) throw new Error('規則已更新，部分行程尚未刷新：' + summary.errors.join('；'))
}
