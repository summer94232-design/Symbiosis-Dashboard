const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })
const timeFormatter = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const fullFormatter = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

export function formatSyncTime(timestamp: string, now = new Date()): { short: string; full: string } | null {
    // The provider stores ISO timestamps; never guess at legacy localized strings.
    if (!/^\d{4}-\d{2}-\d{2}T/.test(timestamp)) return null
    const date = new Date(timestamp)
    if (!Number.isFinite(date.getTime())) return null
    const time = timeFormatter.format(date)
    return {
        short: dateFormatter.format(date) === dateFormatter.format(now) ? time : `${dateFormatter.format(date)} ${time}`,
        full: fullFormatter.format(date),
    }
}
