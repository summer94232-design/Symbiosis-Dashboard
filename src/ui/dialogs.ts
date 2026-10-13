export interface DialogOptions {
    title?: string
    confirmLabel?: string
    tone?: 'danger' | 'warning' | 'neutral'
}
export interface DialogRequest extends DialogOptions {
    message: string
    notification: boolean
}

/** One active decision: repeated clicks cannot queue additional writes. */
export function createDialogController() {
    let current: DialogRequest | null = null
    let settle: ((answer: boolean) => void) | null = null
    let hosts = 0
    let acquireGuard: (() => () => void) | undefined
    let activeGuard: (() => void) | undefined
    const listeners = new Set<() => void>()
    const publish = () => listeners.forEach(listener => listener())
    const resolve = (answer: boolean) => {
        if (answer) {
            try { activeGuard?.() } catch { answer = false }
        }
        const done = settle
        settle = null
        activeGuard = undefined
        current = null
        publish()
        done?.(answer)
    }
    return {
        getSnapshot: () => current,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
        attach: (guard?: () => () => void) => {
            hosts++
            acquireGuard = guard
            return () => { if (--hosts === 0) { resolve(false); acquireGuard = undefined } }
        },
        resolve,
        request(message: string, options: DialogOptions = {}, notification = false): Promise<boolean> {
            if (!hosts || current) return Promise.resolve(false)
            try { activeGuard = acquireGuard?.() } catch { return Promise.resolve(false) }
            current = { message, ...options, notification }
            return new Promise(resolveAnswer => { settle = resolveAnswer; publish() })
        },
    }
}

export const dialogController = createDialogController()
export const confirmAction = (message: string, options?: DialogOptions) => dialogController.request(message, options)
export const alertAction = (message: string) => dialogController.request(message, { title: '操作提示', confirmLabel: '知道了', tone: 'neutral' }, true)
