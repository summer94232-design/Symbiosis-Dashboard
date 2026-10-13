import LoadingState from '../../components/LoadingState'
import { captureUserSession } from '../../lib/userDB'
import { card, btn } from '../../ui/styles'
import { alertAction } from '../../ui/dialogs'
import { useState, useEffect, useRef } from 'react'
import DisclosureNote from '../../components/DisclosureNote'
import { fetchKmsBodiesInBatches, fetchKmsNoteSummaries, fetchKmsTagStats } from '../../lib/kmsData'
import { toLocalDateString } from '../../lib/date'
import { Download, FileText, Filter, Check } from 'lucide-react'
import type { JSONContent } from '@tiptap/react'
import type { NoteImageAsset } from '../../lib/kmsImages'

interface Note {
    id: string
    title: string
    content: string
    contentDoc?: JSONContent
    assets?: NoteImageAsset[]
    type: string
    url?: string
    hashtags: string[]
    createdAt: string
    updatedAt: string
}


function richDocToMarkdown(doc: JSONContent, assets: NoteImageAsset[] = []): string {
    const render = (node: JSONContent, depth = 0): string => {
        if (node.type === 'text') {
            let text = node.text || ''
            for (const mark of node.marks || []) {
                if (mark.type === 'bold') text = `**${text}**`
                else if (mark.type === 'italic') text = `*${text}*`
                else if (mark.type === 'strike') text = `~~${text}~~`
                else if (mark.type === 'code') text = `\`${text}\``
                else if (mark.type === 'link' && mark.attrs?.href) text = `[${text}](${mark.attrs.href})`
            }
            return text
        }
        if (node.type === 'hardBreak') return '\n'
        if (node.type === 'image') {
            const asset = assets.find(item => item.id === node.attrs?.assetId)
            const url = asset?.downloadUrl || node.attrs?.src || ''
            return url ? `![${node.attrs?.alt || '圖片'}](${url})` : ''
        }

        const children = (node.content || []).map(child => render(child, depth + 1))
        if (node.type === 'doc') return children.filter(Boolean).join('\n\n')
        if (node.type === 'paragraph') return children.join('')
        if (node.type === 'heading') return `${'#'.repeat(Number(node.attrs?.level) || 2)} ${children.join('')}`
        if (node.type === 'bulletList') return children.join('\n')
        if (node.type === 'orderedList') return children.map((child, index) => `${index + 1}. ${child.replace(/^[-*] /, '')}`).join('\n')
        if (node.type === 'listItem') return `- ${children.join('\n').replace(/\n/g, `\n${'  '.repeat(depth)}`)}`
        if (node.type === 'blockquote') return children.join('\n').split('\n').map(line => `> ${line}`).join('\n')
        if (node.type === 'codeBlock') return `\`\`\`\n${children.join('')}\n\`\`\``
        if (node.type === 'horizontalRule') return '---'
        return children.join('')
    }
    return render(doc).trim()
}

function richDocImageText(doc: JSONContent, assets: NoteImageAsset[] = []): string {
    const lines: string[] = []
    const visit = (node: JSONContent) => {
        if (node.type === 'image') {
            const asset = assets.find(item => item.id === node.attrs?.assetId)
            const url = asset?.downloadUrl || node.attrs?.src
            if (url) lines.push(`[圖片：${node.attrs?.alt || '未命名'}] ${url}`)
        }
        node.content?.forEach(visit)
    }
    visit(doc)
    return lines.join('\n')
}

