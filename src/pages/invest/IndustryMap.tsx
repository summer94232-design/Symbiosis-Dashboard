import { buttonFill } from '../../ui/styles'
import { confirmAction } from '../../ui/dialogs'
import { saveIndustryEntry } from '../../lib/batchOperations'
import DisclosureNote from '../../components/DisclosureNote'
import { useSafeMutation } from '../../lib/useSafeMutation'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { getDocs, deleteDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { captureUserSession } from '../../lib/userDB'
import { Plus, X, Search, Pencil, Trash2, ChevronDown, ChevronRight, Map, Tag, Loader, Landmark } from 'lucide-react'
import { ChainView } from './IndustryChainView'
import { usePrices } from '../../PriceContext'
import { useMarketCap } from '../../lib/marketCapContext'
import { calcMarketCap, formatMarketCap } from '../../lib/marketCap'
import { useInvestSync } from '../../InvestSyncContext'

// ── 型別 ──────────────────────────────────────────────────────────
type Market = 'TW' | 'US' | 'JP'

const MARKETS: { key: Market; label: string }[] = [
    { key: 'TW', label: '台股' },
    { key: 'US', label: '美股' },
    { key: 'JP', label: '日股' },
]
function marketLabel(m?: Market): string {
    const found = MARKETS.find(x => x.key === m)
    return found ? found.label : '.TW'
}

interface StockEntry {
    code: string
    name: string
    market?: Market
    themes: string[]
    note?: string
}

// ── 股票名稱查詢（✅ 1-2：改走 lib/stockDict 共用模組與快取）──
import { lookupStockName } from '../../lib/stockDict'

// ── 題材顏色 ──────────────────────────────────────────────────────
const THEME_COLORS = [
    '#5b8af5', '#e06060', '#4aaa80', '#c49030', '#9b6cf0',
    '#e07830', '#40b8c0', '#c060b0', '#70a840', '#6080d0',
    '#d05050', '#50b070', '#b08030', '#8060e0', '#50a8c0',
]
function themeColor(theme: string): string {
    let hash = 0
    for (const c of theme) hash = (hash * 31 + c.charCodeAt(0)) & 0xffff
    return THEME_COLORS[hash % THEME_COLORS.length]
}

// ── Style helpers ─────────────────────────────────────────────────
const card: React.CSSProperties = {
    backgroundColor: 'var(--c-card)',
    border: '1px solid var(--c-border)',
    borderRadius: '12px',
    padding: 'var(--ui-card-padding, 20px)',
}
const inp: React.CSSProperties = {
    backgroundColor: 'var(--c-bg)',
    border: '1px solid var(--c-border)',
    borderRadius: '8px',
    padding: '8px 12px',
    color: 'var(--c-text)',
    fontSize: '14px',
    width: '100%',
    outline: 'none',
    boxSizing: 'border-box',
}
const btn = (color: string): React.CSSProperties => ({
    backgroundColor: buttonFill(color),
    border: 'none',
    borderRadius: '8px',
    padding: '8px 16px',
    color: /border|transparent|sidebar|card/.test(color) ? 'var(--c-text)' : /^var\(--c-(accent|positive|danger|warning|purple)\)$/.test(color) ? 'var(--c-on-accent)' : '#fff',
    fontSize: '13px',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
})

// ── 題材徽章 ──────────────────────────────────────────────────────
function ThemeBadge({ label, onRemove, onClick, size = 'md' }: {
    label: string
    onRemove?: () => void
    onClick?: () => void
    size?: 'sm' | 'md'
}) {
    const color = themeColor(label)
    return (
        <span onClick={onClick} style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            background: color + '22', border: `1px solid ${color}55`,
            color, borderRadius: '20px', fontWeight: 600, whiteSpace: 'nowrap',
            padding: size === 'sm' ? '1px 7px' : '2px 10px',
            fontSize: size === 'sm' ? '11px' : '12px',
            cursor: onClick ? 'pointer' : 'default',
        }}>
            {label}
            {onRemove && <X size={10} style={{ cursor: 'pointer' }} onClick={e => { e.stopPropagation(); onRemove() }} />}
        </span>
    )
}

