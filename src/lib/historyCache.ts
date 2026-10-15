export interface DailyCandle { date: string; open: number; high: number; low: number; close: number; volume?: number }
export interface HistoryResult { data: DailyCandle[] }
export interface HistoryEntry {
    key: string; accessedAt: number; data: DailyCandle[]
    coverage: { from: string; to: string; checkedAt: number }[]
}
export interface HistoryStore { get(key: string): Promise<HistoryEntry | undefined>; set(entry: HistoryEntry): Promise<void> }
const DAY = 86400000
const taipeiDay = (time: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(time))
const offset = (day: string, days: number) => new Date(Date.parse(day + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10)
export function validHistoryDate(value: string): boolean {
    return /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
        && new Date(value).toISOString().slice(0, 10) === value
}
export function validateDailyHistory(value: HistoryResult, from: string, to: string): DailyCandle[] {
    if (!Array.isArray(value?.data) || value.data.some(row => !row || !validHistoryDate(row.date)
        || row.date < from || row.date > to || ![row.open, row.high, row.low, row.close].every(n => Number.isFinite(n) && n > 0)
        || row.high < Math.max(row.open, row.close, row.low) || row.low > Math.min(row.open, row.close, row.high)
        || row.volume !== undefined && (!Number.isFinite(row.volume) || row.volume < 0))) throw new Error('歷史行情資料格式異常')
    return [...new Map(value.data.map(row => [row.date, row])).values()].sort((a, b) => a.date.localeCompare(b.date))
}
/** Every segment is at most 365 inclusive days, strictly shorter than a year. */
export function splitHistoryRange(from: string, to: string): { from: string; to: string }[] {
    if (!validHistoryDate(from) || !validHistoryDate(to) || from > to) throw new Error('歷史行情日期不正確')
    const result = []
    for (let start = from; start <= to;) {
        const end = offset(start, 364) < to ? offset(start, 364) : to
        result.push({ from: start, to: end }); start = offset(end, 1)
    }
    return result
}
export function missingHistoryRanges(from: string, to: string, entry: HistoryEntry | undefined, now: number) {
    let missing = [{ from, to }]
    const today = taipeiDay(now)
    for (const row of entry?.coverage ?? []) {
        // Recent data can still be completed/revised. Old history is rechecked
        // weekly; requests touching today are rechecked every five minutes.
        const ttl = row.to >= today ? 300000 : row.to >= offset(today, -30) ? DAY : 7 * DAY
        if (!Number.isFinite(row.checkedAt) || row.checkedAt > now || now - row.checkedAt >= ttl) continue
        missing = missing.flatMap(part => row.to < part.from || row.from > part.to ? [part] : [
            ...(row.from > part.from ? [{ from: part.from, to: offset(row.from, -1) }] : []),
            ...(row.to < part.to ? [{ from: offset(row.to, 1), to: part.to }] : []),
        ])
    }
    return missing.flatMap(part => splitHistoryRange(part.from, part.to))
}

export function createHistoryReader(options: {
    store: HistoryStore; primary?: (symbol: string, from: string, to: string) => Promise<HistoryResult>
    fallback: (symbol: string, from: string, to: string) => Promise<HistoryResult>; now?: () => number
}) {
    const now = options.now ?? Date.now
    const queues = new Map<string, Promise<unknown>>()
    let active = 0
    const waiters: (() => void)[] = []
    const readSegment = async (symbol: string, from: string, to: string, assertActive: () => void) => {
        if (active >= 3) await new Promise<void>(resolve => waiters.push(resolve))
        else active++
        try {
            assertActive()
            try {
                if (!options.primary) throw new Error('No primary')
                return { data: validateDailyHistory(await options.primary(symbol, from, to), from, to) }
            } catch {
                assertActive()
                return { data: validateDailyHistory(await options.fallback(symbol, from, to), from, to) }
            }
        } finally {
            const next = waiters.shift()
            if (next) next()
            else active--
        }
    }
    return (symbol: string, from: string, to: string, assertActive = () => {}): Promise<HistoryResult> => {
        splitHistoryRange(from, to)
        if (!/^[A-Z0-9]{4,12}$/.test(symbol)) return Promise.reject(new Error('歷史行情代號不正確'))
        // Public, unadjusted daily bars only; never persist an account or token.
        const key = `daily:unadjusted:v1:${symbol}`
        const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
            assertActive()
            let entry = await options.store.get(key)
            if (entry && (entry.key !== key || !Array.isArray(entry.coverage)
                || entry.coverage.some(c => !validHistoryDate(c.from) || !validHistoryDate(c.to) || c.from > c.to))) entry = undefined
            if (entry) try { validateDailyHistory(entry, '2000-01-01', '2099-12-31') } catch { entry = undefined }
            entry ??= { key, accessedAt: now(), data: [], coverage: [] }
            for (const part of missingHistoryRanges(from, to, entry, now())) {
                assertActive()
                const result = await readSegment(symbol, part.from, part.to, assertActive)
                assertActive()
                // Replace the queried interval, including legitimate empty ranges.
                entry.data = [...entry.data.filter(row => row.date < part.from || row.date > part.to), ...result.data]
                    .sort((a, b) => a.date.localeCompare(b.date))
                entry.coverage = entry.coverage.filter(c => c.from < part.from || c.to > part.to)
                entry.coverage.push({ ...part, checkedAt: now() })
                entry.accessedAt = now()
                await options.store.set(entry)
            }
            assertActive()
            return { data: entry.data.filter(row => row.date >= from && row.date <= to) }
        })
        queues.set(key, run)
        void run.finally(() => { if (queues.get(key) === run) queues.delete(key) }).catch(() => {})
        return run
    }
}
