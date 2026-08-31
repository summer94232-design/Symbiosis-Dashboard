import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { isETF, type TradeRecord } from '../lib/calc'
import { inp, lbl } from '../ui/styles'
import './tradeSettlementDetails.css'

type SettlementForm = Pick<TradeRecord, 'type' | 'code' | 'shares' | 'fee' | 'tax' | 'total' | 'isMargin'>

export default function TradeSettlementDetails({ form, onChange }: {
    form: SettlementForm
    onChange: (key: 'fee' | 'tax', value: number) => void
}) {
    const id = useId()
    const [expanded, setExpanded] = useState(false)
    const feeNote = form.shares > 0 && form.shares < 1000 ? '零股6折，最低1元' : '6折自動計算'
    const taxNote = form.type === 'sell' ? (isETF(form.code) ? 'ETF千分之一' : '千分之三') : '買入免稅'
    const amountNote = form.isMargin ? (form.type === 'buy' ? '（自備款）' : '（已扣償還）') : ''
    const amountColor = !form.total ? 'var(--c-text)' : form.type === 'buy' ? 'var(--c-danger)' : 'var(--c-positive)'

    return <div className="span2 trade-settlement">
        <div id={`${id}-label`} style={lbl}>收付金額 {amountNote}</div>
        <div>
            <button type="button" className="trade-settlement__summary" style={inp} aria-label="收付金額與費稅明細"
                aria-expanded={expanded} aria-controls={`${id}-details`} onClick={() => setExpanded(value => !value)}
                onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        if (!event.repeat) setExpanded(value => !value)
                    }
                }}>
                <span className="trade-settlement__amount" style={{ color: amountColor }}>
                    ${Number(form.total || 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 })}
                </span>
                <span className="trade-settlement__fees">
                    手續費 {Math.round(form.fee || 0).toLocaleString()}<span aria-hidden="true"> · </span>交易稅 {Math.round(form.tax || 0).toLocaleString()}
                </span>
                <span className="trade-settlement__toggle">費稅明細<ChevronDown size={14} aria-hidden="true" /></span>
            </button>
            <div id={`${id}-details`} className="trade-settlement__fields" hidden={!expanded}>
                <div>
                    <label htmlFor={`${id}-fee`} style={lbl}>手續費 <span className="trade-settlement__note">（{feeNote}）</span></label>
                    <input id={`${id}-fee`} type="number" min={0} step={1} style={inp} value={form.fee || ''} onChange={event => onChange('fee', parseFloat(event.target.value) || 0)} />
                </div>
                <div>
                    <label htmlFor={`${id}-tax`} style={lbl}>交易稅 <span className="trade-settlement__note">（{taxNote}）</span></label>
                    <input id={`${id}-tax`} type="number" min={0} step={1} style={inp} value={form.tax || ''} onChange={event => onChange('tax', parseFloat(event.target.value) || 0)} />
                </div>
                <p className="trade-settlement__help">費稅由系統估算，可依券商實際金額調整；收付金額會同步更新。</p>
            </div>
        </div>
    </div>
}
