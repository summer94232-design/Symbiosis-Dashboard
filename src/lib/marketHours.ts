const taiwanClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

/** Wait ten minutes after the regular 13:30 close before checking held-stock closing quotes. */
export function isAfterTaiwanClose(now: Date = new Date()): boolean {
    const parts = Object.fromEntries(taiwanClock.formatToParts(now).map(part => [part.type, part.value]))
    if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false
    return Number(parts.hour) * 60 + Number(parts.minute) >= 13 * 60 + 40
}
