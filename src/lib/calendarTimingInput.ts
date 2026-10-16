import type { TimingDraft } from './calendarTiming'

export function parseCalendarDate(text: string): string | null {
    const parts = text.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/) || text.trim().match(/^(\d{4})(\d{2})(\d{2})$/)
    if (!parts) return null
    const value = `${parts[1]}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')}`
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? value : null
}

export function parseCalendarTime(text: string): string | null {
    const value = text.trim()
    const parts = value.match(/^(\d{1,2}):(\d{1,2})$/) || value.match(/^(\d{1,2})(\d{2})$/)
    const hour = parts ? Number(parts[1]) : /^\d{1,2}$/.test(value) ? Number(value) : NaN
    const minute = parts ? Number(parts[2]) : 0
    return hour <= 23 && minute <= 59 ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` : null
}

const stamp = (date: string, time: string) => parseCalendarDate(date) && parseCalendarTime(time) ? Date.parse(`${date}T${time}:00Z`) : NaN
const endAt = (draft: TimingDraft, timestamp: number): TimingDraft => ({
    ...draft, endDate: new Date(timestamp).toISOString().slice(0, 10), endTime: new Date(timestamp).toISOString().slice(11, 16),
})

// Use UTC as an editor calendar clock; persisted times still use Asia/Taipei.
export function moveTimingStart(date: string, draft: TimingDraft, nextDate: string, nextTime = draft.startTime): TimingDraft {
    const next = { ...draft, startTime: nextTime }
    if (draft.allDay) {
        if (![date, nextDate, draft.endDate || date].every(parseCalendarDate)) return next
        return { ...next, endDate: new Date(Date.parse(draft.endDate || date) + Date.parse(nextDate) - Date.parse(date)).toISOString().slice(0, 10) }
    }
    const start = stamp(date, draft.startTime), end = stamp(draft.endDate || date, draft.endTime), newStart = stamp(nextDate, nextTime)
    return Number.isFinite(newStart) && end > start ? endAt(next, newStart + end - start) : next
}

export function timingWithDuration(date: string, draft: TimingDraft, minutes: number): TimingDraft {
    const start = stamp(date, draft.startTime)
    return Number.isFinite(start) ? endAt(draft, start + minutes * 60000) : draft
}
