import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode; scope?: 'app' | 'page' }

/** Render/lifecycle and lazy-page failures stay inside their nearest boundary. */
export default class AppErrorBoundary extends Component<Props, { failed: boolean }> {
    state = { failed: false }

    static getDerivedStateFromError() { return { failed: true } }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error('[AppErrorBoundary] 畫面載入失敗', error, info.componentStack)
    }

    render() {
        if (!this.state.failed) return this.props.children
        const fullPage = this.props.scope !== 'page'
        return <div style={{ minHeight: fullPage ? '100dvh' : '240px', padding: '16px', display: 'flex',
            alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--c-bg, #14182a)', color: 'var(--c-text, #dde2f0)' }}>
            <section role="alert" aria-labelledby="page-recovery-title" style={{ width: '100%', maxWidth: '440px',
                padding: '16px', border: '1px solid var(--c-border, #2a3050)', borderRadius: '12px', backgroundColor: 'var(--c-card, #1c2235)' }}>
                <h1 id="page-recovery-title" style={{ fontSize: '18px', margin: '0 0 8px' }}>{fullPage ? '系統暫時無法顯示' : '這個頁面暫時無法顯示'}</h1>
                <p style={{ fontSize: '14px', lineHeight: 1.6, margin: '0 0 12px', color: 'var(--c-muted, #7a88aa)' }}>
                    請重新載入後再試。未儲存的輸入可能需要重新填寫。{!fullPage && '也可以使用側欄切換其他功能。'}
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    <button type="button" onClick={() => window.location.reload()} style={{ minHeight: '44px', padding: '8px 14px',
                        borderRadius: '8px', border: 'none', backgroundColor: 'var(--c-accent, #8b9ef5)', color: '#14182a', cursor: 'pointer', fontSize: '14px' }}>重新載入</button>
                    <a href="/invest" style={{ minHeight: '44px', boxSizing: 'border-box', padding: '8px 14px', display: 'inline-flex', alignItems: 'center',
                        borderRadius: '8px', border: '1px solid var(--c-border, #2a3050)', color: 'inherit', textDecoration: 'none', fontSize: '14px' }}>返回儀表板</a>
                </div>
            </section>
        </div>
    }
}
