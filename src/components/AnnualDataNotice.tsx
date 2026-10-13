import { getAnnualDataWarnings, type AnnualDateRange } from '../lib/annualDataCoverage'

export default function AnnualDataNotice(props: { fomcRange?: AnnualDateRange; settlementRange?: AnnualDateRange; className?: string }) {
    const warnings = getAnnualDataWarnings(props)
    if (!warnings.length) return null
    return <div role="status" className={props.className} style={{ fontSize: '13px', lineHeight: 1.5, padding: '8px 10px', marginBottom: '8px',
        color: 'var(--c-warning)', border: '1px solid color-mix(in srgb, var(--c-warning) 40%, transparent)',
        backgroundColor: 'color-mix(in srgb, var(--c-warning) 8%, transparent)', borderRadius: '8px' }}>
        {warnings.map(message => <div key={message}>{message}</div>)}
    </div>
}
