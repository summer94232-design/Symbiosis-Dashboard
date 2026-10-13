/**
 * styles.ts — 共用 inline style 常數（優化建議書 1-2）
 *
 * 放置位置：src/ui/styles.ts
 *
 * card / inp / lbl / btn 原本被複製貼上在幾乎每一頁，樣式調整要改十幾處。
 * 本模組收錄「完全相同」的標準版本；個別頁面刻意不同的變體
 * （例：InvestSettings 的 card padding 24px、YearReview 的 inp 無 width:100%）
 * 保留在該頁，不強行統一，避免改變既有版面。
 */

/** 標準卡片容器 */
export const card: React.CSSProperties = {
    backgroundColor: 'var(--c-sidebar)',
    border: '1px solid var(--c-border)',
    borderColor: 'var(--c-border)',
    borderRadius: '12px',
    padding: 'var(--ui-card-padding, 20px)',
}

/** 標準輸入框（滿版寬度） */
export const inp: React.CSSProperties = {
    backgroundColor: 'var(--c-bg)',
    border: '1px solid var(--c-border)',
    borderRadius: '8px',
    padding: '8px 12px',
    color: 'var(--c-text)',
    fontSize: '14px',
    width: '100%',
    outline: 'none',
    boxSizing: 'border-box',
}

/** 標準表單欄位標籤 */
export const lbl: React.CSSProperties = {
    fontSize: '12px',
    color: 'var(--c-muted)',
    display: 'block',
    marginBottom: '4px',
}

/** Filled actions share the original semantic palette through common button tokens. */
export const buttonFill = (color: string): string => {
    const match = color.match(/^var\(--c-(accent|positive|danger|warning|purple)\)$/)
    return match ? `var(--c-button-${match[1]})` : color
}

/** 標準按鈕（傳入背景色） */
export const btn = (color: string): React.CSSProperties => ({
    backgroundColor: buttonFill(color),
    border: 'none',
    borderRadius: '8px',
    padding: '8px 12px',
    minHeight: '36px',
    color: /border|transparent|sidebar|card/.test(color) ? 'var(--c-text)' : /^var\(--c-(accent|positive|danger|warning|purple)\)$/.test(color) ? 'var(--c-on-accent)' : '#fff',
    fontSize: '13px',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1.4,
    gap: '6px',
})
