import { card, inp, btn } from '../../ui/styles'
import { confirmAction } from '../../ui/dialogs'
import { useState, useEffect, useRef, useCallback } from 'react'
import AnnualDataNotice from '../../components/AnnualDataNotice'
import AnnualCalendarStatus from '../../components/AnnualCalendarStatus'
import { googleSyncDateRange } from '../../lib/annualDataCoverage'
import { getDocs, setDoc, deleteDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userDoc, captureUserSession } from '../../lib/userDB'
import { Plus, Trash2, Search, Link2, Unlink, CheckCircle2 } from 'lucide-react'
import { EVENT_LABELS, EVENT_COLORS } from '../../lib/calendarData'
import { GOOGLE_ACCOUNT_EMAIL, hasGoogleSheetsAuthorization, hasGoogleDriveSearchAuthorization, hasGoogleReportAuthorization } from '../../../netlify/lib/google-authorization.js'
import {
    getGoogleCalendarAuthUrl,
    parseGoogleAuthRedirect,
    getGoogleCalendarAuth,
    disconnectGoogleCalendar,
    setGoogleCalendarSyncTypes,
    type GoogleCalendarAuth,
    type SyncEventType,
} from '../../lib/googleCalendar'


// Complete the server-verified grant only in the original Firebase browser session.
async function initializeGoogleConnection() {
    const session = captureUserSession()
    const redirect = await parseGoogleAuthRedirect()
    session.assertActive()
    const auth = await getGoogleCalendarAuth()
    session.assertActive()
    return { auth, connected: Boolean(redirect?.connected), error: redirect?.error }
}

