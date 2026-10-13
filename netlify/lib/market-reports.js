export const REPORT_FILE_NAME = '台股每日投資報告資料庫'
export const REPORT_HEADERS = ['日期', '時段', '報告標題', '摘要', '全文', '更新時間']
export function taipeiDate(now = new Date()) {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
const validDate = date => typeof date === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(date)
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date

export function parseReportRows(rows) {
    if (!Array.isArray(rows) || !Array.isArray(rows[0]) || !REPORT_HEADERS.every((name, i) => rows[0][i]?.trim() === name)) throw new Error('報告欄位格式不符')
    const reports = new Map()
    let invalidRows = 0
    for (const row of rows.slice(1)) {
        if (!Array.isArray(row) || row.every(value => value === '' || value == null)) continue
        const [date, period, title, summary, content, updatedAt] = row.map((value, index) => typeof value === 'string' ? (index === 4 ? value : value.trim()) : '')
        let valid = false
        try {
            valid = validDate(date) && ['盤前', '盤後'].includes(period) && Boolean(title && summary && content.trim())
                && /^20\d{2}-\d{2}-\d{2} [0-2]\d:[0-5]\d:[0-5]\d$/.test(updatedAt)
                && validDate(updatedAt.slice(0, 10)) && Number(updatedAt.slice(11, 13)) < 24
        } catch { /* Invalid calendar dates never become reports. */ }
        if (!valid) { invalidRows++; continue }
        const id = `${date}:${period === '盤前' ? 'pre' : 'post'}`
        const report = { id, date, period, title, summary, content, updatedAt }
        const previous = reports.get(id)
        if (previous?.updatedAt === updatedAt && previous.content !== content) throw new Error('同一報告版本內容衝突')
        if (!previous || updatedAt > previous.updatedAt) reports.set(id, report)
    }
    return { reports: [...reports.values()].sort((a, b) => b.date.localeCompare(a.date)
        || (b.period === '盤後' ? 1 : 0) - (a.period === '盤後' ? 1 : 0) || b.updatedAt.localeCompare(a.updatedAt)), invalidRows }
}

export function reportDeliveryStatus(latest, reports, now = new Date(), holidays = [], readFailed = false) {
    const date = taipeiDate(now), day = new Date(`${date}T00:00:00Z`).getUTCDay()
    const label = latest ? `目前顯示 ${latest.date} ${latest.period}` : '尚無可閱讀報告'
    if (readFailed) return `${label}（更新狀態未確認）`
    if ([0, 6].includes(day)) return `週末不執行排程；${label}`
    if (holidays.includes(date)) return `休市日；${label}`
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
    const minutes = Number(parts.find(p => p.type === 'hour').value) * 60 + Number(parts.find(p => p.type === 'minute').value)
    const period = minutes >= 1080 ? '盤後' : minutes >= 535 ? '盤前' : null
    if (!period) return `盤前預計 08:55～09:00 發布；${label}`
    if (reports.some(report => report.date === date && report.period === period)) return label
    const until = period === '盤前' ? 540 : 1085
    return `${minutes < until ? `${period}報告產生中，預計 ${period === '盤前' ? '09:00' : '18:05'} 前完成` : `今日${period}尚未發布`}；${label}`
}
