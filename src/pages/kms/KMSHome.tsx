import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { JSONContent } from '@tiptap/react'
import { doc, getDocs, query, where, writeBatch, type DocumentData, type QueryDocumentSnapshot } from 'firebase/firestore'
import { kmsDB, investDB } from '../../lib/firebase'
import { userCol, userDoc } from '../../lib/userDB'
import { fetchKmsNoteBody, fetchKmsNotePage, fetchKmsNoteSummary, fetchKmsTagOrder, fetchKmsTagStats, invalidateKmsNotes, invalidateKmsTrash, searchKmsNoteSummaries, KMS_UNTAGGED_KEY, type KmsTagStats } from '../../lib/kmsData'
import { buildKmsSearchTerms, buildKmsTagPaths } from '../../lib/kmsSearch'
// ✅ 1-2：共用 CSV 解析模組
import { parseCSVLine } from '../../lib/csv'
import { generateHashtags, findRelatedNotes } from '../../lib/gemini'
import { getQuote, extractPrice } from '../../lib/fugle'
import { toLocalDateString } from '../../lib/date'
import { cleanupStaleNoteImageDrafts, deleteNoteImageAssets, deleteStoragePath, finalizeNoteImageAssets, prepareAndUploadNoteImage, uploadPrivateNoteFile, type NoteImageAsset } from '../../lib/kmsImages'
import { migrateLegacyKmsNote, needsLegacyNoteMigration } from '../../lib/kmsLegacyMigration'
import RichTextEditor from '../../components/kms/RichTextEditor'
import RichTextContent from '../../components/kms/RichTextContent'
import { Plus, Search, Pencil, Trash2, X, Check, Link, FileText, Image, Sparkles, ChevronDown, ChevronUp, ArrowUpDown, Link2, Upload, ClipboardList } from 'lucide-react'

interface Note {
    id?: string
    title: string
    content: string
    type: 'note' | 'url' | 'image' | 'file'
    url?: string
    imageUrl?: string
    coverAssetId?: string
    coverThumbnailUrl?: string
    articleThumbnailUrl?: string
    fileUrl?: string
    fileName?: string
    fileStoragePath?: string
    contentDoc?: JSONContent
    assets?: NoteImageAsset[]
    hashtags: string[]
    links?: string[]
    createdAt: string
    updatedAt: string
}

interface Props {
    selectedTag: string
    setSelectedTag: (tag: string) => void
    onNotesChanged: () => void
}

interface NoteBody {
    content: string
    contentDoc?: JSONContent
    assets?: NoteImageAsset[]
}

