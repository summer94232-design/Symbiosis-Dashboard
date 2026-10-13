import { authenticatedFetch } from './authenticatedFetch'
import { collection, getDocs, query, runTransaction, where, writeBatch } from 'firebase/firestore'
import { investDB } from './firebase'
import { captureUserSession } from './userDB'
import {
  mergeInvestorMeetings,
  normalizeMeetingDates as validDates,
  type InvestorMeetingInput,
  type InvestorMeetingRecord,
} from './investorMeetingMerge'
export type { InvestorMeetingInput, InvestorMeetingRecord } from './investorMeetingMerge'

export interface YahooInvestorMeetingSyncResult {
  fetched: number
  changedGroups: number
}

const yahooSyncInFlight = new Map<string, Promise<YahooInvestorMeetingSyncResult>>()

interface InvestorMeetingOverride {
  stockCode: string
  stockName?: string
  yearMonth: string
  addedDates?: string[]
  removedDates?: string[]
  updatedAt?: string
}

export async function fetchInvestorMeetings(yearMonths: string[]): Promise<InvestorMeetingRecord[]> {
  const session = captureUserSession()
  const months = [...new Set(yearMonths)].filter(month => /^\d{4}-\d{2}$/.test(month))
  if (!months.length) return []

  const [globalSnaps, overrideSnaps] = await Promise.all([
    Promise.all(months.map(month => getDocs(query(
      collection(investDB, 'investorMeetings'),
      where('yearMonth', '==', month),
    )))),
    Promise.all(months.map(month => getDocs(query(
      session.col(investDB, 'investorMeetingOverrides'),
      where('yearMonth', '==', month),
    )))),
  ])

  session.assertActive()
  const globalRows: InvestorMeetingRecord[] = globalSnaps.flatMap(snap => snap.docs.map(docSnap => {
    const data = docSnap.data()
    return {
      id: docSnap.id,
      stockCode: String(data.stockCode || ''),
      stockName: String(data.stockName || data.stockCode || ''),
      yearMonth: String(data.yearMonth || ''),
      dates: validDates(data.dates),
    }
  }))
  const overrideRows = overrideSnaps.flatMap(snap => snap.docs.map(docSnap => {
    const data = docSnap.data() as InvestorMeetingOverride
    return {
      id: docSnap.id,
      stockCode: String(data.stockCode || ''),
      stockName: String(data.stockName || data.stockCode || ''),
      yearMonth: String(data.yearMonth || ''),
      dates: [],
      addedDates: validDates(data.addedDates),
      removedDates: validDates(data.removedDates),
    }
  }))

  return mergeInvestorMeetings(globalRows, overrideRows)
}

/** Adds dates only to the current user's override collection; global data remains backend-only. */
export async function addInvestorMeetingDates(inputs: InvestorMeetingInput[], session = captureUserSession()): Promise<number> {
  const grouped = new Map<string, InvestorMeetingInput>()
  inputs.forEach(input => {
    const dates = validDates(input.dates)
    if (!input.stockCode || !/^\d{4}-\d{2}$/.test(input.yearMonth) || !dates.length) return
    const id = `${input.stockCode}-${input.yearMonth}`
    const current = grouped.get(id)
    grouped.set(id, {
      ...input,
      dates: [...new Set([...(current?.dates ?? []), ...dates])].sort(),
    })
  })

  const entries = [...grouped.entries()]
  let completed = 0
  for (let start = 0; start < entries.length; start += 400) {
    session.assertActive()
    const group = entries.slice(start, start + 400)
    try {
      completed += await runTransaction(investDB, async transaction => {
        const refs = group.map(([id]) => session.doc(investDB, 'investorMeetingOverrides', id))
        const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)))
        session.assertActive()
        let changed = 0
        group.forEach(([, input], index) => {
          const current = snapshots[index].data() as InvestorMeetingOverride | undefined
          const addedDates = [...new Set([...validDates(current?.addedDates), ...input.dates])].sort()
          const addedSet = new Set(input.dates)
          const removedDates = validDates(current?.removedDates).filter(date => !addedSet.has(date))
          const stockName = input.stockName || input.stockCode
          if (current && JSON.stringify(addedDates) === JSON.stringify(validDates(current.addedDates)) && JSON.stringify(removedDates) === JSON.stringify(validDates(current.removedDates)) && current.stockName === stockName) return
          transaction.set(refs[index], { stockCode: input.stockCode, stockName, yearMonth: input.yearMonth, addedDates, removedDates, updatedAt: new Date().toISOString() })
          changed++
        })
        return changed
      })
      session.assertActive()
    } catch (error) {
      throw new Error(`法說會更新未完成，已確認更新 ${completed} 組；可重試同一份資料，不會重複新增。${error instanceof Error ? error.message : ''}`)
    }
  }
  return completed
}

