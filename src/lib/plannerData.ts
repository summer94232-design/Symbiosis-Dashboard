import { getDocs, orderBy, query, where, type CollectionReference, type Query } from 'firebase/firestore'
import { investDB } from './firebase'
import { cache } from './cache'
import { captureUserSession } from './userDB'

const TTL_SECONDS = 90
type PlannerCollection = 'calendarEvents' | 'tasks' | 'taskProjects'
type PlannerRow = Record<string, unknown>

/**
 * Range reads match events by their start `date`. Multi-day events that started
 * before the requested range are still needed (they may be ongoing), so the
 * lower bound looks back this many days; callers keep their overlap filter.
 */
export const PLANNER_EVENT_LOOKBACK_DAYS = 180

const fullKey = (name: PlannerCollection, uid: string) => `planner:${name}:${uid}`

async function fetchPlannerCollection<T>(name: PlannerCollection, orderField: string): Promise<T[]> {
  const session = captureUserSession()
  const key = fullKey(name, session.uid)
  const rows = await cache.getOrLoad<PlannerRow[]>(key, async () => {
    const snap = await getDocs(query(session.col(investDB, name), orderBy(orderField, 'asc')))
    session.assertActive()
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
  }, TTL_SECONDS)
  session.assertActive()
  return rows.map(row => ({ ...row })) as T[]
}

/**
 * Reads a filtered subset. When the full collection is already cached (for
 * example after opening the calendar), it is filtered locally instead of
 * issuing another Firestore read. Keys share the collection prefix, so the
 * existing invalidate* helpers clear these entries too.
 */
async function fetchPlannerSubset<T>(
  name: PlannerCollection,
  variant: string,
  build: (col: CollectionReference) => Query,
  matches: (row: PlannerRow) => boolean,
  sort: (a: PlannerRow, b: PlannerRow) => number,
): Promise<T[]> {
  const session = captureUserSession()
  const full = cache.get<PlannerRow[]>(fullKey(name, session.uid))
  if (full) {
    session.assertActive()
    return full.filter(matches).sort(sort).map(row => ({ ...row })) as T[]
  }
  const rows = await cache.getOrLoad<PlannerRow[]>(`planner:${name}:${variant}:${session.uid}`, async () => {
    const snap = await getDocs(build(session.col(investDB, name) as CollectionReference))
    session.assertActive()
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(matches).sort(sort)
  }, TTL_SECONDS)
  session.assertActive()
  return rows.map(row => ({ ...row })) as T[]
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export function shiftDateString(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
}

const compareValues = (a: unknown, b: unknown) => {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a ?? '').localeCompare(String(b ?? ''))
}

export const fetchCalendarEvents = <T = PlannerRow>() => fetchPlannerCollection<T>('calendarEvents', 'date')
export const fetchTasks = <T = PlannerRow>() => fetchPlannerCollection<T>('tasks', 'order')
export const fetchTaskProjects = <T = PlannerRow>() => fetchPlannerCollection<T>('taskProjects', 'order')

/**
 * Events whose start date is between (from - lookback) and through, ordered by date.
 * Callers must still apply eventOverlapsRange / eventOccursOn for the exact range.
 */
export function fetchCalendarEventsInRange<T = PlannerRow>(from: string, through: string): Promise<T[]> {
  if (!DATE_RE.test(from) || !DATE_RE.test(through)) return Promise.reject(new Error('Invalid date range'))
  const lower = shiftDateString(from, -PLANNER_EVENT_LOOKBACK_DAYS)
  return fetchPlannerSubset<T>('calendarEvents', `range:${lower}:${through}`,
    col => query(col, where('date', '>=', lower), where('date', '<=', through), orderBy('date', 'asc')),
    row => typeof row.date === 'string' && row.date >= lower && row.date <= through,
    (a, b) => compareValues(a.date, b.date))
}

/** Unfinished tasks (`done == false`), in the same `order` sequence as fetchTasks. */
export function fetchOpenTasks<T = PlannerRow>(): Promise<T[]> {
  return fetchPlannerSubset<T>('tasks', 'open',
    col => query(col, where('done', '==', false)),
    // fetchTasks orders by `order`, which omits documents without that field; keep the same set.
    row => row.done === false && row.order !== undefined,
    (a, b) => compareValues(a.order, b.order))
}

export const invalidateCalendarEvents = () => cache.invalidatePrefix('planner:calendarEvents:')
export const invalidateTasks = () => cache.invalidatePrefix('planner:tasks:')
export const invalidateTaskProjects = () => cache.invalidatePrefix('planner:taskProjects:')
