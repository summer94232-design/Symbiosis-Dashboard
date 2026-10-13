import { createContext, useContext } from 'react'
import type { ThemeMode } from '../theme'

interface ThemeContextValue {
    mode: ThemeMode
    toggle: () => void
    setMode: (m: ThemeMode) => void
}

export const ThemeContext = createContext<ThemeContextValue>({
    mode: 'dark',
    toggle: () => { },
    setMode: () => { },
})

export function useTheme() {
    return useContext(ThemeContext)
}