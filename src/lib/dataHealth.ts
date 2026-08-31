import { analyzeDayTrades, type TradeRecord } from './calc'

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
  investmentSummary?: {
    holdingCodes: string[]
    missingPriceCodes: string[]
    marketValue: number
    cash: number
    marginDebt: number
    totalAssets: number
    priceUpdatedAt: string
  }
  stockGroups?: Record<string, unknown>
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

function parsePriceUpdatedAt(value: string): number {
  const match = value.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s*(上午|下午)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (match) {
    let hour = Number(match[5] ?? 0)
    if (match[4] === '下午' && hour < 12) hour += 12
    if (match[4] === '上午' && hour === 12) hour = 0
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour, Number(match[6] ?? 0), Number(match[7] ?? 0)).getTime()
  }
  return Date.parse(value)
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
  const blankTradeNames = input.trades.filter(t => String(t.code || '').trim() && !String(t.name || '').trim())
  addIssue(issues, { id: 'trade-name-blank', severity: 'warning', title: '買賣紀錄缺少股票名稱', detail: '可從相同股票代號的既有資料推測名稱，套用前會先顯示差異。' }, blankTradeNames)

  const holdings = new Map<string, number>()
  const normalizedTrades = input.trades.map(t => ({ ...t, type: ['sell', '賣出'].includes(String(t.type)) ? 'sell' : 'buy' }) as TradeRecord)
  const dayTrades = analyzeDayTrades(normalizedTrades)
  const matchedBySource = new Map(input.trades.map((t, i) => [t, dayTrades.matchedShares.get(normalizedTrades[i]) || 0]))
  addIssue(issues, { id: 'daytrade-invalid', severity: 'critical', title: '當沖配對失效', detail: '已確認的買賣連結、股數或帳戶不再相符；請到買賣紀錄重新核對。失效配對不套用當沖計算。' }, dayTrades.issues.map(issue => ({ ...issue.trade, title: issue.message })))
  addIssue(issues, { id: 'daytrade-candidates', severity: 'warning', title: '同日買賣的成交類別不明', detail: '混合股數不能直接推定為整張成交；不明類別的部分未自動沖抵，請核對券商資料。' }, dayTrades.uncertain.map(trade => ({ ...trade })))
  addIssue(issues, { id: 'daytrade-pending', severity: 'warning', title: '先賣後買尚未完成沖抵', detail: '請補登買入，系統會自動沖抵；未配對且超出庫存的部分使報表不完整。' }, input.trades.filter(t => t.dayTradePending && (matchedBySource.get(t) || 0) < Number(t.shares)))
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
    const shares = Number(event.row.shares) - (matchedBySource.get(event.row) || 0)
    const isSell = ['sell', '賣出'].includes(String(event.row.type))
    if (isSell && shares > current + 1e-8) oversells.push(event.row)
    else holdings.set(code, isSell ? current - shares : current + shares)
  })
  addIssue(issues, { id: 'oversell', severity: 'critical', title: '歷史交易出現超賣', detail: '依日期順序計算時，賣出股數超過當時持股；系統不會把這些資料納入持倉。' }, oversells)

  const marginMissing = input.trades.filter(t => ['sell', '賣出'].includes(String(t.type)) && t.isMargin === true && !positive(t.marginRepay))
  addIssue(issues, { id: 'margin-repay', severity: 'warning', title: '融資賣出缺少償還金額', detail: '可能造成現金與融資負債計算不準確。' }, marginMissing)

  const duplicateKeys = new Map<string, Record<string, unknown>[]>()
  input.trades.forEach(t => {
    const key = [t.date, t.type, t.code, t.price, t.shares, String(t.brokerAccount || '').trim()].join('|')
    duplicateKeys.set(key, [...(duplicateKeys.get(key) ?? []), t])
  })
  const duplicates = [...duplicateKeys.values()].filter(group => group.length > 1).flat()
  addIssue(issues, { id: 'duplicate-trades', severity: 'warning', title: '疑似重複買賣紀錄', detail: '相同日期、類型、代號、價格與股數出現多次，請確認是否為真實分批成交。' }, duplicates)

  const badCashflow = input.cashflow.filter(row => !validDate(row.date) || !['in', 'out', '入金', '出金'].includes(String(row.type)) || !positive(row.amount))
  addIssue(issues, { id: 'cashflow-fields', severity: 'critical', title: '出入金資料格式錯誤', detail: '日期、類型或金額不符合規則。' }, badCashflow)

  const badDividends = input.dividends.filter(row => !validDate(row.date) || !String(row.code || '').trim() || !nonNegative(row.cashDividend ?? 0) || !nonNegative(row.stockDividend ?? 0))
  addIssue(issues, { id: 'dividend-fields', severity: 'warning', title: '除權息資料格式錯誤', detail: '日期、股票代號、現金股利或股票股利不符合規則。' }, badDividends)
  const blankDividendNames = input.dividends.filter(row => String(row.code || '').trim() && !String(row.name || '').trim())
  addIssue(issues, { id: 'dividend-name-blank', severity: 'info', title: '除權息紀錄缺少股票名稱', detail: '可從相同股票代號的既有資料推測名稱，套用前會先顯示差異。' }, blankDividendNames)

  const badSnapshots = input.snapshots.filter(row => !validDate(row.date) || !nonNegative(row.totalAssets) || !nonNegative(row.marketValue) || typeof row.cash !== 'number' || !Number.isFinite(row.cash))
  addIssue(issues, { id: 'snapshot-fields', severity: 'warning', title: '資產快照格式錯誤', detail: '日期或資產數值缺漏，趨勢圖可能因此失真。' }, badSnapshots)

  // ── 投資跨模組一致性 ────────────────────────────────────────────────
  const namesByCode = new Map<string, Set<string>>()
  ;[...input.trades, ...input.dividends].forEach(row => {
    const code = String(row.code || '').trim().toUpperCase()
    const name = String(row.name || '').trim()
    if (!code || !name) return
    if (!namesByCode.has(code)) namesByCode.set(code, new Set())
    namesByCode.get(code)!.add(name)
  })
  const nameConflicts = [...namesByCode.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([code, names]) => ({ id: code, code, title: `${code}：${[...names].join('／')}` }))
  addIssue(issues, { id: 'stock-name-conflict', severity: 'warning', title: '相同股票代號出現不同名稱', detail: '買賣或股利資料的股票名稱不一致，可能造成報表分組與搜尋混亂。' }, nameConflicts)

  if (input.investmentSummary) {
    const summary = input.investmentSummary
    const missingPrices = summary.missingPriceCodes.map(code => ({ id: code, code, title: code }))
    addIssue(issues, { id: 'holding-price-missing', severity: 'warning', title: '目前持倉缺少有效現價', detail: '缺價持倉暫以成本估算市值，會影響儀表板、資產快照與組合試算。' }, missingPrices)

    const missingGroups = summary.holdingCodes
      .filter(code => !String(input.stockGroups?.[code] ?? '').trim())
      .map(code => ({ id: code, code, title: code }))
    addIssue(issues, { id: 'holding-group-missing', severity: 'info', title: '目前持倉尚未設定族群', detail: '未分類股票會降低產業配置與集中度分析的可讀性。' }, missingGroups)

    const priceTimestamp = parsePriceUpdatedAt(summary.priceUpdatedAt)
    const priceAge = Number.isNaN(priceTimestamp) ? null : (input.now ?? new Date()).getTime() - priceTimestamp
    if (summary.holdingCodes.length > 0 && (priceAge === null || priceAge > 7 * 86400000)) {
      addIssue(issues, { id: 'holding-price-stale', severity: 'info', title: '持倉現價可能已過期', detail: '最後更新時間無效或已超過 7 天，建議先更新現價再檢查資產與配置。' }, [{ id: 'lastPrices', title: summary.priceUpdatedAt || '沒有更新時間' }])
    }

    const todayDate = input.now ?? new Date()
    const today = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`
    const todaySnapshot = input.snapshots.find(row => String(row.date) === today)
    if (todaySnapshot) {
      const comparisons = [
        ['總淨值', Number(todaySnapshot.totalAssets), summary.totalAssets],
        ['股票市值', Number(todaySnapshot.marketValue), summary.marketValue],
        ['現金', Number(todaySnapshot.cash), summary.cash],
        ['融資負債', Number(todaySnapshot.marginDebt ?? 0), summary.marginDebt],
      ] as const
      const mismatches = comparisons.filter(([, saved, current]) => Number.isFinite(saved) && Math.abs(saved - current) > Math.max(10, Math.abs(current) * 0.001))
      addIssue(issues, { id: 'today-snapshot-mismatch', severity: 'warning', title: '今日資產快照與目前資料不一致', detail: '今日快照和統一投資快照有差異，可能是交易、現價或出入金更新後尚未重建快照。' }, mismatches.map(([field, saved, current]) => ({ id: field, title: `${field}：快照 ${Math.round(saved)}／目前 ${Math.round(current)}` })))
    }
  }

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
