import LoadingState from '../../components/LoadingState'
import { useFieldFeedback } from '../../ui/useFieldFeedback'
import { confirmAction } from '../../ui/dialogs'
import { useSafeMutation } from '../../lib/useSafeMutation'
import DisclosureNote from '../../components/DisclosureNote'
import { isEffectiveOn } from '../../lib/calc'
import { useState, useEffect, useRef, useMemo, useSyncExternalStore } from 'react'
import { doc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { captureUserSession } from '../../lib/userDB'
import { fetchDividends, fetchTrades, invalidateDividends } from '../../lib/investData'
import type { TradeRecord } from '../../lib/calc'
import { buildDividendForecasts, getDividendFeedState, subscribeDividendFeed, type DividendForecast } from '../../lib/dividendAnnouncements'
import DividendFeedStatus from '../../components/DividendFeedStatus'
// ✅ 1-2：共用模組（股票字典 / UI 樣式）
import { lookupStockName, cacheStockName } from '../../lib/stockDict'
import { toLocalDateString } from '../../lib/date'
import { card, inp, lbl, btn } from '../../ui/styles'
import { Pencil, Trash2, X, Check } from 'lucide-react'
import { useInvestSync } from '../../InvestSyncContext'
import { validateDividendForWrite } from '../../lib/investmentValidation'
import { commitLedgerWrites } from '../../lib/ledgerWrites'

interface DividendRecord {
    sourceAnnouncementId?: string
    status?: 'announced' | 'confirmed'
    cashPaymentDate?: string
    stockDistributionDate?: string
    stockDividendMarginShares?: number
    id?: string
    date: string
    code: string
    name: string
    cashDividend: number
    stockDividend: number
    note: string
}

const empty: DividendRecord = { status: 'announced', cashPaymentDate: '', stockDistributionDate: '', date: toLocalDateString(), code: '', name: '', cashDividend: 0, stockDividend: 0, note: '' }
export default function Dividend() {
    const { version: syncVersion } = useInvestSync()
    const [reading, setReading] = useState(true)
    const [hasLoaded, setHasLoaded] = useState(false)
    const [records, setRecords] = useState<DividendRecord[]>([])
    const [trades, setTrades] = useState<TradeRecord[]>([])
    const feed = useSyncExternalStore(subscribeDividendFeed, getDividendFeedState)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [form, setForm] = useState<DividendRecord>(empty)
    const mutation = useSafeMutation()
    const loading = mutation.busy
    const pendingId = useRef<string | null>(null)
    const [lookingUp, setLookingUp] = useState(false)
    const [formError, setFormError] = useState('')
    const feedback = useFieldFeedback()
    const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    const load = async () => {
        setReading(true)
        // ✅ 1-1：改走共用快取層（lib/investData）
        try {
            const session = captureUserSession()
            const [records, trades] = await Promise.all([fetchDividends<DividendRecord>('desc'), fetchTrades<TradeRecord>()])
            session.assertActive()
            setRecords(records)
            setHasLoaded(true)
            setTrades(trades)
        } catch { setFormError('資料重新載入失敗；已儲存的紀錄不需再次新增，請重新整理。') }
        finally { setReading(false) }
    }

    useEffect(() => { void load() }, [syncVersion])

    // ★ debounce 500ms 再查詢
    const handleCodeChange = (code: string) => {
        const upper = code.toUpperCase()
        setForm(f => ({ ...f, code: upper }))

        if (lookupTimer.current) clearTimeout(lookupTimer.current)
        if (upper.length < 3) return

        lookupTimer.current = setTimeout(async () => {
            setLookingUp(true)
            try {
                const name = await lookupStockName(upper)
                if (name) setForm(f => f.code === upper ? { ...f, name } : f)
            } catch { setFormError('股票名稱查詢失敗，可手動填寫後儲存。') }
            finally { setLookingUp(false) }
        }, 500)
    }

    const handleSave = async () => {
        const validation = validateDividendForWrite(form)
        if (!validation.valid) { feedback.report(validation.errors); setFormError(validation.errors.filter(message => !/日期|代號|名稱|股利|類型|金額|公告/.test(message)).join('；')); return }
        feedback.clear()
        await mutation.run(async session => {
            setFormError('')
            const id = editingId || (pendingId.current ||= doc(session.col(investDB, 'dividends')).id)
            await commitLedgerWrites([{ collection: 'dividends', id, data: { ...form }, mode: editingId ? 'update' : 'create' }], session,
                form.name && form.code ? { [form.code]: form.name } : {})
            session.assertActive()
            invalidateDividends()
            if (form.name && form.code) cacheStockName(form.code, form.name)
            pendingId.current = null
            setEditingId(null); setForm(empty)
            await load()
        })
    }

    const handleEdit = (r: DividendRecord) => {
        if (loading) return
        pendingId.current = null
        if (r.code && r.name) cacheStockName(r.code, r.name)
        setForm(r); setEditingId(r.id!); setFormError('')
    }
    const handleCancel = () => { if (loading) return; pendingId.current = null; setForm(empty); setEditingId(null); setFormError(''); feedback.clear() }
    const handleDelete = async (id: string) => {
        const record = records.find(row => row.id === id)
        if (!await confirmAction(`確定刪除 ${record?.date || ''} ${record?.code || ''} ${record?.name || ''} 的股利紀錄？`, { title: '刪除股利紀錄' })) return
        await mutation.run(async session => {
            await commitLedgerWrites([{ collection: 'dividends', id }], session)
            session.assertActive()
            invalidateDividends()
            await load()
        })
    }

    const today = toLocalDateString()
    const forecasts = useMemo(() => buildDividendForecasts(feed.catalog, trades, records, today), [feed.catalog, trades, records, today])
    const fillForecast = (forecast: DividendForecast) => {
        if (loading) return
        const row = forecast.announcement
        pendingId.current = 'auto-div-' + row.id
        setEditingId(null); setFormError('')
        setForm({ ...empty, sourceAnnouncementId: row.id, status: 'confirmed', date: row.date, code: row.code, name: row.name,
            cashDividend: forecast.foreignCurrency ? 0 : forecast.cashGross || 0, stockDividend: forecast.stockShares,
            note: `官方預告試算；資格股數 ${forecast.shares} 股。實領金額、畸零股及日期需依入帳紀錄確認。` })
    }
    const totalCash = records.filter(r => r.status !== 'announced' && isEffectiveOn(r.cashPaymentDate || r.date, today)).reduce((s, r) => s + r.cashDividend, 0)
    const totalStock = records.filter(r => r.status !== 'announced' && isEffectiveOn(r.stockDistributionDate || r.date, today)).reduce((s, r) => s + r.stockDividend, 0)

    return (
        <>
            <style>{`
        .div-form-grid { display: grid; gap: 12px; grid-template-columns: repeat(3, 1fr); }
        @media (max-width: 900px) { .div-form-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .div-form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; } }
        .div-stats { display: grid; gap: 16px; grid-template-columns: repeat(2, 1fr); margin-bottom: 20px; }
        @media (max-width: 480px) { .div-stats { grid-template-columns: 1fr; } }
        .table-wrap { overflow-x: auto; }
        .div-table { width: 100%; border-collapse: collapse; font-size: 14px; }
        .div-table th, .div-table td { padding: 10px 12px; text-align: left; }
        .div-table th { color: var(--c-muted); font-weight: 500; border-bottom: 1px solid var(--c-border); }
        .div-table td { border-bottom: 1px solid var(--c-border); color: var(--c-text); }
      `}</style>

            <div style={{ padding: 'var(--ui-page-padding, clamp(16px, 3vw, 32px))', maxWidth: '1600px', margin: '0 auto' }}>
                <div style={{ marginBottom: '16px' }}>
                    <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>除權息</h1>
                    <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>共 {records.length} 筆紀錄</p>
                </div>

                {/* 統計卡片 */}
                <div className="div-stats">
                    {[{ label: '已入帳現金股利', value: `${totalCash.toLocaleString()} 元`, color: 'var(--c-positive)' }, { label: '已配發股票股利', value: `${totalStock.toLocaleString()} 股`, color: 'var(--c-accent)' }].map(({ label, value, color }) => (
                        <div key={label} style={card}>
                            <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>{label}</div>
                            <div style={{ fontSize: 'clamp(18px, 2vw, 22px)', fontWeight: 700, color }}>{value}</div>
                        </div>
                    ))}
                </div>

                <div style={{ ...card, marginBottom: '12px', padding: '12px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600 }}>自動除權息預告</div>
                    <DividendFeedStatus showLastUpdate />
                    <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>更新現價時查預告；未到期按現持股，到期按前日持股。確認實領才入帳。</div>
                    {!forecasts.length && <div style={{ fontSize: '12px', color: 'var(--c-muted)' }}>目前沒有尚未登錄、符合持股資格的預告。</div>}
                    {forecasts.map(forecast => <div key={forecast.announcement.id} style={{ padding: '8px 0', borderTop: '1px solid var(--c-border)', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '13px' }}>
                        <div style={{ flex: '1 1 190px' }}>
                            <strong>{forecast.announcement.date} · {forecast.announcement.code} {forecast.announcement.name}</strong>
                            <div style={{ color: 'var(--c-muted)', fontSize: '12px', marginTop: '3px' }}>
                                資格試算 {forecast.shares.toLocaleString()} 股 · 現金 {forecast.cashGross === null ? '待公告' : `${forecast.cashGross.toLocaleString()} ${forecast.foreignCurrency ? '（外幣，需確認幣別）' : '元（未扣費）'}`}
                                {forecast.stockShares > 0 || forecast.stockFraction > 0 ? ` · 配股約 ${forecast.stockShares.toLocaleString()} 股${forecast.stockFraction > 0 ? '，畸零股待確認' : ''}` : ''}
                                {forecast.hasMargin ? ' · 含融資，請核對元大配發' : ''}
                            </div>
                        </div>
                        <button disabled={loading} onClick={() => fillForecast(forecast)} style={{ ...btn('var(--c-accent)'), padding: '7px 10px', fontSize: '12px', minHeight: '40px' }}>填入實領</button>
                    </div>)}
                </div>

                {/* 表單 */}
                <div style={{ ...card, marginBottom: '20px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '16px' }}>
                        {editingId ? '✏️ 編輯紀錄' : '➕ 新增紀錄'}
                    </div>
                    <div ref={feedback.root} onChangeCapture={feedback.clear} className="div-form-grid">
                        <div><label htmlFor={feedback.label('date')} style={lbl}>除權息日期（舊紀錄兼作入帳日）</label><input {...feedback.bind('date')} disabled={mutation.busy || !!form.sourceAnnouncementId} type="date" style={inp} value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />{feedback.message('date')}</div>
                        <div>
                            <label htmlFor={feedback.label('code')} style={lbl}>股票代號</label>
                            <input {...feedback.bind('code')} disabled={mutation.busy || !!form.sourceAnnouncementId} style={inp} placeholder="例：2330" value={form.code} onChange={e => handleCodeChange(e.target.value)} />{feedback.message('code')}
                        </div>
                        <div>
                            <label htmlFor={feedback.label('name')} style={lbl}>股票名稱 {lookingUp && <span style={{ color: 'var(--c-muted)', fontSize: '10px' }}>查詢中...</span>}</label>
                            <input {...feedback.bind('name')} disabled={mutation.busy} style={inp} placeholder="輸入代號後自動帶入" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />{feedback.message('name')}
                        </div>
                        <div><label htmlFor={feedback.label('cashDividend')} style={lbl}>現金股利（元）</label><input {...feedback.bind('cashDividend')} disabled={mutation.busy} type="number" style={inp} placeholder="0" value={form.cashDividend || ''} onChange={e => setForm(f => ({ ...f, cashDividend: parseFloat(e.target.value) || 0 }))} />{feedback.message('cashDividend')}</div>
                        <div><label htmlFor={feedback.label('stockDividend')} style={lbl}>股票股利（股）</label><input {...feedback.bind('stockDividend')} disabled={mutation.busy} type="number" style={inp} placeholder="0" value={form.stockDividend || ''} onChange={e => setForm(f => ({ ...f, stockDividend: parseFloat(e.target.value) || 0 }))} />{feedback.message('stockDividend')}</div>
                        {form.stockDividend > 0 && <div><label htmlFor="dividend-margin-shares" style={lbl}>配股中的融資股數</label><input id="dividend-margin-shares" disabled={mutation.busy} type="number" min="0" max={form.stockDividend} step="1" style={inp} placeholder="依元大配股紀錄確認" value={form.stockDividendMarginShares ?? ''} onChange={e => { const value = e.target.value; setForm(f => { const next = { ...f }; if (value === '') delete next.stockDividendMarginShares; else next.stockDividendMarginShares = Number(value); return next }) }} /><div style={{ fontSize: '11px', color: 'var(--c-muted)', marginTop: '4px' }}>0 表示全數現股；融資持倉配股未填時，新股暫不提供賣出庫存。</div></div>}
                        <div><label htmlFor={feedback.label('status')} style={lbl}>狀態</label><select {...feedback.bind('status')} disabled={mutation.busy} style={inp} value={form.status || 'confirmed'} onChange={e => setForm(f => ({ ...f, status: e.target.value as 'announced' | 'confirmed' }))}>
                            <option value="announced">預告，尚不計入資產</option><option value="confirmed">已確認，依入帳／配發日期計入</option>
                        </select>{feedback.message('status')}</div>
                        <div><label htmlFor={feedback.label('cashPaymentDate')} style={lbl}>現金入帳日期</label><input {...feedback.bind('cashPaymentDate')} disabled={mutation.busy} type="date" style={inp} value={form.cashPaymentDate || ''} onChange={e => setForm(f => ({ ...f, cashPaymentDate: e.target.value }))} />{feedback.message('cashPaymentDate')}</div>
                        <div><label htmlFor={feedback.label('stockDistributionDate')} style={lbl}>股票配發日期</label><input {...feedback.bind('stockDistributionDate')} disabled={mutation.busy} type="date" style={inp} value={form.stockDistributionDate || ''} onChange={e => setForm(f => ({ ...f, stockDistributionDate: e.target.value }))} />{feedback.message('stockDistributionDate')}</div>
                        <div><label htmlFor={feedback.label('note')} style={lbl}>備註</label><input {...feedback.bind('note')} disabled={mutation.busy} style={inp} placeholder="選填" value={form.note ?? ''} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />{feedback.message('note')}</div>
                    </div>
                    {form.sourceAnnouncementId && <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--c-warning)' }}>請改成實際收到的金額／股數，並填實際入帳／配發日。日期尚未填妥前不會儲存或計入資產。</div>}
                    <DisclosureNote summary="預告不計入資產；確認後請填入帳／配發日。">未填入帳／配發日期的舊紀錄沿用原日期。</DisclosureNote>
                    {(formError || mutation.error) && <div style={{ color: 'var(--c-danger)', fontSize: '12px', marginTop: '10px' }}>{formError || mutation.error}</div>}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
                        {(editingId || form.sourceAnnouncementId) && <button disabled={loading} style={btn('var(--c-border)')} onClick={handleCancel}><X size={14} />取消</button>}
                        <button style={btn('var(--c-accent)')} onClick={handleSave} disabled={loading}>
                            <Check size={14} />{loading ? '儲存中...' : editingId ? '確認更新' : '確認新增'}
                        </button>
                    </div>
                </div>

                {/* 列表 */}
                <div style={card}>
                    {reading && hasLoaded && <p className="ui-refresh-status" role="status">資料更新中…</p>}
                    {reading && !hasLoaded ? <LoadingState /> : records.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '48px', color: 'var(--c-muted)' }}><p>還沒有除權息紀錄，請在上方新增</p></div>
                    ) : (
                        <div className="table-wrap">
                            <table className="div-table">
                                <thead>
                                    <tr>{['日期', '代號', '名稱', '現金股利', '股票股利', '備註', ''].map(h => <th key={h}>{h}</th>)}</tr>
                                </thead>
                                <tbody>
                                    {records.map(r => (
                                        <tr key={r.id} style={{ backgroundColor: editingId === r.id ? 'rgba(79,142,247,0.06)' : 'transparent' }}>
                                            <td>{r.date}<div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>{r.status === 'announced' ? '預告' : '已確認'}{r.cashPaymentDate ? ` · 現金 ${r.cashPaymentDate}` : ''}{r.stockDistributionDate ? ` · 配股 ${r.stockDistributionDate}` : ''}</div></td>
                                            <td style={{ color: 'var(--c-accent)', fontWeight: 600 }}>{r.code}</td>
                                            <td>{r.name}</td>
                                            <td style={{ color: 'var(--c-positive)', fontWeight: 600 }}>{r.cashDividend.toLocaleString()} 元</td>
                                            <td style={{ color: 'var(--c-accent)', fontWeight: 600 }}>{r.stockDividend.toLocaleString()} 股{r.stockDividend > 0 && r.stockDividendMarginShares === undefined && trades.some(t => t.code === r.code && t.isMargin && t.date <= (r.stockDistributionDate || r.date)) && <div style={{fontSize:'11px',color:'var(--c-warning)',fontWeight:400}}>融資配股帳別待核對</div>}</td>
                                            <td style={{ color: 'var(--c-muted)' }}>{r.note}</td>
                                            <td>
                                                <div style={{ display: 'flex', gap: '8px' }}>
                                                    <button aria-label="編輯紀錄" disabled={loading} onClick={() => handleEdit(r)} style={{ background: 'none', border: 'none', color: 'var(--c-accent)', cursor: 'pointer' }}><Pencil size={15} /></button>
                                                    <button aria-label="刪除紀錄" disabled={loading} onClick={() => handleDelete(r.id!)} style={{ background: 'none', border: 'none', color: 'var(--c-danger)', cursor: 'pointer' }}><Trash2 size={15} /></button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </>
    )
}
