/**
 * ══════════════════════════════════════════════════════
 *  色彩遷移對照表
 *  舊硬編碼色票  →  新 CSS 變數
 * ══════════════════════════════════════════════════════
 *
 * 使用方式（inline style）：
 *   舊：color: '#e2e8f0'
 *   新：color: 'var(--c-text)'
 *
 * 使用方式（Tailwind class）：
 *   舊：className="text-[#e2e8f0]"
 *   新：className="text-c-text"
 * ══════════════════════════════════════════════════════
 */

export const COLOR_MAP = {

  // ── 背景 ──────────────────────────────────────────
  '#0f1117':  'var(--c-bg)',       // 舊 dark-bg（主背景）
  '#14182a':  'var(--c-bg)',       // 新主背景 dark
  '#f0f2f5':  'var(--c-bg)',       // 新主背景 light

  '#1a1d27':  'var(--c-sidebar)',  // 舊側邊欄/表面色
  '#0f1220':  'var(--c-sidebar)',  // 新側邊欄 dark
  '#e6eaf0':  'var(--c-sidebar)',  // 新側邊欄 light

  '#21253a':  'var(--c-card)',     // 舊卡片
  '#1c2235':  'var(--c-card)',     // 新卡片 dark
  '#f8f9fb':  'var(--c-card)',     // 新卡片 light

  // ── 邊框 ──────────────────────────────────────────
  '#2e3349':  'var(--c-border)',   // 舊邊框
  '#2a3050':  'var(--c-border)',   // 新邊框 dark
  '#d0d6e0':  'var(--c-border)',   // 新邊框 light

  // ── 文字 ──────────────────────────────────────────
  '#e2e8f0':  'var(--c-text)',     // 舊主文字
  '#dde2f0':  'var(--c-text)',     // 新主文字 dark
  '#1e2535':  'var(--c-text)',     // 新主文字 light

  '#8892a4':  'var(--c-muted)',    // 舊次要文字
  '#7a88aa':  'var(--c-muted)',    // 新次要文字 dark
  '#6b7894':  'var(--c-muted)',    // 新次要文字 light

  // ── 強調色 ────────────────────────────────────────
  '#4f8ef7':  'var(--c-accent)',   // 舊 brand-blue（部分路由用這個）
  '#8b9ef5':  'var(--c-accent)',   // 新強調 dark
  '#5b6fd4':  'var(--c-accent)',   // 新強調 light

  // ── 正向色 ────────────────────────────────────────
  '#00c896':  'var(--c-positive)', // 舊 brand-green
  '#4aaa80':  'var(--c-positive)', // 新正向 dark
  '#2a7a5a':  'var(--c-positive)', // 新正向 light

  // ── 危險色 ────────────────────────────────────────
  '#ff5757':  'var(--c-danger)',   // 舊 brand-red
  '#e06060':  'var(--c-danger)',   // 新危險 dark
  '#c44040':  'var(--c-danger)',   // 新危險 light

  // ── 警示色 ────────────────────────────────────────
  '#f5a623':  'var(--c-warning)',  // 舊 brand-gold
  '#c49030':  'var(--c-warning)',  // 新警示 dark
  '#a07020':  'var(--c-warning)',  // 新警示 light
} as const

/**
 * ══════════════════════════════════════════════════════
 *  rgba / 半透明色對照（常見用法）
 * ══════════════════════════════════════════════════════
 *
 * 推薦改法：用 color-mix() 或直接查 theme token 動態產生
 *
 * 舊寫法（硬編碼 dark 色票）：
 *   backgroundColor: 'rgba(0,200,150,0.12)'   → 正向色 12% 透明
 *   backgroundColor: 'rgba(255,87,87,0.12)'   → 危險色 12% 透明
 *   backgroundColor: 'rgba(245,166,35,0.12)'  → 警示色 12% 透明
 *   backgroundColor: 'rgba(79,142,247,0.12)'  → 強調色 12% 透明
 *
 * 新寫法（color-mix，純 CSS，自動跟隨主題）：
 *   backgroundColor: 'color-mix(in srgb, var(--c-positive) 12%, transparent)'
 *   backgroundColor: 'color-mix(in srgb, var(--c-danger)   12%, transparent)'
 *   backgroundColor: 'color-mix(in srgb, var(--c-warning)  12%, transparent)'
 *   backgroundColor: 'color-mix(in srgb, var(--c-accent)   12%, transparent)'
 *
 * color-mix 瀏覽器支援：Chrome 111+, Firefox 113+, Safari 16.2+（2023 起全面支援）
 *
 * 若需要支援更舊瀏覽器，改用 tokenAlpha() helper：
 *   import { tokenAlpha } from '../theme'
 *   backgroundColor: tokenAlpha('positive', mode, 0.12)
 * ══════════════════════════════════════════════════════
 */

/**
 * ══════════════════════════════════════════════════════
 *  語意強制規則（禁止混用）
 * ══════════════════════════════════════════════════════
 *
 * ✅ 正值 / 漲幅 / 安全 / 低優先 / 完成   → var(--c-positive)
 * ✅ 負值 / 跌幅 / 危險 / 高優先 / 刪除   → var(--c-danger)
 * ✅ 警示 / 留意 / 中優先               → var(--c-warning)
 * ✅ 選中導覽 / 主按鈕 / 連結            → var(--c-accent)
 *
 * ❌ 禁止：正向色用於負值情境
 * ❌ 禁止：危險色用於正值情境
 * ══════════════════════════════════════════════════════
 *
 * ratioColor / ratioLabel 更新範例：
 *
 * 舊：
 *   const ratioColor = (v: number) =>
 *     v >= 160 ? '#00c896' : v >= 130 ? '#f5a623' : '#ff5757'
 *
 * 新：
 *   const ratioColor = (v: number) =>
 *     v >= 160 ? 'var(--c-positive)' : v >= 130 ? 'var(--c-warning)' : 'var(--c-danger)'
 *
 * ── TaskManager PRIORITY_COLORS 更新範例 ──────────────
 * 舊：
 *   const PRIORITY_COLORS = { high: '#ff5757', medium: '#f5a623', low: '#00c896' }
 *
 * 新：
 *   const PRIORITY_COLORS = {
 *     high:   'var(--c-danger)',
 *     medium: 'var(--c-warning)',
 *     low:    'var(--c-positive)',
 *   }
 */
