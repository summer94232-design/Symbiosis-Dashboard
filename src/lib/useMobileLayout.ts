import { useSyncExternalStore } from 'react'

// Keep in sync with the mobile media queries in index.css and page styles.
export const MOBILE_LAYOUT_QUERY = '(max-width: 767px), (max-width: 950px) and (pointer: coarse) and (orientation: landscape)'

const getSnapshot = () => window.matchMedia(MOBILE_LAYOUT_QUERY).matches
const subscribe = (notify: () => void) => {
    const media = window.matchMedia(MOBILE_LAYOUT_QUERY)
    media.addEventListener('change', notify)
    return () => media.removeEventListener('change', notify)
}

export function useMobileLayout() {
    return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
