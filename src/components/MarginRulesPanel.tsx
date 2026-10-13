import { useEffect, useState } from 'react'
import { ChevronDown, Save, Settings2, Trash2 } from 'lucide-react'
import { saveMarginRules, validateMarginRules, type MarginRules } from '../lib/marginSettings'

interface Props {
  rules: MarginRules
  onSaved: (rules: MarginRules) => void
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--c-bg)', border: '1px solid var(--c-border)',
  borderRadius: '8px', padding: '9px 10px', color: 'var(--c-text)', fontSize: '13px', outline: 'none', colorScheme: 'dark',
}

export default function MarginRulesPanel({ rules, onSaved }: Props) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(rules)
  const [stockCode, setStockCode] = useState('')
  const [stockRate, setStockRate] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => setDraft(rules), [rules])

  const addStockRate = () => {
    const code = stockCode.trim().toUpperCase()
    const pct = Number(stockRate)
    if (!code || !Number.isFinite(pct) || pct <= 0 || pct > 100) {
      setMessage('請輸入股票代號與 0～100% 的年利率。')
      return
    }
    setDraft(current => ({ ...current, stockInterestRates: { ...current.stockInterestRates, [code]: pct / 100 } }))
    setStockCode(''); setStockRate(''); setMessage('')
  }

  const save = async () => {
    const error = validateMarginRules(draft)
    if (error) { setMessage(error); return }
    setSaving(true); setMessage('')
    try {
      await saveMarginRules(draft)
      onSaved(draft)
      setMessage('已儲存，風險監控與新增交易將使用這組規則。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '儲存失敗，請稍後再試。')
    } finally { setSaving(false) }
  }

  const chips = [
    `年利率 ${(rules.defaultInterestRate * 100).toFixed(2)}%`,
    `安全 ${rules.safeRatio}%`,
    `追繳 ${rules.maintenanceRatio}%`,
    `斷頭 ${rules.liquidationRatio}%`,
  ]

  return (
    <section style={{ background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '12px', marginBottom: '16px', overflow: 'hidden' }}>
      <button onClick={() => { setOpen(value => !value); setMessage('') }} aria-expanded={open} style={{ width: '100%', border: 0, background: 'transparent', padding: '14px 16px', color: 'var(--c-text)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', textAlign: 'left' }}>
        <span style={{ width: '34px', height: '34px', borderRadius: '9px', background: 'color-mix(in srgb, var(--c-accent) 12%, transparent)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Settings2 size={17} color="var(--c-accent)" /></span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <strong style={{ display: 'block', fontSize: '14px' }}>融資規則</strong>
          <span style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', marginTop: '5px' }}>{chips.map(chip => <span key={chip} style={{ fontSize: '10px', color: 'var(--c-muted)', background: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '20px', padding: '2px 7px' }}>{chip}</span>)}</span>
        </span>
        <ChevronDown size={17} color="var(--c-muted)" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s', flexShrink: 0 }} />
      </button>

      {open && <div style={{ borderTop: '1px solid var(--c-border)', padding: '16px' }}>
        <p style={{ margin: '0 0 14px', color: 'var(--c-muted)', fontSize: '11px', lineHeight: 1.6 }}>這裡只調整估算與風險提示，不會回頭改寫既有成交紀錄。</p>
        <div className="margin-rules-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '8px' }}>
          {([
            ['預設年利率', 'defaultInterestRate', draft.defaultInterestRate * 100],
            ['安全線', 'safeRatio', draft.safeRatio],
            ['追繳線', 'maintenanceRatio', draft.maintenanceRatio],
            ['斷頭線', 'liquidationRatio', draft.liquidationRatio],
          ] as const).map(([label, key, value]) => <label key={key} style={{ color: 'var(--c-muted)', fontSize: '11px' }}>{label}（%）<input type="number" min="0" step="0.01" value={Number(value.toFixed(4))} onChange={event => setDraft(current => ({ ...current, [key]: key === 'defaultInterestRate' ? Number(event.target.value) / 100 : Number(event.target.value) }))} style={{ ...inputStyle, marginTop: '4px' }} /></label>)}
        </div>

        <div style={{ marginTop: '14px', color: 'var(--c-muted)', fontSize: '11px' }}>個股利率覆寫</div>
        {Object.entries(draft.stockInterestRates).map(([code, rate]) => <div key={code} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0', borderBottom: '1px solid var(--c-border)', fontSize: '12px' }}><strong style={{ flex: 1 }}>{code}</strong><span style={{ color: 'var(--c-muted)' }}>{(rate * 100).toFixed(4)}%</span><button aria-label={`刪除 ${code} 個股利率`} onClick={() => setDraft(current => { const next = { ...current.stockInterestRates }; delete next[code]; return { ...current, stockInterestRates: next } })} style={{ border: 0, background: 'transparent', color: 'var(--c-danger)', cursor: 'pointer', padding: '3px' }}><Trash2 size={14} /></button></div>)}
        <div className="margin-stock-rate-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '7px', marginTop: '9px' }}>
          <input value={stockCode} onChange={event => setStockCode(event.target.value)} placeholder="股票代號" style={inputStyle} />
          <input type="number" min="0" step="0.01" value={stockRate} onChange={event => setStockRate(event.target.value)} placeholder="個股年利率 %" style={inputStyle} />
          <button onClick={addStockRate} style={{ border: '1px solid var(--c-border)', background: 'var(--c-bg)', color: 'var(--c-text)', borderRadius: '8px', padding: '8px 13px', cursor: 'pointer' }}>新增</button>
        </div>
        {message && <div style={{ marginTop: '9px', fontSize: '11px', color: message.startsWith('已儲存') ? 'var(--c-positive)' : 'var(--c-warning)' }}>{message}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}><button onClick={() => void save()} disabled={saving} style={{ border: 0, background: 'var(--c-button-accent)', color: 'var(--c-on-accent)', borderRadius: '8px', padding: '9px 15px', cursor: saving ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px', opacity: saving ? 0.65 : 1 }}><Save size={14} />{saving ? '儲存中…' : '儲存規則'}</button></div>
      </div>}
      <style>{`@media (max-width: 700px) { .margin-rules-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; } } @media (max-width: 430px) { .margin-stock-rate-row { grid-template-columns: 1fr 1fr !important; } .margin-stock-rate-row button { grid-column: 1 / -1; } }`}</style>
    </section>
  )
}
