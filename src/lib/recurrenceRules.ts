export const weekdays = [['MO', '一'], ['TU', '二'], ['WE', '三'], ['TH', '四'], ['FR', '五'], ['SA', '六'], ['SU', '日']]
export function simpleRule(lines: string[]) {
    if (lines.length !== 1 || !lines[0].startsWith('RRULE:')) return null
    const entries = lines[0].slice(6).split(';').map(part => part.split('='))
    if (entries.some(([key]) => !['FREQ', 'INTERVAL', 'BYDAY', 'COUNT'].includes(key))) return null
    const fields: Record<string, string> = Object.fromEntries(entries)
    if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(fields.FREQ)) return null
    if (fields.BYDAY && (fields.FREQ !== 'WEEKLY' || fields.BYDAY.split(',').some(day => !weekdays.some(([code]) => code === day)))) return null
    return { frequency: fields.FREQ, interval: fields.INTERVAL || '1', days: fields.BYDAY?.split(',') || [], count: fields.COUNT || '' }
}
