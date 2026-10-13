import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { MessageCircle } from 'lucide-react'
const Panel = lazy(() => import('./AiAssistantPanel'))
export default function AiAssistantHost() {
    const [open, setOpen] = useState(false)
    const hostRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        const handler = () => setOpen(true)
        window.addEventListener('symbiosis:open-ai', handler)
        return () => window.removeEventListener('symbiosis:open-ai', handler)
    }, [])
    useEffect(() => {
        if (!open) return
        const dismissOutside = (event: PointerEvent) => {
            if (event.button !== 0 || !(event.target instanceof Node)) return
            if (hostRef.current?.contains(event.target) || document.querySelector('dialog[open]')) return
            setOpen(false)
        }
        document.addEventListener('pointerdown', dismissOutside, true)
        return () => document.removeEventListener('pointerdown', dismissOutside, true)
    }, [open])
    return <div ref={hostRef}><button className="ai-launcher" onClick={() => setOpen(v => !v)} aria-label={open ? '縮小 AI' : '開啟 AI'} aria-expanded={open}><MessageCircle size={20} /><span>AI</span></button>
        {open && <Suspense fallback={<div className="ai-loading" role="status">AI 助理載入中…</div>}><Panel onClose={() => setOpen(false)} /></Suspense>}
    </div>
}
