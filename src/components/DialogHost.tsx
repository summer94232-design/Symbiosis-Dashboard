import { useEffect, useRef, useSyncExternalStore } from 'react'
import { dialogController } from '../ui/dialogs'
import { captureUserSession } from '../lib/userDB'

export default function DialogHost({ scope = '' }: { scope?: string }) {
    const request = useSyncExternalStore(dialogController.subscribe, dialogController.getSnapshot)
    const ref = useRef<HTMLDialogElement>(null)
    useEffect(() => dialogController.attach(() => captureUserSession().assertActive), [])
    useEffect(() => () => dialogController.resolve(false), [scope])
    useEffect(() => {
        const dialog = ref.current
        if (request && dialog && !dialog.open) dialog.showModal()
        if (!request && dialog?.open) dialog.close()
    }, [request])
    const tone = request?.tone || (/刪除|清空|移除/.test(request?.message || '') ? 'danger' : 'warning')
    return <dialog ref={ref} className="ui-dialog" aria-labelledby="ui-dialog-title" aria-describedby="ui-dialog-message"
        onCancel={event => { event.preventDefault(); dialogController.resolve(false) }}>
        {request && <>
            <h2 id="ui-dialog-title">{request.title || (tone === 'danger' ? '確認刪除' : '確認操作')}</h2>
            <p id="ui-dialog-message">{request.message}</p>
            <div className="ui-dialog-actions">
                {!request.notification && <button autoFocus className="ui-button ui-button-secondary" onClick={() => dialogController.resolve(false)}>取消</button>}
                <button autoFocus={request.notification} className={`ui-button ${tone === 'danger' ? 'ui-button-danger' : 'ui-button-primary'}`} onClick={() => dialogController.resolve(true)}>
                    {request.confirmLabel || (tone === 'danger' ? '確認刪除' : '確認繼續')}
                </button>
            </div>
        </>}
    </dialog>
}