// ── 股票卡片(題材視圖 & 股票視圖用)─────────────────────────────
function StockCard({ entry, marketCap, onEdit, onDelete, onThemeClick, highlighted }: {
    entry: StockEntry
    marketCap?: number | null
    onEdit: (e: StockEntry) => void
    onDelete: (code: string) => void
    onThemeClick: (t: string) => void
    highlighted?: boolean
}) {
    return (
        <div style={{ ...card, padding: '14px 16px', outline: highlighted ? '2px solid var(--c-accent)' : 'none', transition: 'outline 0.2s' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--c-muted)', background: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '6px', padding: '1px 5px', marginRight: '6px' }}>{marketLabel(entry.market)}</span>
                    <span style={{ fontWeight: 700, fontSize: '15px', color: 'var(--c-accent)' }}>{entry.code}</span>
                    <span style={{ marginLeft: '8px', fontSize: '13px', color: 'var(--c-text)' }}>{entry.name}</span>
                    {marketCap != null && (
                        <span style={{ marginLeft: '8px', fontSize: '11px', fontWeight: 600, color: 'var(--c-muted)', background: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '6px', padding: '1px 6px' }}>
                            市值 {formatMarketCap(marketCap)}
                        </span>
                    )}
                </div>
                <div style={{ display: 'flex', gap: '4px' }}>
                    <button onClick={() => onEdit(entry)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer', padding: '2px' }}><Pencil size={13} /></button>
                    <button onClick={() => onDelete(entry.code)} style={{ background: 'none', border: 'none', color: 'var(--c-danger)', cursor: 'pointer', padding: '2px' }}><Trash2 size={13} /></button>
                </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: entry.note ? '8px' : 0 }}>
                {entry.themes.map(t => <ThemeBadge key={t} label={t} onClick={() => onThemeClick(t)} />)}
                {entry.themes.length === 0 && <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>尚未設定題材</span>}
            </div>
            {entry.note && <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginTop: '4px', lineHeight: '1.5' }}>{entry.note}</div>}
        </div>
    )
}

