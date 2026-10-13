import { useId, useRef, useState } from 'react'

/** Present existing validator messages beside their fields; no second validation engine. */
export function validationField(message: string): string {
    if (/現金入帳|已確認現金/.test(message)) return 'cashPaymentDate'
    if (/股票配發|已確認股票/.test(message)) return 'stockDistributionDate'
    if (/股票代號|來源公告/.test(message)) return 'code'
    if (/股票名稱/.test(message)) return 'name'
    if (/現金股利/.test(message)) return 'cashDividend'
    if (/股票股利/.test(message)) return 'stockDividend'
    if (/股利狀態/.test(message)) return 'status'
    if (/日期/.test(message)) return 'date'
    if (/類型/.test(message)) return 'type'
    if (/金額/.test(message)) return 'amount'
    return ''
}

export function useFieldFeedback() {
    const prefix = useId()
    const root = useRef<HTMLDivElement>(null)
    const [errors, setErrors] = useState<Record<string, string>>({})
    const clear = () => setErrors({})
    const report = (messages: string[]) => {
        const next: Record<string, string> = {}
        for (const message of messages) {
            const field = validationField(message)
            if (field) next[field] = next[field] ? `${next[field]}；${message}` : message
        }
        setErrors(next)
        // Only invalid submission schedules a frame; no observer or polling.
        requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not(:disabled)')?.focus())
    }
    return {
        root, clear, report,
        bind: (field: string) => ({ id: `${prefix}-${field}`, 'aria-invalid': !!errors[field], 'aria-describedby': errors[field] ? `${prefix}-${field}-error` : undefined }),
        label: (field: string) => `${prefix}-${field}`,
        message: (field: string) => errors[field] ? <p className="ui-field-error" id={`${prefix}-${field}-error`}>{errors[field]}</p> : null,
    }
}
