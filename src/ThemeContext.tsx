import { createContext, useContext, useEffect, useState } from 'react'
import { applyTheme, type ThemeMode } from './theme'

interface ThemeContextValue {
    mode: ThemeMode
    toggle: () => void
    setMode: (m: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue>({
    mode: 'dark',
    toggle: () => { },
    setMode: () => { },
})

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

    // 初始化時立即套用，避免 FOUC（Flash of Unstyled Content）
    useEffect(() => {
        applyTheme(mode)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const setMode = (m: ThemeMode) => setModeState(m)
    const toggle = () => setModeState(prev => (prev === 'dark' ? 'light' : 'dark'))

    return (
        <ThemeContext.Provider value={{ mode, toggle, setMode }}>
            {children}
        </ThemeContext.Provider>
    )
}

export function useTheme() {
    return useContext(ThemeContext)
}