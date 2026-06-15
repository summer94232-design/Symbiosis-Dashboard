/**
 * csv.ts — CSV 解析共用工具（優化建議書 1-2）
 *
 * 放置位置：src/lib/csv.ts
 *
 * 原本 parseCSVLine / toNum / toInt 被複製貼上在 Trades、InvestSettings、KMSHome
 * 三處（實作完全相同），任何修正都要改三份。本模組為唯一真實來源。
 */

/**
 * 穩健 CSV 行解析器：支援雙引號包裹欄位、欄位內含逗號（千分位）、
 * 引號內的跳脫雙引號（"" → "）。每個欄位回傳前會 trim。
 */
export function parseCSVLine(line: string): string[] {
    const result: string[] = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
            else { inQuotes = !inQuotes }
        } else if (ch === ',' && !inQuotes) {
            result.push(current.trim())
            current = ''
        } else {
            current += ch
        }
    }
    result.push(current.trim())
    return result
}

/** 去除千分位逗號後轉浮點數（空字串/NaN 回傳 0） */
export const toNum = (s: string): number => parseFloat((s || '').replace(/,/g, '')) || 0

/** 去除千分位逗號後轉整數（空字串/NaN 回傳 0） */
export const toInt = (s: string): number => parseInt((s || '').replace(/,/g, '')) || 0