/**
 * 將 Date 格式化成使用者本地時區的 YYYY-MM-DD。
 *
 * 不使用 toISOString()，因為它會先轉成 UTC；在台灣時間凌晨
 * 00:00～07:59 之間，UTC 日期仍是前一天。
 */
export function toLocalDateString(date: Date = new Date()): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}