// ── 新增/編輯表單 ─────────────────────────────────────────────────
function StockForm({ initial, allThemes, allStocks, onSave, onCancel }: {
    initial?: Partial<StockEntry>
    allThemes: string[]
    allStocks: { code: string; name: string; market?: Market }[]
    onSave: (entry: StockEntry, rels: { up: string[]; down: string[] }) => Promise<void>
    onCancel: () => void
}) {
    const [code, setCode] = useState(initial?.code || '')
    const [name, setName] = useState(initial?.name || '')
    const [market, setMarket] = useState<Market>(initial?.market || 'TW')
    const [themes, setThemes] = useState<string[]>(initial?.themes || [])
    const [note, setNote] = useState(initial?.note || '')
    const [themeInput, setThemeInput] = useState('')
    const [upCodes, setUpCodes] = useState<string[]>([])
    const [downCodes, setDownCodes] = useState<string[]>([])
    const [saving, setSaving] = useState(false)
    const [lookingUp, setLookingUp] = useState(false)
    const [nameTouched, setNameTouched] = useState(!!initial?.name)
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const isEditing = !!initial?.code

    const handleCodeChange = (val: string) => {
        const upper = val.toUpperCase()
        setCode(upper)
        if (nameTouched) return
        if (market !== 'TW') return // 美股／日股不走台股代號字典自動帶名，由使用者自行輸入
        if (debounceRef.current) clearTimeout(debounceRef.current)
        if (upper.length < 2) return
        debounceRef.current = setTimeout(async () => {
            setLookingUp(true)
            const found = await lookupStockName(upper)
            if (found) setName(found)
            setLookingUp(false)
        }, 300)
    }

    useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])

    const suggestions = allThemes.filter(t => themeInput && t.toLowerCase().includes(themeInput.toLowerCase()) && !themes.includes(t))
    const addTheme = (t: string) => { const tr = t.trim(); if (tr && !themes.includes(tr)) setThemes(p => [...p, tr]); setThemeInput('') }
    const removeTheme = (t: string) => setThemes(p => p.filter(x => x !== t))
    const canSave = code.trim().length > 0 && name.trim().length > 0

    const handleSave = async () => {
        if (!canSave) return
        if (saving) return
        setSaving(true)
        try { await onSave({ code: code.trim(), name: name.trim(), market, themes, note: note.trim() || undefined }, { up: upCodes, down: downCodes })
        } finally { setSaving(false) }
    }

    return (
        <fieldset disabled={saving} style={{ ...card, margin: '0 0 20px', minWidth: 0, pointerEvents: saving ? 'none' : undefined }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--c-accent)', marginBottom: '16px' }}>
                {isEditing ? `編輯：${initial.code}` : '新增股票'}
            </div>
            <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>市場</label>
                <div style={{ display: 'flex', gap: '6px' }}>
                    {MARKETS.map(m => (
                        <button key={m.key} type="button" onClick={() => setMarket(m.key)} style={{
                            background: market === m.key ? 'var(--c-button-accent)' : 'var(--c-card)',
                            color: market === m.key ? 'var(--c-on-accent)' : 'var(--c-text)',
                            border: '1px solid var(--c-border)', borderRadius: '8px',
                            padding: '6px 16px', fontSize: '13px', cursor: 'pointer',
                        }}>{m.label}</button>
                    ))}
                </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                <div>
                    <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>股票代號</label>
                    <input style={inp} value={code} onChange={e => handleCodeChange(e.target.value)} placeholder="代號" disabled={isEditing} autoFocus={!isEditing} />
                </div>
                <div>
                    <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>
                        名稱
                        {lookingUp && <span style={{ marginLeft: '6px', color: 'var(--c-accent)', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '3px' }}><Loader size={10} style={{ animation: 'spin 0.8s linear infinite' }} />查詢中…</span>}
                        {!lookingUp && name && !nameTouched && <span style={{ marginLeft: '6px', color: 'var(--c-positive)', fontSize: '11px' }}>✓ 自動帶入</span>}
                    </label>
                    <input style={{ ...inp, borderColor: lookingUp ? 'var(--c-accent)' : 'var(--c-border)', transition: 'border-color 0.2s' }} value={name} onChange={e => { setName(e.target.value); setNameTouched(true) }} placeholder={lookingUp ? '查詢中…' : '自動帶入'} />
                </div>
            </div>
            <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>題材 / 產業鏈</label>
                <div style={{ position: 'relative' }}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <input style={inp} value={themeInput} onChange={e => setThemeInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTheme(themeInput) } }} placeholder="輸入題材後按 Enter" />
                        <button onClick={() => addTheme(themeInput)} style={btn('var(--c-accent)')}>新增</button>
                    </div>
                    {suggestions.length > 0 && (
                        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '8px', marginTop: '4px', overflow: 'hidden' }}>
                            {suggestions.slice(0, 6).map(s => (
                                <div key={s} onClick={() => addTheme(s)} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: '13px', color: 'var(--c-text)', display: 'flex', alignItems: 'center', gap: '8px' }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--c-bg)')} onMouseLeave={e => (e.currentTarget.style.background = '')}>
                                    <ThemeBadge label={s} />
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                    {themes.map(t => <ThemeBadge key={t} label={t} onRemove={() => removeTheme(t)} />)}
                </div>
            </div>
            <div style={{ marginBottom: '12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                    <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>上游供應商（供應給此檔）</label>
                    <select value="" onChange={e => { const c = e.target.value; if (c && !upCodes.includes(c)) setUpCodes(p => [...p, c]) }} style={inp}>
                        <option value="">＋加入上游…</option>
                        {allStocks.filter(s => s.code !== code && !upCodes.includes(s.code)).map(s => (
                            <option key={s.code} value={s.code}>{s.code} {s.name}〔{marketLabel(s.market)}〕</option>
                        ))}
                    </select>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                        {upCodes.map(c => (
                            <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '20px', padding: '2px 6px 2px 10px', fontSize: '12px', color: 'var(--c-text)' }}>
                                {c}
                                <X size={11} style={{ cursor: 'pointer', color: 'var(--c-danger)' }} onClick={() => setUpCodes(p => p.filter(x => x !== c))} />
                            </span>
                        ))}
                    </div>
                </div>
                <div>
                    <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>下游客戶（此檔供應給）</label>
                    <select value="" onChange={e => { const c = e.target.value; if (c && !downCodes.includes(c)) setDownCodes(p => [...p, c]) }} style={inp}>
                        <option value="">＋加入下游…</option>
                        {allStocks.filter(s => s.code !== code && !downCodes.includes(s.code)).map(s => (
                            <option key={s.code} value={s.code}>{s.code} {s.name}〔{marketLabel(s.market)}〕</option>
                        ))}
                    </select>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                        {downCodes.map(c => (
                            <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '20px', padding: '2px 6px 2px 10px', fontSize: '12px', color: 'var(--c-text)' }}>
                                {c}
                                <X size={11} style={{ cursor: 'pointer', color: 'var(--c-danger)' }} onClick={() => setDownCodes(p => p.filter(x => x !== c))} />
                            </span>
                        ))}
                    </div>
                </div>
            </div>
            <DisclosureNote summary="關係同步至脈絡圖。" style={{ margin: '-4px 0 12px', fontSize: '11px' }}>供應內容與刪除關係，請至「脈絡圖」管理。</DisclosureNote>
            <div style={{ marginBottom: '16px' }}>
                <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>備註</label>
                <input style={inp} value={note} onChange={e => setNote(e.target.value)} placeholder="" />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={handleSave} disabled={saving || !canSave} style={{ ...btn('var(--c-accent)'), opacity: canSave ? 1 : 0.45, cursor: canSave ? 'pointer' : 'not-allowed' }}>
                    {saving ? '儲存中…' : '儲存'}
                </button>
                <button onClick={onCancel} style={btn('var(--c-muted)')}>取消</button>
            </div>
        </fieldset>
    )
}

