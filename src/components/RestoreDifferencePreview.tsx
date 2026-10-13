import type { RestorePreview } from '../lib/backup'

export default function RestoreDifferencePreview({ preview }: { preview: RestorePreview }) {
    const totals = preview.collections.reduce((sum, row) => ({
        added: sum.added + row.added, overwritten: sum.overwritten + row.overwritten,
        unchanged: sum.unchanged + row.unchanged, skipped: sum.skipped + row.skipped, repeated: sum.repeated + row.repeated,
    }), { added: 0, overwritten: 0, unchanged: 0, skipped: 0, repeated: 0 })
    const money = (amount: number | null) => amount === null ? '無法計算' : `${amount.toLocaleString('zh-TW', { maximumFractionDigits: 2 })} 元`
    const cell = { padding: '5px 3px', borderBottom: '1px solid var(--c-border)' }
    return <section aria-label="還原差異預覽" style={{ fontSize: 13, lineHeight: 1.5 }}>
        <p style={{ margin: '6px 0', fontWeight: 600 }}>新增 {totals.added} · 覆蓋 {totals.overwritten} · 相同 {totals.unchanged}</p>
        <div style={{ maxHeight: 260, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                <caption style={{ textAlign: 'left', color: 'var(--c-muted)', fontSize: 12 }}>雲端資料比對（筆）</caption>
                <thead><tr>
                    <th style={{ ...cell, textAlign: 'left' }}>資料</th>
                    {['新增', '覆蓋', '相同', '保留'].map(label => <th key={label} style={{ ...cell, whiteSpace: 'nowrap' }}>{label}</th>)}
                </tr></thead>
                <tbody>{preview.collections.map(row => <tr key={row.key}>
                    <th scope="row" style={{ ...cell, textAlign: 'left', fontWeight: 400 }}>{row.label}</th>
                    {[row.added, row.overwritten, row.unchanged, row.retained].map((value, index) => <td key={index} style={cell}>{value}</td>)}
                </tr>)}</tbody>
            </table>
        </div>
        {(totals.skipped > 0 || totals.repeated > 0) && <p style={{ margin: '6px 0', color: 'var(--c-warning)' }}>
            {totals.skipped > 0 && `另有 ${totals.skipped} 筆異常文件將略過。`}
            {totals.repeated > 0 && `另有 ${totals.repeated} 筆重複 ID，以檔案最後一筆為準。`}
        </p>}
        {preview.amounts.length > 0 && <>
            <p style={{ margin: '10px 0 4px', fontWeight: 600 }}>主要帳務金額：雲端 → 還原後</p>
            {preview.amounts.map(row => <div key={row.label} style={{ padding: '5px 0', borderBottom: '1px solid var(--c-border)' }}>
                <span>{row.label}</span>
                <div style={{ display: 'flex', gap: '4px 8px', flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums' }}>
                    <span>{money(row.before)}{row.beforeDate && `（${row.beforeDate}）`}</span>
                    <span>→ {money(row.after)}{row.afterDate && `（${row.afterDate}）`}</span>
                    <span style={{ color: 'var(--c-warning)' }}>
                        差額 {row.before === null || row.after === null ? '無法計算' : `${row.after - row.before > 0 ? '+' : ''}${money(row.after - row.before)}`}
                    </span>
                </div>
            </div>)}
            <p style={{ margin: '6px 0', fontSize: 12, color: 'var(--c-muted)' }}>紀錄合計包含備份外保留的資料；不代表目前餘額、損益或實際入帳股利。快照僅比較最新一筆。</p>
        </>}
        <p style={{ margin: '6px 0', fontSize: 12, color: 'var(--c-muted)' }}>覆蓋會取代同 ID 的完整內容；相同文件仍會寫入，備份外資料保留。確認時會重新比對雲端資料。</p>
    </section>
}