export default function CalendarSettings() {
    const [watchList, setWatchList] = useState<{ code: string; name: string }[]>([])
    const [newCode, setNewCode] = useState('')
    const [newName, setNewName] = useState('')
    const [stockDict, setStockDict] = useState<Record<string, string>>({})
    const [search, setSearch] = useState('')
    const [loadError, setLoadError] = useState('')
    const connectionRequest = useRef<ReturnType<typeof initializeGoogleConnection> | null>(null)

    // ── Google 行事曆連結狀態 ────────────────────────────────────────
    const [gcalAuth, setGcalAuth] = useState<GoogleCalendarAuth | null>(null)
    const [gcalLoading, setGcalLoading] = useState(true)
    const [gcalMessage, setGcalMessage] = useState<string | null>(null)
    const [gcalError, setGcalError] = useState<string | null>(null)

    // 處理 Google 導回的 URL fragment（連結成功／失敗都會導回這頁）
    useEffect(() => {
        let active = true
        connectionRequest.current ??= initializeGoogleConnection()
        void connectionRequest.current.then(({ auth, connected, error }) => {
            if (!active) return
            setGcalAuth(auth)
            if (error) setGcalError(error)
            if (connected) setGcalMessage('Google 帳號連結成功，已授權行事曆、試算表唯讀與報告檔案搜尋')
        }).catch(error => {
            if (active) setGcalError(error instanceof Error ? error.message : '讀取連結狀態失敗，請重試')
        }).finally(() => { if (active) setGcalLoading(false) })
        return () => { active = false }
    }, [])

    const handleConnectGoogle = async () => {
        if (gcalLoading) return
        setGcalLoading(true)
        setGcalError(null)
        try { window.location.href = await getGoogleCalendarAuthUrl() }
        catch (error) {
            setGcalError(error instanceof Error ? error.message : '無法連結 Google，請稍後重試')
            setGcalLoading(false)
        }
    }

    const handleDisconnectGoogle = async () => {
        if (!await confirmAction('確定要取消共用 Google 連線？行事曆同步與報告來源讀取都會停止，下次使用時需要重新授權。')) return
        setGcalLoading(true)
        setGcalError(null)
        setGcalMessage(null)
        try { await disconnectGoogleCalendar(); setGcalAuth(null) }
        catch { setGcalError('取消連結未完成，請確認登入帳號後重試。') }
        finally { setGcalLoading(false) }
    }

    const handleToggleSyncType = async (type: SyncEventType) => {
        if (!gcalAuth) return
        const current = new Set(gcalAuth.syncTypes)
        if (current.has(type)) current.delete(type); else current.add(type)
        const next = [...current]
        setGcalAuth({ ...gcalAuth, syncTypes: next })
        try {
            await setGoogleCalendarSyncTypes(next)
        } catch {
            setGcalAuth(gcalAuth)
            setGcalError('同步選項儲存失敗，請確認登入帳號後重試。')
        }
    }

    const load = useCallback(async () => {
        try {
            const session = captureUserSession()
            const [snap, dictSnap] = await Promise.all([
                getDocs(session.col(investDB, 'calendarWatchList')),
                getDocs(session.col(investDB, 'stockDict')),
            ])
            session.assertActive()
            setWatchList(snap.docs.map(d => ({ code: d.id, name: d.data().name || d.id })))
            const dict: Record<string, string> = {}
            dictSnap.docs.forEach(d => { dict[d.id] = d.data().name })
            setStockDict(dict)
            setLoadError('')
        } catch { setLoadError('關注清單載入失敗，請重新整理後重試。') }
    }, [])

    useEffect(() => { void load() }, [load])

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
        <div style={{ padding: 'var(--ui-page-padding, clamp(16px, 3vw, 32px))', maxWidth: '800px', margin: '0 auto' }}>
            <div style={{ marginBottom: '16px' }}>
                <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>法說會關注清單</h1>
                {loadError && <p role="alert" style={{ color: 'var(--c-danger)' }}>{loadError}</p>}
                <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>設定要追蹤法說會的股票，行事曆會自動顯示相關法說會</p>
            </div>

            {/* 共用 Google 連線：行事曆同步與試算表唯讀 */}
            <div style={{ ...card, marginBottom: '16px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '8px' }}>Google 帳號連線</div>
                <p style={{ fontSize: '12px', color: 'var(--c-muted)', margin: '0 0 12px', overflowWrap: 'anywhere' }}>
                    使用 {GOOGLE_ACCOUNT_EMAIL}，共用行事曆同步、試算表唯讀與報告檔案搜尋授權。
                </p>
                <AnnualDataNotice fomcRange={gcalAuth?.syncTypes.includes('fomc') ? googleSyncDateRange() : undefined} />

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
                        <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '0 0 12px' }}>連結後可手動同步未來半年行程，並授權系統讀取私人試算表。</p>
                        <button onClick={handleConnectGoogle} style={btn('#4285f4')}>
                            <Link2 size={14} />連結 Google 帳號
                        </button>
                    </div>
                ) : (
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0, fontSize: '13px', color: 'var(--c-text)' }}>
                                <CheckCircle2 size={16} color="var(--c-positive)" style={{ flexShrink: 0 }} />
                                已連結（{new Date(gcalAuth.connectedAt).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })}）
                            </span>
                            <button onClick={handleConnectGoogle} style={{ ...btn('#4285f4'), padding: '8px 10px', fontSize: '12px', marginLeft: 'auto' }}>
                                <Link2 size={12} />{hasGoogleReportAuthorization(gcalAuth) ? '重新授權' : '補充報告授權'}
                            </button>
                            <button onClick={handleDisconnectGoogle} style={{ ...btn('var(--c-border)'), padding: '8px 10px', fontSize: '12px' }}>
                                <Unlink size={12} />取消連結
                            </button>
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '12px', overflowWrap: 'anywhere' }}>
                            <div style={{ marginBottom: '4px' }}>連結帳號：{gcalAuth.googleEmail || '尚未確認，請重新授權'}</div>
                            <div style={{ color: hasGoogleSheetsAuthorization(gcalAuth) ? 'var(--c-positive)' : 'var(--c-warning)' }}>
                                {hasGoogleSheetsAuthorization(gcalAuth) ? '試算表唯讀：已授權' : '試算表唯讀：尚未授權，請補充授權'}
                            </div>
                            <div style={{ marginTop: '4px', color: hasGoogleDriveSearchAuthorization(gcalAuth) ? 'var(--c-positive)' : 'var(--c-warning)' }}>
                                {hasGoogleDriveSearchAuthorization(gcalAuth) ? '報告檔案搜尋：已授權' : '報告檔案搜尋：尚未授權，請補充授權'}
                            </div>
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
            <AnnualCalendarStatus />
        </div>
    )
}
