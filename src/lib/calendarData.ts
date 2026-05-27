export interface CalendarEvent {
    id: string
    date: string        // YYYY-MM-DD
    title: string
    type: 'fomc' | 'futures' | 'tech' | 'investor' | 'personal' | 'dividend' | 'shareholder'
    description?: string
    url?: string
    stockCode?: string
}

// FOMC 會議日期 2025-2026
export const FOMC_DATES: CalendarEvent[] = [
    { id: 'fomc-2025-01', date: '2025-01-29', title: 'FOMC 會議結果', type: 'fomc', description: '聯準會利率決策公布' },
    { id: 'fomc-2025-03', date: '2025-03-19', title: 'FOMC 會議結果', type: 'fomc', description: '聯準會利率決策公布' },
    { id: 'fomc-2025-05', date: '2025-05-07', title: 'FOMC 會議結果', type: 'fomc', description: '聯準會利率決策公布' },
    { id: 'fomc-2025-06', date: '2025-06-18', title: 'FOMC 會議結果', type: 'fomc', description: '聯準會利率決策公布' },
    { id: 'fomc-2025-07', date: '2025-07-30', title: 'FOMC 會議結果', type: 'fomc', description: '聯準會利率決策公布' },
    { id: 'fomc-2025-09', date: '2025-09-17', title: 'FOMC 會議結果', type: 'fomc', description: '聯準會利率決策公布' },
    { id: 'fomc-2025-10', date: '2025-10-29', title: 'FOMC 會議結果', type: 'fomc', description: '聯準會利率決策公布' },
    { id: 'fomc-2025-12', date: '2025-12-17', title: 'FOMC 會議結果', type: 'fomc', description: '聯準會利率決策公布' },
    { id: 'fomc-2026-01', date: '2026-01-28', title: 'FOMC 會議結果', type: 'fomc', description: '聯準會利率決策公布' },
    { id: 'fomc-2026-03', date: '2026-03-18', title: 'FOMC 會議結果', type: 'fomc', description: '聯準會利率決策公布' },
    { id: 'fomc-2026-04', date: '2026-04-29', title: 'FOMC 會議結果', type: 'fomc', description: '聯準會利率決策公布' },
    { id: 'fomc-2026-06', date: '2026-06-17', title: 'FOMC 會議結果', type: 'fomc', description: '聯準會利率決策公布' },
    { id: 'fomc-2026-07', date: '2026-07-29', title: 'FOMC 會議結果', type: 'fomc', description: '聯準會利率決策公布' },
    { id: 'fomc-2026-09', date: '2026-09-16', title: 'FOMC 會議結果', type: 'fomc', description: '聯準會利率決策公布' },
    { id: 'fomc-2026-10', date: '2026-10-28', title: 'FOMC 會議結果', type: 'fomc', description: '聯準會利率決策公布' },
    { id: 'fomc-2026-12', date: '2026-12-16', title: 'FOMC 會議結果', type: 'fomc', description: '聯準會利率決策公布' },
]

// 重要科技活動
export const TECH_EVENTS: CalendarEvent[] = [
]

// 計算指定年月的台灣期貨結算日（每月第三個週三）
// ✅ Bug 修正：
//   舊版有兩個問題：(1) for 迴圈跑整年、完全忽略傳入的 month 參數；
//   (2) `if (year === 今年-1) continue` 會讓「去年整年」的結算日全部消失，
//       導致月曆翻到去年月份時看不到台指期結算日。
//   現在只計算傳入的 (year, month) 當月結算日，邏輯單純且正確。
export function getFuturesSettlementDates(year: number, month: number): CalendarEvent[] {
    const results: CalendarEvent[] = []
    let count = 0
    for (let d = 1; d <= 31; d++) {
        const date = new Date(year, month - 1, d)
        if (date.getMonth() !== month - 1) break // 超出當月
        if (date.getDay() === 3) { // 週三
            count++
            if (count === 3) {
                const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
                results.push({
                    id: `futures-${year}-${month}`,
                    date: dateStr,
                    title: '台指期結算日',
                    type: 'futures',
                    description: '台灣加權指數期貨結算'
                })
                break
            }
        }
    }
    return results
}

export const EVENT_COLORS: Record<string, string> = {
    fomc: '#ff5757',
    futures: '#f5a623',
    tech: '#a78bfa',
    investor: '#00c896',
    personal: '#4f8ef7',
    dividend: '#34d399',
    shareholder: '#f97316',
}

export const EVENT_LABELS: Record<string, string> = {
    fomc: 'FOMC',
    futures: '期貨結算',
    tech: '科技活動',
    investor: '法說會',
    personal: '個人行程',
    dividend: '除權息',
    shareholder: '股東會',
}