export type HealthSeverity = 'critical' | 'warning' | 'info'

export interface HealthIssue {
  id: string
  severity: HealthSeverity
  title: string
  detail: string
  count: number
  samples?: string[]
  affectedIds?: string[]
}

export interface HealthInput {
  trades: Record<string, unknown>[]
  dividends: Record<string, unknown>[]
  cashflow: Record<string, unknown>[]
  snapshots: Record<string, unknown>[]
  notes: Record<string, unknown>[]
  trash: Record<string, unknown>[]
  now?: Date
}

export interface HealthReport {
  checkedAt: string
  recordsChecked: number
  issues: HealthIssue[]
  counts: Record<HealthSeverity, number>
}

const validDate = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00`))
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0
const nonNegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const label = (row: Record<string, unknown>) => String(row.code || row.title || row.id || '未命名資料')
const addIssue = (issues: HealthIssue[], issue: Omit<HealthIssue, 'count'>, rows: Record<string, unknown>[]) => {
  if (rows.length) issues.push({
    ...issue,
    count: rows.length,
    samples: rows.slice(0, 5).map(label),
    affectedIds: rows.map(row => String(row.id || '')).filter(Boolean),
  })
}

function tradeOrder(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const date = String(a.date || '').localeCompare(String(b.date || ''))
  if (date) return date
  const created = String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
  if (created) return created
  return String(a.id || '').localeCompare(String(b.id || ''))
}

export function analyzeDataHealth(input: HealthInput): HealthReport {
  const issues: HealthIssue[] = []
  const badTrades = input.trades.filter(t => !validDate(t.date) || !['buy', 'sell', '買入', '賣出'].includes(String(t.type)) || !String(t.code || '').trim() || !positive(t.price) || !positive(t.shares) || !nonNegative(t.fee) || !nonNegative(t.tax))
  addIssue(issues, { id: 'trade-fields', severity: 'critical', title: '買賣紀錄欄位不完整', detail: '日期、類型、代號、價格、股數、手續費或交易稅有缺漏／格式錯誤。' }, badTrades)

  const holdings = new Map<string, number>()
  const oversells: Record<string, unknown>[] = []
  const timeline = [
    ...input.trades.filter(t => !badTrades.includes(t)).map(row => ({ kind: 'trade' as const, date: String(row.date), row })),
    ...input.dividends.filter(row => validDate(row.date) && String(row.code || '').trim() && positive(row.stockDividend)).map(row => ({ kind: 'stockdiv' as const, date: String(row.date), row })),
  ].sort((a, b) => {
    const date = a.date.localeCompare(b.date)
    if (date) return date
    if (a.kind !== b.kind) return a.kind === 'trade' ? -1 : 1
    return a.kind === 'trade' && b.kind === 'trade' ? tradeOrder(a.row, b.row) : String(a.row.id || '').localeCompare(String(b.row.id || ''))
  })
  timeline.forEach(event => {
    const code = String(event.row.code).trim().toUpperCase()
    const current = holdings.get(code) ?? 0
    if (event.kind === 'stockdiv') {
      if (current > 0) holdings.set(code, current + Number(event.row.stockDividend))
      return
    }
    const shares = Number(event.row.shares)
    const isSell = ['sell', '賣出'].includes(String(event.row.type))
    if (isSell && shares > current + 1e-8) oversells.push(event.row)
    else holdings.set(code, isSell ? current - shares : current + shares)
  })
  addIssue(issues, { id: 'oversell', severity: 'critical', title: '歷史交易出現超賣', detail: '依日期順序計算時，賣出股數超過當時持股；系統不會把這些資料納入持倉。' }, oversells)

  const marginMissing = input.trades.filter(t => ['sell', '賣出'].includes(String(t.type)) && t.isMargin === true && !positive(t.marginRepay))
  addIssue(issues, { id: 'margin-repay', severity: 'warning', title: '融資賣出缺少償還金額', detail: '可能造成現金與融資負債計算不準確。' }, marginMissing)

  const duplicateKeys = new Map<string, Record<string, unknown>[]>()
  input.trades.forEach(t => {
    const key = [t.date, t.type, t.code, t.price, t.shares].join('|')
    duplicateKeys.set(key, [...(duplicateKeys.get(key) ?? []), t])
  })
  const duplicates = [...duplicateKeys.values()].filter(group => group.length > 1).flat()
  addIssue(issues, { id: 'duplicate-trades', severity: 'warning', title: '疑似重複買賣紀錄', detail: '相同日期、類型、代號、價格與股數出現多次，請確認是否為真實分批成交。' }, duplicates)

  const badCashflow = input.cashflow.filter(row => !validDate(row.date) || !['in', 'out', '入金', '出金'].includes(String(row.type)) || !positive(row.amount))
  addIssue(issues, { id: 'cashflow-fields', severity: 'critical', title: '出入金資料格式錯誤', detail: '日期、類型或金額不符合規則。' }, badCashflow)

  const badDividends = input.dividends.filter(row => !validDate(row.date) || !String(row.code || '').trim() || !nonNegative(row.cashDividend ?? 0) || !nonNegative(row.stockDividend ?? 0))
  addIssue(issues, { id: 'dividend-fields', severity: 'warning', title: '除權息資料格式錯誤', detail: '日期、股票代號、現金股利或股票股利不符合規則。' }, badDividends)

  const badSnapshots = input.snapshots.filter(row => !validDate(row.date) || !nonNegative(row.totalAssets) || !nonNegative(row.marketValue) || typeof row.cash !== 'number' || !Number.isFinite(row.cash))
  addIssue(issues, { id: 'snapshot-fields', severity: 'warning', title: '資產快照格式錯誤', detail: '日期或資產數值缺漏，趨勢圖可能因此失真。' }, badSnapshots)

  const noteIds = new Set(input.notes.map(row => String(row.id || '')).filter(Boolean))
  const brokenLinks: Record<string, unknown>[] = []
  const asymmetricLinks: Record<string, unknown>[] = []
  const selfLinks: Record<string, unknown>[] = []
  const noteById = new Map(input.notes.map(row => [String(row.id || ''), row]))
  input.notes.forEach(note => {
    const sourceId = String(note.id || '')
    const links = Array.isArray(note.links) ? note.links.map(String) : []
    if (links.some(id => !noteIds.has(id))) brokenLinks.push(note)
    if (links.includes(sourceId)) selfLinks.push(note)
    if (links.some(id => {
      const target = noteById.get(id)
      return target && !(Array.isArray(target.links) && target.links.map(String).includes(sourceId))
    })) asymmetricLinks.push(note)
  })
  addIssue(issues, { id: 'broken-note-links', severity: 'warning', title: '知識筆記含失效連結', detail: '筆記連到不存在的目標，關聯圖可能顯示異常。' }, brokenLinks)
  addIssue(issues, { id: 'self-note-links', severity: 'warning', title: '知識筆記連結到自己', detail: '自我連結不具關聯意義，修復時會安全移除。' }, selfLinks)
  addIssue(issues, { id: 'asymmetric-note-links', severity: 'info', title: '知識筆記連結未雙向同步', detail: '來源有連結，但目標沒有回連；可檢查是否為舊資料。' }, asymmetricLinks)

  const trashIds = new Set(input.trash.map(row => String(row.id || '')))
  const collisions = input.notes.filter(row => trashIds.has(String(row.id || '')))
  addIssue(issues, { id: 'note-trash-collision', severity: 'critical', title: '筆記與垃圾桶 ID 重複', detail: '同一筆資料同時存在於使用中筆記與垃圾桶。' }, collisions)

  const now = input.now ?? new Date()
  const invalidTrashDates = input.trash.filter(row =>
    typeof row.deletedAt !== 'string' || Number.isNaN(Date.parse(row.deletedAt))
  )
  const expiredTrash = input.trash.filter(row => {
    const deletedAt = typeof row.deletedAt === 'string' ? Date.parse(row.deletedAt) : NaN
    return !Number.isNaN(deletedAt) && now.getTime() - deletedAt > 30 * 86400000
  })
  addIssue(issues, { id: 'invalid-trash-date', severity: 'warning', title: '垃圾桶缺少有效刪除日期', detail: '無法判斷清理期限；請先人工確認資料來源。' }, invalidTrashDates)
  addIssue(issues, { id: 'expired-trash', severity: 'info', title: '垃圾桶有逾期資料', detail: '超過 30 天，可由健康中心安全清理。' }, expiredTrash)

  return {
    checkedAt: now.toISOString(),
    recordsChecked: input.trades.length + input.dividends.length + input.cashflow.length + input.snapshots.length + input.notes.length + input.trash.length,
    issues,
    counts: {
      critical: issues.filter(i => i.severity === 'critical').length,
      warning: issues.filter(i => i.severity === 'warning').length,
      info: issues.filter(i => i.severity === 'info').length,
    },
  }
}
