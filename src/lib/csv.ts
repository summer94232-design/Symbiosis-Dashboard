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
export function parseCSVRecords(text: string): string[][] {
    const input = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    const rows: string[][] = []
    let row: string[] = []
    let current = ''
    let inQuotes = false
    let quoted = false
    let closed = false
    const field = () => { row.push(quoted ? current : current.trim()); current = ''; quoted = false; closed = false }
    const record = () => { field(); if (row.some(value => value.trim())) rows.push(row); row = [] }
    for (let i = 0; i < input.length; i++) {
        const ch = input[i]
        if (inQuotes) {
            if (ch !== '"') current += ch
            else if (input[i + 1] === '"') { current += '"'; i++ }
            else { inQuotes = false; closed = true }
        } else if (ch === ',') field()
        else if (ch === '\n') record()
        else if (closed) {
            if (!/\s/.test(ch)) throw new Error('CSV 引號結束後有不合法的文字')
        } else if (ch === '"') {
            if (current.trim()) throw new Error('CSV 欄位中的引號必須以雙引號跳脫')
            current = ''; quoted = true; inQuotes = true
        } else current += ch
    }
    if (inQuotes) throw new Error('CSV 引號未關閉，請確認檔案內容')
    record()
    return rows
}

/** Legacy single-record API; whole-file imports must use parseCSVRecords. */
export function parseCSVLine(line: string): string[] {
    const rows = parseCSVRecords(line)
    if (rows.length > 1) throw new Error('請使用整份 CSV 解析器讀取多筆資料')
    return (rows[0] || ['']).map(value => value.trim())
}

/** 去除千分位逗號後轉浮點數（空字串/NaN 回傳 0） */
export const toNum = (s: string): number => parseFloat((s || '').replace(/,/g, '')) || 0

/** 去除千分位逗號後轉整數（空字串/NaN 回傳 0） */
export const toInt = (s: string): number => parseInt((s || '').replace(/,/g, '')) || 0
