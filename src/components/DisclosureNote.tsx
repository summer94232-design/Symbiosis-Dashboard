import type { CSSProperties, ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/** Native disclosure: short copy stays visible; touch and keyboard reveal the details. */
export default function DisclosureNote({ summary, children, style, className = '' }: {
    summary: ReactNode
    children: ReactNode
    style?: CSSProperties
    className?: string
}) {
    return <details className={`disclosure-note ${className}`.trim()} style={{ margin: '4px 0 8px', fontSize: '12px', lineHeight: 1.6, color: 'var(--c-muted)', ...style }}>
        <summary className="disclosure-note__summary">
            <ChevronRight className="disclosure-note__chevron" size={14} aria-hidden="true" />
            <span className="disclosure-note__label">{summary}</span>
        </summary>
        <div className="disclosure-note__body">{children}</div>
    </details>
}
