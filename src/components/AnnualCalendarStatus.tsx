import { useSyncExternalStore } from 'react'
import { getAnnualCalendarLastSuccessAt, subscribeAnnualCalendarStatus } from '../lib/annualCalendars'

const formatter = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

export default function AnnualCalendarStatus() {
    const lastSuccessAt = useSyncExternalStore(subscribeAnnualCalendarStatus, getAnnualCalendarLastSuccessAt, getAnnualCalendarLastSuccessAt)
    return (
        <p style={{ margin: '10px 0 0', fontSize: '12px', lineHeight: 1.5, color: 'var(--c-muted)' }}>
            {lastSuccessAt ? <>年度資料最後成功更新：<time dateTime={lastSuccessAt}>{formatter.format(new Date(lastSuccessAt))}</time>（台灣時間）</> : '年度資料最後成功更新：尚無時間紀錄'}
        </p>
    )
}
