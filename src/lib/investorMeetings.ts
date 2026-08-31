import { collection, getDoc, getDocs, query, setDoc, where, writeBatch } from 'firebase/firestore'
import { investDB } from './firebase'
import { userCol, userDoc } from './userDB'
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

let yahooSyncInFlight: Promise<YahooInvestorMeetingSyncResult> | null = null

interface InvestorMeetingOverride {
  stockCode: string
  stockName?: string
  yearMonth: string
  addedDates?: string[]
  removedDates?: string[]
  updatedAt?: string
}

export async function fetchInvestorMeetings(yearMonths: string[]): Promise<InvestorMeetingRecord[]> {
  const months = [...new Set(yearMonths)].filter(month => /^\d{4}-\d{2}$/.test(month))
  if (!months.length) return []

  const [globalSnaps, overrideSnaps] = await Promise.all([
    Promise.all(months.map(month => getDocs(query(
      collection(investDB, 'investorMeetings'),
      where('yearMonth', '==', month),
    )))),
    Promise.all(months.map(month => getDocs(query(
      userCol(investDB, 'investorMeetingOverrides'),
      where('yearMonth', '==', month),
    )))),
  ])

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
export async function addInvestorMeetingDates(inputs: InvestorMeetingInput[]): Promise<number> {
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
  const snapshots = await Promise.all(entries.map(([id]) =>
    getDoc(userDoc(investDB, 'investorMeetingOverrides', id))
  ))
  const now = new Date().toISOString()
  const writes = entries.map(([id, input], index) => {
    const ref = userDoc(investDB, 'investorMeetingOverrides', id)
    const snap = snapshots[index]
    const current = snap.exists() ? snap.data() as InvestorMeetingOverride : null
    const addedDates = [...new Set([...validDates(current?.addedDates), ...input.dates])].sort()
    const addedSet = new Set(input.dates)
    const removedDates = validDates(current?.removedDates).filter(date => !addedSet.has(date))
    const stockName = input.stockName || input.stockCode
    if (current
      && JSON.stringify(addedDates) === JSON.stringify(validDates(current.addedDates))
      && JSON.stringify(removedDates) === JSON.stringify(validDates(current.removedDates))
      && current.stockCode === input.stockCode
      && (current.stockName || current.stockCode) === stockName) return null
    return {
      ref,
      data: {
        stockCode: input.stockCode,
        stockName,
        yearMonth: input.yearMonth,
        addedDates,
        removedDates,
        updatedAt: now,
      },
    }
  }).filter((write): write is NonNullable<typeof write> => write !== null)
  for (let start = 0; start < writes.length; start += 400) {
    const batch = writeBatch(investDB)
    writes.slice(start, start + 400).forEach(write => batch.set(write.ref, write.data))
    await batch.commit()
  }
  return writes.length
}

/** Yahoo 手動同步的共用入口；儀表板與行事曆同時觸發時只會執行一次。 */
export function syncYahooInvestorMeetings(): Promise<YahooInvestorMeetingSyncResult> {
  if (yahooSyncInFlight) return yahooSyncInFlight
  yahooSyncInFlight = (async () => {
    const response = await fetch('/.netlify/functions/yahoo-calendar-proxy')
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
    const changedGroups = await addInvestorMeetingDates([...groups.values()])
    return { fetched: list.length, changedGroups }
  })().finally(() => { yahooSyncInFlight = null })
  return yahooSyncInFlight
}

/** Hides a global date or removes a personal date without modifying the global collection. */
export async function removeInvestorMeetingDate(stockCode: string, stockName: string, isoDate: string): Promise<void> {
  const yearMonth = isoDate.slice(0, 7)
  const id = `${stockCode}-${yearMonth}`
  const ref = userDoc(investDB, 'investorMeetingOverrides', id)
  const snap = await getDoc(ref)
  const current = snap.exists() ? snap.data() as InvestorMeetingOverride : null
  await setDoc(ref, {
    stockCode,
    stockName: stockName || current?.stockName || stockCode,
    yearMonth,
    addedDates: validDates(current?.addedDates).filter(date => date !== isoDate),
    removedDates: [...new Set([...validDates(current?.removedDates), isoDate])].sort(),
    updatedAt: new Date().toISOString(),
  })
}

export async function clearInvestorMeetingOverrides(): Promise<void> {
  const snap = await getDocs(userCol(investDB, 'investorMeetingOverrides'))
  for (let start = 0; start < snap.docs.length; start += 400) {
    const batch = writeBatch(investDB)
    snap.docs.slice(start, start + 400).forEach(docSnap => batch.delete(docSnap.ref))
    await batch.commit()
  }
}