// ── 關聯查詢視圖（全新設計） ──────────────────────────────────────
function RelationView({ entries }: { entries: StockEntry[] }) {
    const [searchQ, setSearchQ] = useState('')
    const [focusCode, setFocusCode] = useState<string | null>(null)
    const [showDropdown, setShowDropdown] = useState(false)
    const [filterTheme, setFilterTheme] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    const focusEntry = focusCode ? entries.find(e => e.code === focusCode) : null

    // 所有題材（排序）

    // 關聯結果：依共同題材數排序，可再依 filterTheme 篩選
    const relatedEntries = useMemo(() => {
        if (!focusEntry) return []
        return entries
            .filter(e => e.code !== focusEntry.code)
            .map(e => ({
                entry: e,
                sharedThemes: e.themes.filter(t => focusEntry.themes.includes(t)),
                uniqueThemes: e.themes.filter(t => !focusEntry.themes.includes(t)),
            }))
            .filter(r => r.sharedThemes.length > 0)
            .filter(r => !filterTheme || r.sharedThemes.includes(filterTheme))
            .sort((a, b) => b.sharedThemes.length - a.sharedThemes.length)
    }, [focusEntry, entries, filterTheme])

    // 搜尋下拉
    const dropdownItems = useMemo(() => {
        if (!searchQ || focusCode) return []
        const q = searchQ.toLowerCase()
        return entries.filter(e => e.code.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)).slice(0, 10)
    }, [searchQ, focusCode, entries])

    const selectEntry = (e: StockEntry) => {
        setFocusCode(e.code)
        setSearchQ(`${e.code} ${e.name}`)
        setShowDropdown(false)
        setFilterTheme(null)
    }

    const clearFocus = () => {
        setFocusCode(null)
        setSearchQ('')
        setFilterTheme(null)
        setTimeout(() => inputRef.current?.focus(), 50)
    }

    // 計算 focusEntry 的每個題材分別有幾個關聯股票（用於題材篩選 badge）
    const themeCounts = useMemo(() => {
        if (!focusEntry) return {}
        const counts: Record<string, number> = {}
        focusEntry.themes.forEach(t => {
            counts[t] = entries.filter(e => e.code !== focusEntry.code && e.themes.includes(t)).length
        })
        return counts
    }, [focusEntry, entries])

    return (
        <div>
            {/* ── 搜尋列 ── */}
            <div style={{ position: 'relative', marginBottom: '16px' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                    <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 0, maxWidth: '420px' }}>
                        <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--c-muted)', pointerEvents: 'none' }} />
                        <input
                            ref={inputRef}
                            style={{ ...inp, paddingLeft: '32px', paddingRight: focusCode ? '36px' : '12px' }}
                            value={searchQ}
                            onChange={e => { setSearchQ(e.target.value); setFocusCode(null); setShowDropdown(true) }}
                            onFocus={() => setShowDropdown(true)}
                            onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
                            placeholder="輸入股票代號或名稱…"
                        />
                        {focusCode && (
                            <button onClick={clearFocus} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer', display: 'flex', padding: '2px' }}>
                                <X size={14} />
                            </button>
                        )}
                    </div>
                    {focusEntry && (
                        <div style={{ fontSize: '12px', color: 'var(--c-muted)' }}>
                            找到 <span style={{ color: 'var(--c-accent)', fontWeight: 700 }}>{relatedEntries.length}</span> 支關聯股票
                        </div>
                    )}
                </div>

                {/* 下拉選單 */}
                {showDropdown && dropdownItems.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, width: 'min(420px, 100%)', zIndex: 20, backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '10px', marginTop: '4px', overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.3)' }}>
                        {dropdownItems.map(e => (
                            <div key={e.code} onMouseDown={() => selectEntry(e)}
                                style={{ padding: '9px 14px', cursor: 'pointer', display: 'flex', gap: '10px', alignItems: 'center', borderBottom: '1px solid var(--c-border)' }}
                                onMouseEnter={el => (el.currentTarget.style.background = 'var(--c-bg)')}
                                onMouseLeave={el => (el.currentTarget.style.background = '')}>
                                <span style={{ color: 'var(--c-accent)', fontWeight: 700, fontSize: '13px', minWidth: '44px' }}>{e.code}</span>
                                <span style={{ color: 'var(--c-text)', fontSize: '13px', flex: 1 }}>{e.name}</span>
                                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                    {e.themes.slice(0, 3).map(t => <ThemeBadge key={t} label={t} size='sm' />)}
                                    {e.themes.length > 3 && <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>+{e.themes.length - 3}</span>}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* ── 主體（未選擇 / 已選擇） ── */}
            {!focusEntry ? (
                <div style={{ ...card, textAlign: 'center', padding: '48px', color: 'var(--c-muted)' }}>
                    <Search size={32} style={{ marginBottom: '12px', opacity: 0.3 }} />
                    <div style={{ fontSize: '14px' }}>搜尋一支股票，查看與哪些股票有共同題材</div>
                </div>
            ) : (
                <div className="industry-relation-layout" style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: '16px', alignItems: 'start' }}>

                    {/* ── 左欄：目標股票資訊 + 題材篩選 ── */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        {/* 目標股票卡 */}
                        <div style={{ ...card, padding: '14px', borderLeft: '4px solid var(--c-accent)' }}>
                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>查詢主體</div>
                            <div style={{ fontWeight: 800, fontSize: '18px', color: 'var(--c-accent)' }}>{focusEntry.code}</div>
                            <div style={{ fontSize: '13px', color: 'var(--c-text)', marginBottom: '10px' }}>{focusEntry.name}</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                                {focusEntry.themes.map(t => (
                                    <div key={t} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                                        <ThemeBadge label={t} size='sm' onClick={() => setFilterTheme(prev => prev === t ? null : t)} />
                                        <span style={{ fontSize: '11px', color: 'var(--c-muted)', flexShrink: 0 }}>{themeCounts[t] ?? 0} 支</span>
                                    </div>
                                ))}
                            </div>
                            {focusEntry.note && <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginTop: '10px', lineHeight: '1.5', borderTop: '1px solid var(--c-border)', paddingTop: '8px' }}>{focusEntry.note}</div>}
                        </div>

                        {/* 題材篩選面板 */}
                        {focusEntry.themes.length > 1 && (
                            <div style={{ ...card, padding: '12px 14px' }}>
                                <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>依題材篩選</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                    <button onClick={() => setFilterTheme(null)} style={{
                                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                        padding: '5px 8px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '12px',
                                        backgroundColor: !filterTheme ? 'var(--c-button-accent)' : 'transparent',
                                        color: !filterTheme ? 'var(--c-on-accent)' : 'var(--c-muted)',
                                    }}>
                                        <span>全部顯示</span>
                                        <span style={{ fontSize: '11px' }}>{relatedEntries.length + (filterTheme ? entries.filter(e => e.code !== focusEntry.code && e.themes.filter(t => focusEntry.themes.includes(t)).length > 0 && !e.themes.includes(filterTheme!)).length : 0)}</span>
                                    </button>
                                    {focusEntry.themes.map(t => {
                                        const count = entries.filter(e => e.code !== focusEntry.code && e.themes.includes(t) && focusEntry.themes.some(ft => e.themes.includes(ft))).length
                                        const color = themeColor(t)
                                        const active = filterTheme === t
                                        return (
                                            <button key={t} onClick={() => setFilterTheme(prev => prev === t ? null : t)} style={{
                                                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                                padding: '5px 8px', borderRadius: '6px', border: `1px solid ${active ? color : 'transparent'}`,
                                                cursor: 'pointer', fontSize: '12px', textAlign: 'left',
                                                backgroundColor: active ? color + '20' : 'transparent',
                                                color: active ? color : 'var(--c-muted)',
                                            }}>
                                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{t}</span>
                                                <span style={{ fontSize: '11px', flexShrink: 0, marginLeft: '6px' }}>{count}</span>
                                            </button>
                                        )
                                    })}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* ── 右欄：關聯列表（緊湊矩陣式） ── */}
                    <div>
                        {relatedEntries.length === 0 ? (
                            <div style={{ ...card, textAlign: 'center', padding: '32px', color: 'var(--c-muted)' }}>
                                {filterTheme ? `沒有同時包含「${filterTheme}」題材的關聯股票` : '尚無其他股票與此股票有共同題材'}
                            </div>
                        ) : (
                            <div className="industry-relation-results" style={{ display: 'flex', flexDirection: 'column', gap: '0px', borderRadius: '12px', overflow: 'hidden', border: '1px solid var(--c-border)' }}>
                                {/* 表頭 */}
                                <div className="industry-relation-head" style={{ display: 'grid', gridTemplateColumns: '100px 90px 1fr 1fr', gap: '0', backgroundColor: 'var(--c-sidebar)', padding: '8px 14px', borderBottom: '1px solid var(--c-border)' }}>
                                    <span style={{ fontSize: '11px', color: 'var(--c-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>代號</span>
                                    <span style={{ fontSize: '11px', color: 'var(--c-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>共同</span>
                                    <span style={{ fontSize: '11px', color: 'var(--c-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>共同題材</span>
                                    <span style={{ fontSize: '11px', color: 'var(--c-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>其他題材</span>
                                </div>

                                {/* 每筆關聯 */}
                                {relatedEntries.map(({ entry: e, sharedThemes, uniqueThemes }, idx) => (
                                    <div className="industry-relation-row" key={e.code} style={{
                                        display: 'grid', gridTemplateColumns: '100px 90px 1fr 1fr',
                                        gap: '0', padding: '9px 14px', alignItems: 'start',
                                        backgroundColor: idx % 2 === 0 ? 'var(--c-card)' : 'var(--c-bg)',
                                        borderBottom: idx < relatedEntries.length - 1 ? '1px solid var(--c-border)' : 'none',
                                    }}>
                                        {/* 代號 + 名稱 */}
                                        <div>
                                            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--c-accent)', lineHeight: '1.3' }}>{e.code}</div>
                                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', lineHeight: '1.3' }}>{e.name}</div>
                                            {e.note && <div style={{ fontSize: '10px', color: 'var(--c-muted)', lineHeight: '1.4', marginTop: '2px', opacity: 0.7 }}>{e.note.slice(0, 20)}{e.note.length > 20 ? '…' : ''}</div>}
                                        </div>

                                        {/* 共同數量 */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', paddingTop: '2px' }}>
                                            <div style={{
                                                width: '28px', height: '28px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                backgroundColor: sharedThemes.length >= 3 ? 'var(--c-button-accent)' : sharedThemes.length === 2 ? 'var(--c-positive)' : 'var(--c-muted)',
                                                fontSize: '13px', fontWeight: 800, color: 'var(--c-on-accent)', flexShrink: 0,
                                            }}>
                                                {sharedThemes.length}
                                            </div>
                                        </div>

                                        {/* 共同題材 */}
                                        <div data-label="共同題材" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', paddingTop: '2px' }}>
                                            {sharedThemes.map(t => <ThemeBadge key={t} label={t} size='sm' />)}
                                        </div>

                                        {/* 其他題材（淡色） */}
                                        <div data-label="其他題材" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', paddingTop: '2px' }}>
                                            {uniqueThemes.map(t => (
                                                <span key={t} style={{ fontSize: '11px', color: 'var(--c-muted)', background: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '1px 7px', whiteSpace: 'nowrap' }}>{t}</span>
                                            ))}
                                            {uniqueThemes.length === 0 && <span style={{ fontSize: '11px', color: 'var(--c-border)' }}>—</span>}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}

// ── 主元件 ────────────────────────────────────────────────────────
type ViewMode = 'stock' | 'theme' | 'graph' | 'chain'
type SortKey = 'code' | 'name' | 'themes'

export default function IndustryMap() {
    const mutation = useSafeMutation()
    const { version: syncVersion } = useInvestSync()
    const { prices, updatePrices: ctxUpdatePrices, priceLoading } = usePrices()
    const { shares: sharesData, sharesLoading, sharesError, updateShares } = useMarketCap()
    const [entries, setEntries] = useState<StockEntry[]>([])
    const [loading, setLoading] = useState(true)
    const [viewMode, setViewMode] = useState<ViewMode>('theme')
    const [showForm, setShowForm] = useState(false)
    const [editEntry, setEditEntry] = useState<StockEntry | null>(null)
    const [searchQ, setSearchQ] = useState('')
    const [sortBy, setSortBy] = useState<SortKey>('code')
    const [marketFilter, setMarketFilter] = useState<Market | 'ALL'>('ALL')
    const [selectedTheme, setSelectedTheme] = useState<string | null>(null)
    const [expandedThemes, setExpandedThemes] = useState<Set<string>>(new Set())
    const [themeQ, setThemeQ] = useState('')

    // 市值資料（僅台股；股數來自 MOPS 公開資料，透過全站共用 MarketCapContext 取得，與選股追蹤頁連動）

    const [loadError, setLoadError] = useState('')
    const loadRevision = useRef(0)
    const load = useCallback(async () => {
        const request = ++loadRevision.current
        try {
            const session = captureUserSession()

            const snap = await getDocs(session.col(investDB, 'industryMap'))
            if (request !== loadRevision.current) return
            session.assertActive()
            const data = snap.docs.map(d => ({ code: d.id, ...d.data() } as StockEntry))
            data.sort((a, b) => a.code.localeCompare(b.code))
            setEntries(data)
            setLoadError('')
        } catch (error) {
            if (request === loadRevision.current) setLoadError(error instanceof Error ? error.message : '資料載入失敗，請重新整理後重試。')
        } finally {
            if (request === loadRevision.current) setLoading(false)
        }
    }, [])

    const cancelLoad = useCallback(() => { loadRevision.current++ }, [])
    useEffect(() => { void load(); return cancelLoad }, [load, cancelLoad, syncVersion])

    const allThemes = useMemo(() => {
        const s = new Set<string>()
        entries.forEach(e => e.themes.forEach(t => s.add(t)))
        return Array.from(s).sort((a, b) => a.localeCompare(b, 'zh-TW'))
    }, [entries])

    const byTheme = useMemo(() => {
        const map: Record<string, StockEntry[]> = {}
        entries.forEach(e => e.themes.forEach(t => { if (!map[t]) map[t] = []; map[t].push(e) }))
        return map
    }, [entries])

    // 題材視圖：依搜尋字串過濾題材（比對題材名稱、股票代號與名稱）
    const visibleThemes = useMemo(() => {
        const q = themeQ.trim().toLowerCase()
        if (!q) return allThemes
        return allThemes.filter(theme =>
            theme.toLowerCase().includes(q) ||
            (byTheme[theme] || []).some(s => s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
        )
    }, [allThemes, byTheme, themeQ])

    const filtered = useMemo(() => {
        const q = searchQ.trim().toLowerCase()
        const list = entries.filter(e =>
            (!q || e.code.toLowerCase().includes(q) || e.name.toLowerCase().includes(q) || e.themes.some(t => t.toLowerCase().includes(q))) &&
            (!selectedTheme || e.themes.includes(selectedTheme)) &&
            (marketFilter === 'ALL' || (e.market || 'TW') === marketFilter)
        )
        // list 為 filter 產生的新陣列，就地排序不會影響 entries
        return list.sort((a, b) => {
            if (sortBy === 'name') return a.name.localeCompare(b.name, 'zh-TW') || a.code.localeCompare(b.code)
            if (sortBy === 'themes') return b.themes.length - a.themes.length || a.code.localeCompare(b.code)
            return a.code.localeCompare(b.code)
        })
    }, [entries, searchQ, selectedTheme, sortBy, marketFilter])

    const handleSave = async (entry: StockEntry, rels: { up: string[]; down: string[] }) => {
        await mutation.run(async session => {
            await saveIndustryEntry(entry, rels, editEntry, session)
            setShowForm(false); setEditEntry(null)
            await load()
        })
    }

    const handleDelete = async (code: string) => {
        if (!await confirmAction(`確定要移除 ${code}？`)) return
        await mutation.run(async session => {
            await deleteDoc(session.doc(investDB, 'industryMap', code))
            session.assertActive()
            await load()
        })
    }

    const openEdit = (entry: StockEntry) => { if (mutation.busy) return; setEditEntry(entry); setShowForm(false) }

    const handleThemeClick = (t: string) => {
        setSelectedTheme(prev => prev === t ? null : t)
        setViewMode('stock')
    }

    const toggleTheme = (t: string) => {
        setExpandedThemes(prev => { const next = new Set(prev); if (next.has(t)) next.delete(t); else next.add(t); return next })
    }
    // 全部展開／全部收合（以目前可見的題材為準）
    const anyCollapsed = visibleThemes.some(t => !expandedThemes.has(t))
    const toggleAll = () => setExpandedThemes(anyCollapsed ? new Set(visibleThemes) : new Set<string>())

    // ★ 更新市值（僅台股）：抓現價（全站共用 PriceContext）+ 已發行股數（全站共用 MarketCapContext）
    const handleUpdateMarketCap = async () => {
        const twCodes = entries.filter(e => (e.market || 'TW') === 'TW').map(e => e.code)
        try {
            await Promise.all([
                ctxUpdatePrices(twCodes),
                updateShares(twCodes),
            ])
        } catch (err) {
            console.error(err)
        }
    }

    return (
        <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
            {(mutation.error || loadError || sharesError) && <p role="alert" style={{ color: 'var(--c-danger)' }}>{mutation.error || loadError || sharesError}</p>}
            <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

            {/* 標題列 */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <Map size={20} color='var(--c-accent)' />
                    <span style={{ fontSize: '18px', fontWeight: 700, color: 'var(--c-text)' }}>產業地圖</span>
                    <span style={{ fontSize: '12px', color: 'var(--c-muted)', background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '2px 10px' }}>
                        {entries.length} 支股票 · {allThemes.length} 個題材
                    </span>
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {(['theme', 'stock', 'graph', 'chain'] as ViewMode[]).map(v => (
                        <button key={v} onClick={() => setViewMode(v)} style={{
                            ...btn(viewMode === v ? 'var(--c-accent)' : 'var(--c-card)'),
                            color: viewMode === v ? '#fff' : 'var(--c-text)',
                            border: '1px solid var(--c-border)', fontSize: '12px', padding: '6px 12px',
                        }}>
                            {v === 'theme' ? '題材視圖' : v === 'stock' ? '股票視圖' : v === 'graph' ? '關聯查詢' : '脈絡圖'}
                        </button>
                    ))}
                    <button onClick={handleUpdateMarketCap} disabled={sharesLoading || priceLoading || entries.length === 0} style={{ ...btn('var(--c-card)'), color: 'var(--c-text)', border: '1px solid var(--c-border)', fontSize: '12px', padding: '6px 12px' }}>
                        <Landmark size={14} style={{ animation: (sharesLoading || priceLoading) ? 'spin 1s linear infinite' : 'none' }} />
                        {(sharesLoading || priceLoading) ? '載入中…' : '更新市值'}
                    </button>
                    <button disabled={mutation.busy} onClick={() => { setShowForm(v => !v); setEditEntry(null) }} style={btn(showForm ? 'var(--c-muted)' : 'var(--c-accent)')}>
                        {showForm ? <X size={14} /> : <Plus size={14} />}{showForm ? '收起' : '新增'}
                    </button>
                </div>
            </div>

            {/* 表單 */}
            {showForm && <StockForm allThemes={allThemes} allStocks={entries} onSave={handleSave} onCancel={() => setShowForm(false)} />}
            {editEntry && <StockForm initial={editEntry} allThemes={allThemes} allStocks={entries} onSave={handleSave} onCancel={() => setEditEntry(null)} />}

            {/* ── 題材視圖 ── */}
            {viewMode === 'theme' && (
                loading ? <div style={{ textAlign: 'center', padding: '40px', color: 'var(--c-muted)' }}>載入中…</div>
                    : allThemes.length === 0 ? (
                        <div style={{ ...card, textAlign: 'center', padding: '40px', color: 'var(--c-muted)' }}>尚未建立任何題材，請先新增股票並標記題材</div>
                    ) : (
                        <div>
                            {/* 題材搜尋 + 全部展開/收合 */}
                            <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', flexWrap: 'wrap' }}>
                                <div style={{ position: 'relative', flex: '1 1 220px' }}>
                                    <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--c-muted)' }} />
                                    <input style={{ ...inp, paddingLeft: '32px' }} value={themeQ} onChange={e => setThemeQ(e.target.value)} placeholder="搜尋題材、代號或名稱…" />
                                </div>
                                <button onClick={toggleAll} style={{ ...btn('var(--c-card)'), color: 'var(--c-text)', border: '1px solid var(--c-border)', fontSize: '12px', padding: '6px 14px', whiteSpace: 'nowrap' }}>
                                    {anyCollapsed ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                    {anyCollapsed ? '全部展開' : '全部收合'}
                                </button>
                            </div>

                            {visibleThemes.length === 0 ? (
                                <div style={{ ...card, textAlign: 'center', padding: '32px', color: 'var(--c-muted)' }}>找不到符合的題材</div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {visibleThemes.map(theme => {
                                        const stocks = byTheme[theme] || []
                                        const collapsed = !expandedThemes.has(theme)
                                        const color = themeColor(theme)
                                        return (
                                            <div key={theme} style={{ ...card, padding: 0, overflow: 'hidden' }}>
                                                <div onClick={() => toggleTheme(theme)} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px', cursor: 'pointer', borderLeft: `4px solid ${color}` }}>
                                                    {collapsed ? <ChevronRight size={15} color='var(--c-muted)' /> : <ChevronDown size={15} color='var(--c-muted)' />}
                                                    <span style={{ fontWeight: 700, fontSize: '14px', color }}>{theme}</span>
                                                    <span style={{ background: color + '22', color, borderRadius: '10px', padding: '1px 7px', fontSize: '11px', fontWeight: 600 }}>{stocks.length}</span>
                                                    {collapsed && (
                                                        <span style={{ flex: 1, minWidth: 0, fontSize: '12px', color: 'var(--c-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                            {stocks.map(s => s.code).join('、')}
                                                        </span>
                                                    )}
                                                </div>
                                                {!collapsed && (
                                                    <div style={{ padding: '4px 14px 12px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                                        {stocks.map(s => (
                                                            <span key={s.code} onClick={() => handleThemeClick(theme)} title={s.note || ''} style={{ display: 'inline-flex', alignItems: 'baseline', gap: '6px', background: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '5px 10px', cursor: 'pointer' }}>
                                                                <span style={{ fontWeight: 700, fontSize: '13px', color: 'var(--c-accent)' }}>{s.code}</span>
                                                                <span style={{ fontSize: '12px', color: 'var(--c-text)' }}>{s.name}</span>
                                                            </span>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )
                                    })}
                                </div>
                            )}
                        </div>
                    )
            )}

            {/* ── 股票視圖 ── */}
            {viewMode === 'stock' && (
                <div>
                    <div style={{ display: 'flex', gap: '10px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <div style={{ position: 'relative', flex: '1 1 200px' }}>
                            <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--c-muted)' }} />
                            <input style={{ ...inp, paddingLeft: '32px' }} value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="搜尋代號、名稱或題材…" />
                        </div>
                        {/* 排序控制 */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '12px', color: 'var(--c-muted)', whiteSpace: 'nowrap' }}>排序</span>
                            {(['code', 'name', 'themes'] as SortKey[]).map(k => (
                                <button key={k} onClick={() => setSortBy(k)} style={{
                                    background: sortBy === k ? 'var(--c-button-accent)' : 'var(--c-card)',
                                    color: sortBy === k ? 'var(--c-on-accent)' : 'var(--c-text)',
                                    border: '1px solid var(--c-border)', borderRadius: '8px',
                                    padding: '6px 12px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
                                }}>
                                    {k === 'code' ? '代號' : k === 'name' ? '名稱' : '題材數'}
                                </button>
                            ))}
                        </div>
                        {/* 市場篩選 */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '12px', color: 'var(--c-muted)', whiteSpace: 'nowrap' }}>市場</span>
                            {(['ALL', 'TW', 'US', 'JP'] as (Market | 'ALL')[]).map(k => (
                                <button key={k} onClick={() => setMarketFilter(k)} style={{
                                    background: marketFilter === k ? 'var(--c-button-accent)' : 'var(--c-card)',
                                    color: marketFilter === k ? 'var(--c-on-accent)' : 'var(--c-text)',
                                    border: '1px solid var(--c-border)', borderRadius: '8px',
                                    padding: '6px 12px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
                                }}>
                                    {k === 'ALL' ? '全部' : marketLabel(k)}
                                </button>
                            ))}
                        </div>
                        {selectedTheme && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '8px', fontSize: '13px', color: 'var(--c-text)' }}>
                                <Tag size={12} color='var(--c-muted)' />
                                篩選：<ThemeBadge label={selectedTheme} onRemove={() => setSelectedTheme(null)} />
                            </div>
                        )}
                    </div>
                    {loading ? (
                        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--c-muted)' }}>載入中…</div>
                    ) : (
                        <div>
                            <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '10px' }}>共 {filtered.length} 支</div>
                            <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
                                {filtered.map(e => {
                                    const isTW = (e.market || 'TW') === 'TW'
                                    const cap = isTW ? calcMarketCap(prices[e.code], sharesData[e.code]) : null
                                    return <StockCard key={e.code} entry={e} marketCap={cap} onEdit={openEdit} onDelete={handleDelete} onThemeClick={handleThemeClick} />
                                })}
                                {filtered.length === 0 && <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '40px', color: 'var(--c-muted)' }}>找不到符合條件的股票</div>}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── 關聯查詢 ── */}
            {viewMode === 'graph' && <RelationView entries={entries} />}

            {/* ── 脈絡圖 ── */}
            {viewMode === 'chain' && <ChainView nodes={entries} />}
        </div>
    )
}
