import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

export default function InfoHint({ text, width = 240 }: { text: string; width?: number }) {
    const [position, setPosition] = useState<{ left: number; top: number; below: boolean; maxHeight: number } | null>(null)
    const button = useRef<HTMLButtonElement>(null)
    const popup = useRef<HTMLSpanElement>(null)
    const pinned = useRef(false)
    const id = useId()
    const close = () => { pinned.current = false; setPosition(null) }
    const show = () => {
        const rect = button.current?.getBoundingClientRect()
        if (!rect) return
        const actualWidth = Math.min(width, window.innerWidth - 16)
        const above = rect.top - 16
        const belowSpace = window.innerHeight - rect.bottom - 16
        const below = above < 160 && belowSpace > above
        setPosition({ left: Math.max(8, Math.min(rect.left + rect.width / 2 - actualWidth / 2, window.innerWidth - actualWidth - 8)),
            top: below ? rect.bottom + 8 : rect.top - 8, below, maxHeight: Math.min(240, Math.max(40, below ? belowSpace : above)) })
    }
    const open = !!position
    useEffect(() => {
        if (!open) return
        const dismiss = (event: PointerEvent) => {
            if (!button.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) close()
        }
        const onScroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) close() }
        const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
        // Only listen while shown. Scrolling closes without per-frame layout work.
        window.addEventListener('pointerdown', dismiss)
        window.addEventListener('keydown', escape)
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', close)
        return () => {
            window.removeEventListener('pointerdown', dismiss)
            window.removeEventListener('keydown', escape)
            window.removeEventListener('scroll', onScroll, true)
            window.removeEventListener('resize', close)
        }
    }, [open])
    return <>
        <button ref={button} type="button" className="info-hint" aria-label="口徑說明" aria-describedby={open ? id : undefined}
            onMouseEnter={show} onMouseLeave={() => { if (!pinned.current) setPosition(null) }} onFocus={show}
            onBlur={event => { if (!popup.current?.contains(event.relatedTarget as Node)) close() }}
            onClick={event => { event.stopPropagation(); if (pinned.current) close(); else { pinned.current = true; show() } }}>
            <Info aria-hidden="true" size="1em" />
        </button>
        {position && createPortal(<span ref={popup} tabIndex={0} id={id} role="tooltip" className="info-hint-popup" onBlur={close}
            style={{ width, left: position.left, top: position.top, maxHeight: position.maxHeight, transform: position.below ? undefined : 'translateY(-100%)' }}>{text}</span>, document.body)}
    </>
}
