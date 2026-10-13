export interface AnnualCalendarEntry { dates: string[]; source: string; checkedAt: string; tentative?: boolean }
export const FED_URL: string
export function twseUrl(year: number): string
export function validDate(date: unknown, year: number): boolean
export function validateAnnualEntry(kind: 'fomc' | 'settlement', year: number, row: unknown): AnnualCalendarEntry
export function getAnnualCalendarLastSuccessAt(data: unknown): string | null
