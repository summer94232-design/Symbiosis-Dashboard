import { useState, useEffect, useRef, useMemo } from 'react'
import { getDocs, setDoc, deleteDoc, getDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc } from '../../lib/userDB'
import { Plus, X, Search, Pencil, Trash2, ChevronDown, ChevronRight, Map, Tag, Loader } from 'lucide-react'

// ── 型別 ──────────────────────────────────────────────────────────
interface StockEntry {
    code: string
    name: string
    themes: string[]
    note?: string
}

// ── 股票名稱查詢 ──────────────────────────────────────────────────
const dictCache: Record<string, string> = {}

async function lookupStockName(code: string): Promise<string> {
    if (dictCache[code]) return dictCache[code]
    const shortDoc = await getDoc(userDoc(investDB, 'stockDict', code))
    if (shortDoc.exists()) {
        const name = shortDoc.data().name as string
        dictCache[code] = name
        return name
    }
    const fullDoc = await getDoc(userDoc(investDB, 'stockDictFull', code))
    if (fullDoc.exists()) {
        const name = fullDoc.data().name as string
        dictCache[code] = name
        await setDoc(userDoc(investDB, 'stockDict', code), { name })
        return name
    }
    return ''
}

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
    padding: '20px',
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
    backgroundColor: color,
    border: 'none',
    borderRadius: '8px',
    padding: '8px 16px',
    color: '#fff',
    fontSize: '13px',
    cursor: 'pointer',
    display: 'flex',
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

