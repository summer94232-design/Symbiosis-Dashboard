import type { HoldingFundingType } from '../lib/portfolioSnapshot'

export default function HoldingFundingBadge({ type }: { type: HoldingFundingType }) {
    if (type === 'cash') return null
    const color = 'var(--c-warning)'
    return <span style={{ display: 'inline-flex', alignItems: 'center', alignSelf: 'center', verticalAlign: 'middle', width: 'fit-content', flexShrink: 0, marginLeft: '6px',
        fontSize: '10px', lineHeight: 1.5, color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
        padding: '1px 5px', borderRadius: '4px', fontWeight: 600, fontStyle: 'normal' }}>
        {type === 'margin' ? '融資' : '配股待核對'}
    </span>
}
