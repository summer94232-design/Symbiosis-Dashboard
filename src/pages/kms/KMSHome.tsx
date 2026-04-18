import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { collection, addDoc, getDocs, updateDoc, deleteDoc, doc, orderBy, query } from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { kmsDB, kmsStorage } from '../../lib/firebase'
import { userCol, userDoc, userDocNested } from '../../lib/userDB'
import { generateHashtags, findRelatedNotes } from '../../lib/gemini'
import { Plus, Search, Pencil, Trash2, X, Check, Link, FileText, Image, Sparkles, ChevronDown, ChevronUp, ArrowUpDown, Link2, Upload } from 'lucide-react'
import * as mammoth from 'mammoth'

interface Note {
    id?: string
    title: string
    content: string
    type: 'note' | 'url' | 'image' | 'file'
    url?: string
    imageUrl?: string
    fileUrl?: string
    fileName?: string
    hashtags: string[]
    links?: string[]
    createdAt: string
    updatedAt: string
}

interface Props {
    selectedTag: string
    setSelectedTag: (tag: string) => void
}

const empty: Note = { title: '', content: '', type: 'note', hashtags: [], links: [], createdAt: '', updatedAt: '' }
const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

const TYPE_ICONS: Record<string, any> = { note: FileText, url: Link, image: Image, file: FileText }
const TYPE_LABELS: Record<string, string> = { note: '文字筆記', url: '網址收藏', image: '圖片', file: '文件' }
const TYPE_COLORS: Record<string, string> = { note: '#4f8ef7', url: '#00c896', image: '#f5a623', file: '#a78bfa' }

