import { useState, useEffect, useMemo } from 'react'
import { getDocs, setDoc, deleteDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc } from '../../lib/userDB'
import { Trash2, X, Search, ArrowUpRight, ArrowDownLeft, Link2, Network, List } from 'lucide-react'

// ── 型別 ──────────────────────────────────────────────────────────
/** 脈絡圖節點：只需要代號與名稱，可直接傳入 IndustryMap 的 StockEntry[]（結構相容） */
export interface ChainNode {
    code: string
    name: string
}

/**
 * 方向性關係。from 供應 / 流向 to。對某一檔 F 而言：
 *   - to === F   → from 是 F 的「上游」（供應給 F）
 *   - from === F → to 是 F 的「下游」（F 供應給它）
 */
export interface ChainLink {
    id: string
    from: string
    to: string
    label?: string
    type?: string
}

// ── 樣式（沿用 IndustryMap 既有風格） ─────────────────────────────
const card: React.CSSProperties = {
    backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '20px',
}
const inp: React.CSSProperties = {
    backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px',
    padding: '8px 12px', color: 'var(--c-text)', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box',
}
const btn = (color: string): React.CSSProperties => ({
    backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px',
    color: '#fff', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
})

// 文字截斷
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

// SVG 版面常數
const BOX_W = 150
const BOX_H = 56
const COL_STEP = 210
const ROW_STEP = 78
const PAD = 28

