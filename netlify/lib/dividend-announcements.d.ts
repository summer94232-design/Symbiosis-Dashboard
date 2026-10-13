export interface DividendAnnouncement {
    id: string; market: 'TWSE' | 'TPEX'; date: string; code: string; name: string
    cashPerShare: number | null; stockRatio: number; source: string; checkedAt: string; active: boolean
}
export interface DividendCatalog { entries: DividendAnnouncement[]; marketCheckedAt: Partial<Record<'TWSE' | 'TPEX', string>> }
export const DIVIDEND_SOURCES: Record<'TWSE' | 'TPEX', string>
export function validateDividendAnnouncement(row: unknown): DividendAnnouncement
export function publicDividendCatalog(data: unknown): DividendCatalog | null
