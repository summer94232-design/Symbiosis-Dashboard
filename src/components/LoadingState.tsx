export default function LoadingState({ label = '資料載入中…' }: { label?: string }) {
    return <div className="ui-loading" role="status">
        {label}<div className="ui-loading-bars" aria-hidden="true"><span /><span /><span /></div>
    </div>
}