/** Yahoo 手動同步的共用入口；儀表板與行事曆同時觸發時只會執行一次。 */
export function syncYahooInvestorMeetings(): Promise<YahooInvestorMeetingSyncResult> {
  const session = captureUserSession()
  const existing = yahooSyncInFlight.get(session.uid)
  if (existing) return existing
  const request = (async () => {
    const response = await authenticatedFetch('/.netlify/functions/yahoo-calendar-proxy', session)
    session.assertActive()
    if (!response.ok) throw new Error(`proxy HTTP ${response.status}`)
    const json = await response.json() as { error?: string; events?: Array<{ code: string; name: string; date: string }> }
    if (json.error) throw new Error(json.error)
    const list = Array.isArray(json.events) ? json.events : []
    const groups = new Map<string, InvestorMeetingInput & { dates: string[] }>()
    for (const event of list) {
      if (!event.code || !/^\d{4}-\d{2}-\d{2}$/.test(event.date)) continue
      const yearMonth = event.date.slice(0, 7)
      const id = `${event.code}-${yearMonth}`
      const current = groups.get(id)
      groups.set(id, {
        stockCode: event.code,
        stockName: event.name || event.code,
        yearMonth,
        dates: [...new Set([...(current?.dates ?? []), event.date])].sort(),
      })
    }
    const changedGroups = await addInvestorMeetingDates([...groups.values()], session)
    return { fetched: list.length, changedGroups }
  })().finally(() => { if (yahooSyncInFlight.get(session.uid) === request) yahooSyncInFlight.delete(session.uid) })
  yahooSyncInFlight.set(session.uid, request)
  return request
}

/** Hides a global date or removes a personal date without modifying the global collection. */
export async function removeInvestorMeetingDate(stockCode: string, stockName: string, isoDate: string): Promise<void> {
  const yearMonth = isoDate.slice(0, 7)
  const id = `${stockCode}-${yearMonth}`
  const session = captureUserSession()
  const ref = session.doc(investDB, 'investorMeetingOverrides', id)
  await runTransaction(investDB, async transaction => {
  const snap = await transaction.get(ref)
  session.assertActive()
  const current = snap.exists() ? snap.data() as InvestorMeetingOverride : null
  transaction.set(ref, {
    stockCode,
    stockName: stockName || current?.stockName || stockCode,
    yearMonth,
    addedDates: validDates(current?.addedDates).filter(date => date !== isoDate),
    removedDates: [...new Set([...validDates(current?.removedDates), isoDate])].sort(),
    updatedAt: new Date().toISOString(),
  })
  })
  session.assertActive()
}

export async function clearInvestorMeetingOverrides(): Promise<void> {
  const session = captureUserSession()
  const snap = await getDocs(session.col(investDB, 'investorMeetingOverrides'))
  session.assertActive()
  for (let start = 0; start < snap.docs.length; start += 400) {
    const batch = writeBatch(investDB)
    snap.docs.slice(start, start + 400).forEach(docSnap => batch.delete(docSnap.ref))
    session.assertActive()
    await batch.commit()
    session.assertActive()
  }
}
