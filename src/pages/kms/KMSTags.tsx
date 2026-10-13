import LoadingState from '../../components/LoadingState'
import { card } from '../../ui/styles'
import { useState, useEffect } from 'react'
import { buildKmsTagStatsFromSummaries, fetchKmsNoteSummaries, fetchKmsTagOrder, fetchKmsTagStats, hasUsableKmsTagStats, invalidateKmsNotes, invalidateKmsTagOrder } from '../../lib/kmsData'
import { Pencil, Check, X, Tag, FolderOpen, ChevronRight, ChevronUp, ChevronDown, GripVertical } from 'lucide-react'
import { renameKmsTag, saveKmsTagOrder } from '../../lib/batchOperations'
import { useSafeMutation } from '../../lib/useSafeMutation'
import type { KmsTagOrder } from '../../lib/kmsData'

interface TagInfo {
    name: string
    count: number
    children: TagInfo[]
}

const inp: React.CSSProperties = { backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '6px 10px', color: 'var(--c-text)', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }


export default function KMSTags() {
    const [tagTree, setTagTree] = useState<TagInfo[]>([])
    const [loading, setLoading] = useState(true)
    const [hasLoaded, setHasLoaded] = useState(false)
    const [editingTag, setEditingTag] = useState<string | null>(null)
    const [editValue, setEditValue] = useState('')
    const mutation = useSafeMutation()
    const saving = mutation.busy
    const [orderBaseline, setOrderBaseline] = useState<KmsTagOrder>({ parentOrder: [], childOrder: {} })
    const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
    const [msg, setMsg] = useState('')
    const [parentOrder, setParentOrder] = useState<string[]>([])
    const [childOrder, setChildOrder] = useState<Record<string, string[]>>({})
    const [dragParent, setDragParent] = useState<string | null>(null)
    const [dragOver, setDragOver] = useState<string | null>(null)

    const load = async (forceSummaries = false) => {
        try {
        const [stats, tagOrder] = await Promise.all([
            fetchKmsTagStats(),
            fetchKmsTagOrder(),
        ])

        let tagCount: Record<string, number> = hasUsableKmsTagStats(stats) ? stats.counts : {}
        if (forceSummaries || !hasUsableKmsTagStats(stats)) {
            const summaries = await fetchKmsNoteSummaries<{ id: string; hashtags?: string[] }>()
            tagCount = buildKmsTagStatsFromSummaries(summaries).counts
        }

        const parents: Record<string, TagInfo> = {}
        const allTags = Object.keys(tagCount).sort()
        allTags.forEach(tag => {
            const parts = tag.split('/')
            const parent = parts[0]
            if (!parents[parent]) parents[parent] = { name: parent, count: 0, children: [] }
            if (parts.length === 1) {
                parents[parent].count = tagCount[tag]
            } else {
                parents[parent].count += tagCount[tag]
                parents[parent].children.push({ name: tag, count: tagCount[tag], children: [] })
            }
        })

        let savedParentOrder: string[] = []
        let savedChildOrder: Record<string, string[]> = {}
        savedParentOrder = tagOrder.parentOrder
        savedChildOrder = tagOrder.childOrder

        const allParentNames = Object.keys(parents)
        const mergedParentOrder = [
            ...savedParentOrder.filter(n => allParentNames.includes(n)),
            ...allParentNames.filter(n => !savedParentOrder.includes(n)).sort((a, b) => a.localeCompare(b, 'zh-TW')),
        ]

        const mergedChildOrder: Record<string, string[]> = {}
        allParentNames.forEach(pName => {
            const childNames = parents[pName].children.map(c => c.name)
            const saved = savedChildOrder[pName] || []
            mergedChildOrder[pName] = [
                ...saved.filter(n => childNames.includes(n)),
                ...childNames.filter(n => !saved.includes(n)).sort((a, b) => a.localeCompare(b, 'zh-TW')),
            ]
        })

        setOrderBaseline(tagOrder)
        setParentOrder(mergedParentOrder)
        setChildOrder(mergedChildOrder)

        const sorted = mergedParentOrder
            .map(pName => {
                const p = parents[pName]
                if (!p) return null
                const sortedChildren = (mergedChildOrder[pName] || [])
                    .map(cName => p.children.find(c => c.name === cName))
                    .filter(Boolean) as TagInfo[]
                return { ...p, children: sortedChildren }
            })
            .filter(Boolean) as TagInfo[]

        setTagTree(sorted)
        setHasLoaded(true)
        } catch { setMsg('標籤讀取失敗，請重新整理後重試。') }
        finally { setLoading(false) }
    }

    useEffect(() => { load() }, [])

    const showMsg = (text: string) => {
        setMsg(text); setTimeout(() => setMsg(''), 3000)
    }

    const saveOrder = async (newParentOrder: string[], newChildOrder: Record<string, string[]>) => {
        await mutation.run(async session => {
            try {
                const next = { parentOrder: newParentOrder, childOrder: newChildOrder }
                await saveKmsTagOrder(next, orderBaseline, session)
                setOrderBaseline(next)
            } finally {
                invalidateKmsTagOrder()
                await load()
            }
        })
    }

    const moveParent = async (name: string, dir: -1 | 1) => {
        if (saving) return
        const idx = parentOrder.indexOf(name)
        if (idx < 0) return
        const newOrder = [...parentOrder]
        const swapIdx = idx + dir
        if (swapIdx < 0 || swapIdx >= newOrder.length) return
            ;[newOrder[idx], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[idx]]
        setParentOrder(newOrder)
        setTagTree(prev => newOrder.map(n => prev.find(t => t.name === n)).filter(Boolean) as TagInfo[])
        await saveOrder(newOrder, childOrder)
    }

    const moveChild = async (parentName: string, childName: string, dir: -1 | 1) => {
        if (saving) return
        const kids = childOrder[parentName] ? [...childOrder[parentName]] : []
        const idx = kids.indexOf(childName)
        if (idx < 0) return
        const swapIdx = idx + dir
        if (swapIdx < 0 || swapIdx >= kids.length) return
            ;[kids[idx], kids[swapIdx]] = [kids[swapIdx], kids[idx]]
        const newChildOrder = { ...childOrder, [parentName]: kids }
        setChildOrder(newChildOrder)
        setTagTree(prev => prev.map(p => {
            if (p.name !== parentName) return p
            const reorderedChildren = kids.map(n => p.children.find(c => c.name === n)).filter(Boolean) as TagInfo[]
            return { ...p, children: reorderedChildren }
        }))
        await saveOrder(parentOrder, newChildOrder)
    }

    const handleDragStart = (name: string) => setDragParent(name)
    const handleDragOver = (e: React.DragEvent, name: string) => {
        e.preventDefault(); setDragOver(name)
    }
    const handleDrop = async (targetName: string) => {
        if (saving) return
        if (!dragParent || dragParent === targetName) { setDragParent(null); setDragOver(null); return }
        const newOrder = [...parentOrder]
        const fromIdx = newOrder.indexOf(dragParent)
        const toIdx = newOrder.indexOf(targetName)
        if (fromIdx < 0 || toIdx < 0) return
        newOrder.splice(fromIdx, 1)
        newOrder.splice(toIdx, 0, dragParent)
        setParentOrder(newOrder)
        setTagTree(prev => newOrder.map(n => prev.find(t => t.name === n)).filter(Boolean) as TagInfo[])
        setDragParent(null); setDragOver(null)
        await saveOrder(newOrder, childOrder)
    }

    const handleRename = async (oldTag: string) => {
        const newTag = editValue.trim()
        if (!newTag || newTag === oldTag) { setEditingTag(null); return }
        await mutation.run(async session => {
            try {
                const result = await renameKmsTag(oldTag, newTag, orderBaseline, session)
                session.assertActive()
                setEditingTag(null)
                showMsg(`✅ 已更新 ${result.count} 則筆記的標籤`)
            } finally {
                invalidateKmsNotes(); invalidateKmsTagOrder()
                await load(true)
            }
        })
    }

    const toggleParent = (name: string) => {
        setExpandedParents(prev => {
            const next = new Set(prev)
            if (next.has(name)) next.delete(name); else next.add(name)
            return next
        })
    }

    const totalTags = tagTree.reduce((s, t) => s + 1 + t.children.length, 0)
    const totalNotes = tagTree.reduce((s, t) => s + (t.children.length > 0 ? t.children.reduce((cs, c) => cs + c.count, 0) : t.count), 0)

    return (
        <div className="kms-tags-page" style={{ padding: 'var(--ui-page-padding, clamp(16px, 3vw, 32px))', maxWidth: '900px', margin: '0 auto' }}>
            <div className="kms-tags-page-header" style={{ marginBottom: '16px' }}>
                <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>標籤管理</h1>
                <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>共 {totalTags} 個標籤・{totalNotes} 則筆記・可拖曳或點擊 ↑↓ 自訂排序</p>
            </div>

            {(mutation.error || msg) && (
                <div style={{ backgroundColor: 'rgba(0,200,150,0.1)', border: '1px solid rgba(0,200,150,0.3)', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', color: 'var(--c-positive)', fontSize: '13px' }}>
                    {mutation.error || msg}
                </div>
            )}

            <div className="kms-tags-card" style={card}>
                {loading && hasLoaded && <p className="ui-refresh-status" role="status">資料更新中…</p>}
                    {loading && !hasLoaded ? (
                    <LoadingState />
                ) : tagTree.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '48px', color: 'var(--c-muted)' }}>
                        <p>還沒有標籤</p>
                        <p style={{ fontSize: '13px', marginTop: '8px' }}>在知識庫新增筆記並加上標籤後會顯示在這裡</p>
                    </div>
                ) : (
                    <div>
                        <div className="kms-tags-heading" style={{ display: 'grid', gridTemplateColumns: '24px 1fr 60px auto', gap: '12px', padding: '8px 12px', borderBottom: '1px solid var(--c-border)', marginBottom: '4px' }}>
                            <span />
                            <span style={{ fontSize: '12px', color: 'var(--c-muted)', fontWeight: 500 }}>標籤名稱</span>
                            <span style={{ fontSize: '12px', color: 'var(--c-muted)', fontWeight: 500, textAlign: 'center' }}>筆記數</span>
                            <span style={{ fontSize: '12px', color: 'var(--c-muted)', fontWeight: 500 }}>操作</span>
                        </div>

                        {tagTree.map((parent, pIdx) => (
                            <div key={parent.name}
                                draggable
                                onDragStart={() => handleDragStart(parent.name)}
                                onDragOver={e => handleDragOver(e, parent.name)}
                                onDrop={() => handleDrop(parent.name)}
                                onDragEnd={() => { setDragParent(null); setDragOver(null) }}
                                style={{ opacity: dragParent === parent.name ? 0.5 : 1, outline: dragOver === parent.name && dragParent !== parent.name ? '2px dashed var(--c-accent)' : 'none', borderRadius: '8px' }}
                            >
                                <div className={`kms-tag-row${editingTag === parent.name ? ' is-editing' : ''}`} style={{ display: 'grid', gridTemplateColumns: '24px 1fr 60px auto', gap: '12px', padding: '10px 12px', borderRadius: '8px', alignItems: 'center', backgroundColor: 'rgba(245,166,35,0.04)', marginBottom: '2px' }}>
                                    <div style={{ color: '#4a5568', cursor: 'grab', display: 'flex', alignItems: 'center' }}>
                                        <GripVertical size={14} />
                                    </div>

                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        {parent.children.length > 0 ? (
                                            <button aria-label={`展開或收合 ${parent.name}`} aria-expanded={expandedParents.has(parent.name)} onClick={() => toggleParent(parent.name)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0, color: 'var(--c-warning)' }}>
                                                {expandedParents.has(parent.name) ? <FolderOpen size={15} /> : <FolderOpen size={15} style={{ opacity: 0.6 }} />}
                                            </button>
                                        ) : <Tag size={13} color="var(--c-muted)" />}

                                        {editingTag === parent.name ? (
                                            <div className="kms-tag-edit" style={{ display: 'flex', gap: '6px', flex: 1, minWidth: 0 }}>
                                                <input aria-label="標籤名稱" style={{ ...inp, flex: 1, minWidth: 0 }} value={editValue} onChange={e => setEditValue(e.target.value)}
                                                    onKeyDown={e => { if (e.key === 'Enter') handleRename(parent.name); if (e.key === 'Escape') setEditingTag(null) }}
                                                    autoFocus />
                                                <button aria-label="儲存標籤名稱" onClick={() => handleRename(parent.name)} disabled={saving}
                                                    style={{ background: 'none', border: 'none', color: 'var(--c-positive)', cursor: 'pointer' }}><Check size={15} /></button>
                                                <button aria-label="取消重新命名" onClick={() => setEditingTag(null)}
                                                    style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><X size={15} /></button>
                                            </div>
                                        ) : (
                                            <span style={{ fontSize: '14px', color: 'var(--c-text)', fontWeight: 600 }}>{parent.name}</span>
                                        )}

                                        {parent.children.length > 0 && (
                                            <button aria-label={`展開或收合 ${parent.name}`} aria-expanded={expandedParents.has(parent.name)} onClick={() => toggleParent(parent.name)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
                                                <ChevronRight size={13} color="var(--c-muted)" style={{ transform: expandedParents.has(parent.name) ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }} />
                                            </button>
                                        )}
                                    </div>

                                    <span style={{ fontSize: '13px', color: 'var(--c-muted)', textAlign: 'center' }}>
                                        {parent.children.length > 0 ? parent.children.reduce((s, c) => s + c.count, 0) : parent.count}
                                    </span>

                                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                                        <button onClick={() => moveParent(parent.name, -1)} disabled={pIdx === 0}
                                            title="上移" style={{ background: 'none', border: 'none', color: pIdx === 0 ? 'var(--c-border)' : 'var(--c-muted)', cursor: pIdx === 0 ? 'default' : 'pointer', padding: '2px', display: 'flex' }}>
                                            <ChevronUp size={14} />
                                        </button>
                                        <button onClick={() => moveParent(parent.name, 1)} disabled={pIdx === tagTree.length - 1}
                                            title="下移" style={{ background: 'none', border: 'none', color: pIdx === tagTree.length - 1 ? 'var(--c-border)' : 'var(--c-muted)', cursor: pIdx === tagTree.length - 1 ? 'default' : 'pointer', padding: '2px', display: 'flex' }}>
                                            <ChevronDown size={14} />
                                        </button>
                                        {editingTag !== parent.name && (
                                            <button className="kms-tag-rename" aria-label={`重新命名 ${parent.name}`} title="重新命名" onClick={() => { setEditingTag(parent.name); setEditValue(parent.name) }}
                                                style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: 'transparent', border: '1px solid var(--c-border)', borderRadius: '6px', padding: '4px 10px', color: 'var(--c-muted)', fontSize: '12px', cursor: 'pointer' }}>
                                                <Pencil size={12} /><span>重新命名</span>
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {expandedParents.has(parent.name) && parent.children.map((child, cIdx) => (
                                    <div className={`kms-tag-row kms-tag-child${editingTag === child.name ? ' is-editing' : ''}`} key={child.name} style={{ display: 'grid', gridTemplateColumns: '24px 1fr 60px auto', gap: '12px', padding: '8px 12px 8px 36px', borderRadius: '8px', alignItems: 'center', marginBottom: '2px' }}>
                                        <div />
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <ChevronRight size={11} color="var(--c-muted)" style={{ opacity: 0.4 }} />
                                            {editingTag === child.name ? (
                                                <div className="kms-tag-edit" style={{ display: 'flex', gap: '6px', flex: 1, minWidth: 0 }}>
                                                    <input aria-label="標籤名稱" style={{ ...inp, flex: 1, minWidth: 0 }} value={editValue} onChange={e => setEditValue(e.target.value)}
                                                        onKeyDown={e => { if (e.key === 'Enter') handleRename(child.name); if (e.key === 'Escape') setEditingTag(null) }}
                                                        autoFocus />
                                                    <button aria-label="儲存標籤名稱" onClick={() => handleRename(child.name)} disabled={saving}
                                                        style={{ background: 'none', border: 'none', color: 'var(--c-positive)', cursor: 'pointer' }}><Check size={15} /></button>
                                                    <button aria-label="取消重新命名" onClick={() => setEditingTag(null)}
                                                        style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><X size={15} /></button>
                                                </div>
                                            ) : (
                                                <span style={{ fontSize: '13px', color: 'var(--c-muted)' }}>{child.name.split('/').slice(1).join('/')}</span>
                                            )}
                                        </div>
                                        <span style={{ fontSize: '13px', color: 'var(--c-muted)', textAlign: 'center' }}>{child.count}</span>
                                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                                            <button onClick={() => moveChild(parent.name, child.name, -1)} disabled={cIdx === 0}
                                                title="上移" style={{ background: 'none', border: 'none', color: cIdx === 0 ? 'var(--c-border)' : 'var(--c-muted)', cursor: cIdx === 0 ? 'default' : 'pointer', padding: '2px', display: 'flex' }}>
                                                <ChevronUp size={14} />
                                            </button>
                                            <button onClick={() => moveChild(parent.name, child.name, 1)} disabled={cIdx === parent.children.length - 1}
                                                title="下移" style={{ background: 'none', border: 'none', color: cIdx === parent.children.length - 1 ? 'var(--c-border)' : 'var(--c-muted)', cursor: cIdx === parent.children.length - 1 ? 'default' : 'pointer', padding: '2px', display: 'flex' }}>
                                                <ChevronDown size={14} />
                                            </button>
                                            {editingTag !== child.name && (
                                                <button className="kms-tag-rename" aria-label={`重新命名 ${child.name}`} title="重新命名" onClick={() => { setEditingTag(child.name); setEditValue(child.name) }}
                                                    style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: 'transparent', border: '1px solid var(--c-border)', borderRadius: '6px', padding: '4px 10px', color: 'var(--c-muted)', fontSize: '12px', cursor: 'pointer' }}>
                                                    <Pencil size={12} /><span>重新命名</span>
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
