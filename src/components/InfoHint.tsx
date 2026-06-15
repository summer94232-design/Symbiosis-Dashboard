/**
 * InfoHint.tsx — 口徑說明小圖示（優化建議書 2-1）
 *
 * 放置位置：src/components/InfoHint.tsx（與 ThemeToggle.tsx 同層）
 *
 * 用途：在報酬率／損益卡片標籤旁顯示一個 ⓘ 圖示，
 * 滑鼠移入（桌機）或點擊（手機）顯示該數字的計算口徑說明，
 * 消除「不同頁面數字對不起來」的困惑。
 *
 * 純展示元件，無外部相依，使用既有 --c-* 主題變數，深淺色模式皆適用。
 */

import { useState } from 'react'

interface InfoHintProps {
    /** 口徑說明文字 */
    text: string
    /** 提示框寬度（px），預設 240 */
    width?: number
}

export default function InfoHint({ text, width = 240 }: InfoHintProps) {
    const [open, setOpen] = useState(false)

    return (
        <span
            style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', marginLeft: '5px', verticalAlign: 'middle' }}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        >
            <span
                aria-label="口徑說明"
                style={{
                    cursor: 'help',
                    width: '14px', height: '14px',
                    borderRadius: '50%',
                    border: '1px solid var(--c-muted)',
                    color: 'var(--c-muted)',
                    fontSize: '9px', fontWeight: 700, fontStyle: 'italic',
                    lineHeight: '12px', textAlign: 'center',
                    display: 'inline-block', userSelect: 'none', flexShrink: 0,
                }}
            >
                i
            </span>
            {open && (
                <span
                    style={{
                        position: 'absolute',
                        bottom: 'calc(100% + 8px)',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        zIndex: 100,
                        width: `${width}px`,
                        padding: '10px 12px',
                        borderRadius: '8px',
                        backgroundColor: 'var(--c-sidebar)',
                        border: '1px solid var(--c-border)',
                        color: 'var(--c-text)',
                        fontSize: '11px', fontWeight: 400,
                        lineHeight: 1.6,
                        whiteSpace: 'normal', textAlign: 'left',
                        boxShadow: '0 6px 16px rgba(0,0,0,0.35)',
                        pointerEvents: 'none',
                    }}
                >
                    {text}
                </span>
            )}
        </span>
    )
}