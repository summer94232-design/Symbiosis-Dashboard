import { useState, useEffect } from 'react'
import { collection, getDocs, updateDoc, doc, query } from 'firebase/firestore'
import { kmsDB } from '../../lib/firebase'
import { userCol } from '../../lib/userDB'
import { Pencil, Check, X, Tag, FolderOpen, ChevronRight } from 'lucide-react'

interface TagInfo {
  name: string
  count: number
  children: TagInfo[]
}

const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '6px 10px', color: '#e2e8f0', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }

export default function KMSTags() {
  const [tagTree, setTagTree] = useState<TagInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [editingTag, setEditingTag] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [msg, setMsg] = useState('')

  const load = async () => {
    setLoading(true)
    const snap = await getDocs(userCol(kmsDB, 'notes'))
    const tagCount: Record<string, number> = {}
    snap.docs.forEach(d => {
      const data = d.data()
      data.hashtags?.forEach((t: string) => {
        tagCount[t] = (tagCount[t] || 0) + 1
      })
    })

    // 建立樹狀結構
    const parents: Record<string, TagInfo> = {}
    const allTags = Object.keys(tagCount).sort()

    allTags.forEach(tag => {
      const parts = tag.split('/')
      const parent = parts[0]
      if (!parents[parent]) {
        parents[parent] = { name: parent, count: 0, children: [] }
      }
      if (parts.length === 1) {
        parents[parent].count = tagCount[tag]
      } else {
        parents[parent].count += tagCount[tag]
        parents[parent].children.push({ name: tag, count: tagCount[tag], children: [] })
      }
    })

    setTagTree(Object.values(parents).sort((a, b) => a.name.localeCompare(b.name, 'zh-TW')))
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const showMsg = (text: string) => {
    setMsg(text); setTimeout(() => setMsg(''), 3000)
  }

  // 重新命名標籤（批次更新所有筆記）
  const handleRename = async (oldTag: string) => {
    if (!editValue.trim() || editValue.trim() === oldTag) { setEditingTag(null); return }
    setSaving(true)
    const snap = await getDocs(query(userCol(kmsDB, 'notes')))
    let updated = 0
    const batch: Promise<void>[] = []
    snap.docs.forEach(d => {
      const data = d.data()
      if (data.hashtags?.includes(oldTag)) {
        const newHashtags = data.hashtags.map((t: string) => t === oldTag ? editValue.trim() : t)
        batch.push(updateDoc(userDoc(kmsDB, 'notes', d.id), { hashtags: newHashtags }))
        updated++
      }
    })
    await Promise.all(batch)
    setSaving(false); setEditingTag(null)
    showMsg(`✅ 已將「${oldTag}」重新命名為「${editValue.trim()}」，共更新 ${updated} 則筆記`)
    load()
  }

  // 合併標籤（把舊標籤改成新標籤名稱）
  const handleMerge = async (fromTag: string, toTag: string) => {
    if (!toTag.trim() || fromTag === toTag.trim()) return
    if (!confirm(`確定要將「${fromTag}」合併到「${toTag}」？`)) return
    setSaving(true)
    const snap = await getDocs(query(userCol(kmsDB, 'notes')))
    const batch: Promise<void>[] = []
    snap.docs.forEach(d => {
      const data = d.data()
      if (data.hashtags?.includes(fromTag)) {
        const newHashtags = [...new Set(data.hashtags.map((t: string) => t === fromTag ? toTag.trim() : t))]
        batch.push(updateDoc(userDoc(kmsDB, 'notes', d.id), { hashtags: newHashtags }))
      }
    })
    await Promise.all(batch)
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
        <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>標籤管理</h1>
        <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>共 {totalTags} 個標籤・{totalNotes} 則筆記</p>
      </div>

      {msg && (
        <div style={{ backgroundColor: 'rgba(0,200,150,0.1)', border: '1px solid rgba(0,200,150,0.3)', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', color: '#00c896', fontSize: '13px' }}>
          {msg}
        </div>
      )}

      <div style={card}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>載入中...</div>
        ) : tagTree.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>
            <p>還沒有標籤</p>
            <p style={{ fontSize: '13px', marginTop: '8px' }}>在知識庫新增筆記並加上標籤後會顯示在這裡</p>
          </div>
        ) : (
          <div>
            {/* 表頭 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 200px', gap: '12px', padding: '8px 12px', borderBottom: '1px solid #2e3349', marginBottom: '4px' }}>
              <span style={{ fontSize: '12px', color: '#8892a4', fontWeight: 500 }}>標籤名稱</span>
              <span style={{ fontSize: '12px', color: '#8892a4', fontWeight: 500, textAlign: 'center' }}>筆記數</span>
              <span style={{ fontSize: '12px', color: '#8892a4', fontWeight: 500 }}>操作</span>
            </div>

            {tagTree.map(parent => (
              <div key={parent.name}>
                {/* 母標籤列 */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 200px', gap: '12px', padding: '10px 12px', borderRadius: '8px', alignItems: 'center', backgroundColor: 'rgba(245,166,35,0.04)', marginBottom: '2px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {parent.children.length > 0 ? (
                      <button onClick={() => toggleParent(parent.name)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0, color: '#f5a623' }}>
                        {expandedParents.has(parent.name) ? <FolderOpen size={15} /> : <FolderOpen size={15} style={{ opacity: 0.6 }} />}
                      </button>
                    ) : <Tag size={13} color="#8892a4" />}

                    {editingTag === parent.name ? (
                      <div style={{ display: 'flex', gap: '6px', flex: 1 }}>
                        <input style={{ ...inp, flex: 1 }} value={editValue} onChange={e => setEditValue(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleRename(parent.name); if (e.key === 'Escape') setEditingTag(null) }}
                          autoFocus />
                        <button onClick={() => handleRename(parent.name)} disabled={saving}
                          style={{ background: 'none', border: 'none', color: '#00c896', cursor: 'pointer' }}><Check size={15} /></button>
                        <button onClick={() => setEditingTag(null)}
                          style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><X size={15} /></button>
                      </div>
                    ) : (
                      <span style={{ fontSize: '14px', color: '#e2e8f0', fontWeight: 600 }}>{parent.name}</span>
                    )}

                    {parent.children.length > 0 && (
                      <button onClick={() => toggleParent(parent.name)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
                        <ChevronRight size={13} color="#8892a4" style={{ transform: expandedParents.has(parent.name) ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }} />
                      </button>
                    )}
                  </div>

                  <span style={{ fontSize: '13px', color: '#8892a4', textAlign: 'center' }}>
                    {parent.children.length > 0 ? parent.children.reduce((s, c) => s + c.count, 0) : parent.count}
                  </span>

                  <div style={{ display: 'flex', gap: '8px' }}>
                    {editingTag !== parent.name && (
                      <button onClick={() => { setEditingTag(parent.name); setEditValue(parent.name) }}
                        style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: 'transparent', border: '1px solid #2e3349', borderRadius: '6px', padding: '4px 10px', color: '#8892a4', fontSize: '12px', cursor: 'pointer' }}>
                        <Pencil size={12} />重新命名
                      </button>
                    )}
                  </div>
                </div>

                {/* 子標籤列 */}
                {expandedParents.has(parent.name) && parent.children.map(child => (
                  <div key={child.name} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 200px', gap: '12px', padding: '8px 12px 8px 36px', borderRadius: '8px', alignItems: 'center', marginBottom: '2px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <ChevronRight size={11} color="#8892a4" style={{ opacity: 0.4 }} />
                      {editingTag === child.name ? (
                        <div style={{ display: 'flex', gap: '6px', flex: 1 }}>
                          <input style={{ ...inp, flex: 1 }} value={editValue} onChange={e => setEditValue(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleRename(child.name); if (e.key === 'Escape') setEditingTag(null) }}
                            autoFocus />
                          <button onClick={() => handleRename(child.name)} disabled={saving}
                            style={{ background: 'none', border: 'none', color: '#00c896', cursor: 'pointer' }}><Check size={15} /></button>
                          <button onClick={() => setEditingTag(null)}
                            style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><X size={15} /></button>
                        </div>
                      ) : (
                        <span style={{ fontSize: '13px', color: '#8892a4' }}>{child.name.split('/').slice(1).join('/')}</span>
                      )}
                    </div>
                    <span style={{ fontSize: '13px', color: '#8892a4', textAlign: 'center' }}>{child.count}</span>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      {editingTag !== child.name && (
                        <button onClick={() => { setEditingTag(child.name); setEditValue(child.name) }}
                          style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: 'transparent', border: '1px solid #2e3349', borderRadius: '6px', padding: '4px 10px', color: '#8892a4', fontSize: '12px', cursor: 'pointer' }}>
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