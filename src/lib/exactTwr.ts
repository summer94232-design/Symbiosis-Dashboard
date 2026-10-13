export interface TwrFlow { id: string; date: string; type: 'in' | 'out'; amount: number }
export interface FlowValuation { time: string; before: string; source: string; order?: string }
export interface ExactTwrReport {
    startDate: string; endDate: string; startValue: string; endValue: string
    startSource: string; endSource: string
    valuations: Record<string, FlowValuation>
    ledgerSignature: string
}
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date
const money = (text: string) => typeof text !== 'string' || text.trim() === '' ? NaN : Number(text)
const hasSource = (text: unknown) => typeof text === 'string' && text.trim().length > 0
export function isExactTwrReport(value: unknown): value is ExactTwrReport {
    if (!value || typeof value !== 'object') return false
    const row = value as Record<string, unknown>
    return ['startDate', 'endDate', 'startValue', 'endValue', 'startSource', 'endSource', 'ledgerSignature'].every(key => typeof row[key] === 'string')
        && !!row.valuations && typeof row.valuations === 'object' && !Array.isArray(row.valuations)
        && Object.values(row.valuations).every(item => item && typeof item === 'object' && ['time', 'before', 'source'].every(key => typeof item[key] === 'string') && (item.order === undefined || typeof item.order === 'string'))
}
export function ledgerSignature(value: unknown): string {
    return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
}
/** End-of-day endpoints, each external flow valued immediately before it.
 * After-flow NAV = before-flow NAV + signed flow (no market movement in between).
 * Daily snapshots are never substituted for cash-flow valuations.
 */
export function calculateExactTwr(report: ExactTwrReport, allFlows: TwrFlow[]) {
    const issues: string[] = []
    const segments: { label: string; opening: number; closing: number; flow: number; after: number; returnPercent: number }[] = []
    const fail = (message: string) => { issues.push(message); return { percent: null, issues, segments } }
    if (!isExactTwrReport(report)) return fail('估值紀錄格式無效，請重新建立估值。')
    if (!validDate(report.startDate) || !validDate(report.endDate) || report.startDate >= report.endDate) return fail('請選擇有效區間；起日必須早於迄日。')
    if (allFlows.some(f => !validDate(f.date) || !Number.isFinite(f.amount) || f.amount <= 0 || !['in', 'out'].includes(f.type) || !f.id)) return fail('出入金資料無效，請先修正原紀錄。')
    if (new Set(allFlows.map(f => f.id)).size !== allFlows.length) return fail('出入金 ID 重複，無法辨識估值。')
    let opening = money(report.startValue), product = 1
    const end = money(report.endValue)
    if (!Number.isFinite(opening) || opening <= 0 || !Number.isFinite(end) || end < 0) return fail('期初淨值必須大於零，期末淨值必須為非負有限數字。')
    if (!hasSource(report.startSource) || !hasSource(report.endSource)) return fail('請記錄期初與期末日終估值的依據。')
    const flows = allFlows.filter(f => f.date > report.startDate && f.date <= report.endDate)
    const times = new Set<string>()
    for (const flow of flows) {
        const valuation = Object.hasOwn(report.valuations, flow.id) ? report.valuations[flow.id] : undefined
        const timestamp = `${flow.date}T${valuation?.time}/${Number(valuation?.order || '1')}`
        if (!valuation || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(valuation.time) || !hasSource(valuation.source) || !Number.isFinite(money(valuation.before))) issues.push(`${flow.date} ${flow.type === 'in' ? '入金' : '出金'} ${flow.amount}：缺少有效時間、流量前淨值或估值依據。`)
        if (valuation?.order && (!/^\d+$/.test(valuation.order) || Number(valuation.order) < 1 || !Number.isSafeInteger(Number(valuation.order)))) issues.push(`${flow.date} 同秒順序必須為正整數。`)
        if (times.has(timestamp)) issues.push(`${flow.date} 有相同時間與順序的出入金，請填入實際同秒先後順序。`)
        times.add(timestamp)
    }
    if (issues.length) return { percent: null, issues, segments }
    flows.sort((a, b) => `${a.date}T${report.valuations[a.id].time}`.localeCompare(`${b.date}T${report.valuations[b.id].time}`) || Number(report.valuations[a.id].order || 1) - Number(report.valuations[b.id].order || 1))
    for (const flow of flows) {
        const before = money(report.valuations[flow.id].before)
        const amount = flow.type === 'in' ? flow.amount : -flow.amount
        const after = before + amount
        if (opening <= 0 || before <= 0 || after <= 0) return fail(`${flow.date} 流量前後淨值非正，無法跨越清空帳戶或重新入金；請另選正淨值區間。`)
        const factor = before / opening
        product *= factor
        segments.push({ label: `${flow.date} ${report.valuations[flow.id].time} #${report.valuations[flow.id].order || 1}`, opening, closing: before, flow: amount, after, returnPercent: (factor - 1) * 100 })
        opening = after
    }
    product *= end / opening
    if (!Number.isFinite(product)) return fail('報酬超出可計算範圍。')
    segments.push({ label: `${report.endDate} 日終`, opening, closing: end, flow: 0, after: end, returnPercent: (end / opening - 1) * 100 })
    return { percent: (product - 1) * 100, issues, segments }
}
