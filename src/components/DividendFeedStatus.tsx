import { useSyncExternalStore } from 'react'
import { getDividendFeedState, subscribeDividendFeed } from '../lib/dividendAnnouncements'
import DisclosureNote from './DisclosureNote'

export default function DividendFeedStatus({ showLastUpdate = false }: { showLastUpdate?: boolean }) {
    const state = useSyncExternalStore(subscribeDividendFeed, getDividendFeedState)
    const times = Object.entries(state.catalog?.marketCheckedAt || {}).map(([market, time]) => `${market === 'TWSE' ? '上市' : '上櫃'} ${new Date(time!).toLocaleString('zh-TW')}`)
    const lastUpdate = times.length ? `公告更新：${times.join(' · ')}；預告尚未入帳。` : '尚未取得官方公告。'
    // Background failures stay available on the dividend page without repeating an alert on the dashboard.
    if (state.error && !state.loading) {
        if (!showLastUpdate) return null
        return <>
            <p style={{ margin: '6px 0', fontSize: '12px', color: 'var(--c-muted)' }}>{lastUpdate}</p>
            <DisclosureNote summary="公告更新狀態">{state.error}</DisclosureNote>
        </>
    }
    const message = state.loading ? '除權息預告更新中…' : (showLastUpdate
        ? times.length ? lastUpdate : '點選更新現價會取得除權息公告；預告尚未入帳。' : '')
    if (!message) return null
    return <p role="status" style={{ margin: '6px 0', fontSize: '12px', color: 'var(--c-muted)' }}>{message}</p>
}
