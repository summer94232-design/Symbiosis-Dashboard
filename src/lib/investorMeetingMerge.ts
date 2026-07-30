export interface InvestorMeetingInput {
  stockCode: string
  stockName: string
  yearMonth: string
  dates: string[]
}

export interface InvestorMeetingRecord extends InvestorMeetingInput {
  id: string
}

export const normalizeMeetingDates = (dates: unknown): string[] =>
  Array.isArray(dates)
    ? [...new Set(dates.map(String).filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort()
    : []

export function mergeInvestorMeetings(
  globalRows: InvestorMeetingRecord[],
  overrideRows: Array<InvestorMeetingRecord & { addedDates?: string[]; removedDates?: string[] }>,
): InvestorMeetingRecord[] {
  const merged = new Map(globalRows.map(row => [
    row.id,
    { ...row, dates: normalizeMeetingDates(row.dates) },
  ]))

  overrideRows.forEach(override => {
    const base = merged.get(override.id) ?? {
      id: override.id,
      stockCode: override.stockCode,
      stockName: override.stockName || override.stockCode,
      yearMonth: override.yearMonth,
      dates: [],
    }
    const removed = new Set(normalizeMeetingDates(override.removedDates))
    const dates = [...new Set([...base.dates, ...normalizeMeetingDates(override.addedDates)])]
      .filter(date => !removed.has(date))
      .sort()
    if (dates.length) {
      merged.set(override.id, {
        ...base,
        stockCode: override.stockCode || base.stockCode,
        stockName: override.stockName || base.stockName,
        yearMonth: override.yearMonth || base.yearMonth,
        dates,
      })
    } else {
      merged.delete(override.id)
    }
  })

  return [...merged.values()]
}
