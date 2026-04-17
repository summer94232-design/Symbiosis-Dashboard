import { useState, useEffect } from 'react'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { kmsDB } from '../../lib/firebase'
import { userCol } from '../../lib/userDB'
import { Download, FileText, Tag, Filter, Check } from 'lucide-react'

interface Note {
  id: string
  title: string
  content: string
  type: string
  url?: string
  hashtags: string[]
  createdAt: string
  updatedAt: string
}

const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

export default function KMSExport() {
  const [notes, setNotes] = useState<Note[]>([])
  const [allTags, setAllTags] = useState<string[]>([])
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set())
  const [format, setFormat] = useState<'single-txt' | 'per-tag-txt' | 'markdown'>('single-txt')
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [filterMode, setFilterMode] = useState<'all' | 'tag'>('all')

  const load = async () => {
    setLoading(true)
    const q = query(userCol(kmsDB, 'notes'), orderBy('createdAt', 'desc'))
    const snap = await getDocs(q)
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() } as Note))
    setNotes(data)
    const tags = new Set<string>()
    data.forEach(n => n.hashtags?.forEach(t => tags.add(t)))
    setAllTags(Array.from(tags).sort())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const toggleTag = (tag: string) => {
    setSelectedTags(prev => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag); else next.add(tag)
      return next
    })
  }

  // 篩選筆記
  const filteredNotes = filterMode === 'all' ? notes : notes.filter(n =>
    n.hashtags?.some(t => selectedTags.has(t) || Array.from(selectedTags).some(st => t.startsWith(st + '/')))
  )

  // 格式化單一筆記
  const formatNote = (note: Note, fmt: string): string => {
    if (fmt === 'markdown') {
      return [
        `# ${note.title}`,
        note.hashtags?.length > 0 ? `**標籤：** ${note.hashtags.map(t => `#${t}`).join(' ')}` : '',
        note.url ? `**網址：** ${note.url}` : '',
        '',
        note.content || '',
        '',
        `*建立於 ${new Date(note.createdAt).toLocaleDateString('zh-TW')}*`,
        '---',
      ].filter(l => l !== null).join('\n')
    } else {
      return [
        `【${note.title}】`,
        note.hashtags?.length > 0 ? `標籤：${note.hashtags.join('、')}` : '',
        note.url ? `網址：${note.url}` : '',
        note.content || '',
        `建立於：${new Date(note.createdAt).toLocaleDateString('zh-TW')}`,
        '────────────────────────',
      ].filter(Boolean).join('\n')
    }
  }

  // 下載檔案
  const downloadFile = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  }

  const handleExport = async () => {
    setExporting(true)
    const ext = format === 'markdown' ? 'md' : 'txt'
    const date = new Date().toISOString().split('T')[0]

    if (format === 'per-tag-txt') {
      // 依標籤分類匯出，每個標籤一個檔案
      const tagMap: Record<string, Note[]> = {}

      filteredNotes.forEach(note => {
        const tags = note.hashtags?.length > 0 ? note.hashtags : ['未分類']
        tags.forEach(tag => {
          if (!tagMap[tag]) tagMap[tag] = []
          tagMap[tag].push(note)
        })
      })

      // 如果有多個標籤，稍微延遲避免瀏覽器阻擋多次下載
      const tagEntries = Object.entries(tagMap)
      for (let i = 0; i < tagEntries.length; i++) {
        const [tag, tagNotes] = tagEntries[i]
        const content = [
          `知識庫匯出 - ${tag}`,
          `匯出日期：${date}`,
          `筆記數量：${tagNotes.length}`,
          '════════════════════════',
          '',
          ...tagNotes.map(n => formatNote(n, 'txt'))
        ].join('\n')
        const safeName = tag.replace(/\//g, '_')
        setTimeout(() => downloadFile(content, `知識庫_${safeName}_${date}.txt`), i * 300)
      }
    } else {
      // 單一檔案匯出
      const header = [
        `知識庫匯出`,
        `匯出日期：${date}`,
        `筆記數量：${filteredNotes.length}`,
        filterMode === 'tag' ? `篩選標籤：${Array.from(selectedTags).join('、')}` : '範圍：全部筆記',
        '════════════════════════',
        '',
      ].join('\n')

      const body = filteredNotes.map(n => formatNote(n, format)).join('\n')
      downloadFile(header + body, `知識庫_${date}.${ext}`)
    }

    setExporting(false)
  }

  const exportCount = filteredNotes.length

  return (
    <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '900px', margin: '0 auto' }}>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>匯出至 NotebookLM</h1>
        <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>將筆記匯出為文字檔，上傳到 NotebookLM 進行 AI 分析</p>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>載入中...</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* 步驟一：篩選範圍 */}
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <div style={{ backgroundColor: '#4f8ef7', borderRadius: '50%', width: '22px', height: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: '#fff', flexShrink: 0 }}>1</div>
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>選擇匯出範圍</span>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
              {[
                { key: 'all', label: '全部筆記', icon: FileText },
                { key: 'tag', label: '依標籤篩選', icon: Filter },
              ].map(({ key, label, icon: Icon }) => (
                <button key={key} onClick={() => setFilterMode(key as any)}
                  style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', borderRadius: '8px', border: '1px solid', borderColor: filterMode === key ? '#4f8ef7' : '#2e3349', backgroundColor: filterMode === key ? 'rgba(79,142,247,0.12)' : 'transparent', color: filterMode === key ? '#4f8ef7' : '#8892a4', fontSize: '13px', cursor: 'pointer' }}>
                  <Icon size={14} />{label}
                </button>
              ))}
            </div>

            {/* 標籤選擇 */}
            {filterMode === 'tag' && (
              <div>
                <p style={{ fontSize: '12px', color: '#8892a4', marginBottom: '10px' }}>選擇要匯出的標籤（可多選，子標籤會自動包含）：</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '200px', overflowY: 'auto' }}>
                  {allTags.map(tag => (
                    <button key={tag} onClick={() => toggleTag(tag)}
                      style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: selectedTags.has(tag) ? 'rgba(79,142,247,0.15)' : 'rgba(79,142,247,0.05)', color: selectedTags.has(tag) ? '#4f8ef7' : '#8892a4', border: `1px solid ${selectedTags.has(tag) ? '#4f8ef7' : '#2e3349'}`, borderRadius: '20px', padding: '4px 12px', fontSize: '12px', cursor: 'pointer' }}>
                      {selectedTags.has(tag) && <Check size={11} />}
                      #{tag}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 步驟二：選擇格式 */}
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <div style={{ backgroundColor: '#4f8ef7', borderRadius: '50%', width: '22px', height: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: '#fff', flexShrink: 0 }}>2</div>
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>選擇匯出格式</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {[
                { key: 'single-txt', label: '單一 TXT 檔', desc: '所有筆記合併為一個文字檔，最適合 NotebookLM 上傳' },
                { key: 'per-tag-txt', label: '依標籤分類 TXT', desc: '每個標籤產生一個 TXT 檔，方便建立不同主題的 Notebook' },
                { key: 'markdown', label: 'Markdown 格式', desc: '保留標題、標籤等格式結構，適合進階使用' },
              ].map(({ key, label, desc }) => (
                <div key={key} onClick={() => setFormat(key as any)}
                  style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '12px 14px', borderRadius: '8px', border: `1px solid ${format === key ? '#4f8ef7' : '#2e3349'}`, backgroundColor: format === key ? 'rgba(79,142,247,0.06)' : 'transparent', cursor: 'pointer' }}>
                  <div style={{ width: '16px', height: '16px', borderRadius: '50%', border: `2px solid ${format === key ? '#4f8ef7' : '#2e3349'}`, backgroundColor: format === key ? '#4f8ef7' : 'transparent', flexShrink: 0, marginTop: '2px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {format === key && <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#fff' }} />}
                  </div>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: format === key ? '#4f8ef7' : '#e2e8f0' }}>{label}</div>
                    <div style={{ fontSize: '12px', color: '#8892a4', marginTop: '2px' }}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 步驟三：匯出 */}
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <div style={{ backgroundColor: '#4f8ef7', borderRadius: '50%', width: '22px', height: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: '#fff', flexShrink: 0 }}>3</div>
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>確認並匯出</span>
            </div>
            <div style={{ backgroundColor: '#0f1117', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', fontSize: '13px', color: '#8892a4' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span>匯出筆記數</span>
                <span style={{ color: '#4f8ef7', fontWeight: 600 }}>{exportCount} 則</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span>匯出格式</span>
                <span style={{ color: '#e2e8f0' }}>
                  {format === 'single-txt' ? '單一 TXT' : format === 'per-tag-txt' ? '依標籤 TXT' : 'Markdown'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>匯出範圍</span>
                <span style={{ color: '#e2e8f0' }}>
                  {filterMode === 'all' ? '全部筆記' : `${selectedTags.size} 個標籤`}
                </span>
              </div>
            </div>

            {exportCount === 0 ? (
              <p style={{ fontSize: '13px', color: '#ff5757', margin: '0 0 12px' }}>⚠️ 沒有符合條件的筆記，請調整篩選條件</p>
            ) : null}

            <button onClick={handleExport} disabled={exporting || exportCount === 0} style={btn(exportCount === 0 ? '#2e3349' : '#00c896')}>
              <Download size={16} />
              {exporting ? '匯出中...' : `匯出 ${exportCount} 則筆記`}
            </button>

            {/* NotebookLM 使用說明 */}
            <div style={{ marginTop: '16px', padding: '12px 14px', backgroundColor: 'rgba(0,200,150,0.06)', border: '1px solid rgba(0,200,150,0.2)', borderRadius: '8px', fontSize: '12px', color: '#8892a4', lineHeight: 1.7 }}>
              <p style={{ margin: '0 0 6px', color: '#00c896', fontWeight: 600 }}>📚 如何上傳到 NotebookLM</p>
              <p style={{ margin: 0 }}>1. 前往 <a href="https://notebooklm.google.com" target="_blank" rel="noopener noreferrer" style={{ color: '#4f8ef7' }}>notebooklm.google.com</a></p>
              <p style={{ margin: 0 }}>2. 建立新 Notebook 或開啟既有的</p>
              <p style={{ margin: 0 }}>3. 點「新增來源」→「上傳檔案」</p>
              <p style={{ margin: 0 }}>4. 選擇剛才匯出的 TXT 或 MD 檔案</p>
              <p style={{ margin: 0 }}>5. 即可用 AI 對你的筆記內容進行問答！</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}