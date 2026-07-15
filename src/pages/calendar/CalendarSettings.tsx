import { useState, useEffect } from 'react'
import { getDocs, setDoc, deleteDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc } from '../../lib/userDB'
import { Plus, Trash2, Search, Link2, Unlink, CheckCircle2 } from 'lucide-react'
import { EVENT_LABELS, EVENT_COLORS } from '../../lib/calendarData'
import {
    getGoogleCalendarAuthUrl,
    parseGoogleAuthRedirect,
    getGoogleCalendarAuth,
    saveGoogleCalendarAuth,
    disconnectGoogleCalendar,
    setGoogleCalendarSyncTypes,
    type GoogleCalendarAuth,
    type SyncEventType,
} from '../../lib/googleCalendar'

const card: React.CSSProperties = { backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '8px 12px', color: 'var(--c-text)', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

export default function CalendarSettings() {
    const [watchList, setWatchList] = useState<{ code: string; name: string }[]>([])
    const [newCode, setNewCode] = useState('')
    const [newName, setNewName] = useState('')
    const [stockDict, setStockDict] = useState<Record<string, string>>({})
    const [search, setSearch] = useState('')

    // ── Google 行事曆連結狀態 ────────────────────────────────────────
    const [gcalAuth, setGcalAuth] = useState<GoogleCalendarAuth | null>(null)
    const [gcalLoading, setGcalLoading] = useState(true)
    const [gcalMessage, setGcalMessage] = useState<string | null>(null)
    const [gcalError, setGcalError] = useState<string | null>(null)

    const loadGcalAuth = async () => {
        try {
            const auth = await getGoogleCalendarAuth()
            setGcalAuth(auth)
        } catch (err) {
            console.error('loadGcalAuth 失敗：', err)
        }
        setGcalLoading(false)
    }

    // 處理 Google 導回的 URL fragment（連結成功／失敗都會導回這頁）
    useEffect(() => {
        const redirect = parseGoogleAuthRedirect()
        if (!redirect) { loadGcalAuth(); return }

        if (redirect.error) {
            setGcalError(redirect.error)
            setGcalLoading(false)
            return
        }
        if (redirect.refreshToken) {
            saveGoogleCalendarAuth(redirect.refreshToken)
                .then(() => { setGcalMessage('✅ Google 帳號連結成功'); loadGcalAuth() })
                .catch(err => { console.error('saveGoogleCalendarAuth 失敗：', err); setGcalError('儲存連結狀態失敗，請重試') })
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const handleConnectGoogle = () => {
        window.location.href = getGoogleCalendarAuthUrl()
    }

    const handleDisconnectGoogle = async () => {
        if (!confirm('確定要取消連結 Google 帳號？下次要同步時需要重新授權。')) return
        await disconnectGoogleCalendar()
        setGcalAuth(null)
    }

    const handleToggleSyncType = async (type: SyncEventType) => {
        if (!gcalAuth) return
        const current = new Set(gcalAuth.syncTypes)
        if (current.has(type)) current.delete(type); else current.add(type)
        const next = [...current]
        setGcalAuth({ ...gcalAuth, syncTypes: next })
        try {
            await setGoogleCalendarSyncTypes(next)
        } catch (err) {
            console.error('setGoogleCalendarSyncTypes 失敗：', err)
        }
    }

    const load = async () => {
        const snap = await getDocs(userCol(investDB, 'calendarWatchList'))
        setWatchList(snap.docs.map(d => ({ code: d.id, name: d.data().name || d.id })))
        const dictSnap = await getDocs(userCol(investDB, 'stockDict'))
        const dict: Record<string, string> = {}
        dictSnap.docs.forEach(d => { dict[d.id] = d.data().name })
        setStockDict(dict)
    }

    useEffect(() => { load() }, [])

    const handleAdd = async () => {
        if (!newCode.trim()) return
        const code = newCode.trim()
        const name = newName.trim() || stockDict[code] || code
        await setDoc(userDoc(investDB, 'calendarWatchList', code), { code, name })
        setNewCode(''); setNewName(''); load()
    }

    const handleDelete = async (code: string) => {
        await deleteDoc(userDoc(investDB, 'calendarWatchList', code)); load()
    }

    // 自動帶入股票名稱
    const handleCodeChange = (code: string) => {
        setNewCode(code)
        if (stockDict[code]) setNewName(stockDict[code])
    }

    const filtered = watchList.filter(w =>
        w.code.includes(search) || w.name.includes(search)
    )

    return (
        <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '800px', margin: '0 auto' }}>
            <div style={{ marginBottom: '24px' }}>
                <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>法說會關注清單</h1>
                <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>設定要追蹤法說會的股票，行事曆會自動顯示相關法說會</p>
            </div>

            {/* Google 行事曆連結 */}
            <div style={{ ...card, marginBottom: '16px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '12px' }}>Google 行事曆同步</div>

                {gcalMessage && (
                    <div style={{ backgroundColor: 'rgba(0,200,150,0.10)', border: '1px solid rgba(0,200,150,0.35)', borderRadius: '8px', padding: '8px 14px', marginBottom: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                        <span style={{ fontSize: '13px', color: 'var(--c-positive)' }}>{gcalMessage}</span>
                        <button onClick={() => setGcalMessage(null)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer', fontSize: '13px' }}>✕</button>
                    </div>
                )}
                {gcalError && (
                    <div style={{ backgroundColor: 'rgba(255,180,0,0.10)', border: '1px solid rgba(255,180,0,0.35)', borderRadius: '8px', padding: '8px 14px', marginBottom: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                        <span style={{ fontSize: '13px', color: 'var(--c-warning)' }}>⚠️ {gcalError}</span>
                        <button onClick={() => setGcalError(null)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer', fontSize: '13px' }}>✕</button>
                    </div>
                )}

                {gcalLoading ? (
                    <div style={{ fontSize: '13px', color: 'var(--c-muted)' }}>載入中…</div>
                ) : !gcalAuth ? (
                    <div>
                        <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '0 0 12px' }}>
                            連結 Google 帳號後，可以把未來半年的行事曆事件（法說會、除權息、個人行程等）手動同步到你的 Google 行事曆。
                        </p>
                        <button onClick={handleConnectGoogle} style={btn('#4285f4')}>
                            <Link2 size={14} />連結 Google 帳號
                        </button>
                    </div>
                ) : (
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
                            <CheckCircle2 size={16} color="var(--c-positive)" />
                            <span style={{ fontSize: '13px', color: 'var(--c-text)' }}>
                                已連結（{new Date(gcalAuth.connectedAt).toLocaleDateString('zh-TW')}）
                            </span>
                            <button onClick={handleDisconnectGoogle} style={{ ...btn('var(--c-border)'), padding: '4px 10px', fontSize: '12px', marginLeft: 'auto' }}>
                                <Unlink size={12} />取消連結
                            </button>
                        </div>

                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>要同步的標籤：</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                            {Object.entries(EVENT_LABELS).map(([type, label]) => {
                                const checked = gcalAuth.syncTypes.includes(type as SyncEventType)
                                return (
                                    <button key={type} onClick={() => handleToggleSyncType(type as SyncEventType)}
                                        style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 12px', borderRadius: '20px', border: '1px solid', borderColor: checked ? EVENT_COLORS[type] : 'var(--c-border)', backgroundColor: checked ? `${EVENT_COLORS[type]}18` : 'transparent', color: checked ? EVENT_COLORS[type] : 'var(--c-muted)', fontSize: '12px', cursor: 'pointer' }}>
                                        <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: EVENT_COLORS[type], display: 'inline-block' }} />
                                        {label}
                                    </button>
                                )
                            })}
                        </div>
                    </div>
                )}
            </div>

            <div style={{ ...card, marginBottom: '16px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '16px' }}>新增關注股票</div>
                <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: '1fr 1fr auto' }}>
                    <div>
                        <input style={inp} placeholder="股票代號（如 2330）" value={newCode}
                            onChange={e => handleCodeChange(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleAdd()} />
                    </div>
                    <div>
                        <input style={inp} placeholder="股票名稱（自動帶入）" value={newName}
                            onChange={e => setNewName(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleAdd()} />
                    </div>
                    <button style={btn('var(--c-accent)')} onClick={handleAdd}><Plus size={14} />新增</button>
                </div>
            </div>

            <div style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>關注清單 ({watchList.length})</div>
                    <div style={{ position: 'relative', width: '200px' }}>
                        <Search size={13} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--c-muted)' }} />
                        <input style={{ ...inp, paddingLeft: '30px', fontSize: '13px' }} placeholder="搜尋..." value={search} onChange={e => setSearch(e.target.value)} />
                    </div>
                </div>

                {filtered.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '32px', color: 'var(--c-muted)', fontSize: '13px' }}>
                        {search ? '找不到符合的股票' : '還沒有關注的股票，請先新增'}
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {filtered.map(w => (
                            <div key={w.code} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', backgroundColor: 'var(--c-bg)', borderRadius: '8px' }}>
                                <div>
                                    <span style={{ fontSize: '14px', color: 'var(--c-accent)', fontWeight: 600, marginRight: '10px' }}>{w.code}</span>
                                    <span style={{ fontSize: '14px', color: 'var(--c-text)' }}>{w.name}</span>
                                </div>
                                <button onClick={() => handleDelete(w.code)} style={{ background: 'none', border: 'none', color: 'var(--c-danger)', cursor: 'pointer' }}>
                                    <Trash2 size={15} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}