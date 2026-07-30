import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'

export type ActionNoticeState = {
    type: 'success' | 'error' | 'info'
    message: string
}

interface ActionNoticeProps extends ActionNoticeState {
    onClose: () => void
}

export default function ActionNotice({ type, message, onClose }: ActionNoticeProps) {
    const Icon = type === 'success' ? CheckCircle2 : type === 'error' ? AlertCircle : Info

    return (
        <div
            className={`action-notice action-notice-${type}`}
            role={type === 'error' ? 'alert' : 'status'}
            aria-live={type === 'error' ? 'assertive' : 'polite'}
        >
            <Icon size={18} aria-hidden="true" />
            <span>{message}</span>
            <button type="button" onClick={onClose} aria-label="關閉提示">
                <X size={16} aria-hidden="true" />
            </button>
        </div>
    )
}
