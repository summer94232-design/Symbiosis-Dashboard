import { useId, useRef, useState } from 'react'
import { CalendarDays } from 'lucide-react'
import type { TimingDraft } from '../lib/calendarTiming'
import { moveTimingStart, parseCalendarDate, parseCalendarTime, timingWithDuration } from '../lib/calendarTimingInput'
import './CalendarTimingFields.css'

function DirectInput({ label, value, onChange, date = false, list }: {
    label: string; value: string; onChange: (value: string) => void; date?: boolean; list?: string
}) {
    const id = useId(), picker = useRef<HTMLInputElement>(null)
    const [draft, setDraft] = useState<string | null>(null)
    const display = date ? value.replaceAll('-', '/') : value
    return <div className="calendar-direct-field">
        <label htmlFor={id}>{label}</label>
        <div className="calendar-direct-control">
            <input id={id} type="text" inputMode="numeric" autoComplete="off"
                placeholder={date ? 'YYYY/MM/DD' : 'HH:MM'} list={list} value={draft ?? display}
                onFocus={event => event.target.select()} onChange={event => setDraft(event.target.value)}
                onBlur={event => {
                    if (draft !== null) onChange((date ? parseCalendarDate : parseCalendarTime)(event.target.value) ?? event.target.value)
                    setDraft(null)
                }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }} />
            {date && <>
                <button type="button" aria-label={`選擇${label}`} onClick={() => picker.current?.showPicker()}><CalendarDays size={17} /></button>
                <input ref={picker} className="calendar-native-picker" type="date" aria-hidden="true" tabIndex={-1}
                    value={parseCalendarDate(value) || ''} onChange={event => { onChange(event.target.value); setDraft(null) }} />
            </>}
        </div>
    </div>
}

export default function CalendarTimingFields({ date, onDateChange, value, onChange, disabled = false, dateOnly = false }: {
    date: string; onDateChange: (date: string) => void
    value: TimingDraft; onChange: (value: TimingDraft) => void; disabled?: boolean; dateOnly?: boolean
}) {
    const list = useId()
    const changeDate = (next: string) => { onChange(moveTimingStart(date, value, next)); onDateChange(next) }
    return <fieldset disabled={disabled} className="calendar-timing-fields">
        <legend>{dateOnly ? '行程日期' : '行程時間（台北時間）'}</legend>
        {!dateOnly && <label className="calendar-all-day"><input type="checkbox" checked={value.allDay} onChange={event => onChange({ ...value, allDay: event.target.checked })} />全天</label>}
        <div className="calendar-timing-row">
            <DirectInput label="開始日期" date value={date} onChange={changeDate} />
            {!dateOnly && !value.allDay && <DirectInput label="開始時間" value={value.startTime} list={list}
                onChange={next => onChange(moveTimingStart(date, value, date, next))} />}
        </div>
        {!dateOnly && <div className="calendar-timing-row">
            <DirectInput label={value.allDay ? '結束日期（含當天）' : '結束日期'} date value={value.endDate || date} onChange={next => onChange({ ...value, endDate: next })} />
            {!value.allDay && <DirectInput label="結束時間" value={value.endTime} list={list} onChange={next => onChange({ ...value, endTime: next })} />}
        </div>}
        {!dateOnly && !value.allDay && <div className="calendar-duration-actions"><span>時長</span>
            {[[30, '30 分'], [60, '1 小時'], [120, '2 小時']].map(([minutes, label]) => <button type="button" key={minutes}
                onClick={() => onChange(timingWithDuration(date, value, Number(minutes)))}>{label}</button>)}
        </div>}
        <p className="calendar-timing-hint">日期可輸入 20261016{!dateOnly && !value.allDay ? '；時間用 24 小時制，可輸入 0930 或 09:30。調整開始時保留時長。' : '，或點日曆選擇。'}</p>
        <datalist id={list}>{Array.from({ length: 48 }, (_, index) => {
            const time = `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`
            return <option key={time} value={time} />
        })}</datalist>
    </fieldset>
}
