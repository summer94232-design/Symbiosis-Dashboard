import LoadingState from '../../components/LoadingState'
import { useFieldFeedback } from '../../ui/useFieldFeedback'
import { card, inp, lbl, btn } from '../../ui/styles'
import { confirmAction } from '../../ui/dialogs'
import { useSafeMutation } from '../../lib/useSafeMutation'
import DisclosureNote from '../../components/DisclosureNote'
import { useState, useEffect, useRef } from 'react'
import { doc, writeBatch, deleteDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { captureUserSession } from '../../lib/userDB'
import { fetchCashflow, invalidateCashflow } from '../../lib/investData'
import { toLocalDateString } from '../../lib/date'
import { Pencil, Trash2, X, Check } from 'lucide-react'
import { useInvestSync } from '../../InvestSyncContext'
import { validateCashflowForWrite } from '../../lib/investmentValidation'

interface CashRecord {
    id?: string
    date: string
    type: 'in' | 'out'
    amount: number
    note: string
}

const empty: CashRecord = { date: toLocalDateString(), type: 'in', amount: 0, note: '' }

export default function CashFlow() {
    const { version: syncVersion } = useInvestSync()
    const [reading, setReading] = useState(true)
    const [hasLoaded, setHasLoaded] = useState(false)
    const [records, setRecords] = useState<CashRecord[]>([])
    const [editingId, setEditingId] = useState<string | null>(null)
    const [form, setForm] = useState<CashRecord>(empty)
    const mutation = useSafeMutation()
    const loading = mutation.busy
    const pendingId = useRef<string | null>(null)
    const [formError, setFormError] = useState('')
    const feedback = useFieldFeedback()

    const load = async () => {
        setReading(true)
        // ✅ 1-1：改走共用快取層（lib/investData）
        try {
            const session = captureUserSession()
            const records = await fetchCashflow<CashRecord>('desc')
            session.assertActive()
            setRecords(records)
            setHasLoaded(true)
        } catch { setFormError('資料重新載入失敗；已儲存的紀錄不需再次新增，請重新整理。') }
        finally { setReading(false) }
    }

    useEffect(() => { void load() }, [syncVersion])

    const handleSave = async () => {
        const validation = validateCashflowForWrite(form)
        if (!validation.valid) { feedback.report(validation.errors); setFormError(validation.errors.filter(message => !/日期|代號|名稱|股利|類型|金額|公告/.test(message)).join('；')); return }
        feedback.clear()
        await mutation.run(async session => {
            setFormError('')
            const id = editingId || (pendingId.current ||= doc(session.col(investDB, 'cashflow')).id)
            const batch = writeBatch(investDB)
            const target = session.doc(investDB, 'cashflow', id)
            if (editingId) batch.update(target, { ...form })
            else batch.set(target, { ...form })

            await batch.commit()
            session.assertActive()
            invalidateCashflow()

            pendingId.current = null
            setEditingId(null); setForm(empty)
            await load()
        })
    }

    const handleEdit = (r: CashRecord) => { if (loading) return; pendingId.current = null; setForm(r); setEditingId(r.id!); setFormError(''); feedback.clear() }
    const handleCancel = () => { if (loading) return; pendingId.current = null; setForm(empty); setEditingId(null); setFormError(''); feedback.clear() }
    const handleDelete = async (id: string) => {
        const record = records.find(row => row.id === id)
        if (!await confirmAction(`確定刪除 ${record?.date || ''} 的${record?.type === 'out' ? '出金' : '入金'}紀錄（${record?.amount.toLocaleString() || '—'} 元）？`, { title: '刪除出入金紀錄' })) return
        await mutation.run(async session => {
            await deleteDoc(session.doc(investDB, 'cashflow', id))
            session.assertActive()
            invalidateCashflow()
            await load()
        })
    }

    const totalIn = records.filter(r => r.type === 'in').reduce((s, r) => s + r.amount, 0)
    const totalOut = records.filter(r => r.type === 'out').reduce((s, r) => s + r.amount, 0)
    const net = totalIn - totalOut

    return (
        <>
            <style>{`
        .cash-form-grid { display: grid; gap: 12px; grid-template-columns: repeat(4, 1fr); }
        @media (max-width: 900px) { .cash-form-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .cash-form-grid { grid-template-columns: 1fr; } }
        .cash-stats { display: grid; gap: 16px; grid-template-columns: repeat(3, 1fr); margin-bottom: 20px; }
        @media (max-width: 600px) { .cash-stats { grid-template-columns: 1fr; } }
        .table-wrap { overflow-x: auto; }
        .cash-table { width: 100%; border-collapse: collapse; font-size: 14px; }
        .cash-table th, .cash-table td { padding: 10px 12px; text-align: left; }
        .cash-table th { color: var(--c-muted); font-weight: 500; border-bottom: 1px solid var(--c-border); }
        .cash-table td { border-bottom: 1px solid var(--c-border); color: var(--c-text); }
      `}</style>

            <div style={{ padding: 'var(--ui-page-padding, clamp(16px, 3vw, 32px))', maxWidth: '1600px', margin: '0 auto' }}>
                <div style={{ marginBottom: '16px' }}>
                    <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>出入金</h1>
                    <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>共 {records.length} 筆紀錄</p>
                    <DisclosureNote summary="請填實際轉帳日；績效預設按收盤後入金計算。">
                        補交割款也不要倒填買股日。出金暫沿用日終假設；盤中出入金請使用進階估值核對。
                    </DisclosureNote>
                </div>

                {/* 統計卡片 */}
                <div className="cash-stats">
                    {[{ label: '總入金', value: totalIn, color: 'var(--c-positive)' }, { label: '總出金', value: totalOut, color: 'var(--c-danger)' }, { label: '淨值', value: net, color: net >= 0 ? 'var(--c-positive)' : 'var(--c-danger)' }].map(({ label, value, color }) => (
                        <div key={label} style={card}>
                            <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>{label}</div>
                            <div style={{ fontSize: 'clamp(18px, 2vw, 22px)', fontWeight: 700, color }}>{value.toLocaleString()}</div>
                        </div>
                    ))}
                </div>

                {/* 表單 */}
                <div style={{ ...card, marginBottom: '20px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '16px' }}>
                        {editingId ? '✏️ 編輯紀錄' : '➕ 新增紀錄'}
                    </div>
                    <div ref={feedback.root} onChangeCapture={feedback.clear} className="cash-form-grid">
                        <div><label htmlFor={feedback.label('date')} style={lbl}>日期</label><input {...feedback.bind('date')} disabled={mutation.busy} type="date" style={inp} value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />{feedback.message('date')}</div>
                        <div><label htmlFor={feedback.label('type')} style={lbl}>類型</label>
                            <select {...feedback.bind('type')} disabled={mutation.busy} style={inp} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as 'in' | 'out' }))}>
                                <option value="in">入金</option>
                                <option value="out">出金</option>
                            </select>{feedback.message('type')}
                        </div>
                        <div><label htmlFor={feedback.label('amount')} style={lbl}>金額</label><input {...feedback.bind('amount')} disabled={mutation.busy} type="number" style={inp} placeholder="0" value={form.amount || ''} onChange={e => setForm(f => ({ ...f, amount: parseFloat(e.target.value) || 0 }))} />{feedback.message('amount')}</div>
                        <div><label htmlFor={feedback.label('note')} style={lbl}>備註</label><input {...feedback.bind('note')} disabled={mutation.busy} style={inp} placeholder="選填" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />{feedback.message('note')}</div>
                    </div>
                    {(formError || mutation.error) && <div style={{ color: 'var(--c-danger)', fontSize: '12px', marginTop: '10px' }}>{formError || mutation.error}</div>}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
                        {editingId && <button disabled={loading} style={btn('var(--c-border)')} onClick={handleCancel}><X size={14} />取消編輯</button>}
                        <button style={btn('var(--c-accent)')} onClick={handleSave} disabled={loading}>
                            <Check size={14} />{loading ? '儲存中...' : editingId ? '確認更新' : '確認新增'}
                        </button>
                    </div>
                </div>

                {/* 列表 */}
                <div style={card}>
                    {reading && hasLoaded && <p className="ui-refresh-status" role="status">資料更新中…</p>}
                    {reading && !hasLoaded ? <LoadingState /> : records.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '48px', color: 'var(--c-muted)' }}><p>還沒有出入金紀錄，請在上方新增</p></div>
                    ) : (
                        <div className="table-wrap">
                            <table className="cash-table">
                                <thead>
                                    <tr>{['日期', '類型', '金額', '備註', ''].map(h => <th key={h}>{h}</th>)}</tr>
                                </thead>
                                <tbody>
                                    {records.map(r => (
                                        <tr key={r.id} style={{ backgroundColor: editingId === r.id ? 'rgba(79,142,247,0.06)' : 'transparent' }}>
                                            <td>{r.date}</td>
                                            <td><span style={{ backgroundColor: r.type === 'in' ? 'color-mix(in srgb, var(--c-positive) 15%, transparent)' : 'rgba(255,87,87,0.15)', color: r.type === 'in' ? 'var(--c-positive)' : 'var(--c-danger)', padding: '2px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 600 }}>{r.type === 'in' ? '入金' : '出金'}</span></td>
                                            <td style={{ color: r.type === 'in' ? 'var(--c-positive)' : 'var(--c-danger)', fontWeight: 600 }}>{r.amount.toLocaleString()}</td>
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
