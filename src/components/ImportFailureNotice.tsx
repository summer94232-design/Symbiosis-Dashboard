export default function ImportFailureNotice({ error, success }: { error?: string; success: number }) {
    if (!error) return null
    return <div role="alert" style={{ marginTop: 8, padding: '8px 10px', fontSize: 13, lineHeight: 1.5, color: 'var(--c-danger)', border: '1px solid var(--c-border)', borderRadius: 8, overflowWrap: 'anywhere' }}>
        匯入已中止：{error}
        <div style={{ marginTop: 4, color: 'var(--c-muted)' }}>已確認成功 {success} 筆，已成功資料仍保留。請核對目前帳號與紀錄，再處理未完成資料。</div>
    </div>
}
