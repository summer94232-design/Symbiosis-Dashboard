export const REPORT_FILE_NAME: string
export const REPORT_HEADERS: string[]
export interface MarketReport {
    id: string; date: string; period: '盤前' | '盤後'; title: string; summary: string; content: string; updatedAt: string
}
export function taipeiDate(now?: Date): string
export function parseReportRows(rows: unknown): { reports: MarketReport[]; invalidRows: number }
export function reportDeliveryStatus(latest: MarketReport | null, reports: Array<Pick<MarketReport, 'date' | 'period'>>, now?: Date, holidays?: string[], readFailed?: boolean): string
