/**
 * App.tsx 色彩遷移 — 關鍵修改點
 *
 * 全文搜尋以下字串逐一替換，其餘邏輯不動
 * ══════════════════════════════════════════════════════
 */

// ── Step 1：在 Sidebar 底部加入 ThemeToggle ────────────
//
// 找到這段（登出按鈕區）：
//   <div style={{ padding: '12px', borderTop: '1px solid #2e3349' }}>
//     <button onClick={() => signOutAll()} ...>
//
// 在 <button 登出> 之前插入：
//   import ThemeToggle from './components/ThemeToggle'
//   ...
//   <ThemeToggle />
//   <button onClick={() => signOutAll()} ...>登出</button>


// ── Step 2：Sidebar/App 內所有硬編碼色票替換 ───────────
//
// 背景色
//   '#0f1117'  →  'var(--c-bg)'
//   '#1a1d27'  →  'var(--c-sidebar)'    （Sidebar aside 背景、header 背景）
//
// 邊框
//   '#2e3349'  →  'var(--c-border)'
//
// 文字
//   '#e2e8f0'  →  'var(--c-text)'
//   '#8892a4'  →  'var(--c-muted)'
//
// 強調（NavLink isActive 狀態）
//   '#4f8ef7'  →  'var(--c-accent)'
//   'rgba(79,142,247,0.12)'  →  'color-mix(in srgb, var(--c-accent) 12%, transparent)'
//
// 正向（KMS isActive 等）
//   '#00c896'  →  'var(--c-positive)'
//   'rgba(0,200,150,0.10)'  →  'color-mix(in srgb, var(--c-positive) 10%, transparent)'
//
// 危險（垃圾桶 isActive / 登出 hover）
//   '#ff5757'  →  'var(--c-danger)'
//   'rgba(255,87,87,0.10)'  →  'color-mix(in srgb, var(--c-danger) 10%, transparent)'


// ── Step 3：具體 diff（App.tsx Sidebar aside style）────
//
// 舊：
//   <aside style={{ backgroundColor: '#1a1d27', borderRight: '1px solid #2e3349', ... }}>
//
// 新：
//   <aside style={{ backgroundColor: 'var(--c-sidebar)', borderRight: '1px solid var(--c-border)', ... }}>


// ── Step 4：NavLink style 函式替換範例 ──────────────────
//
// 舊（投資導覽）：
//   style={({ isActive }) => ({
//     backgroundColor: isActive ? 'rgba(79,142,247,0.12)' : 'transparent',
//     color: isActive ? '#4f8ef7' : '#8892a4',
//   })}
//
// 新：
//   style={({ isActive }) => ({
//     backgroundColor: isActive
//       ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)'
//       : 'transparent',
//     color: isActive ? 'var(--c-accent)' : 'var(--c-muted)',
//   })}
//
// 舊（KMS 筆記）：
//   color: isActive ? '#00c896' : '#8892a4'
// 新：
//   color: isActive ? 'var(--c-positive)' : 'var(--c-muted)'
//
// 舊（垃圾桶）：
//   color: isActive ? '#ff5757' : '#8892a4'
// 新：
//   color: isActive ? 'var(--c-danger)' : 'var(--c-muted)'


// ── Step 5：PageLoader spinner ─────────────────────────
//
// 舊：
//   border: '2px solid #2e3349', borderTopColor: '#4f8ef7'
// 新：
//   border: '2px solid var(--c-border)', borderTopColor: 'var(--c-accent)'

export {}
