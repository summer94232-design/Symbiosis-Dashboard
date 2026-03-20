import { useState, useEffect } from 'react'
import { collection, getDocs, updateDoc, deleteDoc, doc, query, orderBy } from 'firebase/firestore'
import { kmsDB } from '../../lib/firebase'
import { Trash2, RotateCcw, FileText, Link, Image } from 'lucide-react'

interface Note {
  id: string
  title: string
  content: string
  type: 'note' | 'url' | 'image' | 'file'
  hashtags: string[]
  deletedAt: string
  createdAt: string
}

const TYPE_ICONS: Record<string, any> = { note: FileText, url: Link, image: Image, file: FileText }
const TYPE_LABELS: Record<string, string> = { note: '文字筆記', url: '網址收藏', image: '圖片', file: '文件' }
const TYPE_COLORS: Record<string, string> = { note: '#4f8ef7', url: '#00c896', image: '#f5a623', file: '#a78bfa' }
const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }

export default function KMSTrash() {
  const [trashed, setTrashed] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    const q = query(collection(kmsDB, 'trash'), orderBy('deletedAt', 'desc'))
    const snap = await getDocs(q)
    const now = Date.now()
    const data: Note[] = []
    const toDelete: Promise<void>[] = []

    snap.docs.forEach(d => {
      const item = { id: d.id, ...d.data() } as Note
      const deletedTime = new Date(item.deletedAt).getTime()
      // 超過 30 天自動永久刪除
      if (now - deletedTime > 30 * 24 * 60 * 60 * 1000) {
        toDelete.push(deleteDoc(doc(kmsDB, 'trash', d.id)))
      } else {
        data.push(item)
      }
    })

    await Promise.all(toDelete)
    setTrashed(data)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // 復原筆記
  const handleRestore = async (note: Note) => {
    const { id, ...data } = note
    const { deletedAt, ...noteData } = data as any
    await updateDoc(doc(kmsDB, 'notes', id), { ...noteData, updatedAt: new Date().toISOString() }).catch(async () => {
      // 如果 notes 中沒有此 id，重新新增
      const { addDoc } = await import('firebase/firestore')
      await addDoc(collection(kmsDB, 'notes'), { ...noteData, updatedAt: new Date().toISOString() })
    })
    await deleteDoc(doc(kmsDB, 'trash', id))
    load()
  }

  // 永久刪除
  const handlePermanentDelete = async (id: string) => {
    if (!confirm('確定要永久刪除？此操作無法復原。')) return
    await deleteDoc(doc(kmsDB, 'trash', id))
    load()
  }

  // 清空垃圾桶
  const handleEmptyTrash = async () => {
    if (!confirm(`確定要清空垃圾桶？共 ${trashed.length} 則筆記將永久刪除。`)) return
    await Promise.all(trashed.map(n => deleteDoc(doc(kmsDB, 'trash', n.id))))
    setTrashed([])
  }

  const getDaysLeft = (deletedAt: string) => {
    const days = 30 - Math.floor((Date.now() - new Date(deletedAt).getTime()) / (24 * 60 * 60 * 1000))
    return Math.max(0, days)
  }

  return (
    <>
      <style>{`
        .trash-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
        @media (max-width: 700px) { .trash-grid { grid-template-columns: 1fr; } }
      `}</style>

      <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1400px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>垃圾桶</h1>
            <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>
              共 {trashed.length} 則筆記・30 天後自動永久刪除
            </p>
          </div>
          {trashed.length > 0 && (
            <button onClick={handleEmptyTrash} style={{ backgroundColor: 'rgba(255,87,87,0.12)', border: '1px solid rgba(255,87,87,0.3)', borderRadius: '8px', padding: '8px 16px', color: '#ff5757', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Trash2 size={15} />清空垃圾桶
            </button>
          )}
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '64px', color: '#8892a4' }}>載入中...</div>
        ) : trashed.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px', color: '#8892a4' }}>
            <Trash2 size={40} style={{ opacity: 0.3, marginBottom: '12px' }} />
            <p style={{ fontSize: '15px' }}>垃圾桶是空的</p>
          </div>
        ) : (
          <div className="trash-grid">
            {trashed.map(note => {
              const Icon = TYPE_ICONS[note.type] || FileText
              const color = TYPE_COLORS[note.type] || '#4f8ef7'
              const daysLeft = getDaysLeft(note.deletedAt)
              return (
                <div key={note.id} style={{ ...card, opacity: 0.85 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ backgroundColor: `${color}18`, borderRadius: '8px', padding: '6px', display: 'flex' }}>
                        <Icon size={14} color={color} />
                      </div>
                      <span style={{ fontSize: '11px', color, fontWeight: 600 }}>{TYPE_LABELS[note.type]}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button onClick={() => handleRestore(note)} title="復原"
                        style={{ background: 'none', border: '1px solid #2e3349', borderRadius: '6px', color: '#00c896', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
                        <RotateCcw size={13} />復原
                      </button>
                      <button onClick={() => handlePermanentDelete(note.id)} title="永久刪除"
                        style={{ background: 'none', border: 'none', color: '#ff5757', cursor: 'pointer', padding: '4px' }}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  <h3 style={{ margin: '0 0 8px', fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>{note.title}</h3>

                  {note.content && (
                    <p style={{ margin: '0 0 8px', fontSize: '12px', color: '#8892a4', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {note.content}
                    </p>
                  )}

                  {note.hashtags?.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '8px' }}>
                      {note.hashtags.map(tag => (
                        <span key={tag} style={{ backgroundColor: 'rgba(79,142,247,0.08)', color: '#4f8ef7', borderRadius: '20px', padding: '2px 8px', fontSize: '11px' }}>
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <div style={{ fontSize: '11px', color: daysLeft <= 7 ? '#ff5757' : '#8892a4', borderTop: '1px solid #2e3349', paddingTop: '8px' }}>
                    {daysLeft <= 7 ? `⚠️ 還有 ${daysLeft} 天永久刪除` : `${daysLeft} 天後永久刪除`}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}