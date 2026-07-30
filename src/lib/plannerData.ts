import { getDocs, orderBy, query } from 'firebase/firestore'
import { investDB } from './firebase'
import { cache } from './cache'
import { getUID, userCol } from './userDB'

const TTL_SECONDS = 90
type PlannerCollection = 'calendarEvents' | 'tasks' | 'taskProjects'

async function fetchPlannerCollection<T>(name: PlannerCollection, orderField: string): Promise<T[]> {
  const key = `planner:${name}:${getUID()}`
  const rows = await cache.getOrLoad<Record<string, unknown>[]>(key, async () => {
    const snap = await getDocs(query(userCol(investDB, name), orderBy(orderField, 'asc')))
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
  }, TTL_SECONDS)
  return rows.map(row => ({ ...row })) as T[]
}

export const fetchCalendarEvents = <T = Record<string, unknown>>() => fetchPlannerCollection<T>('calendarEvents', 'date')
export const fetchTasks = <T = Record<string, unknown>>() => fetchPlannerCollection<T>('tasks', 'order')
export const fetchTaskProjects = <T = Record<string, unknown>>() => fetchPlannerCollection<T>('taskProjects', 'order')

export const invalidateCalendarEvents = () => cache.invalidatePrefix('planner:calendarEvents:')
export const invalidateTasks = () => cache.invalidatePrefix('planner:tasks:')
export const invalidateTaskProjects = () => cache.invalidatePrefix('planner:taskProjects:')
