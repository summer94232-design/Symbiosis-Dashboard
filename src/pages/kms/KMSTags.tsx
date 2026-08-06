import { useState, useEffect } from 'react'
import { updateDoc, setDoc } from 'firebase/firestore'
import { kmsDB } from '../../lib/firebase'
import { userDoc, userDocNested } from '../../lib/userDB'
import { fetchKmsNoteSummaries, fetchKmsTagOrder, fetchKmsTagStats, invalidateKmsNotes, invalidateKmsTagOrder } from '../../lib/kmsData'
import { Pencil, Check, X, Tag, FolderOpen, ChevronRight, ChevronUp, ChevronDown, GripVertical } from 'lucide-react'
import { buildKmsSearchTerms, buildKmsTagPaths } from '../../lib/kmsSearch'

interface TagInfo {
    name: string
    count: number
    children: TagInfo[]
}

const card: React.CSSProperties = { backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '6px 10px', color: 'var(--c-text)', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }

const TAG_ORDER_DOC = 'tagOrder'

export default function KMSTags() {
    const [tagTree, setTagTree] = useState<TagInfo[]>([])
    const [loading, setLoading] = useState(true)
    const [editingTag, setEditingTag] = useState<string | null>(null)
    const [editValue, setEditValue] = useState('')
    const [saving, setSaving] = useState(false)
    const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
    const [msg, setMsg] = useState('')
    const [parentOrder, setParentOrder] = useState<string[]>([])
    const [childOrder, setChildOrder] = useState<Record<string, string[]>>({})
    const [dragParent, setDragParent] = useState<string | null>(null)
    const [dragOver, setDragOver] = useState<string | null>(null)

    const load = async () => {
        setLoading(true)
        const [stats, tagOrder] = await Promise.all([
            fetchKmsTagStats(),
            fetchKmsTagOrder(),
        ])

        let tagCount: Record<string, number> = stats?.counts || {}
        if (!stats) {
            const summaries = await fetchKmsNoteSummaries<{ id: string; hashtags?: string[] }>()
            tagCount = {}
            summaries.forEach(note => note.hashtags?.forEach(tag => { tagCount[tag] = (tagCount[tag] || 0) + 1 }))
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
        setLoading(false)
    }

    useEffect(() => { load() }, [])

    const showMsg = (text: string) => {
        setMsg(text); setTimeout(() => setMsg(''), 3000)
    }

    const saveOrder = async (newParentOrder: string[], newChildOrder: Record<string, string[]>) => {
        try {
            await setDoc(userDocNested(kmsDB, 'settings', TAG_ORDER_DOC), {
                parentOrder: newParentOrder,
                childOrder: newChildOrder,
                updatedAt: new Date().toISOString(),
            })
            invalidateKmsTagOrder()
        } catch (e) {
            console.error('儲存標籤排序失敗', e)
        }
    }

    const moveParent = async (name: string, dir: -1 | 1) => {
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
        if (!editValue.trim() || editValue.trim() === oldTag) { setEditingTag(null); return }
        setSaving(true)
        const newTag = editValue.trim()
        // 同時處理子標籤：把「投資」改名為「理財」時，「投資/台股」也要變成「理財/台股」，
        // 否則標籤樹會裂成「理財」與「投資/...」兩組。
        const renameTag = (t: string) =>
            t === oldTag ? newTag
                : t.startsWith(oldTag + '/') ? newTag + t.slice(oldTag.length)
                    : t
        const notes = await fetchKmsNoteSummaries<{ id: string; title?: string; hashtags?: string[] }>()
        let updated = 0
        const batch: Promise<void>[] = []
        notes.forEach(note => {
            if (note.hashtags?.some((t: string) => t === oldTag || t.startsWith(oldTag + '/'))) {
                const newHashtags = note.hashtags.map((t: string) => renameTag(t))
                batch.push(updateDoc(userDoc(kmsDB, 'notes', note.id), {
                    hashtags: newHashtags,
                    searchTerms: buildKmsSearchTerms(note.title || '', newHashtags),
                    tagPaths: buildKmsTagPaths(newHashtags),
                    isUntagged: newHashtags.length === 0,
                }))
                updated++
            }
        })
        await Promise.all(batch)
        invalidateKmsNotes()
        const newParentOrder = parentOrder.map(n => renameTag(n))
        const newChildOrder: Record<string, string[]> = {}
        Object.entries(childOrder).forEach(([pk, kids]) => {
            const newPk = renameTag(pk)
            newChildOrder[newPk] = kids.map(k => renameTag(k))
        })
        setParentOrder(newParentOrder)
        setChildOrder(newChildOrder)
        await saveOrder(newParentOrder, newChildOrder)
        setSaving(false); setEditingTag(null)
        showMsg(`✅ 已將「${oldTag}」重新命名為「${editValue.trim()}」，共更新 ${updated} 則筆記`)
        load()
    }

    const handleMerge = async (fromTag: string, toTag: string) => {
        if (!toTag.trim() || fromTag === toTag.trim()) return
        if (!confirm(`確定要將「${fromTag}」合併到「${toTag}」？`)) return
        setSaving(true)
        const target = toTag.trim()
        // 子標籤一併合併：from/xxx → to/xxx
        const mergeTag = (t: string) =>
            t === fromTag ? target
                : t.startsWith(fromTag + '/') ? target + t.slice(fromTag.length)
                    : t
        const notes = await fetchKmsNoteSummaries<{ id: string; title?: string; hashtags?: string[] }>()
        const batch: Promise<void>[] = []
        notes.forEach(note => {
            if (note.hashtags?.some((t: string) => t === fromTag || t.startsWith(fromTag + '/'))) {
                const newHashtags = [...new Set(note.hashtags.map((t: string) => mergeTag(t)))]
                batch.push(updateDoc(userDoc(kmsDB, 'notes', note.id), {
                    hashtags: newHashtags,
                    searchTerms: buildKmsSearchTerms(note.title || '', newHashtags),
                    tagPaths: buildKmsTagPaths(newHashtags),
                    isUntagged: newHashtags.length === 0,
                }))
            }
        })
        await Promise.all(batch)
        invalidateKmsNotes()
        setSaving(false)
        showMsg(`✅ 已將「${fromTag}」合併到「${toTag}」`)
        load()
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
        <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '900px', margin: '0 auto' }}>
            <div style={{ marginBottom: '24px' }}>
                <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>標籤管理</h1>
                <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>共 {totalTags} 個標籤・{totalNotes} 則筆記・可拖曳或點擊 ↑↓ 自訂排序</p>
            </div>

            {msg && (
                <div style={{ backgroundColor: 'rgba(0,200,150,0.1)', border: '1px solid rgba(0,200,150,0.3)', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', color: 'var(--c-positive)', fontSize: '13px' }}>
                    {msg}
                </div>
            )}

            <div style={card}>
                {loading ? (
                    <div style={{ textAlign: 'center', padding: '48px', color: 'var(--c-muted)' }}>載入中...</div>
                ) : tagTree.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '48px', color: 'var(--c-muted)' }}>
                        <p>還沒有標籤</p>
                        <p style={{ fontSize: '13px', marginTop: '8px' }}>在知識庫新增筆記並加上標籤後會顯示在這裡</p>
                    </div>
                ) : (
                    <div>
                        <div style={{ display: 'grid', gridTemplateColumns: '24px 1fr 60px auto', gap: '12px', padding: '8px 12px', borderBottom: '1px solid var(--c-border)', marginBottom: '4px' }}>
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
                                <div style={{ display: 'grid', gridTemplateColumns: '24px 1fr 60px auto', gap: '12px', padding: '10px 12px', borderRadius: '8px', alignItems: 'center', backgroundColor: 'rgba(245,166,35,0.04)', marginBottom: '2px' }}>
                                    <div style={{ color: '#4a5568', cursor: 'grab', display: 'flex', alignItems: 'center' }}>
                                        <GripVertical size={14} />
                                    </div>

                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        {parent.children.length > 0 ? (
                                            <button onClick={() => toggleParent(parent.name)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0, color: 'var(--c-warning)' }}>
                                                {expandedParents.has(parent.name) ? <FolderOpen size={15} /> : <FolderOpen size={15} style={{ opacity: 0.6 }} />}
                                            </button>
                                        ) : <Tag size={13} color="var(--c-muted)" />}

                                        {editingTag === parent.name ? (
                                            <div style={{ display: 'flex', gap: '6px', flex: 1 }}>
                                                <input style={{ ...inp, flex: 1 }} value={editValue} onChange={e => setEditValue(e.target.value)}
                                                    onKeyDown={e => { if (e.key === 'Enter') handleRename(parent.name); if (e.key === 'Escape') setEditingTag(null) }}
                                                    autoFocus />
                                                <button onClick={() => handleRename(parent.name)} disabled={saving}
                                                    style={{ background: 'none', border: 'none', color: 'var(--c-positive)', cursor: 'pointer' }}><Check size={15} /></button>
                                                <button onClick={() => setEditingTag(null)}
                                                    style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><X size={15} /></button>
                                            </div>
                                        ) : (
                                            <span style={{ fontSize: '14px', color: 'var(--c-text)', fontWeight: 600 }}>{parent.name}</span>
                                        )}

                                        {parent.children.length > 0 && (
                                            <button onClick={() => toggleParent(parent.name)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
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
                                            <button onClick={() => { setEditingTag(parent.name); setEditValue(parent.name) }}
                                                style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: 'transparent', border: '1px solid var(--c-border)', borderRadius: '6px', padding: '4px 10px', color: 'var(--c-muted)', fontSize: '12px', cursor: 'pointer' }}>
                                                <Pencil size={12} />重新命名
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {expandedParents.has(parent.name) && parent.children.map((child, cIdx) => (
                                    <div key={child.name} style={{ display: 'grid', gridTemplateColumns: '24px 1fr 60px auto', gap: '12px', padding: '8px 12px 8px 36px', borderRadius: '8px', alignItems: 'center', marginBottom: '2px' }}>
                                        <div />
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <ChevronRight size={11} color="var(--c-muted)" style={{ opacity: 0.4 }} />
                                            {editingTag === child.name ? (
                                                <div style={{ display: 'flex', gap: '6px', flex: 1 }}>
                                                    <input style={{ ...inp, flex: 1 }} value={editValue} onChange={e => setEditValue(e.target.value)}
                                                        onKeyDown={e => { if (e.key === 'Enter') handleRename(child.name); if (e.key === 'Escape') setEditingTag(null) }}
                                                        autoFocus />
                                                    <button onClick={() => handleRename(child.name)} disabled={saving}
                                                        style={{ background: 'none', border: 'none', color: 'var(--c-positive)', cursor: 'pointer' }}><Check size={15} /></button>
                                                    <button onClick={() => setEditingTag(null)}
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
                                                <button onClick={() => { setEditingTag(child.name); setEditValue(child.name) }}
                                                    style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: 'transparent', border: '1px solid var(--c-border)', borderRadius: '6px', padding: '4px 10px', color: 'var(--c-muted)', fontSize: '12px', cursor: 'pointer' }}>
                                                    <Pencil size={12} />重新命名
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