// ── 主元件 ────────────────────────────────────────────────────────
export function ChainView({ nodes }: { nodes: ChainNode[] }) {
    const [links, setLinks] = useState<ChainLink[]>([])
    const [loading, setLoading] = useState(true)
    const [focusCode, setFocusCode] = useState<string | null>(null)
    const [focusSearch, setFocusSearch] = useState('')
    const [depth, setDepth] = useState(2)
    const [view, setView] = useState<'graph' | 'list'>('graph')

    // 新增關係暫存表單（dir: 'up' = 對方供應此檔；'down' = 此檔供應對方）
    const [addDir, setAddDir] = useState<'up' | 'down' | null>(null)
    const [addTarget, setAddTarget] = useState('')
    const [addLabel, setAddLabel] = useState('')
    const [addType, setAddType] = useState('')
    const [saving, setSaving] = useState(false)
    const [addedCount, setAddedCount] = useState(0)

    const load = async () => {
        setLoading(true)
        const snap = await getDocs(userCol(investDB, 'industryRelations'))
        setLinks(snap.docs.map(d => ({ id: d.id, ...d.data() } as ChainLink)))
        setLoading(false)
    }
    useEffect(() => { load() }, [])

    const nameOf = useMemo(() => {
        const m = new Map<string, string>()
        nodes.forEach(n => m.set(n.code, n.name))
        return (code: string) => m.get(code) ?? code
    }, [nodes])

    const sortedNodes = useMemo(
        () => [...nodes].sort((a, b) => a.code.localeCompare(b.code)),
        [nodes],
    )

    const focusMatches = useMemo(() => {
        const q = focusSearch.trim().toLowerCase()
        if (!q) return sortedNodes.slice(0, 12)
        return sortedNodes
            .filter(n => n.code.toLowerCase().includes(q) || n.name.toLowerCase().includes(q))
            .slice(0, 12)
    }, [focusSearch, sortedNodes])

    const upstream = useMemo(() => links.filter(l => l.to === focusCode), [links, focusCode])
    const downstream = useMemo(() => links.filter(l => l.from === focusCode), [links, focusCode])

    // ── 多層版面計算（BFS，左上游／右下游，含循環防呆） ──
    const graph = useMemo(() => {
        if (!focusCode) return null
        const placed = new Map<string, number>()  // code → level（負=上游、正=下游）
        placed.set(focusCode, 0)

        // 上游：沿著 l.to === current 往外，把 l.from 放到更左一層
        let frontier: string[] = [focusCode]
        for (let d = 1; d <= depth; d++) {
            const next: string[] = []
            for (const cur of frontier) {
                for (const l of links) {
                    if (l.to === cur && !placed.has(l.from)) { placed.set(l.from, -d); next.push(l.from) }
                }
            }
            if (next.length === 0) break
            frontier = next
        }
        // 下游：沿著 l.from === current 往外，把 l.to 放到更右一層
        frontier = [focusCode]
        for (let d = 1; d <= depth; d++) {
            const next: string[] = []
            for (const cur of frontier) {
                for (const l of links) {
                    if (l.from === cur && !placed.has(l.to)) { placed.set(l.to, d); next.push(l.to) }
                }
            }
            if (next.length === 0) break
            frontier = next
        }

        // 依層分欄
        const colMap = new Map<number, string[]>()
        Array.from(placed.entries()).forEach(([code, lvl]) => {
            const arr = colMap.get(lvl)
            if (arr) arr.push(code); else colMap.set(lvl, [code])
        })
        const levels = Array.from(colMap.keys()).sort((a, b) => a - b)
        const minLevel = levels[0]
        const maxLevel = levels[levels.length - 1]
        const maxRows = Math.max(...levels.map(l => colMap.get(l)!.length))

        const width = PAD * 2 + (maxLevel - minLevel) * COL_STEP + BOX_W
        const height = Math.max(PAD * 2 + maxRows * ROW_STEP, 180)
        const midY = height / 2

        const pos = new Map<string, { x: number; y: number }>()
        levels.forEach(lvl => {
            const arr = colMap.get(lvl)!
            const x = PAD + (lvl - minLevel) * COL_STEP
            arr.forEach((code, i) => {
                const y = midY + (i - (arr.length - 1) / 2) * ROW_STEP - BOX_H / 2
                pos.set(code, { x, y })
            })
        })

        const edges = links
            .filter(l => pos.has(l.from) && pos.has(l.to))
            .map(l => {
                const a = pos.get(l.from)!
                const b = pos.get(l.to)!
                return { link: l, x1: a.x + BOX_W, y1: a.y + BOX_H / 2, x2: b.x, y2: b.y + BOX_H / 2 }
            })

        return { pos, width, height, edges }
    }, [focusCode, links, depth])

    const selectFocus = (code: string) => {
        setFocusCode(code)
        setFocusSearch('')
        setAddDir(null)
    }

    const clearFocus = () => {
        setFocusCode(null)
        setFocusSearch('')
        setAddDir(null)
    }

    const startAdd = (dir: 'up' | 'down') => {
        setAddDir(dir)
        setAddTarget('')
        setAddLabel('')
        setAddType('')
        setAddedCount(0)
    }

    const handleAdd = async () => {
        if (!focusCode || !addTarget || addTarget === focusCode) return
        const from = addDir === 'up' ? addTarget : focusCode
        const to = addDir === 'up' ? focusCode : addTarget
        const relId = `${from}__${to}`.replace(/\//g, '_')
        setSaving(true)
        await setDoc(userDoc(investDB, 'industryRelations', relId), {
            from,
            to,
            ...(addLabel.trim() ? { label: addLabel.trim() } : {}),
            ...(addType.trim() ? { type: addType.trim() } : {}),
        }, { merge: true })
        setSaving(false)
        setAddTarget('')
        setAddLabel('')
        setAddType('')
        setAddedCount(c => c + 1)
        load()
    }

    const handleDelete = async (id: string) => {
        if (!confirm('確定要刪除這條關係？')) return
        await deleteDoc(userDoc(investDB, 'industryRelations', id))
        load()
    }

    const listVisible = !focusCode || focusSearch.trim().length > 0

    // ── 新增關係表單 ──
    const renderAddForm = (dir: 'up' | 'down') => {
        if (addDir !== dir) return null
        const targetOptions = sortedNodes.filter(n => n.code !== focusCode)
        const canSave = !!addTarget && addTarget !== focusCode && !saving
        const current = dir === 'up' ? upstream : downstream
        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '14px', backgroundColor: 'var(--c-bg)', borderRadius: '8px', border: '1px dashed var(--c-border)', marginTop: '8px' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--c-text)' }}>
                    {dir === 'up' ? '標記上游供應商' : '標記下游客戶'}
                    <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--c-muted)', marginLeft: '8px' }}>可連續加入多筆</span>
                </div>

                {/* 目前已標記的對象（可即時移除） */}
                {current.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {current.map(l => {
                            const cp = dir === 'up' ? l.from : l.to
                            return (
                                <span key={l.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '20px', padding: '2px 6px 2px 10px', fontSize: '12px', color: 'var(--c-text)' }}>
                                    {cp} {short(nameOf(cp), 6)}
                                    <X size={12} style={{ cursor: 'pointer', color: 'var(--c-danger)' }} onClick={() => handleDelete(l.id)} />
                                </span>
                            )
                        })}
                    </div>
                )}

                <select value={addTarget} onChange={e => setAddTarget(e.target.value)} style={inp}>
                    <option value="">{dir === 'up' ? '選擇上游（供應給此檔的公司）' : '選擇下游（此檔供應的對象）'}</option>
                    {targetOptions.map(n => (
                        <option key={n.code} value={n.code}>{n.code}　{n.name}</option>
                    ))}
                </select>
                <input style={inp} placeholder="供應內容 / 關係描述（選填，例：HBM3E 記憶體）" value={addLabel} onChange={e => setAddLabel(e.target.value)} />
                <input style={inp} placeholder="關係類型（選填，例：供應 / 客戶 / 合作）" value={addType} onChange={e => setAddType(e.target.value)} />
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button onClick={handleAdd} disabled={!canSave} style={{ ...btn('var(--c-accent)'), opacity: canSave ? 1 : 0.45, cursor: canSave ? 'pointer' : 'not-allowed' }}>
                        {saving ? '加入中…' : '加入'}
                    </button>
                    <button onClick={() => { setAddDir(null); setAddedCount(0) }} style={btn('var(--c-muted)')}>完成</button>
                    {addedCount > 0 && <span style={{ fontSize: '12px', color: 'var(--c-positive)' }}>已加入 {addedCount} 筆</span>}
                </div>
            </div>
        )
    }

    // ── 清單關係列 ──
    const renderRow = (link: ChainLink, counterpart: string) => (
        <div key={link.id} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
            padding: '10px 12px', backgroundColor: 'var(--c-bg)', borderRadius: '8px',
        }}>
            <div style={{ minWidth: 0 }}>
                <div onClick={() => selectFocus(counterpart)} style={{ cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                    <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--c-accent)' }}>{counterpart}</span>
                    <span style={{ fontSize: '13px', color: 'var(--c-text)' }}>{nameOf(counterpart)}</span>
                </div>
                {(link.label || link.type) && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px', alignItems: 'center' }}>
                        {link.type && <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--c-muted)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '1px 8px' }}>{link.type}</span>}
                        {link.label && <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>{link.label}</span>}
                    </div>
                )}
            </div>
            <button onClick={() => handleDelete(link.id)} style={{ background: 'none', border: 'none', color: 'var(--c-danger)', cursor: 'pointer', padding: '2px', flexShrink: 0 }}>
                <Trash2 size={14} />
            </button>
        </div>
    )

    if (nodes.length === 0) {
        return (
            <div style={{ ...card, textAlign: 'center', padding: '40px', color: 'var(--c-muted)' }}>
                請先到「股票視圖」新增股票。脈絡圖會以你的股票為節點，標記彼此的上下游關係。
            </div>
        )
    }

    return (
        <div>
            <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '12px', lineHeight: 1.6 }}>
                以你追蹤的股票為節點，由左到右呈現供應鏈：左邊是上游、右邊是下游，箭頭由供應商指向客戶。點任一節點即可重新聚焦、沿鏈往下追。關係類型可自由填寫，不限產業。
            </div>

            {/* 焦點挑選 */}
            <div style={{ ...card, marginBottom: '16px', padding: '14px 16px' }}>
                <div style={{ position: 'relative' }}>
                    <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--c-muted)', pointerEvents: 'none' }} />
                    <input
                        style={{ ...inp, paddingLeft: '32px', paddingRight: focusCode ? '38px' : '12px' }}
                        value={focusSearch}
                        onChange={e => setFocusSearch(e.target.value)}
                        placeholder={focusCode ? `目前：${focusCode} ${nameOf(focusCode)}（輸入可切換）` : '輸入代號或名稱選擇要查看的標的…'}
                    />
                    {focusCode && (
                        <button onClick={clearFocus} title="清除選擇" style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer', display: 'flex', padding: '2px' }}>
                            <X size={16} />
                        </button>
                    )}
                </div>
                {listVisible && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
                        {focusMatches.length === 0 ? (
                            <span style={{ fontSize: '13px', color: 'var(--c-muted)' }}>查無符合的標的</span>
                        ) : focusMatches.map(n => (
                            <button key={n.code} onClick={() => selectFocus(n.code)} style={{
                                backgroundColor: n.code === focusCode ? 'var(--c-accent)' : 'var(--c-bg)',
                                color: n.code === focusCode ? '#fff' : 'var(--c-text)',
                                border: '1px solid var(--c-border)', borderRadius: '8px',
                                padding: '6px 12px', fontSize: '13px', cursor: 'pointer',
                            }}>
                                <strong>{n.code}</strong> {n.name}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {!focusCode ? (
                <div style={{ ...card, textAlign: 'center', padding: '40px', color: 'var(--c-muted)' }}>
                    選擇一個標的後，這裡會顯示它的上下游脈絡。
                </div>
            ) : loading ? (
                <div style={{ ...card, textAlign: 'center', padding: '40px', color: 'var(--c-muted)' }}>載入中…</div>
            ) : (
                <>
                    {/* 焦點標頭 + 控制列 */}
                    <div style={{ ...card, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                        <div style={{ width: '40px', height: '40px', borderRadius: '10px', backgroundColor: 'color-mix(in srgb, var(--c-accent) 12%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <Link2 size={20} color="var(--c-accent)" />
                        </div>
                        <div>
                            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--c-accent)' }}>{focusCode}</div>
                            <div style={{ fontSize: '13px', color: 'var(--c-text)' }}>{nameOf(focusCode)}</div>
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--c-muted)' }}>上游 {upstream.length} · 下游 {downstream.length}</div>

                        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                            {/* 新增關係 */}
                            <button onClick={() => startAdd('up')} style={{ ...btn('color-mix(in srgb, var(--c-accent) 14%, transparent)'), color: 'var(--c-accent)', padding: '6px 10px', fontSize: '12px' }}>
                                <ArrowDownLeft size={13} />＋上游
                            </button>
                            <button onClick={() => startAdd('down')} style={{ ...btn('color-mix(in srgb, var(--c-accent) 14%, transparent)'), color: 'var(--c-accent)', padding: '6px 10px', fontSize: '12px' }}>
                                <ArrowUpRight size={13} />＋下游
                            </button>

                            {/* 深度（僅圖模式） */}
                            {view === 'graph' && (
                                <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    層數
                                    <select value={depth} onChange={e => setDepth(parseInt(e.target.value, 10))} style={{ ...inp, width: 'auto', padding: '4px 8px' }}>
                                        <option value={1}>1</option>
                                        <option value={2}>2</option>
                                        <option value={3}>3</option>
                                        <option value={4}>4</option>
                                    </select>
                                </label>
                            )}

                            {/* 圖 / 清單切換 */}
                            <div style={{ display: 'flex', border: '1px solid var(--c-border)', borderRadius: '8px', overflow: 'hidden' }}>
                                <button onClick={() => setView('graph')} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '6px 10px', border: 'none', cursor: 'pointer', fontSize: '12px', backgroundColor: view === 'graph' ? 'var(--c-accent)' : 'transparent', color: view === 'graph' ? '#fff' : 'var(--c-muted)' }}>
                                    <Network size={13} />圖
                                </button>
                                <button onClick={() => setView('list')} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '6px 10px', border: 'none', cursor: 'pointer', fontSize: '12px', backgroundColor: view === 'list' ? 'var(--c-accent)' : 'transparent', color: view === 'list' ? '#fff' : 'var(--c-muted)' }}>
                                    <List size={13} />清單
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* 新增表單（接在標頭下方） */}
                    {addDir === 'up' && <div style={{ marginBottom: '16px' }}>{renderAddForm('up')}</div>}
                    {addDir === 'down' && <div style={{ marginBottom: '16px' }}>{renderAddForm('down')}</div>}

                    {/* ── 圖視圖 ── */}
                    {view === 'graph' && graph && (
                        <div style={{ ...card, padding: '12px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--c-muted)', marginBottom: '8px', padding: '0 4px' }}>
                                <span>← 上游（供應商）</span><span>焦點</span><span>下游（客戶）→</span>
                            </div>
                            <div style={{ overflowX: 'auto' }}>
                                <svg width={graph.width} height={graph.height} viewBox={`0 0 ${graph.width} ${graph.height}`} style={{ display: 'block' }}>
                                    <defs>
                                        <marker id="chain-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                                            <path d="M0,0 L10,5 L0,10 z" style={{ fill: 'var(--c-muted)' }} />
                                        </marker>
                                    </defs>

                                    {/* 連線 */}
                                    {graph.edges.map(e => {
                                        const dx = Math.max(30, Math.abs(e.x2 - e.x1) * 0.4)
                                        const d = `M ${e.x1} ${e.y1} C ${e.x1 + dx} ${e.y1}, ${e.x2 - dx} ${e.y2}, ${e.x2} ${e.y2}`
                                        const mx = (e.x1 + e.x2) / 2
                                        const my = (e.y1 + e.y2) / 2
                                        return (
                                            <g key={e.link.id}>
                                                <path d={d} fill="none" style={{ stroke: 'var(--c-border)' }} strokeWidth={2} markerEnd="url(#chain-arrow)" />
                                                <path d={d} fill="none" stroke="transparent" strokeWidth={16} style={{ cursor: 'pointer' }} onClick={() => handleDelete(e.link.id)}>
                                                    <title>{(e.link.type ? `[${e.link.type}] ` : '') + (e.link.label || '點擊以刪除這條關係')}</title>
                                                </path>
                                                {e.link.label && (
                                                    <text x={mx} y={my - 5} textAnchor="middle" style={{ fill: 'var(--c-muted)', pointerEvents: 'none' }} fontSize={10}>
                                                        {short(e.link.label, 10)}
                                                    </text>
                                                )}
                                            </g>
                                        )
                                    })}

                                    {/* 節點 */}
                                    {Array.from(graph.pos.entries()).map(([code, p]) => {
                                        const isFocus = code === focusCode
                                        return (
                                            <g key={code} onClick={() => selectFocus(code)} style={{ cursor: 'pointer' }}>
                                                <rect
                                                    x={p.x} y={p.y} width={BOX_W} height={BOX_H} rx={10}
                                                    style={{ fill: 'var(--c-card)', stroke: isFocus ? 'var(--c-accent)' : 'var(--c-border)' }}
                                                    strokeWidth={isFocus ? 2.5 : 1}
                                                />
                                                <text x={p.x + 14} y={p.y + 23} style={{ fill: 'var(--c-accent)', pointerEvents: 'none' }} fontSize={14} fontWeight={700}>{code}</text>
                                                <text x={p.x + 14} y={p.y + 42} style={{ fill: 'var(--c-text)', pointerEvents: 'none' }} fontSize={12}>{short(nameOf(code), 8)}</text>
                                            </g>
                                        )
                                    })}
                                </svg>
                            </div>
                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginTop: '8px', padding: '0 4px' }}>
                                點節點可重新聚焦；點連線可刪除該關係。預設顯示 {depth} 層，可在上方調整。
                            </div>
                        </div>
                    )}

                    {/* ── 清單視圖 ── */}
                    {view === 'list' && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
                            <div style={card}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                                    <ArrowDownLeft size={16} color="var(--c-muted)" />
                                    <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>上游供應商</span>
                                    <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>（供應給此檔）</span>
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {upstream.length === 0 && <div style={{ fontSize: '13px', color: 'var(--c-muted)', textAlign: 'center', padding: '16px' }}>尚未設定上游</div>}
                                    {upstream.map(l => renderRow(l, l.from))}
                                </div>
                            </div>
                            <div style={card}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                                    <ArrowUpRight size={16} color="var(--c-muted)" />
                                    <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>下游客戶</span>
                                    <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>（此檔供應給）</span>
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {downstream.length === 0 && <div style={{ fontSize: '13px', color: 'var(--c-muted)', textAlign: 'center', padding: '16px' }}>尚未設定下游</div>}
                                    {downstream.map(l => renderRow(l, l.to))}
                                </div>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    )
}