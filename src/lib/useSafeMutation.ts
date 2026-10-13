import { useRef, useState } from 'react'
import { captureUserSession } from './userDB'

export function useSafeMutation() {
    const lock = useRef(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const run = async (work: (session: ReturnType<typeof captureUserSession>) => Promise<void>) => {
        if (lock.current) return
        lock.current = true
        setBusy(true)
        setError('')
        try {
            const session = captureUserSession()
            await work(session)
            session.assertActive()
        } catch (error) {
            setError(error instanceof Error ? error.message : '操作未完成，請確認資料後重試。')
        } finally {
            lock.current = false
            setBusy(false)
        }
    }
    return { busy, error, run }
}
