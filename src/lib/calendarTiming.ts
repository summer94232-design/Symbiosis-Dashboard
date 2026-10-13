export interface EventTime { date?: string; dateTime?: string; timeZone?: string }
export interface EventTiming {
    start?: EventTime | null
    end?: EventTime | null
    recurringEventId?: string | null
    originalStartTime?: EventTime | null
}
export interface TimingDraft { allDay: boolean; startTime: string; endTime: string; endDate: string }
export const emptyTimingDraft = (): TimingDraft => ({ allDay: true, startTime: '09:00', endTime: '10:00', endDate: '' })
export function timingDraft(event: EventTiming & { date: string }): TimingDraft {
    const time = (value?: string) => value ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)) : ''
    return { allDay: !event.start?.dateTime, startTime: time(event.start?.dateTime) || '09:00', endTime: time(event.end?.dateTime) || '10:00', endDate: calendarDate(event.end, !event.start?.dateTime) || event.date }
}
export function timingForWrite(date: string, draft: TimingDraft, original?: EventTiming & { date: string }) {
    if (original?.start && original.end && original.date === date && JSON.stringify(timingDraft(original)) === JSON.stringify(draft)) return { start: original.start, end: original.end }
    const endDate = draft.endDate || date
    const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
    if (!validDate(date) || !validDate(endDate)) throw new Error('請填寫有效的開始及結束日期。')
    if (draft.allDay) {
        if (endDate < date) throw new Error('結束日期不能早於開始日期。')
        return { start: { date }, end: { date: new Date(Date.parse(endDate) + 86400000).toISOString().slice(0, 10) } }
    }
    if (![draft.startTime, draft.endTime].every(value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value))) throw new Error('請填寫有效的開始及結束時間。')
    const start = `${date}T${draft.startTime}:00+08:00`, end = `${endDate}T${draft.endTime}:00+08:00`
    if (Date.parse(end) <= Date.parse(start)) throw new Error('結束時間必須晚於開始時間。')
    return { start: { dateTime: start, timeZone: 'Asia/Taipei' }, end: { dateTime: end, timeZone: 'Asia/Taipei' } }
}
export function calendarDate(time: EventTime | null | undefined, exclusiveEnd = false): string {
    if (time?.date) {
        if (!exclusiveEnd) return time.date
        return new Date(Date.parse(time.date) - 86400000).toISOString().slice(0, 10)
    }
    if (!time?.dateTime) return ''
    const date = new Date(Date.parse(time.dateTime) - (exclusiveEnd ? 1 : 0))
    if (!Number.isFinite(date.getTime())) return ''
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
    const part = (type: string) => parts.find(p => p.type === type)?.value
    return `${part('year')}-${part('month')}-${part('day')}`
}
export function eventOccursOn(event: EventTiming & { date: string }, date: string): boolean {
    return eventOverlapsRange(event, date, date)
}
export function eventOverlapsRange(event: EventTiming & { date: string }, from: string, through: string): boolean {
    const start = calendarDate(event.start) || event.date
    const end = calendarDate(event.end, true) || start
    return from <= through && start <= through && end >= from
}
export function eventScheduleLabel(event: EventTiming & { date: string }): string {
    const recurring = event.recurringEventId ? ' · 重複行程（本次）' : ''
    if (event.start?.dateTime && event.end?.dateTime) {
        const format = (value: string) => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value))
        return `${format(event.start.dateTime)} ～ ${format(event.end.dateTime)}（台北時間）${recurring}`
    }
    const end = calendarDate(event.end, true)
    return `${event.date}${end && end !== event.date ? ` ～ ${end}` : ''} 全天${recurring}`
}
