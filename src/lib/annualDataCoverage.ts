import { FOMC_COVERED_YEARS } from './calendarData'
import { getSettlementCalendarYears, TWSE_SETTLEMENT_COVERED_YEARS } from './calc'
import { toLocalDateString } from './date'

export interface AnnualDateRange { start: string; end: string }

export function missingAnnualYears(range: AnnualDateRange, covered: readonly number[]): number[] {
    const date = (value: string) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
        const parsed = new Date(`${value}T00:00:00Z`)
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? parsed : null
    }
    const start = date(range.start), end = date(range.end)
    if (!start || !end || start > end) return []
    const missing: number[] = []
    for (let year = start.getUTCFullYear(); year <= end.getUTCFullYear(); year++) {
        if (!covered.includes(year)) missing.push(year)
    }
    return missing
}

export function getAnnualDataWarnings({ fomcRange, settlementRange }: {
    fomcRange?: AnnualDateRange; settlementRange?: AnnualDateRange
}): string[] {
    const messages: string[] = []
    if (fomcRange) {
        const years = missingAnnualYears(fomcRange, FOMC_COVERED_YEARS)
        if (years.length) messages.push(`${years.join('、')} 年 FOMC 日期尚未建置，事件清單可能不完整。`)
    }
    if (settlementRange) {
        const years = getSettlementCalendarYears(settlementRange.start, settlementRange.end)
            .filter(year => !TWSE_SETTLEMENT_COVERED_YEARS.includes(year))
        if (years.length) messages.push(`${years.join('、')} 年交割休假資料尚未建置，交割日與融資利息估算可能有誤差，請以券商實際金額為準。`)
    }
    return messages
}

/** Match the Google sync horizon, including a range that crosses New Year. */
export function googleSyncDateRange(now = new Date()): AnnualDateRange {
    return { start: toLocalDateString(now), end: toLocalDateString(new Date(now.getFullYear(), now.getMonth() + 6, now.getDate())) }
}
