import { useState } from 'react'
import { collection, getDocs, doc, setDoc, orderBy, query, addDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc } from '../../lib/userDB'
import { calcFee, calcTax } from '../../lib/calc'
import { Download, Upload, FileSpreadsheet, Database, FileDown } from 'lucide-react'
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

/**
 * 穩健 CSV 行解析器：支援引號包裹欄位、欄位內含逗號（千分位）
 */
function parseCSVLine(line: string): string[] {
    const result: string[] = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
            else { inQuotes = !inQuotes }
        } else if (ch === ',' && !inQuotes) {
            result.push(current.trim())
            current = ''
        } else {
            current += ch
        }
    }
    result.push(current.trim())
    return result
}

/** 去除千分位逗號後轉浮點數 */
const toNum = (s: string) => parseFloat((s || '').replace(/,/g, '')) || 0
/** 去除千分位逗號後轉整數 */
const toInt = (s: string) => parseInt((s || '').replace(/,/g, '')) || 0

export default function InvestSettings() {
    const [importing, setImporting] = useState(false)
    const [importResult, setImportResult] = useState<{ success: number; failed: number } | null>(null)
    const [tradeImportResult, setTradeImportResult] = useState<{ success: number; failed: number; skipped: number } | null>(null)
    const [exportLoading, setExportLoading] = useState(false)
    const [fullExportLoading, setFullExportLoading] = useState(false)
    const [tradeImporting, setTradeImporting] = useState(false)
    const [msg, setMsg] = useState('')

    const showMsg = (text: string) => {
        setMsg(text)
        setTimeout(() => setMsg(''), 5000)
    }

    // ── 匯入股票字典（Excel）──────────────────────────────────────────────
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
                        try { await setDoc(userDoc(investDB, 'stockDict', code), { name }); success++ }
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

    // ── 匯入買賣紀錄 CSV ──────────────────────────────────────────────────
    const handleImportTradesCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        setTradeImporting(true)
        setTradeImportResult(null)

        const text = await file.text()
        const lines = text
            .replace(/^\uFEFF/, '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .split('\n')
            .filter(l => l.trim())

        if (lines.length < 2) {
            showMsg('❌ CSV 檔案內容為空或格式錯誤')
            setTradeImporting(false)
            e.target.value = ''
            return
        }

        const headers = parseCSVLine(lines[0])
        let success = 0, failed = 0, skipped = 0

        for (let i = 1; i < lines.length; i++) {
            const cols = parseCSVLine(lines[i])
            const row: Record<string, string> = {}
            headers.forEach((h, idx) => { row[h] = cols[idx] || '' })

            const date = row['日期'] || ''
            const typeStr = row['類型'] || ''
            const code = (row['代號'] || row['股票代號'] || '').replace('.TW', '').replace('.tw', '').trim()
            const name = (row['名稱'] || row['股票名稱'] || '').trim()
            const price = toNum(row['價格'] || row['價格/金額'] || '')
            // ★ toInt 去除千分位逗號後再轉整數
            const shares = toInt(row['股數'])
            const note = row['備註'] || row['備註/筆記'] || ''

            if (!date || !typeStr) { skipped++; continue }
            if (typeStr !== '買入' && typeStr !== '賣出' && typeStr !== '買進') { skipped++; continue }
            if (!code || !price || !shares) { failed++; continue }

            const tradeType: 'buy' | 'sell' = (typeStr === '買入' || typeStr === '買進') ? 'buy' : 'sell'

            // 若 CSV 有提供手續費/交易稅則使用，否則自動計算
            const feeRaw = row['手續費'] !== undefined && row['手續費'] !== '' ? toNum(row['手續費']) : null
            const taxRaw = row['交易稅'] !== undefined && row['交易稅'] !== '' ? toNum(row['交易稅']) : null
            const fee = feeRaw !== null ? feeRaw : calcFee(price, shares)
            const tax = taxRaw !== null ? taxRaw : (tradeType === 'sell' ? calcTax(price, shares, code) : 0)
            const totalRaw = row['收付金額'] !== undefined && row['收付金額'] !== '' ? toNum(row['收付金額']) : null
            const total = totalRaw !== null ? totalRaw : (tradeType === 'buy' ? price * shares + fee : price * shares - fee - tax)

            try {
                await addDoc(userCol(investDB, 'trades'), { date, type: tradeType, code, name, price, shares, fee, tax, total, note })
                if (name && code) await setDoc(userDoc(investDB, 'stockDict', code), { name })
                success++
            } catch { failed++ }
        }

        setTradeImportResult({ success, failed, skipped })
        showMsg(`✅ 買賣紀錄匯入完成！成功 ${success} 筆，失敗 ${failed} 筆，略過 ${skipped} 筆`)
        setTradeImporting(false)
        e.target.value = ''
    }

    // ── 一鍵匯出全部資料（多工作表 Excel）──────────────────────────────
    const exportAllData = async () => {
        setFullExportLoading(true)
        try {
            const [tradesSnap, cashSnap, dividendsSnap, dictSnap] = await Promise.all([
                getDocs(query(userCol(investDB, 'trades'), orderBy('date', 'desc'))),
                getDocs(query(userCol(investDB, 'cashflow'), orderBy('date', 'desc'))),
                getDocs(query(userCol(investDB, 'dividends'), orderBy('date', 'desc'))),
                getDocs(userCol(investDB, 'stockDict')),
            ])

            const tradesData = tradesSnap.docs.map(d => {
                const t = d.data() as TradeRow
                return {
                    'Firestore ID': d.id,
                    '日期': t.date,
                    '類型': t.type === 'buy' ? '買入' : '賣出',
                    '代號': t.code,
                    '名稱': t.name,
                    '價格': t.price,
                    '股數': t.shares,
                    '手續費': t.fee,
                    '交易稅': t.tax,
                    '收付金額': t.total,
                    '備註': t.note ?? '',
                }
            })

            const cashData = cashSnap.docs.map(d => {
                const r = d.data() as CashflowRow
                return {
                    'Firestore ID': d.id,
                    '日期': r.date,
                    '類型': r.type === 'in' ? '入金' : '出金',
                    '金額': r.amount,
                    '備註': r.note ?? '',
                }
            })

            const dividendsData = dividendsSnap.docs.map(d => {
                const r = d.data() as DividendRow
                return {
                    'Firestore ID': d.id,
                    '日期': r.date,
                    '代號': r.code,
                    '名稱': r.name,
                    '現金股利': r.cashDividend,
                    '股票股利': r.stockDividend,
                    '備註': r.note ?? '',
                }
            })

            const dictData = dictSnap.docs.map(d => ({
                '股票代號': d.id,
                '股票名稱': (d.data() as { name: string }).name,
            }))

            const wb = XLSX.utils.book_new()
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tradesData.length ? tradesData : [{}]), '買賣紀錄')
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cashData.length ? cashData : [{}]), '出入金紀錄')
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dividendsData.length ? dividendsData : [{}]), '除權息紀錄')
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dictData.length ? dictData : [{}]), '股票字典')
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
                { '項目': '買賣紀錄', '筆數': tradesData.length },
                { '項目': '出入金紀錄', '筆數': cashData.length },
                { '項目': '除權息紀錄', '筆數': dividendsData.length },
                { '項目': '股票字典', '筆數': dictData.length },
                { '項目': '匯出時間', '筆數': new Date().toLocaleString('zh-TW') },
            ]), '摘要')

            XLSX.writeFile(wb, `投資系統完整備份_${today()}.xlsx`)
            showMsg(`✅ 全部資料匯出完成！共 ${tradesData.length + cashData.length + dividendsData.length} 筆紀錄`)
        } catch (err) {
            showMsg('❌ 匯出失敗，請稍後再試')
            console.error(err)
        }
        setFullExportLoading(false)
    }

    // ── 分項匯出 CSV ──────────────────────────────────────────────────────
    const exportTrades = async () => {
        setExportLoading(true)
        const snap = await getDocs(query(userCol(investDB, 'trades'), orderBy('date', 'desc')))
        const trades = snap.docs.map(d => d.data() as TradeRow)
        const header = ['日期', '類型', '代號', '名稱', '價格', '股數', '手續費', '交易稅', '收付金額', '備註']
        const rows = trades.map(t => [t.date, t.type === 'buy' ? '買入' : '賣出', t.code, t.name, t.price, t.shares, t.fee, t.tax, t.total, t.note ?? ''])
        downloadCSV([header, ...rows].map(r => r.join(',')).join('\n'), `買賣紀錄_${today()}.csv`)
        setExportLoading(false)
        showMsg('✅ 已匯出買賣紀錄')
    }

    const exportCashFlow = async () => {
        const snap = await getDocs(query(userCol(investDB, 'cashflow'), orderBy('date', 'desc')))
        const records = snap.docs.map(d => d.data() as CashflowRow)
        const header = ['日期', '類型', '金額', '備註']
        const rows = records.map(r => [r.date, r.type === 'in' ? '入金' : '出金', r.amount, r.note ?? ''])
        downloadCSV([header, ...rows].map(r => r.join(',')).join('\n'), `出入金紀錄_${today()}.csv`)
        showMsg('✅ 已匯出出入金紀錄')
    }

    const exportDividends = async () => {
        const snap = await getDocs(query(userCol(investDB, 'dividends'), orderBy('date', 'desc')))
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
                <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>匯入股票字典、買賣紀錄，匯出報表與完整備份</p>
            </div>

            {msg && (
                <div style={{ backgroundColor: msg.startsWith('❌') ? 'rgba(255,87,87,0.12)' : 'rgba(0,200,150,0.12)', border: `1px solid ${msg.startsWith('❌') ? 'rgba(255,87,87,0.3)' : 'rgba(0,200,150,0.3)'}`, borderRadius: '8px', padding: '12px 16px', marginBottom: '20px', color: msg.startsWith('❌') ? '#ff5757' : '#00c896', fontSize: '14px' }}>
                    {msg}
                </div>
            )}

            {/* ① 一鍵匯出全部資料 */}
            <div style={{ ...card, marginBottom: '20px', border: '1px solid rgba(79,142,247,0.4)', background: 'linear-gradient(135deg, #1a1d27 0%, #1e2236 100%)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                    <Database size={18} color="#4f8ef7" />
                    <span style={{ fontSize: '15px', fontWeight: 600, color: '#e2e8f0' }}>一鍵匯出全部資料</span>
                    <span style={{ fontSize: '11px', backgroundColor: 'rgba(79,142,247,0.2)', color: '#4f8ef7', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>備份 / 核查用</span>
                </div>
                <p style={{ fontSize: '13px', color: '#8892a4', marginBottom: '16px', lineHeight: 1.6 }}>
                    將系統內<strong style={{ color: '#e2e8f0' }}>全部資料</strong>（買賣紀錄、出入金、除權息、股票字典）一次匯出為<strong style={{ color: '#4f8ef7' }}> Excel 多工作表檔案</strong>，包含 Firestore ID，方便核查是否有錯誤資料。
                </p>
                <button style={{ ...btn('#4f8ef7'), opacity: fullExportLoading ? 0.6 : 1 }} onClick={exportAllData} disabled={fullExportLoading}>
                    <FileDown size={16} />
                    {fullExportLoading ? '匯出中，請稍候...' : '匯出完整備份 (.xlsx)'}
                </button>
            </div>

            {/* ② 股票字典匯入 */}
            <div style={{ ...card, marginBottom: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                    <FileSpreadsheet size={18} color="#a78bfa" />
                    <span style={{ fontSize: '15px', fontWeight: 600, color: '#e2e8f0' }}>匯入股票字典</span>
                </div>
                <p style={{ fontSize: '13px', color: '#8892a4', marginBottom: '16px', lineHeight: 1.6 }}>
                    支援 <strong style={{ color: '#e2e8f0' }}>.xlsx / .xls</strong> 格式，欄位需包含 <strong style={{ color: '#a78bfa' }}>「股票代號」</strong> 和 <strong style={{ color: '#a78bfa' }}>「股票名稱」</strong>。<br />
                    匯入後輸入代號時會自動帶入名稱，重複代號會自動覆蓋更新。
                </p>
                <label style={{ ...btn('#a78bfa'), width: 'fit-content', cursor: 'pointer', opacity: importing ? 0.6 : 1 }}>
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

            {/* ③ 匯入買賣紀錄 CSV */}
            <div style={{ ...card, marginBottom: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                    <Upload size={18} color="#00c896" />
                    <span style={{ fontSize: '15px', fontWeight: 600, color: '#e2e8f0' }}>匯入買賣紀錄</span>
                    <span style={{ fontSize: '11px', backgroundColor: 'rgba(0,200,150,0.15)', color: '#00c896', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>CSV</span>
                </div>
                <p style={{ fontSize: '13px', color: '#8892a4', marginBottom: '4px', lineHeight: 1.6 }}>
                    支援 <strong style={{ color: '#e2e8f0' }}>.csv</strong> 格式，需包含以下欄位：
                </p>
                <div style={{ backgroundColor: '#0f1117', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', border: '1px solid #2e3349', fontSize: '12px', color: '#8892a4', fontFamily: 'monospace', lineHeight: 1.8 }}>
                    <span style={{ color: '#4f8ef7' }}>必填：</span> 日期、類型（買入/賣出）、代號、名稱、價格、股數<br />
                    <span style={{ color: '#8892a4' }}>選填：</span> 手續費、交易稅、收付金額、備註<br />
                    <span style={{ color: '#f5a623' }}>※</span> 股數支援含千分位逗號格式（如 1,000）<br />
                    <span style={{ color: '#f5a623' }}>※</span> 未填手續費/交易稅時，系統將依規則自動計算（含零股最低 1 元）
                </div>
                <label style={{ ...btn('#00c896'), width: 'fit-content', cursor: 'pointer', opacity: tradeImporting ? 0.6 : 1 }}>
                    <Upload size={16} />
                    {tradeImporting ? '匯入中...' : '選擇 CSV 檔案匯入'}
                    <input type="file" accept=".csv" onChange={handleImportTradesCSV} disabled={tradeImporting} style={{ display: 'none' }} />
                </label>
                {tradeImportResult && (
                    <div style={{ marginTop: '16px', padding: '16px', backgroundColor: '#0f1117', borderRadius: '8px', border: '1px solid #2e3349', display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
                        <div>
                            <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '4px' }}>成功匯入</div>
                            <div style={{ fontSize: '22px', fontWeight: 700, color: '#00c896' }}>{tradeImportResult.success} 筆</div>
                        </div>
                        {tradeImportResult.failed > 0 && (
                            <div>
                                <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '4px' }}>失敗（資料不完整）</div>
                                <div style={{ fontSize: '22px', fontWeight: 700, color: '#ff5757' }}>{tradeImportResult.failed} 筆</div>
                            </div>
                        )}
                        {tradeImportResult.skipped > 0 && (
                            <div>
                                <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '4px' }}>略過（非買賣類型）</div>
                                <div style={{ fontSize: '22px', fontWeight: 700, color: '#8892a4' }}>{tradeImportResult.skipped} 筆</div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* ④ 分項匯出報表 */}
            <div style={card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                    <Download size={18} color="#f5a623" />
                    <span style={{ fontSize: '15px', fontWeight: 600, color: '#e2e8f0' }}>分項匯出報表（CSV）</span>
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