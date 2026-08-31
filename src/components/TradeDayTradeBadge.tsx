import { getTradeDayTradeBadge } from '../lib/tradeList'

export default function TradeDayTradeBadge({ shares, matchedShares }: { shares: number; matchedShares: number }) {
    const badge = getTradeDayTradeBadge(shares, matchedShares)
    if (!badge) return null
    return <span title={badge.description} aria-label={`${badge.label}：${badge.description}`} style={{
        backgroundColor: 'color-mix(in srgb, var(--c-accent) 14%, transparent)', color: 'var(--c-accent)',
        padding: '2px 6px', borderRadius: '20px', fontSize: '10px', fontWeight: 600, flexShrink: 0,
        whiteSpace: 'nowrap',
    }}>{badge.label}</span>
}
