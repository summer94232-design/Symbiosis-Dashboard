/**
 * 色彩系統 — 集中管理 Light / Dark 兩組色票
 *
 * 語意 token 對應規則（Light / Dark 通用）：
 *   正向（漲幅/安全/完成）   → --c-positive
 *   危險（跌幅/高優先/刪除）  → --c-danger
 *   警示（留意/中優先）      → --c-warning
 *   強調（選中/主按鈕/連結） → --c-accent
 *   主背景                  → --c-bg
 *   側邊欄背景              → --c-sidebar
 *   卡片背景                → --c-card
 *   邊框                   → --c-border
 *   主要文字               → --c-text
 *   次要文字（標籤/說明）   → --c-muted
 */

export type ThemeMode = 'dark' | 'light'

export interface ThemeTokens {
    bg: string
    sidebar: string
    card: string
    border: string
    text: string
    muted: string
    accent: string
    positive: string
    danger: string
    warning: string
}

export const themes: Record<ThemeMode, ThemeTokens> = {
    dark: {
        bg: '#14182a',
        sidebar: '#0f1220',
        card: '#1c2235',
        border: '#2a3050',
        text: '#dde2f0',
        muted: '#7a88aa',
        accent: '#8b9ef5',
        positive: '#4aaa80',
        danger: '#e06060',
        warning: '#c49030',
    },
    light: {
        bg: '#f0f2f5',
        sidebar: '#e6eaf0',
        card: '#f8f9fb',
        border: '#d0d6e0',
        text: '#1e2535',
        muted: '#6b7894',
        accent: '#5b6fd4',
        positive: '#2a7a5a',
        danger: '#c44040',
        warning: '#a07020',
    },
}

/** 把 token 物件寫入 :root 的 CSS 自訂屬性 */
export function applyTheme(mode: ThemeMode): void {
    const t = themes[mode]
    const root = document.documentElement
    root.setAttribute('data-theme', mode)
    root.style.setProperty('--c-bg', t.bg)
    root.style.setProperty('--c-sidebar', t.sidebar)
    root.style.setProperty('--c-card', t.card)
    root.style.setProperty('--c-border', t.border)
    root.style.setProperty('--c-text', t.text)
    root.style.setProperty('--c-muted', t.muted)
    root.style.setProperty('--c-accent', t.accent)
    root.style.setProperty('--c-positive', t.positive)
    root.style.setProperty('--c-danger', t.danger)
    root.style.setProperty('--c-warning', t.warning)
}

/** 讀取目前 CSS 變數值（供 JS inline style 使用） */
export function token(name: keyof ThemeTokens): string {
    return `var(--c-${name})`
}

/** rgba helper — 在 CSS 變數上疊加透明度（需搭配 color-mix 或直接用 hex） */
export function tokenAlpha(name: keyof ThemeTokens, mode: ThemeMode, alpha: number): string {
    const hex = themes[mode][name]
    // 將 hex 轉成 rgba
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r},${g},${b},${alpha})`
}