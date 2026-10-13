import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../lib/themeContext'

/**
 * 主題切換按鈕
 * 放在 Sidebar 底部（登出按鈕旁）即可
 *
 * 用法：
 *   import ThemeToggle from '../ThemeToggle'
 *   <ThemeToggle />
 */
export default function ThemeToggle() {
    const { mode, toggle } = useTheme()
    const isDark = mode === 'dark'

    return (
        <button
            onClick={toggle}
            title={isDark ? '切換淺色模式' : '切換深色模式'}
            style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                backgroundColor: 'transparent',
                border: '1px solid var(--c-border)',
                borderRadius: '8px',
                padding: '8px',
                color: 'var(--c-muted)',
                fontSize: '12px',
                cursor: 'pointer',
                transition: 'all 0.15s',
                marginBottom: '6px',
            }}
            onMouseEnter={e => {
                e.currentTarget.style.borderColor = 'var(--c-accent)'
                e.currentTarget.style.color = 'var(--c-accent)'
            }}
            onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'var(--c-border)'
                e.currentTarget.style.color = 'var(--c-muted)'
            }}
        >
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
            {isDark ? '淺色模式' : '深色模式'}
        </button>
    )
}