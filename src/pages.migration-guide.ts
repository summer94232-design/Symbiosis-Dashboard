/**
 * 頁面元件色彩遷移指南
 *
 * 影響範圍：所有 src/pages/ 底下的 .tsx 元件
 * 核心原則：全文搜尋硬編碼色票，依語意替換成 CSS 變數
 * ══════════════════════════════════════════════════════
 */


// ── Dashboard.tsx / MarginManager.tsx ─────────────────
//
// card 物件（inline style const）
//
// 舊：
//   const card: React.CSSProperties = {
//     backgroundColor: '#1a1d27',
//     border: '1px solid #2e3349',
//     borderRadius: '12px',
//     padding: '20px',
//   }
//
// 新：
//   const card: React.CSSProperties = {
//     backgroundColor: 'var(--c-card)',
//     border: '1px solid var(--c-border)',
//     borderRadius: '12px',
//     padding: '20px',
//   }

// ── ratioColor / ratioLabel（融資維持率） ──────────────
//
// 舊：
//   const ratioColor = (v: number) =>
//     v >= 160 ? '#00c896' : v >= 130 ? '#f5a623' : '#ff5757'
//
// 新：
//   const ratioColor = (v: number) =>
//     v >= 160 ? 'var(--c-positive)' : v >= 130 ? 'var(--c-warning)' : 'var(--c-danger)'

// ── 維持率卡片漸層背景 ────────────────────────────────
//
// 舊：
//   background: currentRatio < 130
//     ? 'linear-gradient(135deg, #1a1d27 0%, rgba(255,87,87,0.06) 100%)'
//     : currentRatio < 160
//       ? 'linear-gradient(135deg, #1a1d27 0%, rgba(245,166,35,0.05) 100%)'
//       : '#1a1d27'
//
// 新：
//   background: currentRatio < 130
//     ? 'linear-gradient(135deg, var(--c-card) 0%, color-mix(in srgb, var(--c-danger) 6%, transparent) 100%)'
//     : currentRatio < 160
//       ? 'linear-gradient(135deg, var(--c-card) 0%, color-mix(in srgb, var(--c-warning) 5%, transparent) 100%)'
//       : 'var(--c-card)'

// ── 維持率卡片邊框 ────────────────────────────────────
//
// 舊：
//   borderColor: currentRatio < 130
//     ? 'rgba(255,87,87,0.5)'
//     : currentRatio < 160 ? 'rgba(245,166,35,0.4)' : '#2e3349'
//
// 新：
//   borderColor: currentRatio < 130
//     ? 'color-mix(in srgb, var(--c-danger) 50%, transparent)'
//     : currentRatio < 160
//       ? 'color-mix(in srgb, var(--c-warning) 40%, transparent)'
//       : 'var(--c-border)'

// ── Icon 背景圓形 ──────────────────────────────────────
//
// 舊：
//   backgroundColor: `${ratioColor(currentRatio)}18`
//   （18 是十六進位的 alpha ≈ 9.4%）
//
// 新：
//   backgroundColor: `color-mix(in srgb, ${ratioColor(currentRatio)} 10%, transparent)`

// ── 標籤 badge ────────────────────────────────────────
//
// 舊：
//   backgroundColor: `${ratioColor(currentRatio)}18`
//   color: ratioColor(currentRatio)
//
// 新（同上）：
//   backgroundColor: `color-mix(in srgb, ${ratioColor(currentRatio)} 10%, transparent)`
//   color: ratioColor(currentRatio)

// ══════════════════════════════════════════════════════
// ── TaskManager.tsx ────────────────────────────────────
// ══════════════════════════════════════════════════════

// 舊：
//   const PRIORITY_COLORS = { high: '#ff5757', medium: '#f5a623', low: '#00c896' }
//
// 新：
//   const PRIORITY_COLORS = {
//     high:   'var(--c-danger)',
//     medium: 'var(--c-warning)',
//     low:    'var(--c-positive)',
//   }

// 舊：
//   color: isOverdue ? '#ff5757' : '#8892a4'
// 新：
//   color: isOverdue ? 'var(--c-danger)' : 'var(--c-muted)'

// 舊：
//   backgroundColor: `${PRIORITY_COLORS[task.priority]}18`
// 新：
//   backgroundColor: `color-mix(in srgb, ${PRIORITY_COLORS[task.priority]} 10%, transparent)`

// ══════════════════════════════════════════════════════
// ── Dashboard.tsx inline CSS string（.h-table 等） ────
// ══════════════════════════════════════════════════════
//
// Dashboard 裡有一段 <style>{`...`} 字串，包含 .h-table 等 class
// 直接改成 CSS 變數即可：
//
// 舊：
//   .h-table th { color: #8892a4; border-bottom: 1px solid #2e3349; }
//   .h-table td { border-bottom: 1px solid #2e3349; color: #e2e8f0; }
//
// 新：
//   .h-table th { color: var(--c-muted); border-bottom: 1px solid var(--c-border); }
//   .h-table td { border-bottom: 1px solid var(--c-border); color: var(--c-text); }

export {}
