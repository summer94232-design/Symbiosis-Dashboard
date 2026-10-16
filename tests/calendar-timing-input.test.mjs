import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, read } from './helpers/compile.mjs'

const input = compile(read('src/lib/calendarTimingInput.ts'))
const timing = compile(read('src/lib/calendarTiming.ts'))
const date = '2026-10-16'
const draft = { allDay: false, startTime: '09:00', endTime: '10:00', endDate: date }

test('whole date and time input normalizes compact or separated values without accepting impossible values', () => {
    for (const text of ['20261016', '2026/10/16', '2026-10-16']) assert.equal(input.parseCalendarDate(text), date)
    assert.equal(input.parseCalendarDate('2024/2/29'), '2024-02-29')
    for (const text of ['20260229', '2026/2/30', '2026/13/1', '202610', '']) assert.equal(input.parseCalendarDate(text), null)
    for (const text of ['0930', '930', '9:30', '09:30']) assert.equal(input.parseCalendarTime(text), '09:30')
    assert.equal(input.parseCalendarTime('9'), '09:00')
    assert.equal(input.parseCalendarTime('0:05'), '00:05')
    for (const text of ['2400', '09:60', '999', '-1', '', 'abc']) assert.equal(input.parseCalendarTime(text), null)
})

test('moving a start preserves duration across midnight, month and year boundaries', () => {
    const overnight = input.moveTimingStart(date, draft, date, '23:30')
    assert.deepEqual(overnight, { ...draft, startTime: '23:30', endDate: '2026-10-17', endTime: '00:30' })
    const moved = input.moveTimingStart(date, overnight, '2026-12-31')
    assert.equal(moved.endDate, '2027-01-01')
    const schedule = timing.timingForWrite('2026-12-31', moved)
    assert.equal(schedule.start.dateTime, '2026-12-31T23:30:00+08:00')
    assert.equal(schedule.end.dateTime, '2027-01-01T00:30:00+08:00')
    assert.equal(timing.eventOccursOn({ date: '2026-12-31', ...schedule }, '2027-01-01'), true)
})

test('all-day start changes preserve the inclusive date span and Google exclusive end', () => {
    const moved = input.moveTimingStart(date, { ...draft, allDay: true, endDate: '2026-10-18' }, '2026-10-31')
    assert.equal(moved.endDate, '2026-11-02')
    assert.equal(timing.timingForWrite('2026-10-31', moved).end.date, '2026-11-03')
    assert.equal(input.moveTimingStart(date, { ...draft, allDay: true, endDate: '' }, '2026-10-17').endDate, '2026-10-17')
})

test('duration shortcuts calculate a valid end and invalid edits remain invalid until corrected', () => {
    assert.equal(input.timingWithDuration(date, draft, 30).endTime, '09:30')
    assert.equal(input.timingWithDuration(date, draft, 120).endTime, '11:00')
    const overnight = input.timingWithDuration(date, { ...draft, startTime: '23:45' }, 30)
    assert.equal(overnight.endDate, '2026-10-17'); assert.equal(overnight.endTime, '00:15')
    const invalid = input.moveTimingStart(date, draft, date, '2560')
    assert.equal(invalid.startTime, '2560'); assert.equal(invalid.endTime, '10:00')
    assert.throws(() => timing.timingForWrite(date, invalid), /有效/)
    assert.deepEqual(input.timingWithDuration(date, invalid, 60), invalid)
    assert.throws(() => timing.timingForWrite('2026-02-30', draft), /有效/)
    assert.throws(() => timing.timingForWrite(date, { ...draft, endTime: '08:00' }), /晚於/)
})

test('untouched imported event retains its original timezone, seconds and recurrence timing', () => {
    const event = { date, start: { dateTime: '2026-10-15T18:00:25-07:00', timeZone: 'America/Los_Angeles' }, end: { dateTime: '2026-10-15T19:00:25-07:00', timeZone: 'America/Los_Angeles' }, recurringEventId: 'series' }
    assert.deepEqual(timing.timingForWrite(date, timing.timingDraft(event), event), { start: event.start, end: event.end })
})

test('calendar add rejects an impossible typed date before either personal or meeting writes', async () => {
    const source = read('src/pages/calendar/CalendarHome.tsx')
    const body = source.slice(source.indexOf('    const handleAddEvent ='), source.indexOf('    const handleDeleteEvent ='))
    for (const type of ['personal', 'investor']) {
        const mod = compile(body, {
            ...input, form: { title: 'fixture', date: '2026-02-30', type },
            mutation: { run: work => work({}) },
            timingForWrite: () => assert.fail('must validate before preparing a write'),
            addInvestorMeetingDates: () => assert.fail('must not write an invalid meeting date'),
            runTransaction: () => assert.fail('must not write an invalid personal date'),
        }, 'export { handleAddEvent }')
        await assert.rejects(mod.handleAddEvent(), /有效的開始日期/)
    }
})
