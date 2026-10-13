import { ThemeContext } from './lib/themeContext'
import { useEffect, useState } from 'react'
import { applyTheme, type ThemeMode } from './theme'

const STORAGE_KEY = 'symbiosis-theme'

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const [mode, setModeState] = useState<ThemeMode>(() => {
        // 預設 dark，除非使用者曾手動切換
        return (localStorage.getItem(STORAGE_KEY) as ThemeMode) ?? 'dark'
    })

    useEffect(() => {
        applyTheme(mode)
        localStorage.setItem(STORAGE_KEY, mode)
    }, [mode])


    const setMode = (m: ThemeMode) => setModeState(m)
    const toggle = () => setModeState(prev => (prev === 'dark' ? 'light' : 'dark'))

    return (
        <ThemeContext.Provider value={{ mode, toggle, setMode }}>
            {children}
        </ThemeContext.Provider>
    )
}