// ── 股票卡片（題材視圖 & 股票視圖用） ─────────────────────────────
function StockCard({ entry, onEdit, onDelete, onThemeClick, highlighted }: {
    entry: StockEntry
    onEdit: (e: StockEntry) => void
    onDelete: (code: string) => void
    onThemeClick: (t: string) => void
    highlighted?: boolean
}) {
    return (
        <div style={{ ...card, padding: '14px 16px', outline: highlighted ? '2px solid var(--c-accent)' : 'none', transition: 'outline 0.2s' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                <div>
                    <span style={{ fontWeight: 700, fontSize: '15px', color: 'var(--c-accent)' }}>{entry.code}</span>
                    <span style={{ marginLeft: '8px', fontSize: '13px', color: 'var(--c-text)' }}>{entry.name}</span>
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
function StockForm({ initial, allThemes, onSave, onCancel }: {
    initial?: Partial<StockEntry>
    allThemes: string[]
    onSave: (entry: StockEntry) => Promise<void>
    onCancel: () => void
}) {
    const [code, setCode] = useState(initial?.code || '')
    const [name, setName] = useState(initial?.name || '')
    const [themes, setThemes] = useState<string[]>(initial?.themes || [])
    const [note, setNote] = useState(initial?.note || '')
    const [themeInput, setThemeInput] = useState('')
    const [saving, setSaving] = useState(false)
    const [lookingUp, setLookingUp] = useState(false)
    const [nameTouched, setNameTouched] = useState(!!initial?.name)
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const isEditing = !!initial?.code

    const handleCodeChange = (val: string) => {
        const upper = val.toUpperCase()
        setCode(upper)
        if (nameTouched) return
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
        setSaving(true)
        await onSave({ code: code.trim(), name: name.trim(), themes, note: note.trim() || undefined })
        setSaving(false)
    }

    return (
        <div style={{ ...card, marginBottom: '20px' }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--c-accent)', marginBottom: '16px' }}>
                {isEditing ? `編輯：${initial.code}` : '新增股票'}
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
        </div>
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
    const allThemes = useMemo(() => {
        const s = new Set<string>()
        entries.forEach(e => e.themes.forEach(t => s.add(t)))
        return Array.from(s).sort((a, b) => a.localeCompare(b, 'zh-TW'))
    }, [entries])

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
        setSearchQ(`${e.code}　${e.name}`)
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
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <div style={{ position: 'relative', flex: 1, maxWidth: '420px' }}>
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
                    <div style={{ position: 'absolute', top: '100%', left: 0, width: '420px', zIndex: 20, backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '10px', marginTop: '4px', overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.3)' }}>
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
                <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: '16px', alignItems: 'start' }}>

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
                                        backgroundColor: !filterTheme ? 'var(--c-accent)' : 'transparent',
                                        color: !filterTheme ? '#fff' : 'var(--c-muted)',
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
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0px', borderRadius: '12px', overflow: 'hidden', border: '1px solid var(--c-border)' }}>
                                {/* 表頭 */}
                                <div style={{ display: 'grid', gridTemplateColumns: '100px 90px 1fr 1fr', gap: '0', backgroundColor: 'var(--c-sidebar)', padding: '8px 14px', borderBottom: '1px solid var(--c-border)' }}>
                                    <span style={{ fontSize: '11px', color: 'var(--c-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>代號</span>
                                    <span style={{ fontSize: '11px', color: 'var(--c-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>共同</span>
                                    <span style={{ fontSize: '11px', color: 'var(--c-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>共同題材</span>
                                    <span style={{ fontSize: '11px', color: 'var(--c-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>其他題材</span>
                                </div>

                                {/* 每筆關聯 */}
                                {relatedEntries.map(({ entry: e, sharedThemes, uniqueThemes }, idx) => (
                                    <div key={e.code} style={{
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
                                                backgroundColor: sharedThemes.length >= 3 ? 'var(--c-accent)' : sharedThemes.length === 2 ? 'var(--c-positive)' : 'var(--c-muted)',
                                                fontSize: '13px', fontWeight: 800, color: '#fff', flexShrink: 0,
                                            }}>
                                                {sharedThemes.length}
                                            </div>
                                        </div>

                                        {/* 共同題材 */}
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', paddingTop: '2px' }}>
                                            {sharedThemes.map(t => <ThemeBadge key={t} label={t} size='sm' />)}
                                        </div>

                                        {/* 其他題材（淡色） */}
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', paddingTop: '2px' }}>
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
type ViewMode = 'stock' | 'theme' | 'graph'

export default function IndustryMap() {
    const [entries, setEntries] = useState<StockEntry[]>([])
    const [loading, setLoading] = useState(true)
    const [viewMode, setViewMode] = useState<ViewMode>('theme')
    const [showForm, setShowForm] = useState(false)
    const [editEntry, setEditEntry] = useState<StockEntry | null>(null)
    const [searchQ, setSearchQ] = useState('')
    const [selectedTheme, setSelectedTheme] = useState<string | null>(null)
    const [collapsedThemes, setCollapsedThemes] = useState<Set<string>>(new Set())

    const load = async () => {
        setLoading(true)
        const snap = await getDocs(userCol(investDB, 'industryMap'))
        const data = snap.docs.map(d => ({ code: d.id, ...d.data() } as StockEntry))
        data.sort((a, b) => a.code.localeCompare(b.code))
        setEntries(data)
        setLoading(false)
    }

    useEffect(() => { load() }, [])

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

    const filtered = useMemo(() => {
        const q = searchQ.toLowerCase()
        return entries.filter(e =>
            (!q || e.code.includes(q) || e.name.includes(q) || e.themes.some(t => t.toLowerCase().includes(q))) &&
            (!selectedTheme || e.themes.includes(selectedTheme))
        )
    }, [entries, searchQ, selectedTheme])

    const handleSave = async (entry: StockEntry) => {
        await setDoc(userDoc(investDB, 'industryMap', entry.code), {
            name: entry.name, themes: entry.themes, ...(entry.note ? { note: entry.note } : {}),
        })
        setShowForm(false); setEditEntry(null); load()
    }

    const handleDelete = async (code: string) => {
        if (!confirm(`確定要移除 ${code}？`)) return
        await deleteDoc(userDoc(investDB, 'industryMap', code)); load()
    }

    const openEdit = (entry: StockEntry) => { setEditEntry(entry); setShowForm(false) }

    const handleThemeClick = (t: string) => {
        setSelectedTheme(prev => prev === t ? null : t)
        setViewMode('stock')
    }

    const toggleTheme = (t: string) => {
        setCollapsedThemes(prev => { const next = new Set(prev); next.has(t) ? next.delete(t) : next.add(t); return next })
    }

    return (
        <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
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
                    {(['theme', 'stock', 'graph'] as ViewMode[]).map(v => (
                        <button key={v} onClick={() => setViewMode(v)} style={{
                            ...btn(viewMode === v ? 'var(--c-accent)' : 'var(--c-card)'),
                            color: viewMode === v ? '#fff' : 'var(--c-text)',
                            border: '1px solid var(--c-border)', fontSize: '12px', padding: '6px 12px',
                        }}>
                            {v === 'theme' ? '題材視圖' : v === 'stock' ? '股票視圖' : '關聯查詢'}
                        </button>
                    ))}
                    <button onClick={() => { setShowForm(true); setEditEntry(null) }} style={btn('var(--c-accent)')}>
                        <Plus size={14} />新增
                    </button>
                </div>
            </div>

            {/* 表單 */}
            {showForm && <StockForm allThemes={allThemes} onSave={handleSave} onCancel={() => setShowForm(false)} />}
            {editEntry && <StockForm initial={editEntry} allThemes={allThemes} onSave={handleSave} onCancel={() => setEditEntry(null)} />}

            {/* ── 題材視圖 ── */}
            {viewMode === 'theme' && (
                loading ? <div style={{ textAlign: 'center', padding: '40px', color: 'var(--c-muted)' }}>載入中…</div>
                    : allThemes.length === 0 ? (
                        <div style={{ ...card, textAlign: 'center', padding: '40px', color: 'var(--c-muted)' }}>尚未建立任何題材，請先新增股票並標記題材</div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            {allThemes.map(theme => {
                                const stocks = byTheme[theme] || []
                                const collapsed = collapsedThemes.has(theme)
                                const color = themeColor(theme)
                                return (
                                    <div key={theme} style={{ ...card, padding: 0, overflow: 'hidden' }}>
                                        <div onClick={() => toggleTheme(theme)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', cursor: 'pointer', borderLeft: `4px solid ${color}`, backgroundColor: color + '10' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                                {collapsed ? <ChevronRight size={16} color='var(--c-muted)' /> : <ChevronDown size={16} color='var(--c-muted)' />}
                                                <span style={{ fontWeight: 700, fontSize: '15px', color }}>{theme}</span>
                                                <span style={{ background: color + '22', border: `1px solid ${color}44`, color, borderRadius: '12px', padding: '1px 8px', fontSize: '12px', fontWeight: 600 }}>{stocks.length} 支</span>
                                            </div>
                                        </div>
                                        {!collapsed && (
                                            <div style={{ padding: '12px 18px 16px', display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                                                {stocks.map(s => (
                                                    <div key={s.code} style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '10px', padding: '10px 14px', minWidth: '130px' }}>
                                                        <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--c-accent)', marginBottom: '4px' }}>{s.code}</div>
                                                        <div style={{ fontSize: '12px', color: 'var(--c-text)', marginBottom: '6px' }}>{s.name}</div>
                                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                                            {s.themes.filter(t => t !== theme).map(t => <ThemeBadge key={t} label={t} size='sm' onClick={() => handleThemeClick(t)} />)}
                                                        </div>
                                                        {s.note && <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginTop: '6px' }}>{s.note}</div>}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    )
            )}

            {/* ── 股票視圖 ── */}
            {viewMode === 'stock' && (
                <div>
                    <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
                        <div style={{ position: 'relative', flex: '1 1 200px' }}>
                            <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--c-muted)' }} />
                            <input style={{ ...inp, paddingLeft: '32px' }} value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="搜尋代號、名稱或題材…" />
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
                        <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
                            {filtered.map(e => <StockCard key={e.code} entry={e} onEdit={openEdit} onDelete={handleDelete} onThemeClick={handleThemeClick} />)}
                            {filtered.length === 0 && <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '40px', color: 'var(--c-muted)' }}>找不到符合條件的股票</div>}
                        </div>
                    )}
                </div>
            )}

            {/* ── 關聯查詢 ── */}
            {viewMode === 'graph' && <RelationView entries={entries} />}
        </div>
    )
}