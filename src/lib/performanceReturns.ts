/** Trend returns use recorded daily valuations; flows are in (start, end]. */
export interface DatedAmount { date: string; amount: number }
export interface AssetValuation {
    date: string; totalAssets: number
    valuationQuality?: 'closing' | 'intraday' | 'manual-unverified'
    valuationAt?: string
}
export function snapshotValuationIssue(row: AssetValuation | undefined, date: string): string | null {
    if (!row) return `缺少 ${date} 的資產快照`
    if (!Number.isFinite(dayTime(date)) || row.date !== date) return '快照日期無效'
    if (!Number.isFinite(row.totalAssets)) return `${date} 的快照淨值無效`
    return null
}

/** Use recorded dated NAV endpoints, including existing and intraday snapshots. */
export function calculateSnapshotAccountReturn(input: {
    snapshots: AssetValuation[]; startDate: string; endDate: string; cashflows: DatedAmount[]
}): AccountReturnResult {
    const start = input.snapshots.find(s => s.date === input.startDate)
    const end = input.snapshots.find(s => s.date === input.endDate)
    if (input.snapshots.filter(s => s.date === input.startDate).length > 1 || input.snapshots.filter(s => s.date === input.endDate).length > 1) {
        return { annualized: null, reason: '同一天有重複快照，請先核對紀錄', startValue: null, endValue: null }
    }
    const issue = snapshotValuationIssue(start, input.startDate) || snapshotValuationIssue(end, input.endDate)
    if (issue) return { annualized: null, reason: issue, startValue: start?.totalAssets ?? null, endValue: end?.totalAssets ?? null }
    return calculateAccountReturn({ ...input, startValue: start!.totalAssets, endValue: end!.totalAssets })
}

/** Drawdown of a flow-adjusted NAV index; never of zero-based accumulated profit. */
export function calculateReturnDrawdown(points: ReturnPoint[]): number | null {
    if (points.length < 2 || points.some(p => p.issue || p.assetReturn === null)) return null
    let peak = 1, drawdown = 0
    for (const point of points) {
        const value = 1 + point.assetReturn! / 100
        if (!Number.isFinite(value) || value < 0) return null
        peak = Math.max(peak, value)
        drawdown = Math.max(drawdown, (peak - value) / peak)
    }
    return drawdown
}
export interface CashflowBasisSnapshot extends AssetValuation {
    cash: number
    cashflowBasis?: string
    cashflowNetAtCapture?: number
}

/** Reconcile only snapshots with a known cash-flow basis. Never guess for legacy/manual values.
 * Return a copy with its basis advanced too, so a second reconciliation cannot double count.
 */
export function alignSnapshotCashflows<T extends CashflowBasisSnapshot>(snapshots: T[], flows: DatedAmount[]): T[] {
    if (flows.some(flow => !Number.isFinite(dayTime(flow.date)) || !Number.isFinite(flow.amount))) throw new Error('出入金資料無效，無法對齊快照')
    return snapshots.map(snapshot => {
        if (snapshot.cashflowBasis !== 'after-close-v1') return { ...snapshot }
        if (!Number.isFinite(snapshot.cashflowNetAtCapture) || !Number.isFinite(snapshot.cash) || !Number.isFinite(snapshot.totalAssets)) throw new Error('快照出入金基準無效，請重新儲存快照')
        const net = flows.filter(flow => flow.date <= snapshot.date).reduce((sum, flow) => sum + flow.amount, 0)
        const delta = net - snapshot.cashflowNetAtCapture!
        return { ...snapshot, cash: snapshot.cash + delta, totalAssets: snapshot.totalAssets + delta, cashflowNetAtCapture: net }
    })
}
const dayTime = (date: string): number => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN
    const time = Date.parse(date + 'T00:00:00Z')
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date ? time : NaN
}

export interface AccountReturnResult {
    annualized: number | null
    reason: string
    startValue: number | null
    endValue: number | null
}

/** XIRR on a 365-day basis. Scan log(1+r) so losses near -100% remain resolvable.
 * Multiple detected roots or degenerate flows produce no rate instead of an arbitrary guess.
 */
