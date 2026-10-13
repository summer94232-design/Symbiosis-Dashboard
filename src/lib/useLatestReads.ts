import { useCallback, useEffect, useRef, useState } from 'react'
import { captureUserSession } from './userDB'
import { createLatestReads } from './latestReads'

export function useLatestReads() {
    const reader = useRef(createLatestReads())
    const [states, setStates] = useState<Record<string, { loading: boolean; error: string }>>({})
    const status = useCallback((key: string, loading: boolean, error: string) => {
        setStates(previous => ({ ...previous, [key]: { loading, error } }))
    }, [])
    const run = useCallback(<T,>(key: string, load: () => Promise<T>, apply: (value: T) => void) => {
        const session = captureUserSession()
        return reader.current.run(key, load, apply, status, session.assertActive)
    }, [status])
    useEffect(() => { const current = reader.current; return () => current.cancel() }, [])
    return { run, states }
}
