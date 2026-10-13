import LoadingState from '../../components/LoadingState'
import { card } from '../../ui/styles'
import { confirmAction } from '../../ui/dialogs'
import { purgeKmsTrash } from '../../lib/kmsPurge'
import { mutateLinkedKmsNote } from '../../lib/kmsNoteLinks'
import { useState, useEffect, useCallback } from 'react'
import { captureUserSession } from '../../lib/userDB'
import { fetchKmsTrash, invalidateKmsNotes, invalidateKmsTrash } from '../../lib/kmsData'
import { type NoteImageAsset } from '../../lib/kmsImages'
import { Trash2, RotateCcw, FileText, Link, Image } from 'lucide-react'

interface Note {
    id: string
    title: string
    content: string
    type: 'note' | 'url' | 'image' | 'file'
    hashtags: string[]
    assets?: NoteImageAsset[]
    fileStoragePath?: string
    purgeState?: string
    deletedAt: string
    createdAt: string
}

const TYPE_ICONS: Record<string, typeof FileText> = { note: FileText, url: Link, image: Image, file: FileText }
const TYPE_LABELS: Record<string, string> = { note: '文字筆記', url: '網址收藏', image: '圖片', file: '文件' }
const TYPE_COLORS: Record<string, string> = { note: 'var(--c-accent)', url: 'var(--c-positive)', image: 'var(--c-warning)', file: '#a78bfa' }

const permanentlyDelete = (note: Note, session = captureUserSession()) => purgeKmsTrash(note.id, session)