export function accountXirr(flows: DatedAmount[]): number | null {
    const sums = new Map<string, number>()
    for (const flow of flows) {
        if (!Number.isFinite(dayTime(flow.date)) || !Number.isFinite(flow.amount)) return null
        sums.set(flow.date, (sums.get(flow.date) || 0) + flow.amount)
    }
    const rows = [...sums].filter(([, amount]) => amount !== 0).sort(([a], [b]) => a.localeCompare(b))
    if (rows.length < 2 || !rows.some(([, amount]) => amount > 0) || !rows.some(([, amount]) => amount < 0)) return null
    const start = dayTime(rows[0][0])
    const times = rows.map(([date]) => (dayTime(date) - start) / (86400000 * 365))
    const scale = Math.max(...rows.map(([, amount]) => Math.abs(amount)))
    const npv = (logRate: number) => {
        // Normalize exponential terms too, preventing overflow on long histories.
        const offsets = times.map(t => -logRate * t)
        const max = Math.max(...offsets)
        return rows.reduce((sum, [, amount], i) => sum + amount / scale * Math.exp(offsets[i] - max), 0)
    }
    const roots: number[] = []
    const addRoot = (root: number) => { if (!roots.some(r => Math.abs(r - root) < 1e-7)) roots.push(root) }
    let left = -25
    let fLeft = npv(left)
    for (let i = 1; i <= 1000; i++) {
        const right = -25 + i * 0.05
        const fRight = npv(right)
        if (fLeft === 0) addRoot(left)
        if (fRight === 0) addRoot(right)
        if (fLeft * fRight < 0) {
            let lo = left, hi = right, flo = fLeft
            for (let j = 0; j < 100; j++) {
                const mid = (lo + hi) / 2, fmid = npv(mid)
                if (fmid === 0 || hi - lo < 1e-12) { lo = mid; hi = mid; break }
                if (Math.sign(fmid) === Math.sign(flo)) { lo = mid; flo = fmid } else hi = mid
            }
            addRoot((lo + hi) / 2)
        }
        left = right; fLeft = fRight
    }
    return roots.length === 1 ? Math.expm1(roots[0]) : null
}

export function calculateAccountReturn(input: {
    startDate: string; endDate: string
    startValue?: number | null; endValue?: number | null
    /** Investor perspective: deposits negative, withdrawals positive. */
    cashflows: DatedAmount[]
}): AccountReturnResult {
    const { startDate, endDate, startValue, endValue } = input
    const result = (annualized: number | null, reason = '') => ({ annualized, reason,
        startValue: startValue ?? null, endValue: endValue ?? null })
    if (!Number.isFinite(dayTime(startDate)) || !Number.isFinite(dayTime(endDate)) || startDate >= endDate) return result(null, '起始日期必須早於結束日期')
    if (startValue == null || !Number.isFinite(startValue)) return result(null, `缺少 ${startDate} 的帳戶淨值，請補上當日快照或設定起始淨值`)
    if (endValue == null || !Number.isFinite(endValue)) return result(null, `缺少 ${endDate} 的帳戶淨值，請補上當日快照`)
    if (startValue < 0 || endValue < 0) return result(null, '區間端點為負淨值，不適用此年化報酬模型')
    if (input.cashflows.some(cf => !Number.isFinite(dayTime(cf.date)) || !Number.isFinite(cf.amount))) return result(null, '出入金資料無效')
    const period = input.cashflows.filter(cf => cf.date > startDate && cf.date <= endDate)
    if (period.some(cf => !Number.isFinite(cf.amount) || !Number.isFinite(dayTime(cf.date)))) return result(null, '區間出入金資料無效')
    const flows = [{ date: startDate, amount: -startValue }, ...period, { date: endDate, amount: endValue }]
    const rate = accountXirr(flows)
    // A total loss is a boundary outcome, not an ordinary finite XIRR solution.
    if (rate === null && endValue === 0 && flows.some(cf => cf.amount < 0) && !flows.some(cf => cf.amount > 0)) {
        return result(-100, '本金全損（−100%）；一般 XIRR 無有限解')
    }
    return rate === null ? result(null, '現金流無法求得可辨識的單一年化報酬率') : result(rate * 100)
}

export interface ReturnPoint {
    date: string
    assetReturn: number | null
    issue: string | null
}

