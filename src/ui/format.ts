/**
 * format.ts — 損益顏色與數字格式化共用工具（優化建議書 1-2）
 *
 * 放置位置：src/ui/format.ts
 *
 * pnlColor 原本在 Dashboard / Holdings / HistoryPnL / YearReview 各複製一份；
 * fmtMoney / fmtPct 沿用 YearReview 的既有行為（唯一以常數定義的版本），
 * 其他頁面的 inline 格式化字串行為略有差異（負數是否帶 −、是否取絕對值），
 * 為避免改變既有顯示，未強制全面替換。
 */

/** 正數綠、負數紅（0 視為正） */
export const pnlColor = (v: number): string => v >= 0 ? 'var(--c-positive)' : 'var(--c-danger)'

/**
 * 金額格式化（沿用 YearReview 既有行為）：
 * 正數帶 +、取絕對值加千分位、無小數。負值帶 - 號，搭配 pnlColor 表達方向。
 * 例：fmtMoney(12345.6) → "+$12,346"、fmtMoney(-5000) → "-$5,000"
 */
export const fmtMoney = (v: number): string =>
    `${v >= 0 ? '+' : '-'}$${Math.abs(v).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`

/**
 * 百分比格式化（沿用 YearReview 既有行為）：正數帶 +，固定兩位小數。
 * 例：fmtPct(3.456) → "+3.46%"、fmtPct(-1.2) → "-1.20%"
 */
export const fmtPct = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`