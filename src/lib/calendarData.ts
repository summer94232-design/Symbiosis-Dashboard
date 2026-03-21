export interface CalendarEvent {
  id: string
  date: string        // YYYY-MM-DD
  title: string
  type: 'fomc' | 'futures' | 'tech' | 'investor' | 'personal' | 'dividend'
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
  { id: 'gtc-2025', date: '2025-03-17', title: 'NVIDIA GTC 2025', type: 'tech', description: 'NVIDIA 年度開發者大會', url: 'https://www.nvidia.com/gtc/' },
  { id: 'wwdc-2025', date: '2025-06-09', title: 'Apple WWDC 2025', type: 'tech', description: 'Apple 全球開發者大會' },
  { id: 'build-2025', date: '2025-05-19', title: 'Microsoft Build 2025', type: 'tech', description: 'Microsoft 開發者大會' },
  { id: 'google-io-2025', date: '2025-05-14', title: 'Google I/O 2025', type: 'tech', description: 'Google 開發者大會' },
  { id: 'gtc-2026', date: '2026-03-16', title: 'NVIDIA GTC 2026', type: 'tech', description: 'NVIDIA 年度開發者大會' },
  { id: 'wwdc-2026', date: '2026-06-08', title: 'Apple WWDC 2026', type: 'tech', description: 'Apple 全球開發者大會' },
  { id: 'ces-2026', date: '2026-01-06', title: 'CES 2026', type: 'tech', description: '國際消費電子展', url: 'https://www.ces.tech/' },
]

// 計算台灣期貨結算日（每月第三個週三）
export function getFuturesSettlementDates(year: number, month: number): CalendarEvent[] {
  const results: CalendarEvent[] = []
  for (let m = 1; m <= 12; m++) {
    if (year === new Date().getFullYear() - 1) continue
    let count = 0
    for (let d = 1; d <= 31; d++) {
      const date = new Date(year, m - 1, d)
      if (date.getMonth() !== m - 1) break
      if (date.getDay() === 3) { // 週三
        count++
        if (count === 3) {
          const dateStr = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
          results.push({
            id: `futures-${year}-${m}`,
            date: dateStr,
            title: '台指期結算日',
            type: 'futures',
            description: '台灣加權指數期貨結算'
          })
          break
        }
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
  dividend: '#00c896',
}

export const EVENT_LABELS: Record<string, string> = {
  fomc: 'FOMC',
  futures: '期貨結算',
  tech: '科技活動',
  investor: '法說會',
  personal: '個人行程',
  dividend: '除權息',
}