/** Snapshot approximation: assume net external flow occurs at the end of each interval.
 * Without valuations at each flow, returns through non-positive bases cannot be reconstructed.
 */
export function buildTimeWeightedReturns(snapshots: AssetValuation[], cashflows: DatedAmount[], requireFlowDateSnapshots = false, validateSnapshots = false): ReturnPoint[] {
    const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date))
    let index = 1
    let issue: string | null = null
    if (validateSnapshots && (new Set(sorted.map(s => s.date)).size !== sorted.length
        || sorted.some(s => !Number.isFinite(dayTime(s.date)))
        || cashflows.some(f => !Number.isFinite(dayTime(f.date)) || !Number.isFinite(f.amount)))) issue = '快照日期重複或出入金資料無效，請先核對紀錄'
    return sorted.map((row, i) => {
        if (validateSnapshots) issue ||= snapshotValuationIssue(row, row.date)
        if (!Number.isFinite(row.totalAssets)) issue ||= '快照淨值無效'
        else if (row.totalAssets < 0) issue ||= '帳戶淨值為負，無法延續時間加權報酬'
        else if (i === 0 && row.totalAssets <= 0) issue ||= '起點淨值不是正數，請改選有正淨值的起始日'
        if (i > 0 && !issue) {
            const previous = sorted[i - 1]
            if (requireFlowDateSnapshots && cashflows.some(cf => cf.amount !== 0 && cf.date > previous.date && cf.date < row.date)) {
                issue = '出入金當日缺少快照，無法依期末入金假設計算；請補上該日含出入金的淨值'
                return { date: row.date, assetReturn: null, issue }
            }
            const flow = cashflows.filter(cf => cf.date > previous.date && cf.date <= row.date).reduce((sum, cf) => sum + cf.amount, 0)
            if (!Number.isFinite(flow)) issue = '區間出入金資料無效'
            else if (previous.totalAssets === 0) {
                if (row.totalAssets !== 0 || flow !== 0) issue = '零淨值後有資產或出入金變動，請另選新的正淨值起點'
            } else {
                const factor = (row.totalAssets - flow) / previous.totalAssets
                if (!Number.isFinite(factor) || factor < 0) issue = '區間資金流與淨值無法用期末流量假設計算報酬'
                else index *= factor // Zero is a total loss, never a flat-return substitute.
            }
            if (!Number.isFinite(index)) issue = '報酬超出可計算範圍'
        }
        return { date: row.date, assetReturn: issue ? null : Math.round((index - 1) * 10000) / 100, issue }
    })
}

export interface RestartedReturnSeries {
    points: ReturnPoint[]
    startDate: string | null
    skippedSnapshots: number
    unavailableReason: string | null
}

/** Earliest positive baseline with a computable suffix through the latest snapshot.
 * This is an explicit new period, not a repair of missing history. Never mutates data.
 */
export function buildRestartedTimeWeightedReturns(snapshots: AssetValuation[], cashflows: DatedAmount[], validateSnapshots = false): RestartedReturnSeries {
    const unavailable = (reason: string): RestartedReturnSeries => ({ points: [], startDate: null, skippedSnapshots: 0, unavailableReason: reason })
    if (snapshots.some(s => !Number.isFinite(dayTime(s.date))) || cashflows.some(f => !Number.isFinite(dayTime(f.date)) || !Number.isFinite(f.amount))) {
        return unavailable('日期或出入金金額無效，請先檢查紀錄')
    }
    const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date))
    if (new Set(sorted.map(s => s.date)).size !== sorted.length) return unavailable('同一天有重複快照，請先檢查紀錄')
    let start = 0
    while (start < sorted.length - 1) {
        if (!Number.isFinite(sorted[start].totalAssets) || sorted[start].totalAssets <= 0) { start++; continue }
        const points = buildTimeWeightedReturns(sorted.slice(start), cashflows, true, validateSnapshots)
        const broken = points.findIndex(p => p.issue !== null)
        if (broken < 0) return { points, startDate: points[0].date, skippedSnapshots: start, unavailableReason: null }
        // The first snapshot after a gap can be a new baseline: its day's flows
        // are already included in its NAV and must not be subtracted again.
        start += Math.max(1, broken)
    }
    return unavailable('尚無可連續計算至最新快照的區間，請再累積至少兩筆可計算的快照')
}
