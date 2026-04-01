import { useState, useEffect } from 'react'
import { collection, getDocs, doc, setDoc, getDoc, orderBy, query } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { Download, Upload, FileSpreadsheet } from 'lucide-react'
import * as XLSX from 'xlsx'

const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '24px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '10px 18px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' })
const inp: React.CSSProperties = { backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', outline: 'none' }

export default function InvestSettings() {
    const [importing, setImporting] = useState(false)
    const [importResult, setImportResult] = useState<{ success: number; failed: number } | null>(null)
    const [exportLoading, setExportLoading] = useState(false)
    const [msg, setMsg] = useState('')

    // 績效起始日設定
    const [perfStartDate, setPerfStartDate] = useState('')
    const [perfStartValue, setPerfStartValue] = useState('')
    const [perfConfigLoading, setPerfConfigLoading] = useState(true)
    const [perfConfigSaving, setPerfConfigSaving] = useState(false)

    const showMsg = (text: string) => {
        setMsg(text)
        setTimeout(() => setMsg(''), 4000)
    }

    useEffect(() => {
        getDoc(doc(investDB, 'settings', 'performanceConfig')).then(d => {
            if (d.exists()) {
                const data = d.data()
                setPerfStartDate(data.startDate || '')
                setPerfStartValue(data.startValue ? String(data.startValue) : '')
            }
            setPerfConfigLoading(false)
        }).catch(() => setPerfConfigLoading(false))
    }, [])

    const savePerfConfig = async () => {
        setPerfConfigSaving(true)
        const startValue = parseFloat(perfStartValue.replace(/,/g, ''))
        await setDoc(doc(investDB, 'settings', 'performanceConfig'), {
            startDate: perfStartDate || null,
            startValue: !isNaN(startValue) && startValue > 0 ? startValue : null,
        })
        setPerfConfigSaving(false)
        showMsg('✅ 設定已儲存！重新載入年度復盤頁將生效。')
    }

    const clearPerfConfig = async () => {
        if (!confirm('確定要清除起始日設定？')) return
        await setDoc(doc(investDB, 'settings', 'performanceConfig'), { startDate: null, startValue: null })
        setPerfStartDate('')
        setPerfStartValue('')
        showMsg('✅ 已清除設定')
    }

    const handleImportDict = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        setImporting(true)
        setImportResult(null)
        const reader = new FileReader()
        reader.onload = async (evt) => {
            try {
                const data = new Uint8Array(evt.target!.result as ArrayBuffer)
                const workbook = XLSX.read(data, { type: 'array' })
                const sheet = workbook.Sheets[workbook.SheetNames[0]]
                const rows: any[] = XLSX.utils.sheet_to_json(sheet)
                let success = 0, failed = 0
                for (const row of rows) {
                    const code = String(row['股票代號'] || row['代號'] || row['code'] || row['Code'] || '').trim()
                    const name = String(row['股票名稱'] || row['名稱'] || row['name'] || row['Name'] || '').trim()
                    if (code && name) {
                        try { await setDoc(doc(investDB, 'stockDict', code), { name }); success++ }
                        catch { failed++ }
                    } else { failed++ }
                }
                setImportResult({ success, failed })
                showMsg(`✅ 匯入完成！成功 ${success} 筆，失敗 ${failed} 筆`)
            } catch { showMsg('❌ 檔案格式錯誤，請確認欄位名稱為「股票代號」和「股票名稱」') }
            setImporting(false)
            e.target.value = ''
        }
        reader.readAsArrayBuffer(file)
    }

    const exportTrades = async () => {
        setExportLoading(true)
        const snap = await getDocs(query(collection(investDB, 'trades'), orderBy('date', 'desc')))
        const trades = snap.docs.map(d => d.data())
        const header = ['日期', '類型', '代號', '名稱', '價格', '股數', '手續費', '交易稅', '收付金額', '備註']
        const rows = trades.map((t: any) => [t.date, t.type === 'buy' ? '買入' : '賣出', t.code, t.name, t.price, t.shares, t.fee, t.tax, t.total, t.note || ''])
        downloadCSV([header, ...rows].map(r => r.join(',')).join('\n'), `買賣紀錄_${today()}.csv`)
        setExportLoading(false)
        showMsg('✅ 已匯出買賣紀錄')
    }

    const exportCashFlow = async () => {
        const snap = await getDocs(query(collection(investDB, 'cashflow'), orderBy('date', 'desc')))
        const records = snap.docs.map(d => d.data())
        const header = ['日期', '類型', '金額', '備註']
        const rows = records.map((r: any) => [r.date, r.type === 'in' ? '入金' : '出金', r.amount, r.note || ''])
        downloadCSV([header, ...rows].map(r => r.join(',')).join('\n'), `出入金紀錄_${today()}.csv`)
        showMsg('✅ 已匯出出入金紀錄')
    }

    const exportDividends = async () => {
        const snap = await getDocs(query(collection(investDB, 'dividends'), orderBy('date', 'desc')))
        const records = snap.docs.map(d => d.data())
        const header = ['日期', '代號', '名稱', '現金股利', '股票股利', '備註']
        const rows = records.map((r: any) => [r.date, r.code, r.name, r.cashDividend, r.stockDividend, r.note || ''])
        downloadCSV([header, ...rows].map(r => r.join(',')).join('\n'), `除權息紀錄_${today()}.csv`)
        showMsg('✅ 已匯出除權息紀錄')
    }

    const downloadCSV = (csv: string, filename: string) => {
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = filename; a.click()
        URL.revokeObjectURL(url)
    }

    const today = () => new Date().toISOString().split('T')[0]

    return (
        <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '900px', margin: '0 auto' }}>
            <div style={{ marginBottom: '24px' }}>
                <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>設定與備份</h1>
                <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>匯入股票字典、匯出報表</p>
            </div>

            {msg && (
                <div style={{ backgroundColor: msg.startsWith('❌') ? 'rgba(255,87,87,0.12)' : 'rgba(0,200,150,0.12)', border: `1px solid ${msg.startsWith('❌') ? 'rgba(255,87,87,0.3)' : 'rgba(0,200,150,0.3)'}`, borderRadius: '8px', padding: '12px 16px', marginBottom: '20px', color: msg.startsWith('❌') ? '#ff5757' : '#00c896', fontSize: '14px' }}>
                    {msg}
                </div>
            )}

            {/* 績效計算起始日 */}
            <div style={{ ...card, marginBottom: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                    <span style={{ fontSize: '18px' }}>📅</span>
                    <span style={{ fontSize: '15px', fontWeight: 600, color: '#e2e8f0' }}>績效計算起始日</span>
                </div>
                <p style={{ fontSize: '13px', color: '#8892a4', marginBottom: '16px', lineHeight: 1.6 }}>
                    設定後，「年度復盤」的自訂區間 CAGR 將<strong style={{ color: '#e2e8f0' }}>自動忽略此日期前的所有交易資料</strong>，不需每次手動輸入。<br />
                    起始資產可不填（系統自動用持倉成本推算），但建議填入實際金額讓結果更準確。
                </p>

                {perfConfigLoading ? (
                    <div style={{ color: '#8892a4', fontSize: '13px' }}>載入中...</div>
                ) : (
                    <>
                        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '16px' }}>
                            <div>
                                <label style={{ fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }}>起始日期</label>
                                <input type="date" style={inp} value={perfStartDate} onChange={e => setPerfStartDate(e.target.value)} />
                            </div>
                            <div>
                                <label style={{ fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }}>起始資產（可選填）</label>
                                <input
                                    type="text" placeholder="例：260100"
                                    style={{ ...inp, width: '160px' }}
                                    value={perfStartValue}
                                    onChange={e => setPerfStartValue(e.target.value)}
                                />
                            </div>
                            <button onClick={savePerfConfig} disabled={perfConfigSaving || !perfStartDate}
                                style={{ ...btn('#4f8ef7'), opacity: (!perfStartDate || perfConfigSaving) ? 0.5 : 1, cursor: !perfStartDate ? 'not-allowed' : 'pointer' }}>
                                {perfConfigSaving ? '儲存中...' : '儲存設定'}
                            </button>
                            {perfStartDate && (
                                <button onClick={clearPerfConfig} style={btn('#3a3f55')}>清除</button>
                            )}
                        </div>

                        {perfStartDate ? (
                            <div style={{ backgroundColor: 'rgba(79,142,247,0.1)', border: '1px solid rgba(79,142,247,0.3)', borderRadius: '8px', padding: '12px 16px', fontSize: '13px' }}>
                                <span style={{ color: '#8892a4' }}>目前設定：</span>
                                <span style={{ color: '#4f8ef7', fontWeight: 600, marginLeft: '6px' }}>從 {perfStartDate} 起算</span>
                                {perfStartValue && (
                                    <span style={{ color: '#8892a4', marginLeft: '12px' }}>
                                        起始資產：<span style={{ color: '#00c896', fontWeight: 600 }}>${parseFloat(perfStartValue.replace(/,/g, '')).toLocaleString()}</span>
                                    </span>
                                )}
                            </div>
                        ) : (
                            <div style={{ backgroundColor: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.25)', borderRadius: '8px', padding: '12px 16px', fontSize: '13px', color: '#f5a623' }}>
                                尚未設定起始日，CAGR 計算會包含所有歷史交易資料。
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* 股票字典匯入 */}
            <div style={{ ...card, marginBottom: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                    <FileSpreadsheet size={18} color="#4f8ef7" />
                    <span style={{ fontSize: '15px', fontWeight: 600, color: '#e2e8f0' }}>匯入股票字典</span>
                </div>
                <p style={{ fontSize: '13px', color: '#8892a4', marginBottom: '16px', lineHeight: 1.6 }}>
                    支援 <strong style={{ color: '#e2e8f0' }}>.xlsx / .xls</strong> 格式，欄位需包含 <strong style={{ color: '#4f8ef7' }}>「股票代號」</strong> 和 <strong style={{ color: '#4f8ef7' }}>「股票名稱」</strong>。<br />
                    匯入後輸入代號時會自動帶入名稱，重複代號會自動覆蓋更新。
                </p>
                <label style={{ ...btn('#4f8ef7'), width: 'fit-content', cursor: 'pointer', opacity: importing ? 0.6 : 1 }}>
                    <Upload size={16} />
                    {importing ? '匯入中...' : '選擇 Excel 檔案匯入'}
                    <input type="file" accept=".xlsx,.xls" onChange={handleImportDict} disabled={importing} style={{ display: 'none' }} />
                </label>
                {importResult && (
                    <div style={{ marginTop: '16px', padding: '16px', backgroundColor: '#0f1117', borderRadius: '8px', border: '1px solid #2e3349' }}>
                        <div style={{ display: 'flex', gap: '24px' }}>
                            <div>
                                <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '4px' }}>成功匯入</div>
                                <div style={{ fontSize: '22px', fontWeight: 700, color: '#00c896' }}>{importResult.success} 筆</div>
                            </div>
                            {importResult.failed > 0 && (
                                <div>
                                    <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '4px' }}>略過（格式錯誤）</div>
                                    <div style={{ fontSize: '22px', fontWeight: 700, color: '#ff5757' }}>{importResult.failed} 筆</div>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* 匯出報表 */}
            <div style={card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                    <Download size={18} color="#00c896" />
                    <span style={{ fontSize: '15px', fontWeight: 600, color: '#e2e8f0' }}>匯出報表（CSV）</span>
                </div>
                <p style={{ fontSize: '13px', color: '#8892a4', marginBottom: '16px' }}>
                    匯出後可直接用 Excel 開啟，所有中文字符完整顯示。
                </p>
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    <button style={btn('#4f8ef7')} onClick={exportTrades} disabled={exportLoading}>
                        <Download size={16} />買賣紀錄
                    </button>
                    <button style={btn('#00c896')} onClick={exportCashFlow}>
                        <Download size={16} />出入金紀錄
                    </button>
                    <button style={btn('#f5a623')} onClick={exportDividends}>
                        <Download size={16} />除權息紀錄
                    </button>
                </div>
            </div>
        </div>
    )
}