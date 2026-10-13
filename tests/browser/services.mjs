// In-memory services, only loaded by the explicit browser-test Vite configuration.
import { useSyncExternalStore } from 'react'
export const investDB = {}
export const kmsDB = {}
export const investAuth = { currentUser: { uid: 'fixture-A', getIdToken: async () => 'fixture-token' } }
investAuth.onAuthStateChanged = callback => { callback(investAuth.currentUser); return () => {} }
export const kmsAuth = { currentUser: { uid: 'fixture-A' } }
export const state = { mode: 'normal', rows: new Map(), requests: 0, pending: [], log: [], network: 'normal', holdReads: false, pendingReads: [] }
let sequence = 0
export function switchAccount() {
  const uid = investAuth.currentUser.uid === 'fixture-A' ? 'fixture-B' : 'fixture-A'
  investAuth.currentUser = { uid, getIdToken: async () => 'fixture-token' }; kmsAuth.currentUser = { uid }
}
let syncVersion = 0
const syncListeners = new Set()
export const publishRemoteChange = () => { syncVersion++; syncListeners.forEach(fn => fn()) }
export const useInvestSync = () => ({ version: useSyncExternalStore(fn => { syncListeners.add(fn); return () => syncListeners.delete(fn) }, () => syncVersion), status: 'live', reconnect: publishRemoteChange })
export const onSnapshot = (ref, options, callback) => { const next = typeof options === 'function' ? options : callback; let active = true; getDocs(ref).then(snapshot => { if (active) next(snapshot) }).catch(() => {}); return () => { active = false } }
export const collection = (_db, ...parts) => ({ path: parts.join('/') })
export const doc = (parent, ...parts) => {
  const path = parent.path ? `${parent.path}/${parts.join('/') || `id-${++sequence}`}` : parts.join('/')
  return { path, id: path.split('/').at(-1) }
}
export const orderBy = () => null
export const where = (field, op, value) => ({ field, op, value })
export const query = (ref, ...filters) => ({ ...ref, filters: filters.filter(Boolean) })
const snapshot = ref => ({ id: ref.id, ref, exists: () => state.rows.has(ref.path), data: () => structuredClone(state.rows.get(ref.path)) })
export const getDoc = async ref => snapshot(ref)
export const getDocFromServer = async ref => { if (state.mode === 'read-fail') throw new Error('測試：讀取斷線'); return snapshot(ref) }
export async function getDocs(ref) {
  if (state.holdReads) await new Promise(resolve => state.pendingReads.push(resolve))
  if (state.mode === 'read-fail') throw new Error('測試：讀取斷線')
  const docs = [...state.rows].filter(([path, data]) => path.startsWith(ref.path + '/') && path.split('/').length === ref.path.split('/').length + 1 && (ref.filters || []).every(f => data[f.field] === f.value)).map(([path]) => snapshot({ path, id: path.split('/').at(-1) }))
  return { docs, empty: !docs.length, size: docs.length, forEach: fn => docs.forEach(fn), metadata: { fromCache: false, hasPendingWrites: false }, docChanges: () => [] }
}
export const getDocsFromServer = getDocs
async function commit(ops) {
  state.requests++
  const mode = state.mode
  if (mode === 'delay') await new Promise(resolve => state.pending.push(resolve))
  if (mode === 'fail') throw new Error('測試：寫入斷線，請重試')
  for (const [kind, ref, value, options] of ops) {
    state.log.push(`${kind} ${ref.path}`)
    if (kind === 'delete') state.rows.delete(ref.path)
    else state.rows.set(ref.path, structuredClone(kind === 'update' || options?.merge ? { ...state.rows.get(ref.path), ...value } : value))
  }
  if (mode === 'lost-ack') throw new Error('測試：資料已送達，回覆遺失')
}
export function writeBatch() {
  const ops = []
  return { set: (...args) => ops.push(['set', ...args]), update: (...args) => ops.push(['update', ...args]), delete: ref => ops.push(['delete', ref]), commit: () => commit(ops) }
}
export const setDoc = (ref, data, options) => commit([['set', ref, data, options]])
export async function addDoc(ref, data) {
  const created = doc(ref)
  await setDoc(created, data)
  return created
}
export const updateDoc = (ref, data) => commit([['update', ref, data]])
export const deleteDoc = ref => commit([['delete', ref]])
export async function runTransaction(_db, work) {
  const batch = writeBatch()
  const result = await work({ ...batch, get: getDoc })
  await batch.commit()
  return result
}
export const lookupStockName = async () => '隔離測試股票'
export const cacheStockName = () => {}
export const fetchInvestorMeetings = async () => []
export const addInvestorMeetingDates = async () => 0
export const removeInvestorMeetingDate = async () => {}
export const syncYahooInvestorMeetings = async () => ({ fetched: 0, changedGroups: 0 })
export const limit = () => null
export const startAfter = () => null
// Fail closed: this test page must never send real application requests.
export function installNetworkFixture() {
  window.fetch = async (url, options = {}) => {
    state.log.push(`HTTP ${url}`)
    if (state.network === 'delay') await new Promise(resolve => state.pending.push(resolve))
    if (state.network === 'fail') throw new Error('測試：Google 連線失敗')
    if (state.network === 'snapshot-trend' && String(url).endsWith('fugle-proxy')) {
      return Response.json({data:['2026-10-01','2026-10-02','2026-10-05'].map((date,i)=>({date,open:100+i,high:101+i,low:99+i,close:100+i}))})
    }
    if (String(url).endsWith('google-calendar-series')) {
      const body = JSON.parse(options.body)
      state.series ||= { id: 'series', etag: '"v1"', summary: '隔離重複系列', start: { date: '2026-09-09' }, end: { date: '2026-09-10' }, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'], status: 'confirmed' }
      if (body.action === 'update') { state.series.recurrence = body.recurrence; state.series.etag = '"v2"' }
      if (body.action === 'inspect') return Response.json({ instances: body.ids.map(id => ({ id, status: 'cancelled' })) })
      return Response.json(state.series)
    }
    if (String(url).endsWith('google-calendar-ensure')) return Response.json({ calendarId: 'fixture-calendar' })
    if (String(url).endsWith('google-calendar-pull')) return Response.json({ events: [] })
    if (String(url).endsWith('google-calendar-sync')) return Response.json({ results: [] })
    throw new Error(`測試頁禁止外連：${url}`)
  }
}

export const saveStockName = async () => {}
export const searchStockByCodePrefix = async () => []
export const searchStockByNamePrefix = async () => []
