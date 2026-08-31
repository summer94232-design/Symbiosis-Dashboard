import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { inferTradingSession, type TradeRecord } from '../lib/calc'
import './tradeForm.css'

export default function TradeDayTradeExceptions({ form, onChange, onReview }: {
    form: TradeRecord
    onChange: (key: 'dayTradeExcluded' | 'dayTradePending', value: boolean) => void
    onReview?: () => void
}) {
    const [open, setOpen] = useState(false)
    const id = useId()
    const root = useRef<HTMLDivElement>(null)
    const trigger = useRef<HTMLButtonElement>(null)
    useEffect(() => {
        if (!open) return
        const dismiss = (event: PointerEvent) => {
            if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
        }
        document.addEventListener('pointerdown', dismiss)
        return () => document.removeEventListener('pointerdown', dismiss)
    }, [open])
    if (form.isMargin) return null
    return <div className="trade-exceptions" ref={root} onKeyDown={event => {
        if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); event.stopPropagation() }
    }} onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}>
        <button ref={trigger} type="button" className="trade-exceptions__trigger" aria-expanded={open}
            aria-controls={id} onClick={() => setOpen(value => !value)}>
            例外處理<ChevronDown size={12} aria-hidden="true" />
        </button>
        <div id={id} className="trade-exceptions__panel" hidden={!open}>
            <label><input type="checkbox" checked={form.dayTradeExcluded || false} onChange={e => onChange('dayTradeExcluded', e.target.checked)} />
                <span>券商未認列當沖／不沖銷，使用一般庫存成本</span></label>
            {form.type === 'sell' && !form.dayTradeExcluded && inferTradingSession(form) === 'regular' && <label>
                <input type="checkbox" checked={form.dayTradePending || false} onChange={e => onChange('dayTradePending', e.target.checked)} />
                <span>尚未登錄回補買入，先暫存（報表暫不完整）</span></label>}
            <p>一般交易會自動判定，不需設定。費稅維持原成交金額，僅例外情況需修正。</p>
            {onReview && <button type="button" className="trade-exceptions__trigger" style={{ paddingLeft: 0 }}
                onClick={() => { setOpen(false); onReview() }}>查看／修正當沖明細</button>}
        </div>
    </div>
}
