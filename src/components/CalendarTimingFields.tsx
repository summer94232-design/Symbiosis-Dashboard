import type { TimingDraft } from '../lib/calendarTiming'

export default function CalendarTimingFields({ value, onChange, disabled = false }: {
    value: TimingDraft; onChange: (value: TimingDraft) => void; disabled?: boolean
}) {
    return <fieldset disabled={disabled} style={{ border: '1px solid var(--c-border)', borderRadius: 8, padding: 12, display: 'grid', gap: 10 }}>
        <legend>行程時間（台北時間）</legend>
        <label><input type="checkbox" checked={value.allDay} onChange={event => onChange({ ...value, allDay: event.target.checked })} />全天</label>
        {!value.allDay && <label>開始時間 <input type="time" value={value.startTime} onChange={event => onChange({ ...value, startTime: event.target.value })} /></label>}
        <label>結束日期（全天行程含當天） <input type="date" value={value.endDate} onChange={event => onChange({ ...value, endDate: event.target.value })} /></label>
        {!value.allDay && <label>結束時間 <input type="time" value={value.endTime} onChange={event => onChange({ ...value, endTime: event.target.value })} /></label>}
    </fieldset>
}
