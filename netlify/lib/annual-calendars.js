export const FED_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'
export const twseUrl = year => `https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json&date=${year}0101`
const text = html => html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, ' ').trim()
export function validDate(date, year) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number(date.slice(0, 4)) !== year) return false
    const parsed = new Date(date + 'T00:00:00Z')
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
}
export function validateAnnualEntry(kind, year, row) {
    if (!Number.isInteger(year) || year < 2020 || year > 2100 || !row || !Array.isArray(row.dates)) throw new Error('Invalid calendar')
    const dates = row.dates
    if (dates.some(date => !validDate(date, year)) || new Set(dates).size !== dates.length || dates.some((date, i) => i > 0 && date <= dates[i - 1])) throw new Error('Invalid calendar dates')
    if (kind === 'fomc' ? dates.length !== 8 : dates.length < 5 || dates.length > 50) throw new Error('Incomplete calendar')
    if (row.source !== (kind === 'fomc' ? FED_URL : twseUrl(year))) throw new Error('Invalid calendar source')
    if (typeof row.checkedAt !== 'string' || !Number.isFinite(Date.parse(row.checkedAt))) throw new Error('Invalid calendar timestamp')
    // Return only public schedule fields; discard unexpected fields before caching or serving.
    return { dates: [...dates], source: row.source, checkedAt: row.checkedAt, ...(kind === 'fomc' ? { tentative: true } : {}) }
}
/** Last verified source check saved by the job, excluding bundled seed data. */
export function getAnnualCalendarLastSuccessAt(data) {
    let latest = null
    for (const kind of ['fomc', 'settlement']) {
        const rows = data?.[kind]
        if (!rows || typeof rows !== 'object' || Array.isArray(rows) || Object.keys(rows).length > 81) continue
        for (const [year, value] of Object.entries(rows)) {
            if (!/^20\d{2}$/.test(year)) continue
            try {
                const timestamp = Date.parse(validateAnnualEntry(kind, Number(year), value).checkedAt)
                if (latest === null || timestamp > latest) latest = timestamp
            } catch { /* A malformed row is not evidence of a successful update. */ }
        }
    }
    return latest === null ? null : new Date(latest).toISOString()
}
export function parseFomc(html, years, now = new Date()) {
    const headings = [...html.matchAll(/<h4[^>]*>\s*(?:<a[^>]*>)?(\d{4}) FOMC Meetings(?:<\/a>)?\s*<\/h4>/gi)]
    const months = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12, Jan: 1, Feb: 2, Mar: 3, Apr: 4, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 }
    const output = {}
    for (const [i, heading] of headings.entries()) {
        const year = Number(heading[1])
        if (!years.includes(year)) continue
        const section = html.slice(heading.index + heading[0].length, headings[i + 1]?.index ?? html.length)
        const matches = [...section.matchAll(/<div[^>]*class="[^"]*fomc-meeting__month[^"\n]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="[^"]*fomc-meeting__date[^"]*"[^>]*>([\s\S]*?)<\/div>/g)]
        const dates = matches.filter(match => !/^\d{1,2} \(notation vote\)$/.test(text(match[2]))).map(match => {
            const monthName = text(match[1]).split('/').at(-1), dayRange = text(match[2]).replace(/\*/g, '')
            if (!months[monthName] || !/^\d{1,2}-\d{1,2}$/.test(dayRange)) throw new Error('Unrecognized FOMC date')
            return `${year}-${String(months[monthName]).padStart(2, '0')}-${String(Number(dayRange.split('-')[1])).padStart(2, '0')}`
        })
        // Additional unscheduled/notation votes are deliberately excluded, never silently parsed.
        const row = { dates, source: FED_URL, checkedAt: now.toISOString(), tentative: true }
        try { output[year] = validateAnnualEntry('fomc', year, row) } catch { /* Keep the last complete year. */ }
    }
    return output
}
export function parseTwse(data, year, now = new Date()) {
    if (data?.stat !== 'ok' || data.queryYear !== year || !String(data.title).startsWith(`${year - 1911} 年`) || !Array.isArray(data.data) || data.data.length < 10 || data.total !== data.data.length) throw new Error('TWSE year not published or incomplete')
    const dates = []
    for (const row of data.data) {
        if (!Array.isArray(row) || row.length !== 3 || !validDate(row[0], year) || typeof row[1] !== 'string' || typeof row[2] !== 'string') throw new Error('Invalid TWSE row')
        const [date, name, description] = row
        // Trading holidays differ from settlement holidays. Do not count settlement-only days.
        if (/僅辦理結算交割作業/.test(name)) continue
        if (/開始交易|最後交易/.test(name)) continue
        // Fail closed for changed official wording instead of treating an unknown row as a holiday.
        if (!/放假|補假/.test(description)) throw new Error('Unrecognized TWSE holiday wording')
        if (![0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay())) dates.push(date)
    }
    dates.sort()
    return validateAnnualEntry('settlement', year, { dates, source: twseUrl(year), checkedAt: now.toISOString() })
}
export async function collectAnnualCalendars(fetcher = fetch, now = new Date()) {
    const year = Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Taipei' }).format(now))
    const years = [year - 1, year, year + 1]
    const load = async (url, type) => {
        const response = await fetcher(url, { signal: AbortSignal.timeout(8000), headers: { Accept: type === 'json' ? 'application/json' : 'text/html' } })
        if (!response.ok) throw new Error('Official source unavailable')
        return type === 'json' ? response.json() : response.text()
    }
    const results = await Promise.allSettled([load(FED_URL, 'html'), ...years.map(y => load(twseUrl(y), 'json'))])
    const output = { fomc: {}, settlement: {} }, failures = []
    try {
        if (results[0].status !== 'fulfilled') throw new Error('Unavailable')
        output.fomc = parseFomc(results[0].value, years, now)
        if (!output.fomc[year]) failures.push('fomc-current')
    } catch { failures.push('fomc') }
    years.forEach((y, i) => {
        try {
            const result = results[i + 1]
            if (result.status !== 'fulfilled') throw new Error('Unavailable')
            output.settlement[y] = parseTwse(result.value, y, now)
        } catch { failures.push(`settlement-${y}`) }
    })
    return { output, failures }
}

export async function updateAnnualCalendars(db, fetcher = fetch, now = new Date()) {
    const { output, failures } = await collectAnnualCalendars(fetcher, now)
    if (Object.keys(output.fomc).length + Object.keys(output.settlement).length) {
        const ref = db.doc('sharedData/annualCalendars')
        await db.runTransaction(async tx => {
            const current = (await tx.get(ref)).data() || { fomc: {}, settlement: {} }
            for (const kind of ['fomc', 'settlement']) {
                current[kind] = { ...current[kind] }
                for (const [year, row] of Object.entries(output[kind])) {
                    // An older overlapping run cannot replace a newer verified response.
                    if (!current[kind][year]?.checkedAt || current[kind][year].checkedAt <= row.checkedAt) current[kind][year] = row
                }
            }
            tx.set(ref, { fomc: current.fomc, settlement: current.settlement })
        })
    }
    return { failures, fomcYears: Object.keys(output.fomc), settlementYears: Object.keys(output.settlement) }
}