export default function KMSHome({ selectedTag, setSelectedTag }: Props) {
    const [searchParams] = useSearchParams()
    const [notes, setNotes] = useState<Note[]>([])
    const [showForm, setShowForm] = useState(false)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [form, setForm] = useState<Note>(empty)
    const [loading, setLoading] = useState(false)
    const [aiLoading, setAiLoading] = useState(false)
    const [aiLinkLoading, setAiLinkLoading] = useState(false)
    const [search, setSearch] = useState('')
    const [expandedId, setExpandedId] = useState<string | null>(null)
    const [newTag, setNewTag] = useState('')
    const [uploading, setUploading] = useState(false)
    const [allTags, setAllTags] = useState<string[]>([])
    const [sortBy, setSortBy] = useState<'createdAt' | 'updatedAt' | 'title'>('createdAt')
    const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')
    const [showLinkPicker, setShowLinkPicker] = useState(false)
    const [linkSearch, setLinkSearch] = useState('')
    const [showImport, setShowImport] = useState(false)
    const [importMsg, setImportMsg] = useState('')
    const [importing, setImporting] = useState(false)
    const fileRef = useRef<HTMLInputElement>(null)
    const imgRef = useRef<HTMLInputElement>(null)
    const importFileRef = useRef<HTMLInputElement>(null)
    const noteRefs = useRef<Record<string, HTMLDivElement | null>>({})

    const load = async () => {
        const q = query(userCol(kmsDB, 'notes'), orderBy('createdAt', 'desc'))
        const snap = await getDocs(q)
        const data = snap.docs.map(d => ({ id: d.id, ...d.data() } as Note))
        setNotes(data)
        const tags = new Set<string>()
        data.forEach(n => n.hashtags?.forEach(t => tags.add(t)))
        setAllTags(Array.from(tags).sort())
    }

    useEffect(() => { load() }, [])

    useEffect(() => {
        const noteId = searchParams.get('note')
        if (noteId) {
            setExpandedId(noteId)
            setTimeout(() => {
                const el = noteRefs.current[noteId]
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }, 300)
        }
    }, [searchParams])

    const handleAutoTag = async () => {
        if (!form.content && !form.title && !form.url) return
        setAiLoading(true)
        const tags = await generateHashtags(form.content || form.url || '', form.title, allTags)
        setForm(f => ({ ...f, hashtags: tags }))
        setAiLoading(false)
    }

    // AI 自動找相關筆記
    const handleAILinks = async () => {
        if (!form.title && !form.content) return
        setAiLinkLoading(true)
        const otherNotes = notes
            .filter(n => n.id !== editingId)
            .map(n => ({ id: n.id!, title: n.title, content: n.content || '' }))
        const relatedIds = await findRelatedNotes(form.title, form.content, otherNotes)
        // 合併現有連結
        const merged = [...new Set([...(form.links || []), ...relatedIds])]
        setForm(f => ({ ...f, links: merged }))
        setAiLinkLoading(false)
    }

    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]; if (!file) return
        setUploading(true)
        const storageRef = ref(kmsStorage, `images/${Date.now()}_${file.name}`)
        await uploadBytes(storageRef, file)
        const url = await getDownloadURL(storageRef)
        setForm(f => ({ ...f, imageUrl: url, type: 'image' }))
        setUploading(false)
    }

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]; if (!file) return
        setUploading(true)
        try {
            let extractedText = ''
            if (file.name.endsWith('.docx')) {
                const buf = await file.arrayBuffer()
                extractedText = (await mammoth.extractRawText({ arrayBuffer: buf })).value
            }
            const storageRef = ref(kmsStorage, `files/${Date.now()}_${file.name}`)
            await uploadBytes(storageRef, file)
            const fileUrl = await getDownloadURL(storageRef)
            setForm(f => ({ ...f, type: 'file', fileUrl, fileName: file.name, content: extractedText || f.content }))
        } catch (err) { console.error(err) }
        setUploading(false)
    }

    const handleSave = async () => {
        if (!form.title) return
        setLoading(true)
        const now = new Date().toISOString()

        // 雙向連結：更新被連結的筆記也加入反向連結
        const oldLinks = editingId ? (notes.find(n => n.id === editingId)?.links || []) : []
        const newLinks = form.links || []
        const addedLinks = newLinks.filter(id => !oldLinks.includes(id))
        const removedLinks = oldLinks.filter(id => !newLinks.includes(id))

        if (editingId) {
            await updateDoc(userDoc(kmsDB, 'notes', editingId), { ...form, updatedAt: now })
        } else {
            const docRef = await addDoc(userCol(kmsDB, 'notes'), { ...form, createdAt: now, updatedAt: now })
            // 新筆記的 id
            const newId = docRef.id
            // 更新被連結的筆記加入反向連結
            for (const linkedId of newLinks) {
                const linkedNote = notes.find(n => n.id === linkedId)
                if (linkedNote) {
                    const updatedLinks = [...new Set([...(linkedNote.links || []), newId])]
                    await updateDoc(userDoc(kmsDB, 'notes', linkedId), { links: updatedLinks })
                }
            }
            setShowForm(false); setEditingId(null); setForm(empty); setLoading(false); load(); return
        }

        // 更新雙向連結
        for (const linkedId of addedLinks) {
            const linkedNote = notes.find(n => n.id === linkedId)
            if (linkedNote && editingId) {
                const updatedLinks = [...new Set([...(linkedNote.links || []), editingId])]
                await updateDoc(userDoc(kmsDB, 'notes', linkedId), { links: updatedLinks })
            }
        }
        for (const linkedId of removedLinks) {
            const linkedNote = notes.find(n => n.id === linkedId)
            if (linkedNote && editingId) {
                const updatedLinks = (linkedNote.links || []).filter(id => id !== editingId)
                await updateDoc(userDoc(kmsDB, 'notes', linkedId), { links: updatedLinks })
            }
        }

        setShowForm(false); setEditingId(null); setForm(empty); setLoading(false); load()
    }

    const handleEdit = (note: Note) => {
        setForm({ ...note, links: note.links || [] })
        setEditingId(note.id!); setShowForm(true)
        window.scrollTo({ top: 0, behavior: 'smooth' })
    }

    const handleDelete = async (id: string) => {
        if (!confirm('確定要刪除？筆記將移至垃圾桶，30 天後永久刪除。')) return
        const note = notes.find(n => n.id === id); if (!note) return
        // 移除其他筆記中對此筆記的連結
        for (const linkedId of (note.links || [])) {
            const linkedNote = notes.find(n => n.id === linkedId)
            if (linkedNote) {
                await updateDoc(userDoc(kmsDB, 'notes', linkedId), {
                    links: (linkedNote.links || []).filter(l => l !== id)
                })
            }
        }
        const { setDoc } = await import('firebase/firestore')
        await setDoc(userDoc(kmsDB, 'trash', id), { ...note, deletedAt: new Date().toISOString() })
        await deleteDoc(userDoc(kmsDB, 'notes', id)); load()
    }

    // ── 批次匯入筆記（JSON） ──────────────────────────────────────────────
    const handleImportNotes = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        setImporting(true)
        setImportMsg('')
        try {
            const text = await file.text()
            let rows: any[] = []

            if (file.name.endsWith('.json')) {
                const parsed = JSON.parse(text)
                rows = Array.isArray(parsed) ? parsed : parsed.notes ?? []
            } else if (file.name.endsWith('.csv')) {
                // 簡易 CSV：title,content,type,url,hashtags(分號分隔)
                const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n').filter(l => l.trim())
                const headers = lines[0].split(',').map(h => h.trim())
                rows = lines.slice(1).map(line => {
                    const cols = line.split(',')
                    const row: Record<string, string> = {}
                    headers.forEach((h, i) => { row[h] = (cols[i] || '').trim() })
                    return row
                })
            }

            if (!rows.length) { setImportMsg('❌ 檔案內容為空或格式不符'); setImporting(false); e.target.value = ''; return }

            let success = 0, skipped = 0
            const now = new Date().toISOString()

            for (const row of rows) {
                const title = String(row.title || row['標題'] || '').trim()
                if (!title) { skipped++; continue }

                const content = String(row.content || row['內容'] || '').trim()
                const type = (['note', 'url', 'image', 'file'] as const).includes(row.type) ? row.type : 'note'
                const url = String(row.url || row['網址'] || '').trim() || undefined
                // hashtags: 陣列 or 分號/逗號分隔字串
                let hashtags: string[] = []
                if (Array.isArray(row.hashtags)) hashtags = row.hashtags.map(String)
                else if (row.hashtags) hashtags = String(row.hashtags).split(/[;,、]/).map((t: string) => t.trim()).filter(Boolean)
                else if (row['標籤']) hashtags = String(row['標籤']).split(/[;,、]/).map((t: string) => t.trim()).filter(Boolean)

                try {
                    await addDoc(userCol(kmsDB, 'notes'), {
                        title, content, type, url,
                        hashtags,
                        links: [],
                        createdAt: row.createdAt || now,
                        updatedAt: now,
                    })
                    success++
                } catch { skipped++ }
            }

            setImportMsg(`✅ 匯入完成：成功 ${success} 筆，略過 ${skipped} 筆`)
            load()
        } catch (err) {
            setImportMsg('❌ 解析失敗，請確認格式為 JSON 陣列或 CSV（title,content,type,url,hashtags）')
        }
        setImporting(false)
        e.target.value = ''
    }

    const handleSort = (key: typeof sortBy) => {
        if (sortBy === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
        else { setSortBy(key); setSortDir('desc') }
    }

    const toggleLink = (noteId: string) => {
        setForm(f => {
            const links = f.links || []
            return { ...f, links: links.includes(noteId) ? links.filter(l => l !== noteId) : [...links, noteId] }
        })
    }

    const filtered = notes
        .filter(n => {
            const matchSearch = !search || n.title.includes(search) || n.content.includes(search) ||
                n.hashtags?.some(t => t.includes(search)) || n.url?.includes(search)
            const matchTag = !selectedTag || n.hashtags?.some(t => t === selectedTag || t.startsWith(selectedTag + '/'))
            return matchSearch && matchTag
        })
        .sort((a, b) => {
            if (sortBy === 'title') return sortDir === 'asc' ? a.title.localeCompare(b.title, 'zh-TW') : b.title.localeCompare(a.title, 'zh-TW')
            const aVal = a[sortBy] || ''; const bVal = b[sortBy] || ''
            return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
        })

    const linkableNotes = notes.filter(n =>
        n.id !== editingId &&
        (linkSearch === '' || n.title.toLowerCase().includes(linkSearch.toLowerCase()))
    )

    return (
        <>
            <style>{`
        .kms-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
        @media (max-width: 700px) { .kms-grid { grid-template-columns: 1fr; } }
        .form-grid { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
        @media (max-width: 600px) { .form-grid { grid-template-columns: 1fr; } }
        .note-content { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .note-content.expanded { display: block; }
        .note-card-highlight { box-shadow: 0 0 0 2px #4f8ef7 !important; }
        .sort-btn { display: flex; align-items: center; gap: 4px; border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer; transition: all 0.15s; }
        .link-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px; cursor: pointer; transition: background 0.15s; }
        .link-item:hover { background: rgba(79,142,247,0.08); }
      `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1400px', margin: '0 auto' }}>

                {/* 標題列 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
                    <div>
                        <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>
                            {selectedTag ? `#${selectedTag}` : '知識庫'}
                        </h1>
                        <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>共 {filtered.length} 則筆記</p>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button style={{ ...btn('#21253a'), border: '1px solid #2e3349' }} onClick={() => { setShowImport(true); setImportMsg('') }}>
                            <Upload size={14} />批次匯入
                        </button>
                        <button style={btn('#4f8ef7')} onClick={() => { setForm(empty); setEditingId(null); setShowForm(true) }}>
                            <Plus size={16} />新增筆記
                        </button>
                    </div>
                </div>

                {/* 批次匯入 Modal */}
                {showImport && (
                    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.75)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
                        <div style={{ ...card, width: '100%', maxWidth: '560px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                <span style={{ fontSize: '16px', fontWeight: 600, color: '#e2e8f0' }}>批次匯入筆記</span>
                                <button onClick={() => setShowImport(false)} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><X size={18} /></button>
                            </div>

                            {/* 格式說明 */}
                            <div style={{ backgroundColor: '#0f1117', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', border: '1px solid #2e3349', fontSize: '12px', color: '#8892a4', lineHeight: 1.9 }}>
                                <div style={{ color: '#4f8ef7', fontWeight: 600, marginBottom: '6px' }}>支援格式</div>
                                <div style={{ marginBottom: '8px' }}>
                                    <span style={{ color: '#a78bfa', fontWeight: 600 }}>JSON</span> — 陣列格式，每筆含：
                                    <span style={{ color: '#e2e8f0' }}> title</span>（必填）、
                                    <span style={{ color: '#e2e8f0' }}> content</span>、
                                    <span style={{ color: '#e2e8f0' }}> type</span>（note/url/image/file）、
                                    <span style={{ color: '#e2e8f0' }}> url</span>、
                                    <span style={{ color: '#e2e8f0' }}> hashtags</span>（字串陣列）
                                </div>
                                <div>
                                    <span style={{ color: '#00c896', fontWeight: 600 }}>CSV</span> — 標題行：
                                    <span style={{ color: '#e2e8f0' }}> title, content, type, url, hashtags</span>（hashtags 用分號分隔）
                                </div>
                                <div style={{ marginTop: '8px', color: '#f5a623' }}>※ 重複標題的筆記不會被覆蓋，會新增一筆</div>
                            </div>

                            <label style={{ ...btn('#a78bfa'), width: 'fit-content', cursor: 'pointer', opacity: importing ? 0.6 : 1 }}>
                                <Upload size={15} />
                                {importing ? '匯入中...' : '選擇 JSON / CSV 檔案'}
                                <input ref={importFileRef} type="file" accept=".json,.csv" onChange={handleImportNotes} disabled={importing} style={{ display: 'none' }} />
                            </label>

                            {importMsg && (
                                <div style={{ marginTop: '14px', padding: '10px 14px', borderRadius: '8px', backgroundColor: importMsg.startsWith('❌') ? 'rgba(255,87,87,0.1)' : 'rgba(0,200,150,0.1)', border: `1px solid ${importMsg.startsWith('❌') ? 'rgba(255,87,87,0.3)' : 'rgba(0,200,150,0.3)'}`, color: importMsg.startsWith('❌') ? '#ff5757' : '#00c896', fontSize: '13px' }}>
                                    {importMsg}
                                </div>
                            )}

                            <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end' }}>
                                <button style={{ ...btn('#2e3349'), fontSize: '13px' }} onClick={() => setShowImport(false)}><X size={14} />關閉</button>
                            </div>
                        </div>
                    </div>
                )}

                {/* 表單 */}
                {showForm && (
                    <div style={{ ...card, marginBottom: '24px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                            <span style={{ fontSize: '15px', fontWeight: 600, color: '#e2e8f0' }}>{editingId ? '✏️ 編輯筆記' : '➕ 新增筆記'}</span>
                            <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><X size={18} /></button>
                        </div>

                        {/* 類型 */}
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
                            {Object.entries(TYPE_LABELS).map(([key, label]) => {
                                const Icon = TYPE_ICONS[key]
                                return (
                                    <button key={key} onClick={() => setForm(f => ({ ...f, type: key as any }))}
                                        style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 14px', borderRadius: '8px', border: '1px solid', borderColor: form.type === key ? TYPE_COLORS[key] : '#2e3349', backgroundColor: form.type === key ? `${TYPE_COLORS[key]}18` : 'transparent', color: form.type === key ? TYPE_COLORS[key] : '#8892a4', fontSize: '13px', cursor: 'pointer' }}>
                                        <Icon size={14} />{label}
                                    </button>
                                )
                            })}
                        </div>

                        <div className="form-grid">
                            <div style={{ gridColumn: 'span 2' }}>
                                <label style={lbl}>標題 *</label>
                                <input style={inp} placeholder="筆記標題" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
                            </div>
                            {form.type === 'url' && (
                                <div style={{ gridColumn: 'span 2' }}>
                                    <label style={lbl}>網址</label>
                                    <input style={inp} placeholder="https://..." value={form.url || ''} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} />
                                </div>
                            )}
                            {form.type === 'image' && (
                                <div style={{ gridColumn: 'span 2' }}>
                                    <label style={lbl}>圖片</label>
                                    {form.imageUrl && <img src={form.imageUrl} alt="" style={{ maxHeight: '200px', borderRadius: '8px', marginBottom: '8px', display: 'block' }} />}
                                    <label style={{ ...btn('#21253a'), border: '1px solid #2e3349', cursor: 'pointer', width: 'fit-content' }}>
                                        <Image size={14} />{uploading ? '上傳中...' : '選擇圖片'}
                                        <input ref={imgRef} type="file" accept="image/*" onChange={handleImageUpload} style={{ display: 'none' }} />
                                    </label>
                                </div>
                            )}
                            {form.type === 'file' && (
                                <div style={{ gridColumn: 'span 2' }}>
                                    <label style={lbl}>文件（PDF / Word）</label>
                                    {form.fileName && <p style={{ fontSize: '13px', color: '#00c896', margin: '0 0 8px' }}>📄 {form.fileName}</p>}
                                    <label style={{ ...btn('#21253a'), border: '1px solid #2e3349', cursor: 'pointer', width: 'fit-content' }}>
                                        <FileText size={14} />{uploading ? '上傳中...' : '選擇文件'}
                                        <input ref={fileRef} type="file" accept=".pdf,.docx,.doc" onChange={handleFileUpload} style={{ display: 'none' }} />
                                    </label>
                                </div>
                            )}
                            <div style={{ gridColumn: 'span 2' }}>
                                <label style={lbl}>內容 / 備註</label>
                                <textarea style={{ ...inp, minHeight: '120px', resize: 'vertical', fontFamily: 'sans-serif', lineHeight: 1.6 }}
                                    placeholder="輸入內容、心得或備註..." value={form.content}
                                    onChange={e => setForm(f => ({ ...f, content: e.target.value }))} />
                            </div>

                            {/* Hashtag */}
                            <div style={{ gridColumn: 'span 2' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                    <label style={{ ...lbl, margin: 0 }}>Hashtag 標籤</label>
                                    <button onClick={handleAutoTag} disabled={aiLoading} style={{ ...btn('#a78bfa'), fontSize: '12px', padding: '4px 12px' }}>
                                        <Sparkles size={13} />{aiLoading ? 'AI 分析中...' : 'AI 自動產生'}
                                    </button>
                                </div>
                                <p style={{ fontSize: '11px', color: '#8892a4', margin: '0 0 8px' }}>支援母子標籤，用 / 分隔，例如：投資/台股</p>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                                    {form.hashtags.map(tag => (
                                        <span key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', backgroundColor: 'rgba(79,142,247,0.12)', color: '#4f8ef7', borderRadius: '20px', padding: '3px 10px', fontSize: '12px' }}>
                                            #{tag}<button onClick={() => setForm(f => ({ ...f, hashtags: f.hashtags.filter(t => t !== tag) }))} style={{ background: 'none', border: 'none', color: '#4f8ef7', cursor: 'pointer', padding: 0 }}>×</button>
                                        </span>
                                    ))}
                                </div>
                                <div style={{ display: 'flex', gap: '8px' }}>
                                    <input style={{ ...inp, flex: 1 }} placeholder="新增標籤（支援 投資/台股 格式）" value={newTag}
                                        onChange={e => setNewTag(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { if (!newTag.trim() || form.hashtags.includes(newTag.trim())) return; setForm(f => ({ ...f, hashtags: [...f.hashtags, newTag.trim()] })); setNewTag('') } }} />
                                    <button style={btn('#2e3349')} onClick={() => { if (!newTag.trim() || form.hashtags.includes(newTag.trim())) return; setForm(f => ({ ...f, hashtags: [...f.hashtags, newTag.trim()] })); setNewTag('') }}><Plus size={14} /></button>
                                </div>
                                {allTags.length > 0 && (
                                    <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                        {allTags.filter(t => !form.hashtags.includes(t)).slice(0, 12).map(tag => (
                                            <button key={tag} onClick={() => setForm(f => ({ ...f, hashtags: [...f.hashtags, tag] }))}
                                                style={{ backgroundColor: 'rgba(79,142,247,0.06)', color: '#8892a4', border: '1px solid #2e3349', borderRadius: '20px', padding: '2px 8px', fontSize: '11px', cursor: 'pointer' }}>
                                                +{tag}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* 雙向連結 */}
                            <div style={{ gridColumn: 'span 2' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                    <label style={{ ...lbl, margin: 0 }}>
                                        <Link2 size={12} style={{ display: 'inline', marginRight: '4px' }} />
                                        筆記連結
                                        {(form.links?.length || 0) > 0 && <span style={{ marginLeft: '6px', fontSize: '11px', backgroundColor: 'rgba(79,142,247,0.12)', color: '#4f8ef7', borderRadius: '10px', padding: '1px 6px' }}>{form.links?.length}</span>}
                                    </label>
                                    <div style={{ display: 'flex', gap: '6px' }}>
                                        <button onClick={handleAILinks} disabled={aiLinkLoading} style={{ ...btn('#00c896'), fontSize: '12px', padding: '4px 12px' }}>
                                            <Sparkles size={13} />{aiLinkLoading ? 'AI 分析中...' : 'AI 建議連結'}
                                        </button>
                                        <button onClick={() => setShowLinkPicker(v => !v)} style={{ ...btn('#21253a'), border: '1px solid #2e3349', fontSize: '12px', padding: '4px 12px' }}>
                                            <Plus size={13} />手動選擇
                                        </button>
                                    </div>
                                </div>

                                {/* 已選連結 */}
                                {(form.links?.length || 0) > 0 && (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                                        {form.links?.map(linkId => {
                                            const linkedNote = notes.find(n => n.id === linkId)
                                            if (!linkedNote) return null
                                            return (
                                                <span key={linkId} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', backgroundColor: 'rgba(0,200,150,0.1)', color: '#00c896', borderRadius: '20px', padding: '3px 10px', fontSize: '12px' }}>
                                                    🔗 {linkedNote.title.slice(0, 20)}
                                                    <button onClick={() => toggleLink(linkId)} style={{ background: 'none', border: 'none', color: '#00c896', cursor: 'pointer', padding: 0 }}>×</button>
                                                </span>
                                            )
                                        })}
                                    </div>
                                )}

                                {/* 連結選擇器 */}
                                {showLinkPicker && (
                                    <div style={{ backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '12px', marginTop: '8px' }}>
                                        <input style={{ ...inp, marginBottom: '8px', fontSize: '13px' }} placeholder="搜尋筆記..." value={linkSearch}
                                            onChange={e => setLinkSearch(e.target.value)} />
                                        <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                                            {linkableNotes.slice(0, 20).map(n => {
                                                const isLinked = form.links?.includes(n.id!)
                                                return (
                                                    <div key={n.id} className="link-item" onClick={() => toggleLink(n.id!)}
                                                        style={{ backgroundColor: isLinked ? 'rgba(0,200,150,0.08)' : 'transparent' }}>
                                                        <div style={{ width: '16px', height: '16px', borderRadius: '4px', border: `2px solid ${isLinked ? '#00c896' : '#2e3349'}`, backgroundColor: isLinked ? '#00c896' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                                            {isLinked && <Check size={10} color="#fff" />}
                                                        </div>
                                                        <div style={{ flex: 1, minWidth: 0 }}>
                                                            <div style={{ fontSize: '13px', color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title}</div>
                                                            {n.content && <div style={{ fontSize: '11px', color: '#8892a4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.content.slice(0, 60)}</div>}
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                            {linkableNotes.length === 0 && <p style={{ fontSize: '13px', color: '#8892a4', textAlign: 'center', padding: '16px' }}>找不到筆記</p>}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
                            <button style={btn('#2e3349')} onClick={() => setShowForm(false)}><X size={14} />取消</button>
                            <button style={btn('#4f8ef7')} onClick={handleSave} disabled={loading}>
                                <Check size={14} />{loading ? '儲存中...' : editingId ? '確認更新' : '確認新增'}
                            </button>
                        </div>
                    </div>
                )}

                {/* 搜尋 + 排序 */}
                <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
                        <Search size={15} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#8892a4' }} />
                        <input style={{ ...inp, paddingLeft: '36px', backgroundColor: '#1a1d27' }}
                            placeholder="搜尋標題、內容、標籤..." value={search} onChange={e => setSearch(e.target.value)} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                        <ArrowUpDown size={13} color="#8892a4" />
                        {[
                            { key: 'createdAt' as const, label: '建立' },
                            { key: 'updatedAt' as const, label: '更新' },
                            { key: 'title' as const, label: '標題' },
                        ].map(({ key, label }) => (
                            <button key={key} className="sort-btn" onClick={() => handleSort(key)}
                                style={{ backgroundColor: sortBy === key ? 'rgba(79,142,247,0.12)' : 'transparent', color: sortBy === key ? '#4f8ef7' : '#8892a4', border: `1px solid ${sortBy === key ? '#4f8ef7' : '#2e3349'}` }}>
                                {label}{sortBy === key && <span>{sortDir === 'desc' ? ' ↓' : ' ↑'}</span>}
                            </button>
                        ))}
                    </div>
                </div>

                {/* 筆記卡片 */}
                {filtered.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '64px', color: '#8892a4' }}>
                        <p style={{ fontSize: '15px' }}>{search || selectedTag ? '找不到相關筆記' : '還沒有筆記，點上方「新增筆記」開始記錄'}</p>
                    </div>
                ) : (
                    <div className="kms-grid">
                        {filtered.map(note => {
                            const Icon = TYPE_ICONS[note.type] || FileText
                            const color = TYPE_COLORS[note.type] || '#4f8ef7'
                            const isExpanded = expandedId === note.id
                            const isHighlighted = searchParams.get('note') === note.id
                            const linkedNotes = (note.links || []).map(id => notes.find(n => n.id === id)).filter(Boolean) as Note[]

                            return (
                                <div key={note.id}
                                    ref={el => { noteRefs.current[note.id!] = el }}
                                    className={isHighlighted ? 'note-card-highlight' : ''}
                                    style={{ ...card, display: 'flex', flexDirection: 'column', gap: '12px', transition: 'box-shadow 0.3s' }}>

                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <div style={{ backgroundColor: `${color}18`, borderRadius: '8px', padding: '6px', display: 'flex' }}>
                                                <Icon size={14} color={color} />
                                            </div>
                                            <span style={{ fontSize: '11px', color, fontWeight: 600 }}>{TYPE_LABELS[note.type]}</span>
                                        </div>
                                        <div style={{ display: 'flex', gap: '6px' }}>
                                            <button onClick={() => handleEdit(note)} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><Pencil size={14} /></button>
                                            <button onClick={() => handleDelete(note.id!)} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><Trash2 size={14} /></button>
                                        </div>
                                    </div>

                                    <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#e2e8f0', lineHeight: 1.4 }}>{note.title}</h3>

                                    {note.imageUrl && <img src={note.imageUrl} alt="" style={{ width: '100%', maxHeight: '180px', objectFit: 'cover', borderRadius: '8px' }} />}

                                    {note.url && (
                                        <a href={note.url} target="_blank" rel="noopener noreferrer"
                                            style={{ fontSize: '12px', color: '#00c896', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            <Link size={12} />{note.url}
                                        </a>
                                    )}

                                    {note.fileUrl && note.fileName && (
                                        <a href={note.fileUrl} target="_blank" rel="noopener noreferrer"
                                            style={{ fontSize: '12px', color: '#a78bfa', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                            <FileText size={12} />{note.fileName}
                                        </a>
                                    )}

                                    {note.content && (
                                        <div>
                                            <p className={`note-content${isExpanded ? ' expanded' : ''}`}
                                                style={{ margin: 0, fontSize: '13px', color: '#8892a4', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                                                {note.content}
                                            </p>
                                            {note.content.length > 150 && (
                                                <button onClick={() => setExpandedId(isExpanded ? null : note.id!)}
                                                    style={{ background: 'none', border: 'none', color: '#4f8ef7', fontSize: '12px', cursor: 'pointer', padding: '4px 0', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                    {isExpanded ? <><ChevronUp size={12} />收起</> : <><ChevronDown size={12} />展開全文</>}
                                                </button>
                                            )}
                                        </div>
                                    )}

                                    {note.hashtags?.length > 0 && (
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                            {note.hashtags.map(tag => (
                                                <button key={tag} onClick={() => setSelectedTag(tag)}
                                                    style={{ backgroundColor: 'rgba(79,142,247,0.08)', color: '#4f8ef7', border: 'none', borderRadius: '20px', padding: '2px 8px', fontSize: '11px', cursor: 'pointer' }}>
                                                    #{tag}
                                                </button>
                                            ))}
                                        </div>
                                    )}

                                    {/* 雙向連結顯示 */}
                                    {linkedNotes.length > 0 && (
                                        <div style={{ borderTop: '1px solid #2e3349', paddingTop: '10px' }}>
                                            <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                <Link2 size={11} />連結筆記 ({linkedNotes.length})
                                            </div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                                {linkedNotes.map(linked => (
                                                    <div key={linked.id}
                                                        onClick={() => {
                                                            setExpandedId(linked.id!)
                                                            noteRefs.current[linked.id!]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                                                        }}
                                                        style={{ backgroundColor: '#0f1117', borderRadius: '6px', padding: '8px 10px', cursor: 'pointer', border: '1px solid #2e3349', transition: 'border-color 0.15s' }}
                                                        onMouseEnter={e => (e.currentTarget.style.borderColor = '#00c896')}
                                                        onMouseLeave={e => (e.currentTarget.style.borderColor = '#2e3349')}>
                                                        <div style={{ fontSize: '12px', color: '#00c896', fontWeight: 600, marginBottom: '3px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                            🔗 {linked.title}
                                                        </div>
                                                        {linked.content && (
                                                            <div style={{ fontSize: '11px', color: '#8892a4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                {linked.content.slice(0, 80)}
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    <div style={{ fontSize: '11px', color: '#8892a4', borderTop: '1px solid #2e3349', paddingTop: '8px', display: 'flex', justifyContent: 'space-between' }}>
                                        <span>建立：{new Date(note.createdAt).toLocaleDateString('zh-TW')}</span>
                                        {note.updatedAt !== note.createdAt && <span>更新：{new Date(note.updatedAt).toLocaleDateString('zh-TW')}</span>}
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