export default function KMSTrash() {
    const [trashed, setTrashed] = useState<Note[]>([])
    const [loading, setLoading] = useState(true)
    const [hasLoaded, setHasLoaded] = useState(false)
    const [busy, setBusy] = useState(false)
    const [errorMessage, setErrorMessage] = useState('')

    const load = useCallback(async () => {
        try {
            const session = captureUserSession()
            const rows = await fetchKmsTrash<Note>()
            session.assertActive()
            setErrorMessage('')
            const now = Date.now()
            const data: Note[] = []
            let cleanupFailed = false

            for (const item of rows) {
                session.assertActive()
                const deletedTime = new Date(item.deletedAt).getTime()
                if (now - deletedTime > 30 * 24 * 60 * 60 * 1000) {
                    try {
                        await permanentlyDelete(item, session)
                    } catch (error) {
                        session.assertActive()
                        console.error('自動清理垃圾桶失敗', error)
                        cleanupFailed = true
                        data.push(item)
                    }
                } else {
                    data.push(item)
                }
            }
            invalidateKmsTrash()
            data.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
            setTrashed(data)
            setHasLoaded(true)
            if (cleanupFailed) setErrorMessage('部分逾期項目暫時無法永久刪除，稍後會再次嘗試。')
        } catch (error) {
            console.error(error)
            setErrorMessage('垃圾桶載入失敗，請檢查網路後重試。')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { void load() }, [load])

    // 復原筆記
    // ⚠️ 必須用 setDoc 以「原本的 ID」寫回 notes/{id}：
    //    刪除流程是 set(trash/{id}) + delete(notes/{id})，還原時 notes/{id} 必不存在，
    //    若用 updateDoc + addDoc fallback 會永遠產生新的隨機 ID，
    //    其他筆記 links 陣列指向舊 ID 的雙向連結會全部斷裂、知識圖譜連線消失。
    const handleRestore = async (note: Note) => {
        if (busy) return
        setBusy(true)
        setErrorMessage('')
        try {
        await mutateLinkedKmsNote({ id: note.id, mode: 'restore' })
        invalidateKmsNotes()
        invalidateKmsTrash()
        await load()
        } catch (error) {
            console.error(error)
            setErrorMessage(error instanceof Error ? error.message : '復原失敗，請重新整理後確認。')
        } finally {
            setBusy(false)
        }
    }

    // 永久刪除
    const handlePermanentDelete = async (note: Note) => {
        if (!await confirmAction(`確定永久刪除「${note.title || '未命名筆記'}」？此操作無法復原。`)) return
        if (busy) return
        setBusy(true)
        setErrorMessage('')
        try {
            await permanentlyDelete(note)
            invalidateKmsTrash()
            await load()
        } catch (error) {
            console.error(error)
            setErrorMessage('清理未完成，部分附件可能已刪除；請重試永久刪除，不要復原。')
        } finally {
            setBusy(false)
        }
    }

    // 清空垃圾桶
    const handleEmptyTrash = async () => {
        if (!await confirmAction(`確定要清空垃圾桶？共 ${trashed.length} 則筆記將永久刪除。`)) return
        if (busy) return
        setBusy(true)
        setErrorMessage('')
        try {
            const session = captureUserSession()
            for (const note of trashed) {
                session.assertActive()
                await permanentlyDelete(note, session)
            }
            invalidateKmsTrash()
            await load()
        } catch (error) {
            invalidateKmsTrash()
            setErrorMessage(error instanceof Error ? error.message + '；清理未完成，請重試。' : '清理未完成，請重試。')
        } finally { setBusy(false) }

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

            <div style={{ padding: 'var(--ui-page-padding, clamp(16px, 3vw, 32px))', maxWidth: '1400px', margin: '0 auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
                    <div>
                        <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>垃圾桶</h1>
                        <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>
                            共 {trashed.length} 則筆記・30 天後自動永久刪除
                        </p>
                    </div>
                    {trashed.length > 0 && (
                        <button onClick={handleEmptyTrash} disabled={busy} style={{ backgroundColor: 'color-mix(in srgb, var(--c-danger) 12%, transparent)', border: '1px solid rgba(255,87,87,0.3)', borderRadius: '8px', padding: '8px 16px', color: 'var(--c-danger)', fontSize: '14px', cursor: busy ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <Trash2 size={15} />清空垃圾桶
                        </button>
                    )}
                </div>

                {errorMessage && (
                    <div role="alert" style={{ marginBottom: '16px', padding: '10px 14px', borderRadius: '8px', backgroundColor: 'rgba(255,87,87,0.1)', border: '1px solid rgba(255,87,87,0.3)', color: 'var(--c-danger)', fontSize: '13px' }}>
                        {errorMessage}
                    </div>
                )}

                {loading && hasLoaded && <p className="ui-refresh-status" role="status">資料更新中…</p>}
                {loading && !hasLoaded ? (
                    <LoadingState />
                ) : trashed.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '64px', color: 'var(--c-muted)' }}>
                        <Trash2 size={40} style={{ opacity: 0.3, marginBottom: '12px' }} />
                        <p style={{ fontSize: '15px' }}>垃圾桶是空的</p>
                    </div>
                ) : (
                    <div className="trash-grid">
                        {trashed.map(note => {
                            const Icon = TYPE_ICONS[note.type] || FileText
                            const color = TYPE_COLORS[note.type] || 'var(--c-accent)'
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
                                            <button onClick={() => void handleRestore(note)} disabled={busy || note.purgeState === 'deleting'} title="復原"
                                                style={{ background: 'none', border: '1px solid var(--c-border)', borderRadius: '6px', color: 'var(--c-positive)', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
                                                <RotateCcw size={13} />復原
                                            </button>
                                            <button onClick={() => void handlePermanentDelete(note)} disabled={busy} title="永久刪除"
                                                style={{ background: 'none', border: 'none', color: 'var(--c-danger)', cursor: 'pointer', padding: '4px' }}>
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    </div>

                                    <h3 style={{ margin: '0 0 8px', fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>{note.title}</h3>

                                    {note.content && (
                                        <p style={{ margin: '0 0 8px', fontSize: '12px', color: 'var(--c-muted)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                                            {note.content}
                                        </p>
                                    )}

                                    {note.hashtags?.length > 0 && (
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '8px' }}>
                                            {note.hashtags.map(tag => (
                                                <span key={tag} style={{ backgroundColor: 'color-mix(in srgb, var(--c-accent) 8%, transparent)', color: 'var(--c-accent)', borderRadius: '20px', padding: '2px 8px', fontSize: '11px' }}>
                                                    #{tag}
                                                </span>
                                            ))}
                                        </div>
                                    )}

                                    <div style={{ fontSize: '11px', color: daysLeft <= 7 ? 'var(--c-danger)' : 'var(--c-muted)', borderTop: '1px solid var(--c-border)', paddingTop: '8px' }}>
                                        {note.purgeState === 'deleting' ? '清理已開始，無法復原；請重試永久刪除。' : daysLeft <= 7 ? `⚠️ 還有 ${daysLeft} 天永久刪除` : `${daysLeft} 天後永久刪除`}
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