const empty: Note = { title: '', content: '', type: 'note', hashtags: [], links: [], createdAt: '', updatedAt: '' }
const card: React.CSSProperties = { backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '8px 12px', color: 'var(--c-text)', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

const TYPE_ICONS: Record<string, any> = { note: FileText, url: Link, image: Image, file: FileText }
const TYPE_LABELS: Record<string, string> = { note: '文字筆記', url: '網址收藏', image: '圖片', file: '文件' }
const TYPE_COLORS: Record<string, string> = { note: 'var(--c-accent)', url: 'var(--c-positive)', image: 'var(--c-warning)', file: '#a78bfa' }
type UploadSource = 'cover' | 'file' | 'editor' | 'migration'
const NOTES_PAGE_SIZE = 40

function noteBody(note: Note): NoteBody {
    return { content: note.content || '', contentDoc: note.contentDoc, assets: note.assets || [] }
}

function noteSummary(note: Note): Note {
    const summary: Note = { ...note, content: '' }
    Object.assign(summary, {
        searchTerms: buildKmsSearchTerms(note.title, note.hashtags),
        tagPaths: buildKmsTagPaths(note.hashtags),
        isUntagged: (note.hashtags?.length ?? 0) === 0,
    })
    const cover = note.assets?.find(asset => asset.id === note.coverAssetId)
    const articlePreview = note.assets?.find(asset => asset.id !== note.coverAssetId)
    if (cover?.thumbnailUrl) summary.coverThumbnailUrl = cover.thumbnailUrl
    else delete summary.coverThumbnailUrl
    if (articlePreview?.thumbnailUrl) summary.articleThumbnailUrl = articlePreview.thumbnailUrl
    else delete summary.articleThumbnailUrl
    delete summary.contentDoc
    delete summary.assets
    return summary
}

function VirtualNoteItem({ children }: { children: () => React.ReactNode }) {
    const hostRef = useRef<HTMLDivElement>(null)
    const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
    const [placeholderHeight, setPlaceholderHeight] = useState(320)

    useEffect(() => {
        const host = hostRef.current
        if (!host || typeof IntersectionObserver === 'undefined') return
        const observer = new IntersectionObserver(([entry]) => {
            setVisible(entry.isIntersecting)
        }, { rootMargin: '700px 0px' })
        observer.observe(host)
        return () => observer.disconnect()
    }, [])

    useEffect(() => {
        if (!visible) return
        const frame = requestAnimationFrame(() => {
            if (hostRef.current?.offsetHeight) setPlaceholderHeight(hostRef.current.offsetHeight)
        })
        return () => cancelAnimationFrame(frame)
    }, [visible])

    return (
        <div ref={hostRef} style={{ minHeight: visible ? undefined : `${placeholderHeight}px` }}>
            {visible ? children() : null}
        </div>
    )
}

// 「標籤管理」頁儲存父標籤排序的 Firestore document（settings/tagOrder）
// ── 筆記模板定義 ──────────────────────────────────────────
interface NoteTemplate {
    id: string
    label: string
    emoji: string
    titlePrefix: string
    hashtags: string[]
    // dynamic：套用時需非同步帶入外部資料（加權指數、當日交易）
    dynamic?: boolean
    content: (date: string) => string
}

const NOTE_TEMPLATES: NoteTemplate[] = [
    {
        id: 'trading-journal',
        label: '交易日誌',
        emoji: '📋',
        titlePrefix: '交易日誌',
        hashtags: ['交易日誌'],
        dynamic: true,
        // ⚠️ 交易日誌為動態模板：市場快照與操作計畫於 applyTemplate 時即時帶入。
        //    此處 content 僅作為「抓取失敗」時的後備骨架。
        content: (date) =>
            `日期：${date}\n市場快照：大盤指數（載入失敗）\n今日觀察：\n今日思路：\n操作計畫：（載入失敗）\n收盤覆盤：\n情緒狀態：\n明日重點：\n`,
    },
    {
        id: 'stock-analysis',
        label: '選股分析',
        emoji: '🔍',
        titlePrefix: '選股分析',
        hashtags: ['選股分析'],
        content: (date) =>
            `日期：${date}\n股票代號／名稱：\n產業／類股：\n基本面摘要：\n技術面觀察：\n潛在風險：\n目標價／停損點：\n結論：\n`,
    },
    {
        id: 'earnings-note',
        label: '法說會筆記',
        emoji: '📢',
        titlePrefix: '法說會',
        hashtags: ['法說會'],
        content: (date) =>
            `日期：${date}\n公司名稱：\n本期營收／獲利重點：\n管理層展望：\nQ&A 重點：\n我的解讀：\n後續追蹤：\n`,
    },
]
// ────────────────────────────────────────────────────────

export default function KMSHome({ selectedTag, setSelectedTag, onNotesChanged }: Props) {
    const [searchParams] = useSearchParams()
    const [notes, setNotes] = useState<Note[]>([])
    const [bodies, setBodies] = useState<Record<string, NoteBody>>({})
    const [bodyLoadingId, setBodyLoadingId] = useState<string | null>(null)
    const [pageCursor, setPageCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null)
    const [hasMoreNotes, setHasMoreNotes] = useState(false)
    const [pageLoading, setPageLoading] = useState(false)
    const [remoteResults, setRemoteResults] = useState<Note[] | null>(null)
    const [showForm, setShowForm] = useState(false)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [form, setForm] = useState<Note>(empty)
    const [loading, setLoading] = useState(false)
    const [aiLoading, setAiLoading] = useState(false)
    const [aiLinkLoading, setAiLinkLoading] = useState(false)
    const [search, setSearch] = useState('')
    const [expandedId, setExpandedId] = useState<string | null>(null)
    const [newTag, setNewTag] = useState('')
    // ── Autocomplete state ──────────────────────────────────────────────
    const [tagSuggestions, setTagSuggestions] = useState<string[]>([])
    const [suggestionIdx, setSuggestionIdx] = useState(-1)
    const tagInputRef = useRef<HTMLInputElement>(null)
    // ───────────────────────────────────────────────────────────────────
    const [activeUploads, setActiveUploads] = useState<Set<UploadSource>>(new Set())
    const [actionError, setActionError] = useState('')
    const [migrationStatus, setMigrationStatus] = useState('')
    const [draftNoteId, setDraftNoteId] = useState('')
    const [originalAssets, setOriginalAssets] = useState<NoteImageAsset[]>([])
    const [sessionUploadedAssets, setSessionUploadedAssets] = useState<NoteImageAsset[]>([])
    const [originalFileStoragePath, setOriginalFileStoragePath] = useState('')
    const [sessionUploadedFilePath, setSessionUploadedFilePath] = useState('')
    const [allTags, setAllTags] = useState<string[]>([])
    const [globalTagStats, setGlobalTagStats] = useState<KmsTagStats | null>(null)
    // 父標籤排序（沿用「標籤管理」頁存的 settings/tagOrder.parentOrder）
    const [parentOrder, setParentOrder] = useState<string[]>([])
    const [sortBy, setSortBy] = useState<'createdAt' | 'updatedAt' | 'title'>('createdAt')
    const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')
    const [showLinkPicker, setShowLinkPicker] = useState(false)
    const [linkSearch, setLinkSearch] = useState('')
    const [showImport, setShowImport] = useState(false)
    const [importMsg, setImportMsg] = useState('')
    const [importing, setImporting] = useState(false)
    // ── 模板下拉 ─────────────────────────────────────────────────────────
    const [showTemplateMenu, setShowTemplateMenu] = useState(false)
    const [templateLoading, setTemplateLoading] = useState(false)
    // ────────────────────────────────────────────────────────────────────
    const fileRef = useRef<HTMLInputElement>(null)
    const imgRef = useRef<HTMLInputElement>(null)
    const importFileRef = useRef<HTMLInputElement>(null)
    const noteRefs = useRef<Record<string, HTMLDivElement | null>>({})

    const setUploadActive = (source: UploadSource, active: boolean) => {
        setActiveUploads(current => {
            const next = new Set(current)
            if (active) next.add(source)
            else next.delete(source)
            return next
        })
    }
    const uploadsActive = activeUploads.size > 0

    const load = async () => {
        try {
            setPageLoading(true)
            const [page, tagOrder, stats] = await Promise.all([
                fetchKmsNotePage<Note>(NOTES_PAGE_SIZE),
                fetchKmsTagOrder(),
                fetchKmsTagStats(),
            ])
            const data = page.rows
            setNotes(data)
            setPageCursor(page.cursor)
            setHasMoreNotes(page.hasMore)
            const tags = stats ? Object.keys(stats.counts) : [...new Set(data.flatMap(note => note.hashtags || []))]
            setAllTags(tags.sort())
            setGlobalTagStats(stats)
            // 讀取「標籤管理」頁儲存的父標籤排序；讀不到就留空陣列（fallback 依筆記數）
            setParentOrder(tagOrder.parentOrder)
            cleanupStaleNoteImageDrafts().catch(error => console.warn('清理逾期圖片草稿失敗', error))
        } catch (error) {
            console.error(error)
            setActionError('知識庫載入失敗，請檢查網路後重新整理。')
        } finally {
            setPageLoading(false)
        }
    }

    const loadMoreNotes = async () => {
        if (!pageCursor || !hasMoreNotes || pageLoading) return
        setPageLoading(true)
        setActionError('')
        try {
            const page = await fetchKmsNotePage<Note>(NOTES_PAGE_SIZE, pageCursor)
            setNotes(current => [...current, ...page.rows.filter(row => !current.some(note => note.id === row.id))])
            setPageCursor(page.cursor)
            setHasMoreNotes(page.hasMore)
            setAllTags(current => {
                const tags = new Set(current)
                page.rows.forEach(note => note.hashtags?.forEach(tag => tags.add(tag)))
                return [...tags].sort()
            })
        } catch (error) {
            console.error(error)
            setActionError('下一頁筆記載入失敗，請稍後重試。')
        } finally {
            setPageLoading(false)
        }
    }

    const loadBodyForNote = async (note: Note): Promise<NoteBody> => {
        if (!note.id) return noteBody(note)
        if (bodies[note.id]) return bodies[note.id]
        setBodyLoadingId(note.id)
        try {
            const body = await fetchKmsNoteBody<NoteBody>(note.id)
            setBodies(current => ({ ...current, [note.id!]: body }))
            return body
        } finally {
            setBodyLoadingId(current => current === note.id ? null : current)
        }
    }

    const handleExpand = async (note: Note) => {
        if (expandedId === note.id) {
            setExpandedId(null)
            return
        }
        setActionError('')
        try {
            await loadBodyForNote(note)
            setExpandedId(note.id!)
        } catch (error) {
            console.error(error)
            setActionError('完整文章載入失敗，請稍後重試。')
        }
    }

    useEffect(() => { load() }, [])

    useEffect(() => {
        if (!search && !selectedTag) {
            setRemoteResults(null)
            return
        }
        const timer = window.setTimeout(() => {
            searchKmsNoteSummaries<Note>(search, search ? '' : selectedTag, NOTES_PAGE_SIZE)
                .then(setRemoteResults)
                .catch(error => {
                    console.error('跨分頁搜尋失敗', error)
                    setActionError('跨分頁搜尋失敗；舊筆記需先建立搜尋索引。')
                })
        }, 250)
        return () => window.clearTimeout(timer)
    }, [search, selectedTag])

    useEffect(() => {
        const noteId = searchParams.get('note')
        const note = notes.find(row => row.id === noteId)
        if (note) {
            void handleExpand(note)
            setTimeout(() => {
                const el = noteRefs.current[noteId!]
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }, 300)
        } else if (noteId && !pageLoading) {
            void fetchKmsNoteSummary<Note>(noteId).then(summary => {
                if (summary) setNotes(current => current.some(row => row.id === summary.id) ? current : [summary, ...current])
            }).catch(error => console.error('載入指定筆記摘要失敗', error))
        }
        // 只在路由指定的筆記首次出現在目前分頁時處理。
    }, [searchParams, notes.length])

    // ── 套用模板 ──────────────────────────────────────────────────────────
    // 交易日誌（dynamic）會額外帶入：
    //   市場快照 → 加權指數 IX0001 即時收盤（Fugle）
    //   操作計畫 → 當日 trades 紀錄，格式「買進台積電(2330)、賣出台積電(2330)」
    const applyTemplate = async (template: NoteTemplate) => {
        setShowTemplateMenu(false)

        const today = new Date().toLocaleDateString('zh-TW', {
            year: 'numeric', month: '2-digit', day: '2-digit'
        })

        // 非動態模板：維持原本同步行為
        if (!template.dynamic) {
            setForm(f => ({
                ...f,
                title: f.title || `${template.titlePrefix} ${today}`,
                content: template.content(today),
                hashtags: [...new Set([...f.hashtags, ...template.hashtags])],
            }))
            return
        }

        // ── 動態模板（交易日誌）──────────────────────────────────────────
        setTemplateLoading(true)

        // 1) 市場快照：抓加權指數 IX0001 即時收盤 + 當日漲跌幅
        let snapshotLine = '市場快照：大盤指數（載入失敗，請手動填寫）'
        try {
            const quote = await getQuote('IX0001')
            const price = extractPrice(quote)
            if (price != null) {
                // 漲跌幅：優先用 Fugle 回傳的 changePercent；
                // 若無則以 (現價 − 參考價) / 參考價 自行計算
                let pctStr = ''
                let pct: number | null =
                    typeof quote?.changePercent === 'number' ? quote.changePercent : null
                if (pct == null && typeof quote?.referencePrice === 'number' && quote.referencePrice > 0) {
                    pct = ((price - quote.referencePrice) / quote.referencePrice) * 100
                }
                if (pct != null) {
                    pctStr = ` (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`
                }
                snapshotLine = `市場快照：加權指數 ${price.toLocaleString('zh-TW')}${pctStr}`
            }
        } catch (err) {
            console.error('[交易日誌] 加權指數抓取失敗:', err)
        }

        // 2) 操作計畫：撈當日交易紀錄（trades collection，date 為 YYYY-MM-DD）
        let planLine = '操作計畫：'
        try {
            const todayISO = toLocalDateString()
            const snap = await getDocs(
                query(userCol(investDB, 'trades'), where('date', '==', todayISO))
            )
            const trades = snap.docs.map(d => d.data() as { type: 'buy' | 'sell'; code: string; name: string })
            if (trades.length > 0) {
                const items = trades.map(t => {
                    const action = t.type === 'buy' ? '買進' : '賣出'
                    return `${action}${t.name}(${t.code})`
                })
                planLine = `操作計畫：${items.join('、')}`
            } else {
                planLine = '操作計畫：（今日無交易）'
            }
        } catch (err) {
            console.error('[交易日誌] 當日交易抓取失敗:', err)
            planLine = '操作計畫：（交易紀錄載入失敗，請手動填寫）'
        }

        // 3) 組合內容
        const content =
            `日期：${today}\n` +
            `${snapshotLine}\n` +
            `今日觀察：\n` +
            `今日思路：\n` +
            `${planLine}\n` +
            `收盤覆盤：\n` +
            `情緒狀態：\n` +
            `明日重點：\n`

        setForm(f => ({
            ...f,
            title: f.title || `${template.titlePrefix} ${today}`,
            content,
            hashtags: [...new Set([...f.hashtags, ...template.hashtags])],
        }))

        setTemplateLoading(false)
    }
    // ─────────────────────────────────────────────────────────────────────

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
        setActionError('')
        setUploadActive('cover', true)
        try {
            const asset = await prepareAndUploadNoteImage(file, draftNoteId)
            setSessionUploadedAssets(current => [...current, asset])
            setForm(current => ({
                ...current,
                imageUrl: asset.downloadUrl,
                coverAssetId: asset.id,
                assets: [...(current.assets || []).filter(item => item.id !== current.coverAssetId), asset],
                type: 'image',
            }))
        } catch (error) {
            console.error(error)
            setActionError(error instanceof Error ? error.message : '圖片處理或上傳失敗')
        } finally {
            setUploadActive('cover', false)
            e.target.value = ''
        }
    }

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]; if (!file) return
        setActionError('')
        setUploadActive('file', true)
        try {
            let extractedText = ''
            if (file.name.endsWith('.docx')) {
                const buf = await file.arrayBuffer()
                const mammoth = await import('mammoth')
                extractedText = (await mammoth.extractRawText({ arrayBuffer: buf })).value
            }
            const uploaded = await uploadPrivateNoteFile(file, draftNoteId)
            if (sessionUploadedFilePath) {
                await deleteStoragePath(sessionUploadedFilePath).catch(error => console.warn('清除先前未儲存文件失敗', error))
            }
            setSessionUploadedFilePath(uploaded.storagePath)
            setForm(f => ({ ...f, type: 'file', fileUrl: uploaded.downloadUrl, fileStoragePath: uploaded.storagePath, fileName: file.name, content: extractedText || f.content }))
        } catch (error) {
            console.error(error)
            setActionError(error instanceof Error ? error.message : '文件處理或上傳失敗')
        } finally {
            setUploadActive('file', false)
            e.target.value = ''
        }
    }

    const openNewNote = () => {
        const id = doc(userCol(kmsDB, 'notes')).id
        setDraftNoteId(id)
        setOriginalAssets([])
        setSessionUploadedAssets([])
        setOriginalFileStoragePath('')
        setSessionUploadedFilePath('')
        setForm({ ...empty, assets: [] })
        setEditingId(null)
        setShowForm(true)
    }

    const closeNoteForm = async () => {
        if (uploadsActive) {
            alert('檔案仍在處理中，請等上傳完成後再關閉。')
            return
        }
        if (sessionUploadedAssets.length) {
            try {
                await deleteNoteImageAssets(sessionUploadedAssets)
            } catch (error) {
                console.error('清除未儲存圖片失敗', error)
            }
        }
        if (sessionUploadedFilePath) {
            await deleteStoragePath(sessionUploadedFilePath).catch(error => console.error('清除未儲存文件失敗', error))
        }
        setShowForm(false)
        setShowTemplateMenu(false)
        setEditingId(null)
        setDraftNoteId('')
        setOriginalAssets([])
        setSessionUploadedAssets([])
        setOriginalFileStoragePath('')
        setSessionUploadedFilePath('')
        setForm(empty)
    }

    const handleSave = async () => {
        if (!form.title || uploadsActive) return
        setLoading(true)
        setActionError('')
        try {
        const now = new Date().toISOString()
        let savedId = editingId

        // 雙向連結：更新被連結的筆記也加入反向連結
        const oldLinks = editingId ? (notes.find(n => n.id === editingId)?.links || []) : []
        const newLinks = form.links || []
        const addedLinks = newLinks.filter(id => !oldLinks.includes(id))
        const removedLinks = oldLinks.filter(id => !newLinks.includes(id))

        const noteRef = editingId
            ? userDoc(kmsDB, 'notes', editingId)
            : userDoc(kmsDB, 'notes', draftNoteId || doc(userCol(kmsDB, 'notes')).id)
        savedId = noteRef.id
        const savedNote: Note = editingId
            ? { ...form, id: editingId, updatedAt: now }
            : { ...form, id: noteRef.id, createdAt: now, updatedAt: now }
        const linkedUpdates: Record<string, string[]> = {}

        for (const linkedId of addedLinks) {
            const linkedNote = notes.find(n => n.id === linkedId)
            if (linkedNote && linkedId !== noteRef.id) {
                linkedUpdates[linkedId] = [...new Set([...(linkedNote.links || []), noteRef.id])]
            }
        }
        for (const linkedId of removedLinks) {
            const linkedNote = notes.find(n => n.id === linkedId)
            if (linkedNote) {
                linkedUpdates[linkedId] = (linkedNote.links || []).filter(id => id !== noteRef.id)
            }
        }

        if (Object.keys(linkedUpdates).length > 449) {
            alert('這則筆記的關聯數超過單次安全更新上限（449），請先減少連結後再儲存。')
            return
        }

        // 筆記本體與所有反向連結在同一批次提交：全部成功或全部失敗。
        const batch = writeBatch(kmsDB)
        const summary = noteSummary(savedNote)
        const body = noteBody(savedNote)
        batch.set(noteRef, summary)
        batch.set(userDoc(kmsDB, 'noteBodies', noteRef.id), body)
        Object.entries(linkedUpdates).forEach(([linkedId, links]) => {
            batch.update(userDoc(kmsDB, 'notes', linkedId), { links, updatedAt: now })
        })
        await batch.commit()
        await finalizeNoteImageAssets(savedNote.assets || []).catch(error => {
            console.warn('圖片草稿標記清理失敗，稍後會由自動清理重新確認', error)
        })

        // Firestore 已成功保存新文章結構後，再刪除文章中不再引用的圖片。
        // 即使 Storage 清理失敗，文章仍可正常顯示，僅留下可稍後清理的孤兒檔。
        const retainedAssetIds = new Set((savedNote.assets || []).map(asset => asset.id))
        const assetsToDelete = [...originalAssets, ...sessionUploadedAssets]
            .filter(asset => !retainedAssetIds.has(asset.id))
            .filter((asset, index, rows) => rows.findIndex(row => row.id === asset.id) === index)
        if (assetsToDelete.length) {
            try {
                await deleteNoteImageAssets(assetsToDelete)
            } catch (error) {
                console.error('清除未引用圖片失敗', error)
            }
        }
        if (originalFileStoragePath && originalFileStoragePath !== savedNote.fileStoragePath) {
            await deleteStoragePath(originalFileStoragePath).catch(error => console.warn('清除舊文件失敗', error))
        }

        setNotes(prev => {
            const withLinks = prev.map(note => linkedUpdates[note.id!] ? { ...note, links: linkedUpdates[note.id!] } : note)
            return editingId
                ? withLinks.map(note => note.id === editingId ? summary : note)
                : [summary, ...withLinks]
        })
        setBodies(current => ({ ...current, [noteRef.id]: body }))

        // 更新 allTags（編輯情境）
        const newTagsSet = new Set(allTags)
            ; (form.hashtags || []).forEach(t => newTagsSet.add(t))
        setAllTags(Array.from(newTagsSet).sort())

        invalidateKmsNotes()
        onNotesChanged()
        setSearch('')
        setSelectedTag((form.hashtags?.length ?? 0) === 0 ? KMS_UNTAGGED_KEY : form.hashtags[0])
        setExpandedId(savedId)
        setShowForm(false); setEditingId(null); setForm(empty)
        setDraftNoteId(''); setOriginalAssets([]); setSessionUploadedAssets([])
        setOriginalFileStoragePath(''); setSessionUploadedFilePath('')
        if (savedId) {
            setTimeout(() => {
                noteRefs.current[savedId!]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }, 100)
        }
        } catch (error) {
            console.error(error)
            setActionError('筆記儲存失敗，內容仍保留在表單中，請稍後重試。')
        } finally {
            setLoading(false)
        }
    }

    const handleEdit = async (note: Note) => {
        setActionError('')
        try {
            const body = await loadBodyForNote(note)
            const assets = body.assets || []
            setForm({ ...note, ...body, links: note.links || [], assets })
            setOriginalAssets(assets)
            setSessionUploadedAssets([])
            setOriginalFileStoragePath(note.fileStoragePath || '')
            setSessionUploadedFilePath('')
            setDraftNoteId(note.id!)
            setEditingId(note.id!); setShowForm(true)
            window.scrollTo({ top: 0, behavior: 'smooth' })
        } catch (error) {
            console.error(error)
            setActionError('筆記內容載入失敗，暫時無法編輯。')
        }
    }

    const handleDelete = async (id: string) => {
        if (!confirm('確定要刪除？筆記將移至垃圾桶，30 天後永久刪除。')) return
        const note = notes.find(n => n.id === id); if (!note) return
        setActionError('')
        try {
        const linkedUpdates: Record<string, string[]> = {}
        for (const linkedId of (note.links || [])) {
            const linkedNote = notes.find(n => n.id === linkedId)
            if (linkedNote) {
                linkedUpdates[linkedId] = (linkedNote.links || []).filter(l => l !== id)
            }
        }
        if (Object.keys(linkedUpdates).length > 448) {
            alert('這則筆記的關聯數超過單次安全刪除上限（448），請先減少連結後再刪除。')
            return
        }
        // 反向連結、寫入垃圾桶與刪除原筆記全部放在同一批次。
        const batch = writeBatch(kmsDB)
        Object.entries(linkedUpdates).forEach(([linkedId, links]) => {
            batch.update(userDoc(kmsDB, 'notes', linkedId), { links, updatedAt: new Date().toISOString() })
        })
        batch.set(userDoc(kmsDB, 'trash', id), { ...note, deletedAt: new Date().toISOString() })
        batch.delete(userDoc(kmsDB, 'notes', id))
        await batch.commit()
        invalidateKmsNotes()
        invalidateKmsTrash()
        onNotesChanged()
        // 本地移除，不重讀 Firestore
        setNotes(prev => prev
            .filter(n => n.id !== id)
            .map(n => linkedUpdates[n.id!] ? { ...n, links: linkedUpdates[n.id!] } : n))
        } catch (error) {
            console.error(error)
            setActionError('筆記刪除失敗，資料尚未移至垃圾桶，請稍後重試。')
        }
    }

    const legacyNotes = notes.filter(needsLegacyNoteMigration)

    const handleLegacyMigration = async () => {
        if (!legacyNotes.length || uploadsActive) return
        if (!confirm(`將目前頁面的 ${legacyNotes.length} 則舊筆記拆分摘要／正文，並把舊原圖轉為縮圖。過程中請保持頁面開啟，是否繼續？`)) return

        setActionError('')
        setUploadActive('migration', true)
        let completed = 0
        let failed = 0
        try {
            for (const note of legacyNotes) {
                setMigrationStatus(`正在遷移 ${completed + failed + 1} / ${legacyNotes.length}：${note.title}`)
                try {
                    await migrateLegacyKmsNote(note)
                    completed += 1
                } catch (error) {
                    failed += 1
                    console.error(`遷移筆記 ${note.id} 失敗`, error)
                }
            }
            invalidateKmsNotes()
            await load()
            setMigrationStatus(`遷移完成：成功 ${completed} 則${failed ? `，失敗 ${failed} 則` : ''}`)
            if (failed) setActionError('部分舊附件遷移失敗，原始資料仍保留，可稍後再次執行。')
        } finally {
            setUploadActive('migration', false)
        }
    }

    // ── Autocomplete helpers ────────────────────────────────────────────
    const addTag = (tag: string) => {
        const t = tag.trim()
        if (!t || form.hashtags.includes(t)) return
        setForm(f => ({ ...f, hashtags: [...f.hashtags, t] }))
        setNewTag('')
        setTagSuggestions([])
        setSuggestionIdx(-1)
    }

    const handleTagInput = (val: string) => {
        setNewTag(val)
        setSuggestionIdx(-1)
        if (val.trim()) {
            const q = val.trim().toLowerCase()
            const matched = allTags
                .filter(t => !form.hashtags.includes(t) && t.toLowerCase().includes(q))
                .slice(0, 8)
            setTagSuggestions(matched)
        } else {
            setTagSuggestions([])
        }
    }

    const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (tagSuggestions.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSuggestionIdx(i => Math.min(i + 1, tagSuggestions.length - 1))
                return
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSuggestionIdx(i => Math.max(i - 1, -1))
                return
            }
            if (e.key === 'Escape') {
                setTagSuggestions([])
                setSuggestionIdx(-1)
                return
            }
        }
        if (e.key === 'Enter') {
            e.preventDefault()
            const selected = suggestionIdx >= 0 ? tagSuggestions[suggestionIdx] : newTag
            addTag(selected)
        }
    }
    // ───────────────────────────────────────────────────────────────────

    // ── 批次匯入筆記（JSON / CSV） ────────────────────────────────────────
    // ✅ 1-2：CSV 解析改用 lib/csv 共用模組（支援引號包裹欄位）

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
                // ✅ 修正：使用 quoted CSV parser 取代 line.split(',')
                const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n').filter(l => l.trim())
                const headers = parseCSVLine(lines[0]).map(h => h.trim())
                rows = lines.slice(1).map(line => {
                    const cols = parseCSVLine(line)
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
                    const importedRef = doc(userCol(kmsDB, 'notes'))
                    const importBatch = writeBatch(kmsDB)
                    importBatch.set(importedRef, {
                        title, type, url,
                        hashtags,
                        searchTerms: buildKmsSearchTerms(title, hashtags),
                        tagPaths: buildKmsTagPaths(hashtags),
                        isUntagged: hashtags.length === 0,
                        links: [],
                        createdAt: row.createdAt || now,
                        updatedAt: now,
                    })
                    importBatch.set(userDoc(kmsDB, 'noteBodies', importedRef.id), { content, assets: [] })
                    await importBatch.commit()
                    success++
                } catch { skipped++ }
            }

            setImportMsg(`✅ 匯入完成：成功 ${success} 筆，略過 ${skipped} 筆`)
            // 重讀一次（批次匯入資料量大，local state 更新複雜度高，直接重讀即可）
            invalidateKmsNotes()
            onNotesChanged()
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

    const filtered = (remoteResults ?? notes)
        .filter(n => {
            const q = search.toLowerCase()
            const matchSearch = !search ||
                n.title.toLowerCase().includes(q) ||
                n.hashtags?.some(t => t.toLowerCase().includes(q)) ||
                (n.url?.toLowerCase().includes(q) ?? false)
            const matchTag = !selectedTag
                || (selectedTag === KMS_UNTAGGED_KEY
                    ? (n.hashtags?.length ?? 0) === 0
                    : n.hashtags?.some(t => t === selectedTag || t.startsWith(selectedTag + '/')))
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

    // ── 第一層：標籤入口分組 ───────────────────────────────────────────────
    // 只取每個 hashtag 的最上層（以 / 分隔的第一段），子標籤折疊在內。
    // 例如 生活、生活/物慾、生活/酒 都會歸到「生活」這個入口。
    // 點某個入口 → setSelectedTag(該標籤) → 沿用既有 filtered 過濾邏輯
    //（filtered 的 matchTag 已支援 startsWith(selectedTag + '/')，會帶出子標籤）。
    const tagGroups = (() => {
        const counts = new Map<string, number>()
        let untagged = globalTagStats?.untagged ?? 0
        if (globalTagStats) {
            const roots = Object.keys(globalTagStats.rootCounts).length
                ? globalTagStats.rootCounts
                : Object.fromEntries(Object.entries(globalTagStats.counts).map(([tag, count]) => [tag.split('/')[0], count]))
            Object.entries(roots).forEach(([tag, count]) => counts.set(tag, count))
        } else {
            notes.forEach(n => {
                const tags = n.hashtags ?? []
                if (tags.length === 0) { untagged++; return }
                const tops = Array.from(new Set(tags.map(t => t.split('/')[0])))
                tops.forEach(top => counts.set(top, (counts.get(top) ?? 0) + 1))
            })
        }
        const sorted = Array.from(counts.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => {
                // 依「標籤管理」頁存的父標籤順序排序
                const ia = parentOrder.indexOf(a.name)
                const ib = parentOrder.indexOf(b.name)
                if (ia !== -1 && ib !== -1) return ia - ib   // 兩者都有排序 → 照索引
                if (ia !== -1) return -1                      // 只有 a 有 → a 排前
                if (ib !== -1) return 1                       // 只有 b 有 → b 排前
                // 都不在排序清單裡 → 依名稱（與標籤管理頁的 fallback 一致）
                return a.name.localeCompare(b.name, 'zh-TW')
            })
        // 未分類（無任何標籤）排在所有標籤卡之後
        if (untagged > 0) sorted.push({ name: KMS_UNTAGGED_KEY, count: untagged })
        return sorted
    })()
    // ─────────────────────────────────────────────────────────────────────

    return (
        <>
            <style>{`
        .kms-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
        @media (max-width: 700px) { .kms-grid { grid-template-columns: 1fr; } }
        .form-grid { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
        @media (max-width: 600px) { .form-grid { grid-template-columns: 1fr; } }
        .note-content { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .note-content.expanded { display: block; }
        .note-card-highlight { box-shadow: 0 0 0 2px var(--c-accent) !important; }
        .kms-search-toolbar { position: sticky; top: 0; z-index: 20; display: flex; gap: 12px; margin: -8px -8px 16px; padding: 8px; flex-wrap: wrap; align-items: center; border-radius: 10px; background: color-mix(in srgb, var(--c-bg) 94%, transparent); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
        .kms-search-box { position: relative; flex: 1; min-width: 200px; }
        .kms-search-clear { position: absolute; top: 50%; right: 4px; display: inline-flex; width: 34px; height: 34px; align-items: center; justify-content: center; transform: translateY(-50%); border: 0; border-radius: 7px; color: var(--c-muted); background: transparent; cursor: pointer; }
        .kms-search-clear:hover { color: var(--c-text); background: var(--c-card); }
        .kms-results-count { color: var(--c-muted); font-size: 12px; white-space: nowrap; }
        .sort-btn { display: flex; min-height: 34px; align-items: center; gap: 4px; border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer; transition: all 0.15s; }
        .kms-icon-button { display: inline-flex; width: 36px; height: 36px; align-items: center; justify-content: center; border-radius: 8px !important; }
        .link-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px; cursor: pointer; transition: background 0.15s; }
        .link-item:hover { background: color-mix(in srgb, var(--c-accent) 8%, transparent); }
        .tag-suggestion-item:hover { background: color-mix(in srgb, var(--c-accent) 12%, transparent) !important; color: var(--c-accent) !important; }
        .template-menu-item:hover { background: color-mix(in srgb, var(--c-accent) 10%, transparent); }
        .tag-entry-card:hover { border-color: var(--c-accent) !important; }
        .tag-entry-card:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 2px; }
        @media (max-width: 767px) {
            .kms-search-toolbar { top: 0; margin-inline: -4px; padding-inline: 4px; }
            .kms-search-box { flex-basis: 100%; }
            .kms-results-count { order: 3; margin-left: auto; }
            .sort-btn { min-height: 44px; }
            .kms-icon-button { width: 44px; height: 44px; }
        }
      `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1400px', margin: '0 auto' }}>

                {/* 標題列 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
                    <div>
                        {/* 返回鍵：只在選了標籤時出現，點擊清空 selectedTag 回到標籤入口 */}
                        {selectedTag && (
                            <button
                                onClick={() => setSelectedTag('')}
                                style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)', color: 'var(--c-muted)', fontSize: '13px', padding: '4px 12px', marginBottom: '8px' }}>
                                ← 全部標籤
                            </button>
                        )}
                        <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>
                            {selectedTag ? (selectedTag === KMS_UNTAGGED_KEY ? '未分類' : `#${selectedTag}`) : '知識庫'}
                        </h1>
                        <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>
                            {!selectedTag && !search
                                ? `${tagGroups.filter(g => g.name !== KMS_UNTAGGED_KEY).length} 個標籤・${notes.length} 則筆記`
                                : `共 ${filtered.length} 則筆記`}
                        </p>
                    </div>
                    <div className="page-actions" style={{ display: 'flex', gap: '8px' }}>
                        <button style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)' }} onClick={() => { setShowImport(true); setImportMsg('') }}>
                            <Upload size={14} />批次匯入
                        </button>
                        <button style={btn('var(--c-accent)')} onClick={openNewNote}>
                            <Plus size={16} />新增
                        </button>
                    </div>
                </div>

                {actionError && (
                    <div role="alert" style={{ marginBottom: '16px', padding: '10px 14px', borderRadius: '8px', backgroundColor: 'rgba(255,87,87,0.1)', border: '1px solid rgba(255,87,87,0.3)', color: 'var(--c-danger)', fontSize: '13px' }}>
                        {actionError}
                    </div>
                )}

                {legacyNotes.length > 0 && (
                    <div style={{ marginBottom: '16px', padding: '12px 14px', borderRadius: '10px', backgroundColor: 'color-mix(in srgb, var(--c-warning) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--c-warning) 35%, transparent)', color: 'var(--c-text)', fontSize: '13px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                        <span>目前頁面有 {legacyNotes.length} 則舊筆記待最佳化：拆分摘要／正文，舊原圖會搬到私有路徑並補產生縮圖。</span>
                        <button style={btn('var(--c-warning)')} onClick={() => void handleLegacyMigration()} disabled={uploadsActive}>
                            <Upload size={14} />{activeUploads.has('migration') ? '遷移中…' : '遷移舊附件'}
                        </button>
                    </div>
                )}

                {migrationStatus && (
                    <div aria-live="polite" style={{ marginBottom: '16px', fontSize: '12px', color: 'var(--c-muted)' }}>{migrationStatus}</div>
                )}

                {/* 批次匯入 Modal */}
                {showImport && (
                    <div className="mobile-modal" style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.75)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
                        <div style={{ ...card, width: '100%', maxWidth: '560px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                <span style={{ fontSize: '16px', fontWeight: 600, color: 'var(--c-text)' }}>批次匯入筆記</span>
                                <button onClick={() => setShowImport(false)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><X size={18} /></button>
                            </div>

                            {/* 格式說明 */}
                            <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', border: '1px solid var(--c-border)', fontSize: '12px', color: 'var(--c-muted)', lineHeight: 1.9 }}>
                                <div style={{ color: 'var(--c-accent)', fontWeight: 600, marginBottom: '6px' }}>支援格式</div>
                                <div style={{ marginBottom: '8px' }}>
                                    <span style={{ color: '#a78bfa', fontWeight: 600 }}>JSON</span> — 陣列格式，每筆含：
                                    <span style={{ color: 'var(--c-text)' }}> title</span>（必填）、
                                    <span style={{ color: 'var(--c-text)' }}> content</span>、
                                    <span style={{ color: 'var(--c-text)' }}> type</span>（note/url/image/file）、
                                    <span style={{ color: 'var(--c-text)' }}> url</span>、
                                    <span style={{ color: 'var(--c-text)' }}> hashtags</span>（字串陣列）
                                </div>
                                <div>
                                    <span style={{ color: 'var(--c-positive)', fontWeight: 600 }}>CSV</span> — 標題行：
                                    <span style={{ color: 'var(--c-text)' }}> title, content, type, url, hashtags</span>（hashtags 用分號分隔）
                                </div>
                                <div style={{ marginTop: '8px', color: 'var(--c-warning)' }}>※ 重複標題的筆記不會被覆蓋，會新增一筆</div>
                            </div>

                            <label style={{ ...btn('#a78bfa'), width: 'fit-content', cursor: 'pointer', opacity: importing ? 0.6 : 1 }}>
                                <Upload size={15} />
                                {importing ? '匯入中...' : '選擇 JSON / CSV 檔案'}
                                <input ref={importFileRef} type="file" accept=".json,.csv" onChange={handleImportNotes} disabled={importing} style={{ display: 'none' }} />
                            </label>

                            {importMsg && (
                                <div style={{ marginTop: '14px', padding: '10px 14px', borderRadius: '8px', backgroundColor: importMsg.startsWith('❌') ? 'rgba(255,87,87,0.1)' : 'rgba(0,200,150,0.1)', border: `1px solid ${importMsg.startsWith('❌') ? 'rgba(255,87,87,0.3)' : 'rgba(0,200,150,0.3)'}`, color: importMsg.startsWith('❌') ? 'var(--c-danger)' : 'var(--c-positive)', fontSize: '13px' }}>
                                    {importMsg}
                                </div>
                            )}

                            <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end' }}>
                                <button style={{ ...btn('var(--c-border)'), fontSize: '13px' }} onClick={() => setShowImport(false)}><X size={14} />關閉</button>
                            </div>
                        </div>
                    </div>
                )}

                {/* 表單 */}
                {showForm && (
                    <div className="mobile-sticky-form" style={{ ...card, marginBottom: '24px' }}>
                        {/* ── 表單 Header ── */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
                            <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--c-text)' }}>{editingId ? '✏️ 編輯筆記' : '➕ 新增筆記'}</span>

                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                {/* 帶入格式按鈕：只在新增模式顯示 */}
                                {!editingId && (
                                    <div style={{ position: 'relative' }}>
                                        <button
                                            onClick={() => !templateLoading && setShowTemplateMenu(v => !v)}
                                            disabled={templateLoading}
                                            style={{
                                                display: 'flex', alignItems: 'center', gap: '6px',
                                                padding: '6px 12px', borderRadius: '7px',
                                                border: '1px solid var(--c-warning)',
                                                backgroundColor: showTemplateMenu ? 'rgba(245,166,35,0.15)' : 'rgba(245,166,35,0.08)',
                                                color: 'var(--c-warning)', fontSize: '13px',
                                                cursor: templateLoading ? 'wait' : 'pointer',
                                                opacity: templateLoading ? 0.7 : 1,
                                            }}
                                        >
                                            <ClipboardList size={14} />
                                            {templateLoading ? '帶入中…' : '帶入格式'}
                                            {!templateLoading && <ChevronDown size={13} style={{ transform: showTemplateMenu ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />}
                                        </button>

                                        {/* 下拉選單 */}
                                        {showTemplateMenu && (
                                            <div style={{
                                                position: 'absolute', top: 'calc(100% + 6px)', right: 0,
                                                backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)',
                                                borderRadius: '10px', padding: '6px', zIndex: 100,
                                                minWidth: '200px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                                            }}>
                                                {NOTE_TEMPLATES.map(tmpl => (
                                                    <button
                                                        key={tmpl.id}
                                                        className="template-menu-item"
                                                        onClick={() => { void applyTemplate(tmpl) }}
                                                        style={{
                                                            display: 'flex', alignItems: 'center', gap: '8px',
                                                            width: '100%', padding: '9px 12px', borderRadius: '7px',
                                                            border: 'none', backgroundColor: 'transparent',
                                                            color: 'var(--c-text)', fontSize: '13px', cursor: 'pointer',
                                                            textAlign: 'left',
                                                        }}
                                                    >
                                                        <span style={{ fontSize: '16px' }}>{tmpl.emoji}</span>
                                                        {tmpl.label}
                                                        <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--c-accent)', backgroundColor: 'color-mix(in srgb, var(--c-accent) 12%, transparent)', borderRadius: '4px', padding: '1px 6px' }}>
                                                            #{tmpl.hashtags[0]}
                                                        </span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}

                                <button onClick={() => void closeNoteForm()} disabled={uploadsActive} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: uploadsActive ? 'wait' : 'pointer' }}>
                                    <X size={18} />
                                </button>
                            </div>
                        </div>

                        {/* 類型 */}
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
                            {Object.entries(TYPE_LABELS).map(([key, label]) => {
                                const Icon = TYPE_ICONS[key]
                                return (
                                    <button key={key} onClick={() => setForm(f => ({ ...f, type: key as any }))}
                                        style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 14px', borderRadius: '8px', border: '1px solid', borderColor: form.type === key ? TYPE_COLORS[key] : 'var(--c-border)', backgroundColor: form.type === key ? `${TYPE_COLORS[key]}18` : 'transparent', color: form.type === key ? TYPE_COLORS[key] : 'var(--c-muted)', fontSize: '13px', cursor: 'pointer' }}>
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
                                    <label style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)', cursor: 'pointer', width: 'fit-content' }}>
                                        <Image size={14} />{activeUploads.has('cover') ? '上傳中...' : '選擇圖片'}
                                        <input ref={imgRef} type="file" accept="image/*,.heic,.heif" onChange={handleImageUpload} disabled={uploadsActive} style={{ display: 'none' }} />
                                    </label>
                                </div>
                            )}
                            {form.type === 'file' && (
                                <div style={{ gridColumn: 'span 2' }}>
                                    <label style={lbl}>文件（PDF / Word）</label>
                                    {form.fileName && <p style={{ fontSize: '13px', color: 'var(--c-positive)', margin: '0 0 8px' }}>📄 {form.fileName}</p>}
                                    <label style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)', cursor: 'pointer', width: 'fit-content' }}>
                                        <FileText size={14} />{activeUploads.has('file') ? '上傳中...' : '選擇文件'}
                                        <input ref={fileRef} type="file" accept=".pdf,.docx,.doc" onChange={handleFileUpload} disabled={uploadsActive} style={{ display: 'none' }} />
                                    </label>
                                </div>
                            )}
                            <div style={{ gridColumn: 'span 2' }}>
                                <label style={lbl}>文章內容</label>
                                <RichTextEditor
                                    key={draftNoteId}
                                    noteId={draftNoteId}
                                    value={form.contentDoc}
                                    fallbackText={form.content}
                                    assets={form.assets || []}
                                    preserveAssetIds={form.coverAssetId ? [form.coverAssetId] : []}
                                    onChange={(contentDoc, content, assets) => {
                                        setForm(current => ({ ...current, contentDoc, content, assets }))
                                    }}
                                    onAssetUploaded={asset => {
                                        setSessionUploadedAssets(current => [...current, asset])
                                    }}
                                    onUploadingChange={active => setUploadActive('editor', active)}
                                />
                            </div>

                            {/* Hashtag */}
                            <div style={{ gridColumn: 'span 2' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                    <label style={{ ...lbl, margin: 0 }}>Hashtag 標籤</label>
                                    <button onClick={handleAutoTag} disabled={aiLoading} style={{ ...btn('#a78bfa'), fontSize: '12px', padding: '4px 12px' }}>
                                        <Sparkles size={13} />{aiLoading ? 'AI 分析中...' : 'AI 自動產生'}
                                    </button>
                                </div>
                                <p style={{ fontSize: '11px', color: 'var(--c-muted)', margin: '0 0 8px' }}>支援母子標籤，用 / 分隔，例如：投資/台股</p>

                                {/* 已加入的標籤 */}
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                                    {form.hashtags.map(tag => (
                                        <span key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', backgroundColor: 'color-mix(in srgb, var(--c-accent) 12%, transparent)', color: 'var(--c-accent)', borderRadius: '20px', padding: '3px 10px', fontSize: '12px' }}>
                                            #{tag}<button onClick={() => setForm(f => ({ ...f, hashtags: f.hashtags.filter(t => t !== tag) }))} style={{ background: 'none', border: 'none', color: 'var(--c-accent)', cursor: 'pointer', padding: 0 }}>×</button>
                                        </span>
                                    ))}
                                </div>

                                {/* 輸入框 + Autocomplete 下拉 */}
                                <div style={{ position: 'relative' }}>
                                    <div style={{ display: 'flex', gap: '8px' }}>
                                        <input
                                            ref={tagInputRef}
                                            style={{ ...inp, flex: 1 }}
                                            placeholder="輸入標籤名稱快速搜尋，Enter 確認新增"
                                            value={newTag}
                                            onChange={e => handleTagInput(e.target.value)}
                                            onKeyDown={handleTagKeyDown}
                                            onBlur={() => setTimeout(() => setTagSuggestions([]), 150)}
                                            autoComplete="off"
                                        />
                                        <button style={btn('var(--c-border)')} onClick={() => addTag(newTag)}><Plus size={14} /></button>
                                    </div>

                                    {/* Autocomplete 下拉選單 */}
                                    {tagSuggestions.length > 0 && (
                                        <div style={{
                                            position: 'absolute', top: '100%', left: 0, right: '48px',
                                            backgroundColor: '#1e2235',
                                            border: '1px solid var(--c-border)',
                                            borderRadius: '8px',
                                            marginTop: '4px',
                                            zIndex: 200,
                                            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                                            overflow: 'hidden'
                                        }}>
                                            {tagSuggestions.map((tag, i) => (
                                                <div
                                                    key={tag}
                                                    className="tag-suggestion-item"
                                                    onMouseDown={() => addTag(tag)}
                                                    onMouseEnter={() => setSuggestionIdx(i)}
                                                    style={{
                                                        padding: '9px 14px',
                                                        fontSize: '13px',
                                                        cursor: 'pointer',
                                                        color: i === suggestionIdx ? 'var(--c-accent)' : '#c8d0e0',
                                                        backgroundColor: i === suggestionIdx ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)' : 'transparent',
                                                        transition: 'background 0.1s, color 0.1s',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: '6px'
                                                    }}
                                                >
                                                    <span style={{ color: i === suggestionIdx ? 'var(--c-accent)' : '#4a5270', fontSize: '11px' }}>#</span>
                                                    {tag}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {/* 快速選擇：現有標籤（未選的前 12 個） */}
                                {allTags.length > 0 && (
                                    <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                        {allTags.filter(t => !form.hashtags.includes(t)).slice(0, 12).map(tag => (
                                            <button key={tag} onClick={() => addTag(tag)}
                                                style={{ backgroundColor: 'rgba(79,142,247,0.06)', color: 'var(--c-muted)', border: '1px solid var(--c-border)', borderRadius: '20px', padding: '2px 8px', fontSize: '11px', cursor: 'pointer' }}>
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
                                        {(form.links?.length || 0) > 0 && <span style={{ marginLeft: '6px', fontSize: '11px', backgroundColor: 'color-mix(in srgb, var(--c-accent) 12%, transparent)', color: 'var(--c-accent)', borderRadius: '10px', padding: '1px 6px' }}>{form.links?.length}</span>}
                                    </label>
                                    <div style={{ display: 'flex', gap: '6px' }}>
                                        <button onClick={handleAILinks} disabled={aiLinkLoading} style={{ ...btn('var(--c-positive)'), fontSize: '12px', padding: '4px 12px' }}>
                                            <Sparkles size={13} />{aiLinkLoading ? 'AI 分析中...' : 'AI 建議連結'}
                                        </button>
                                        <button onClick={() => setShowLinkPicker(v => !v)} style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)', fontSize: '12px', padding: '4px 12px' }}>
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
                                                <span key={linkId} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', backgroundColor: 'rgba(0,200,150,0.1)', color: 'var(--c-positive)', borderRadius: '20px', padding: '3px 10px', fontSize: '12px' }}>
                                                    🔗 {linkedNote.title.slice(0, 20)}
                                                    <button onClick={() => toggleLink(linkId)} style={{ background: 'none', border: 'none', color: 'var(--c-positive)', cursor: 'pointer', padding: 0 }}>×</button>
                                                </span>
                                            )
                                        })}
                                    </div>
                                )}

                                {/* 連結選擇器 */}
                                {showLinkPicker && (
                                    <div style={{ backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '12px', marginTop: '8px' }}>
                                        <input style={{ ...inp, marginBottom: '8px', fontSize: '13px' }} placeholder="搜尋筆記..." value={linkSearch}
                                            onChange={e => setLinkSearch(e.target.value)} />
                                        <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                                            {linkableNotes.slice(0, 20).map(n => {
                                                const isLinked = form.links?.includes(n.id!)
                                                return (
                                                    <div key={n.id} className="link-item" onClick={() => toggleLink(n.id!)}
                                                        style={{ backgroundColor: isLinked ? 'rgba(0,200,150,0.08)' : 'transparent' }}>
                                                        <div style={{ width: '16px', height: '16px', borderRadius: '4px', border: `2px solid ${isLinked ? 'var(--c-positive)' : 'var(--c-border)'}`, backgroundColor: isLinked ? 'var(--c-positive)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                                            {isLinked && <Check size={10} color="#fff" />}
                                                        </div>
                                                        <div style={{ flex: 1, minWidth: 0 }}>
                                                            <div style={{ fontSize: '13px', color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title}</div>
                                                            {n.content && <div style={{ fontSize: '11px', color: 'var(--c-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.content.slice(0, 60)}</div>}
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                            {linkableNotes.length === 0 && <p style={{ fontSize: '13px', color: 'var(--c-muted)', textAlign: 'center', padding: '16px' }}>找不到筆記</p>}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="mobile-sticky-actions" style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
                            <button style={btn('var(--c-border)')} onClick={() => void closeNoteForm()} disabled={uploadsActive}><X size={14} />取消</button>
                            <button style={btn('var(--c-accent)')} onClick={handleSave} disabled={loading || uploadsActive}>
                                <Check size={14} />{uploadsActive ? '檔案處理中...' : loading ? '儲存中...' : editingId ? '確認更新' : '確認新增'}
                            </button>
                        </div>
                    </div>
                )}

                {/* 搜尋 + 排序 */}
                <div className="kms-search-toolbar">
                    <div className="kms-search-box">
                        <Search size={15} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--c-muted)' }} />
                        <input style={{ ...inp, paddingLeft: '36px', paddingRight: search ? '42px' : '12px', backgroundColor: 'var(--c-sidebar)' }}
                            placeholder="搜尋標題、內容、標籤..." value={search} onChange={e => setSearch(e.target.value)} />
                        {search && (
                            <button type="button" className="kms-search-clear" onClick={() => setSearch('')} aria-label="清除搜尋" title="清除搜尋">
                                <X size={15} />
                            </button>
                        )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                        <ArrowUpDown size={13} color="var(--c-muted)" />
                        {[
                            { key: 'createdAt' as const, label: '建立' },
                            { key: 'updatedAt' as const, label: '更新' },
                            { key: 'title' as const, label: '標題' },
                        ].map(({ key, label }) => (
                            <button key={key} className="sort-btn" onClick={() => handleSort(key)}
                                style={{ backgroundColor: sortBy === key ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)' : 'transparent', color: sortBy === key ? 'var(--c-accent)' : 'var(--c-muted)', border: `1px solid ${sortBy === key ? 'var(--c-accent)' : 'var(--c-border)'}` }}>
                                {label}{sortBy === key && <span>{sortDir === 'desc' ? ' ↓' : ' ↑'}</span>}
                            </button>
                        ))}
                    </div>
                    <span className="kms-results-count" aria-live="polite">
                        顯示 {filtered.length}／已載入 {notes.length} 則{hasMoreNotes ? '（尚有下一頁）' : ''}
                    </span>
                </div>

                {/* ── 內容區 ──────────────────────────────────────────────────
                    第一層（沒選標籤、沒搜尋）：顯示標籤入口卡片
                    其餘情況：沿用原本的筆記卡片列表
                */}
                {pageLoading && notes.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '64px', color: 'var(--c-muted)' }}>載入摘要中…</div>
                ) : !selectedTag && !search ? (
                    notes.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '64px', color: 'var(--c-muted)' }}>
                            <p style={{ fontSize: '15px' }}>還沒有筆記，點上方「新增」開始記錄</p>
                        </div>
                    ) : (
                        <div className="kms-grid">
                            {tagGroups.map(g => (
                                <button key={g.name}
                                    type="button"
                                    className="tag-entry-card"
                                    onClick={() => setSelectedTag(g.name)}
                                    aria-label={`開啟${g.name === KMS_UNTAGGED_KEY ? '未分類' : g.name}，共 ${g.count} 則筆記`}
                                    style={{ ...card, width: '100%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', transition: 'border-color 0.15s', textAlign: 'left', font: 'inherit' }}>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                                        <span style={{ fontSize: '16px', fontWeight: 600, color: 'var(--c-accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name === KMS_UNTAGGED_KEY ? '未分類' : g.name}</span>
                                    </span>
                                    <span style={{ fontSize: '13px', color: 'var(--c-muted)', flexShrink: 0 }}>{g.count} 則</span>
                                </button>
                            ))}
                        </div>
                    )
                ) : filtered.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '64px', color: 'var(--c-muted)' }}>
                        <p style={{ fontSize: '15px' }}>{search || selectedTag ? '找不到相關筆記' : '還沒有筆記，點上方「新增筆記」開始記錄'}</p>
                    </div>
                ) : (
                    <div className="kms-grid">
                        {filtered.map(note => {
                            const Icon = TYPE_ICONS[note.type] || FileText
                            const color = TYPE_COLORS[note.type] || 'var(--c-accent)'
                            const isExpanded = expandedId === note.id
                            const isHighlighted = searchParams.get('note') === note.id
                            const linkedNotes = (note.links || []).map(id => notes.find(n => n.id === id)).filter(Boolean) as Note[]
                            const fullBody = note.id ? bodies[note.id] : undefined

                            return (
                                <VirtualNoteItem key={note.id}>{() => (
                                <div
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
                                            <button className="kms-icon-button" onClick={() => void handleEdit(note)} aria-label={`編輯「${note.title}」`} title="編輯筆記" style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><Pencil size={14} /></button>
                                            <button className="kms-icon-button" onClick={() => handleDelete(note.id!)} aria-label={`刪除「${note.title}」`} title="刪除筆記" style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><Trash2 size={14} /></button>
                                        </div>
                                    </div>

                                    <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: 'var(--c-text)', lineHeight: 1.4 }}>{note.title}</h3>

                                    {(note.coverThumbnailUrl || note.imageUrl) && <img src={note.coverThumbnailUrl || note.imageUrl} alt="" loading="lazy" decoding="async" style={{ width: '100%', maxHeight: '180px', objectFit: 'cover', borderRadius: '8px' }} />}

                                    {!note.imageUrl && !isExpanded && note.articleThumbnailUrl && (
                                        <img src={note.articleThumbnailUrl} alt="文章圖片預覽" loading="lazy" decoding="async"
                                            style={{ width: '100%', maxHeight: '180px', objectFit: 'cover', borderRadius: '8px' }} />
                                    )}

                                    {note.url && (
                                        <a href={note.url} target="_blank" rel="noopener noreferrer"
                                            style={{ fontSize: '12px', color: 'var(--c-positive)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            <Link size={12} />{note.url}
                                        </a>
                                    )}

                                    {note.fileUrl && note.fileName && (
                                        <a href={note.fileUrl} target="_blank" rel="noopener noreferrer"
                                            style={{ fontSize: '12px', color: '#a78bfa', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                            <FileText size={12} />{note.fileName}
                                        </a>
                                    )}

                                    {isExpanded && fullBody && (
                                        fullBody.contentDoc
                                            ? <RichTextContent doc={fullBody.contentDoc} assets={fullBody.assets} />
                                            : <p className="note-content" style={{ margin: 0, fontSize: '13px', color: 'var(--c-muted)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{fullBody.content}</p>
                                    )}
                                    <button onClick={() => void handleExpand(note)} disabled={bodyLoadingId === note.id}
                                        style={{ background: 'none', border: 'none', color: 'var(--c-accent)', fontSize: '12px', cursor: bodyLoadingId === note.id ? 'wait' : 'pointer', padding: '4px 0', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                        {bodyLoadingId === note.id ? '載入全文中…' : isExpanded ? <><ChevronUp size={12} />收起</> : <><ChevronDown size={12} />展開全文</>}
                                    </button>

                                    {note.hashtags?.length > 0 && (
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                            {note.hashtags.map(tag => (
                                                <button key={tag} onClick={() => setSelectedTag(tag)}
                                                    style={{ backgroundColor: 'color-mix(in srgb, var(--c-accent) 8%, transparent)', color: 'var(--c-accent)', border: 'none', borderRadius: '20px', padding: '2px 8px', fontSize: '11px', cursor: 'pointer' }}>
                                                    #{tag}
                                                </button>
                                            ))}
                                        </div>
                                    )}

                                    {/* 雙向連結顯示 */}
                                    {linkedNotes.length > 0 && (
                                        <div style={{ borderTop: '1px solid var(--c-border)', paddingTop: '10px' }}>
                                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                <Link2 size={11} />連結筆記 ({linkedNotes.length})
                                            </div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                                {linkedNotes.map(linked => (
                                                    <div key={linked.id}
                                                        onClick={() => {
                                                            void handleExpand(linked)
                                                            noteRefs.current[linked.id!]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                                                        }}
                                                        style={{ backgroundColor: 'var(--c-bg)', borderRadius: '6px', padding: '8px 10px', cursor: 'pointer', border: '1px solid var(--c-border)', transition: 'border-color 0.15s' }}
                                                        onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--c-positive)')}
                                                        onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--c-border)')}>
                                                        <div style={{ fontSize: '12px', color: 'var(--c-positive)', fontWeight: 600, marginBottom: '3px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                            🔗 {linked.title}
                                                        </div>
                                                        {linked.content && (
                                                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                {linked.content.slice(0, 80)}
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    <div style={{ fontSize: '11px', color: 'var(--c-muted)', borderTop: '1px solid var(--c-border)', paddingTop: '8px', display: 'flex', justifyContent: 'space-between' }}>
                                        <span>建立：{new Date(note.createdAt).toLocaleDateString('zh-TW')}</span>
                                        {note.updatedAt !== note.createdAt && <span>更新：{new Date(note.updatedAt).toLocaleDateString('zh-TW')}</span>}
                                    </div>
                                </div>
                                )}</VirtualNoteItem>
                            )
                        })}
                    </div>
                )}

                {hasMoreNotes && (
                    <div style={{ display: 'flex', justifyContent: 'center', marginTop: '20px' }}>
                        <button onClick={() => void loadMoreNotes()} disabled={pageLoading} style={btn('var(--c-card)')}>
                            {pageLoading ? '載入中…' : `載入下一頁（每頁 ${NOTES_PAGE_SIZE} 則）`}
                        </button>
                    </div>
                )}
            </div>
        </>
    )
}