export default function KMSExport() {
    const [notes, setNotes] = useState<Note[]>([])
    const [allTags, setAllTags] = useState<string[]>([])
    const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set())
    const [format, setFormat] = useState<'single-txt' | 'per-tag-txt' | 'markdown'>('single-txt')
    const [loadError, setLoadError] = useState('')
    const [loading, setLoading] = useState(true)
    const [hasLoaded, setHasLoaded] = useState(false)
    const [exporting, setExporting] = useState(false)
    const [exportProgress, setExportProgress] = useState('')
    const [filterMode, setFilterMode] = useState<'all' | 'tag'>('all')
    const loadedSession = useRef<ReturnType<typeof captureUserSession> | null>(null)
    const exportingLock = useRef(false)

    const load = async () => {
        setLoading(true)
        setLoadError('')
        try {
            const session = captureUserSession()
            const [data, stats] = await Promise.all([
                fetchKmsNoteSummaries<Note>(),
                fetchKmsTagStats(),
            ])
            session.assertActive()
            loadedSession.current = session
            setNotes(data)
            setHasLoaded(true)
            const tags = stats ? Object.keys(stats.counts) : [...new Set(data.flatMap(note => note.hashtags || []))]
            setAllTags(tags.sort())
        } catch { setLoadError('筆記載入失敗，請稍後重試。') }
        finally { setLoading(false) }
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
            const body = note.contentDoc ? richDocToMarkdown(note.contentDoc, note.assets) : note.content || ''
            return [
                `# ${note.title}`,
                note.hashtags?.length > 0 ? `**標籤：** ${note.hashtags.map(t => `#${t}`).join(' ')}` : '',
                note.url ? `**網址：** ${note.url}` : '',
                '',
                body,
                '',
                `*建立於 ${new Date(note.createdAt).toLocaleDateString('zh-TW')}*`,
                '---',
            ].filter(l => l !== null).join('\n')
        } else {
            const imageLinks = note.contentDoc ? richDocImageText(note.contentDoc, note.assets) : ''
            return [
                `【${note.title}】`,
                note.hashtags?.length > 0 ? `標籤：${note.hashtags.join('、')}` : '',
                note.url ? `網址：${note.url}` : '',
                note.content || '',
                imageLinks,
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
        if (exportingLock.current) return
        exportingLock.current = true
        setExporting(true)
        setExportProgress('準備讀取正文…')
        try {
        const session = loadedSession.current
        if (!session) throw new Error('請先重新載入筆記')
        session.assertActive()
        const bodyMap = await fetchKmsBodiesInBatches<Pick<Note, 'content' | 'contentDoc' | 'assets'>>(
            filteredNotes.map(note => note.id),
            20,
            (completed, total) => setExportProgress(`讀取正文 ${completed} / ${total}`),
            session,
        )
        session.assertActive()
        const exportNotes = filteredNotes.map(note => ({ ...note, ...(bodyMap[note.id] || {}) }))
        const ext = format === 'markdown' ? 'md' : 'txt'
        const date = toLocalDateString()

        if (format === 'per-tag-txt') {
            // 依標籤分類匯出，每個標籤一個檔案
            const tagMap: Record<string, Note[]> = {}

            exportNotes.forEach(note => {
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
                if (i > 0) await new Promise(resolve => setTimeout(resolve, 300))
                session.assertActive()
                downloadFile(content, `知識庫_${safeName}_${date}.txt`)
            }
        } else {
            // 單一檔案匯出
            const header = [
                `知識庫匯出`,
                `匯出日期：${date}`,
                `筆記數量：${exportNotes.length}`,
                filterMode === 'tag' ? `篩選標籤：${Array.from(selectedTags).join('、')}` : '範圍：全部筆記',
                '════════════════════════',
                '',
            ].join('\n')

            const body = exportNotes.map(n => formatNote(n, format)).join('\n')
            session.assertActive()
            downloadFile(header + body, `知識庫_${date}.${ext}`)
        }

        } catch (error) {
            console.error(error)
            const accountChanged = error instanceof Error && /登入|帳號|帳戶/.test(error.message)
            if (accountChanged) { loadedSession.current = null; setNotes([]); setAllTags([]); setHasLoaded(false); setLoadError('登入帳號已變更，請重新載入筆記。') }
            void alertAction(accountChanged ? '登入帳號已變更，匯出已取消；請重新載入筆記後再試。' : '匯出失敗，已停止讀取後續正文，請稍後重試。')
        } finally {
            exportingLock.current = false
            setExporting(false)
            setExportProgress('')
        }
    }

    const exportCount = filteredNotes.length

    return (
        <div style={{ padding: 'var(--ui-page-padding, clamp(16px, 3vw, 32px))', maxWidth: '900px', margin: '0 auto' }}>
            <div style={{ marginBottom: '16px' }}>
                <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>匯出至 NotebookLM</h1>
            <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>匯出筆記，供 NotebookLM 分析。</p>
            </div>

            {loadError && <div role="alert" className="ui-load-error">{loadError} <button className="ui-button ui-button-secondary" disabled={loading} onClick={() => void load()}>重新載入</button></div>}
            {loading && hasLoaded && <p className="ui-refresh-status" role="status">資料更新中…</p>}
                {loading && !hasLoaded ? (
                <LoadingState />
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

                    {/* 步驟一：篩選範圍 */}
                    <div style={card}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                            <div style={{ backgroundColor: 'var(--c-button-accent)', borderRadius: '50%', width: '22px', height: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: 'var(--c-on-accent)', flexShrink: 0 }}>1</div>
                            <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>選擇匯出範圍</span>
                        </div>
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                            {[
                                { key: 'all', label: '全部筆記', icon: FileText },
                                { key: 'tag', label: '依標籤篩選', icon: Filter },
                            ].map(({ key, label, icon: Icon }) => (
                                <button key={key} onClick={() => setFilterMode(key as 'all' | 'tag')}
                                    style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', borderRadius: '8px', border: '1px solid', borderColor: filterMode === key ? 'var(--c-accent)' : 'var(--c-border)', backgroundColor: filterMode === key ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)' : 'transparent', color: filterMode === key ? 'var(--c-accent)' : 'var(--c-muted)', fontSize: '13px', cursor: 'pointer' }}>
                                    <Icon size={14} />{label}
                                </button>
                            ))}
                        </div>

                        {/* 標籤選擇 */}
                        {filterMode === 'tag' && (
                            <div>
                                <p style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '10px' }}>選擇要匯出的標籤（可多選，子標籤會自動包含）：</p>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '200px', overflowY: 'auto' }}>
                                    {allTags.map(tag => (
                                        <button key={tag} onClick={() => toggleTag(tag)}
                                            style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: selectedTags.has(tag) ? 'color-mix(in srgb, var(--c-accent) 15%, transparent)' : 'rgba(79,142,247,0.05)', color: selectedTags.has(tag) ? 'var(--c-accent)' : 'var(--c-muted)', border: `1px solid ${selectedTags.has(tag) ? 'var(--c-accent)' : 'var(--c-border)'}`, borderRadius: '20px', padding: '4px 12px', fontSize: '12px', cursor: 'pointer' }}>
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
                            <div style={{ backgroundColor: 'var(--c-button-accent)', borderRadius: '50%', width: '22px', height: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: 'var(--c-on-accent)', flexShrink: 0 }}>2</div>
                            <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>選擇匯出格式</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {[
                                { key: 'single-txt', label: '單一 TXT 檔', desc: '全部筆記合併一檔' },
                                { key: 'per-tag-txt', label: '依標籤分類 TXT', desc: '每個標籤各一檔' },
                                { key: 'markdown', label: 'Markdown 格式', desc: '保留標題與標籤結構' },
                            ].map(({ key, label, desc }) => (
                                <div key={key} onClick={() => setFormat(key as typeof format)}
                                    style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '12px 14px', borderRadius: '8px', border: `1px solid ${format === key ? 'var(--c-accent)' : 'var(--c-border)'}`, backgroundColor: format === key ? 'rgba(79,142,247,0.06)' : 'transparent', cursor: 'pointer' }}>
                                    <div style={{ width: '16px', height: '16px', borderRadius: '50%', border: `2px solid ${format === key ? 'var(--c-accent)' : 'var(--c-border)'}`, backgroundColor: format === key ? 'var(--c-accent)' : 'transparent', flexShrink: 0, marginTop: '2px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                        {format === key && <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#fff' }} />}
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '13px', fontWeight: 600, color: format === key ? 'var(--c-accent)' : 'var(--c-text)' }}>{label}</div>
                                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginTop: '2px' }}>{desc}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* 步驟三：匯出 */}
                    <div style={card}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                            <div style={{ backgroundColor: 'var(--c-button-accent)', borderRadius: '50%', width: '22px', height: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: 'var(--c-on-accent)', flexShrink: 0 }}>3</div>
                            <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>確認並匯出</span>
                        </div>
                        <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', fontSize: '13px', color: 'var(--c-muted)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                                <span>匯出筆記數</span>
                                <span style={{ color: 'var(--c-accent)', fontWeight: 600 }}>{exportCount} 則</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                                <span>匯出格式</span>
                                <span style={{ color: 'var(--c-text)' }}>
                                    {format === 'single-txt' ? '單一 TXT' : format === 'per-tag-txt' ? '依標籤 TXT' : 'Markdown'}
                                </span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span>匯出範圍</span>
                                <span style={{ color: 'var(--c-text)' }}>
                                    {filterMode === 'all' ? '全部筆記' : `${selectedTags.size} 個標籤`}
                                </span>
                            </div>
                        </div>

                        {exportCount === 0 ? (
                            <p style={{ fontSize: '13px', color: 'var(--c-danger)', margin: '0 0 12px' }}>⚠️ 沒有符合條件的筆記，請調整篩選條件</p>
                        ) : null}

                        <button onClick={handleExport} disabled={exporting || exportCount === 0} style={btn(exportCount === 0 ? 'var(--c-border)' : 'var(--c-positive)')}>
                            <Download size={16} />
                            {exporting ? exportProgress || '匯出中...' : `匯出 ${exportCount} 則筆記`}
                        </button>

                        {/* NotebookLM 使用說明 */}
                        <DisclosureNote summary="NotebookLM 上傳方式" style={{ marginTop: '16px' }}>
                            <p style={{ margin: 0 }}>1. 前往 <a href="https://notebooklm.google.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--c-accent)' }}>notebooklm.google.com</a></p>
                            <p style={{ margin: 0 }}>2. 建立新 Notebook 或開啟既有的</p>
                            <p style={{ margin: 0 }}>3. 點「新增來源」→「上傳檔案」</p>
                            <p style={{ margin: 0 }}>4. 選擇剛才匯出的 TXT 或 MD 檔案</p>
                            <p style={{ margin: 0 }}>5. 即可用 AI 對你的筆記內容進行問答！</p>
                        </DisclosureNote>
                    </div>
                </div>
            )}
        </div>
    )
}
