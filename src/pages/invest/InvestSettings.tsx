import { useState } from 'react'
import { collection, getDocs, doc, setDoc, orderBy, query } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { Download, Upload, FileSpreadsheet } from 'lucide-react'
import * as XLSX from 'xlsx'

interface StockRow {
    '股票代號'?: string
    '代號'?: string
    code?: string
    Code?: string
    '股票名稱'?: string
    '名稱'?: string
    name?: string
    Name?: string
}

interface TradeRow {
    date: string
    type: string
    code: string
    name: string
    price: number
    shares: number
    fee: number
    tax: number
    total: number
    note?: string
}

interface CashflowRow {
    date: string
    type: string
    amount: number
    note?: string
}

interface DividendRow {
    date: string
    code: string
    name: string
    cashDividend: number
    stockDividend: number
    note?: string
}

const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '24px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '10px 18px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' })

export default function InvestSettings() {
    const [importing, setImporting] = useState(false)
    const [importResult, setImportResult] = useState<{ success: number; failed: number } | null>(null)
    const [exportLoading, setExportLoading] = useState(false)
    const [msg, setMsg] = useState('')

    const showMsg = (text: string) => {
        setMsg(text)
        setTimeout(() => setMsg(''), 4000)
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
                const rows = XLSX.utils.sheet_to_json<StockRow>(sheet)
                let success = 0, failed = 0
                for (const row of rows) {
                    const code = String(row['股票代號'] || row['代號'] || row.code || row.Code || '').trim()
                    const name = String(row['股票名稱'] || row['名稱'] || row.name || row.Name || '').trim()
                    if (code && name) {
                        try { await setDoc(doc(investDB, 'stockDict', code), { name }); success++ }
                        catch { failed++ }
                    } else { failed++ }
                }
                setImportResult({ success, failed })
                showMsg(`✅ 匯入完成！成功 ${success} 筆，失敗 ${failed} 筆`)
            } catch {
                showMsg('❌ 檔案格式錯誤，請確認欄位名稱為「股票代號」和「股票名稱」')
            }
            setImporting(false)
            e.target.value = ''
        }
        reader.readAsArrayBuffer(file)
    }

    const exportTrades = async () => {
        setExportLoading(true)
        const snap = await getDocs(query(collection(investDB, 'trades'), orderBy('date', 'desc')))
        const trades = snap.docs.map(d => d.data() as TradeRow)
        const header = ['日期', '類型', '代號', '名稱', '價格', '股數', '手續費', '交易稅', '收付金額', '備註']
        const rows = trades.map(t => [t.date, t.type === 'buy' ? '買入' : '賣出', t.code, t.name, t.price, t.shares, t.fee, t.tax, t.total, t.note ?? ''])
        downloadCSV([header, ...rows].map(r => r.join(',')).join('\n'), `買賣紀錄_${today()}.csv`)
        setExportLoading(false)
        showMsg('✅ 已匯出買賣紀錄')
    }

    const exportCashFlow = async () => {
        const snap = await getDocs(query(collection(investDB, 'cashflow'), orderBy('date', 'desc')))
        const records = snap.docs.map(d => d.data() as CashflowRow)
        const header = ['日期', '類型', '金額', '備註']
        const rows = records.map(r => [r.date, r.type === 'in' ? '入金' : '出金', r.amount, r.note ?? ''])
        downloadCSV([header, ...rows].map(r => r.join(',')).join('\n'), `出入金紀錄_${today()}.csv`)
        showMsg('✅ 已匯出出入金紀錄')
    }

    const exportDividends = async () => {
        const snap = await getDocs(query(collection(investDB, 'dividends'), orderBy('date', 'desc')))
        const records = snap.docs.map(d => d.data() as DividendRow)
        const header = ['日期', '代號', '名稱', '現金股利', '股票股利', '備註']
        const rows = records.map(r => [r.date, r.code, r.name, r.cashDividend, r.stockDividend, r.note ?? ''])
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