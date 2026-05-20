import { useState, useEffect } from 'react'
import { collection, getDocs, getDoc, doc, setDoc, orderBy, query, addDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc, userDocNested } from '../../lib/userDB'
import { calcFee, calcTax } from '../../lib/calc'
import { Download, Upload, FileSpreadsheet, Database, FileDown, User } from 'lucide-react'
import * as XLSX from 'xlsx'

interface SnapshotRecord {
    date: string
    totalAssets: number
    marketValue: number
    cash: number
}

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

const card: React.CSSProperties = { backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '24px' }
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
    const [cashImportResult, setCashImportResult] = useState<{ success: number; failed: number } | null>(null)
    const [divImportResult, setDivImportResult] = useState<{ success: number; failed: number } | null>(null)
    const [exportLoading, setExportLoading] = useState(false)
    const [fullExportLoading, setFullExportLoading] = useState(false)
    const [trendExportLoading, setTrendExportLoading] = useState(false)
    const [tradeImporting, setTradeImporting] = useState(false)
    const [cashImporting, setCashImporting] = useState(false)
    const [divImporting, setDivImporting] = useState(false)
    const [msg, setMsg] = useState('')

    // ── 帳戶名稱 ─────────────────────────────────────────────────────────────
    const [displayName, setDisplayName] = useState('')
    const [nameInput, setNameInput] = useState('')
    const [nameSaving, setNameSaving] = useState(false)

    useEffect(() => {
        getDoc(userDocNested(investDB, 'settings', 'profile'))
            .then(snap => {
                const name = snap.exists() ? (snap.data().displayName ?? '') : ''
                setDisplayName(name)
                setNameInput(name)
            })
            .catch(() => { })
    }, [])

    const showMsg = (text: string) => {
        setMsg(text)
        setTimeout(() => setMsg(''), 5000)
    }

    const saveName = async () => {
        const name = nameInput.trim()
        if (!name) return
        setNameSaving(true)
        try {
            await setDoc(userDocNested(investDB, 'settings', 'profile'), { displayName: name }, { merge: true })
            setDisplayName(name)
            showMsg('✅ 顯示名稱已儲存')
        } catch {
            showMsg('❌ 儲存失敗，請稍後再試')
        }
        setNameSaving(false)
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
            const shares = toInt(row['股數'])
            const note = row['備註'] || row['備註/筆記'] || ''

            if (!date || !typeStr) { skipped++; continue }
            if (typeStr !== '買入' && typeStr !== '賣出' && typeStr !== '買進') { skipped++; continue }
            if (!code || !price || !shares) { failed++; continue }

            const tradeType: 'buy' | 'sell' = (typeStr === '買入' || typeStr === '買進') ? 'buy' : 'sell'

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

    // ── 匯入出入金 CSV ────────────────────────────────────────────────────
    const handleImportCashCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        setCashImporting(true)
        setCashImportResult(null)

        const text = await file.text()
        const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim())

        if (lines.length < 2) {
            showMsg('❌ CSV 內容為空或格式錯誤')
            setCashImporting(false)
            e.target.value = ''
            return
        }

        const headers = parseCSVLine(lines[0])
        let success = 0, failed = 0

        for (let i = 1; i < lines.length; i++) {
            const cols = parseCSVLine(lines[i])
            const row: Record<string, string> = {}
            headers.forEach((h, idx) => { row[h] = cols[idx] || '' })

            const date = row['日期'] || ''
            const typeStr = row['類型'] || ''
            const amount = toNum(row['金額'] || row['金額/收付'] || '')
            const note = row['備註'] || ''

            if (!date || !typeStr || !amount) { failed++; continue }

            const cashType = typeStr === '入金' || typeStr === 'in' ? 'in' : typeStr === '出金' || typeStr === 'out' ? 'out' : null
            if (!cashType) { failed++; continue }

            try {
                await addDoc(userCol(investDB, 'cashflow'), { date, type: cashType, amount, note })
                success++
            } catch { failed++ }
        }

        setCashImportResult({ success, failed })
        showMsg(`✅ 出入金匯入完成！成功 ${success} 筆，失敗 ${failed} 筆`)
        setCashImporting(false)
        e.target.value = ''
    }

    // ── 匯入除權息 CSV ────────────────────────────────────────────────────
    const handleImportDividendCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        setDivImporting(true)
        setDivImportResult(null)

        const text = await file.text()
        const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim())

        if (lines.length < 2) {
            showMsg('❌ CSV 內容為空或格式錯誤')
            setDivImporting(false)
            e.target.value = ''
            return
        }

        const headers = parseCSVLine(lines[0])
        let success = 0, failed = 0

        for (let i = 1; i < lines.length; i++) {
            const cols = parseCSVLine(lines[i])
            const row: Record<string, string> = {}
            headers.forEach((h, idx) => { row[h] = cols[idx] || '' })

            const date = row['日期'] || ''
            const code = (row['代號'] || row['股票代號'] || '').trim()
            const name = (row['名稱'] || row['股票名稱'] || '').trim()
            const cashDividend = toNum(row['現金股利'] || row['現金'] || '')
            const stockDividend = toNum(row['股票股利'] || row['股票'] || '')
            const note = row['備註'] || ''

            if (!date || !code) { failed++; continue }

            try {
                await addDoc(userCol(investDB, 'dividends'), { date, code, name, cashDividend, stockDividend, note })
                if (name && code) await setDoc(userDoc(investDB, 'stockDict', code), { name })
                success++
            } catch { failed++ }
        }

        setDivImportResult({ success, failed })
        showMsg(`✅ 除權息匯入完成！成功 ${success} 筆，失敗 ${failed} 筆`)
        setDivImporting(false)
        e.target.value = ''
    }

    // ── 一鍵匯出全部資料（多工作表 Excel）──────────────────────────────
    const exportAllData = async () => {
        setFullExportLoading(true)
        try {
            const [tradesSnap, cashSnap, dividendsSnap, dictSnap, snapshotsSnap] = await Promise.all([
                getDocs(query(userCol(investDB, 'trades'), orderBy('date', 'desc'))),
                getDocs(query(userCol(investDB, 'cashflow'), orderBy('date', 'desc'))),
                getDocs(query(userCol(investDB, 'dividends'), orderBy('date', 'desc'))),
                getDocs(userCol(investDB, 'stockDict')),
                getDocs(query(userCol(investDB, 'assetSnapshots'), orderBy('date', 'desc'))),
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

            const snapshotsData = snapshotsSnap.docs.map(d => {
                const s = d.data() as SnapshotRecord
                return {
                    '日期': s.date,
                    '總資產': s.totalAssets,
                    '股票市值': s.marketValue,
                    '現金': s.cash,
                }
            })

            const wb = XLSX.utils.book_new()
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tradesData.length ? tradesData : [{}]), '買賣紀錄')
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cashData.length ? cashData : [{}]), '出入金紀錄')
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dividendsData.length ? dividendsData : [{}]), '除權息紀錄')
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dictData.length ? dictData : [{}]), '股票字典')
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(snapshotsData.length ? snapshotsData : [{}]), '資產趨勢')
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
                { '項目': '買賣紀錄', '筆數': tradesData.length },
                { '項目': '出入金紀錄', '筆數': cashData.length },
                { '項目': '除權息紀錄', '筆數': dividendsData.length },
                { '項目': '股票字典', '筆數': dictData.length },
                { '項目': '資產趨勢快照', '筆數': snapshotsData.length },
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

    const exportTrendCSV = async () => {
        setTrendExportLoading(true)
        const snap = await getDocs(query(userCol(investDB, 'assetSnapshots'), orderBy('date', 'asc')))
        const records = snap.docs.map(d => d.data() as SnapshotRecord)
        if (records.length === 0) { showMsg('⚠️ 尚無資產趨勢資料'); setTrendExportLoading(false); return }
        const header = ['日期', '總資產', '股票市值', '現金']
        const rows = records.map(r => [r.date, r.totalAssets, r.marketValue, r.cash])
        downloadCSV([header, ...rows].map(r => r.join(',')).join('\n'), `資產趨勢_${today()}.csv`)
        showMsg('✅ 已匯出資產趨勢（CSV）')
        setTrendExportLoading(false)
    }

    const exportTrendXLSX = async () => {
        setTrendExportLoading(true)
        const snap = await getDocs(query(userCol(investDB, 'assetSnapshots'), orderBy('date', 'asc')))
        const records = snap.docs.map(d => d.data() as SnapshotRecord)
        if (records.length === 0) { showMsg('⚠️ 尚無資產趨勢資料'); setTrendExportLoading(false); return }
        const rows = records.map(r => ({ '日期': r.date, '總資產': r.totalAssets, '股票市值': r.marketValue, '現金': r.cash }))
        const ws = XLSX.utils.json_to_sheet(rows)
        ws['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }]
        const wb = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(wb, ws, '資產趨勢')
        XLSX.writeFile(wb, `資產趨勢_${today()}.xlsx`)
        showMsg('✅ 已匯出資產趨勢（Excel）')
        setTrendExportLoading(false)
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
        <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1200px', margin: '0 auto' }}>
            <div style={{ marginBottom: '24px' }}>
                <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>設定與備份</h1>
                <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>匯入資料、匯出報表與完整備份</p>
            </div>

            {msg && (
                <div style={{ backgroundColor: msg.startsWith('❌') ? 'color-mix(in srgb, var(--c-danger) 12%, transparent)' : 'color-mix(in srgb, var(--c-positive) 12%, transparent)', border: `1px solid ${msg.startsWith('❌') ? 'rgba(255,87,87,0.3)' : 'rgba(0,200,150,0.3)'}`, borderRadius: '8px', padding: '12px 16px', marginBottom: '20px', color: msg.startsWith('❌') ? 'var(--c-danger)' : 'var(--c-positive)', fontSize: '14px' }}>
                    {msg}
                </div>
            )}

            {/* ── 匯入區（兩欄） ── */}
            <div style={{ marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Upload size={15} color="var(--c-muted)" />
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--c-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>匯入資料</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '14px', marginBottom: '24px' }}>

                {/* ① 股票字典 */}
                <div style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <FileSpreadsheet size={16} color="#a78bfa" />
                        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>股票字典</span>
                        <span style={{ fontSize: '11px', backgroundColor: 'rgba(167,139,250,0.15)', color: '#a78bfa', padding: '1px 7px', borderRadius: '20px' }}>xlsx / xls</span>
                    </div>
                    <p style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '12px', lineHeight: 1.6 }}>
                        需含 <strong style={{ color: '#a78bfa' }}>「股票代號」</strong> 和 <strong style={{ color: '#a78bfa' }}>「股票名稱」</strong> 欄位。匯入後輸入代號自動帶入名稱。
                    </p>
                    <label style={{ ...btn('#a78bfa'), width: 'fit-content', cursor: 'pointer', opacity: importing ? 0.6 : 1, fontSize: '13px' }}>
                        <Upload size={14} />{importing ? '匯入中...' : '選擇 Excel 匯入'}
                        <input type="file" accept=".xlsx,.xls" onChange={handleImportDict} disabled={importing} style={{ display: 'none' }} />
                    </label>
                    {importResult && (
                        <div style={{ marginTop: '10px', padding: '10px 14px', backgroundColor: 'var(--c-bg)', borderRadius: '8px', border: '1px solid var(--c-border)', display: 'flex', gap: '20px' }}>
                            <div><div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>成功</div><div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--c-positive)' }}>{importResult.success}</div></div>
                            {importResult.failed > 0 && <div><div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>略過</div><div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--c-danger)' }}>{importResult.failed}</div></div>}
                        </div>
                    )}
                </div>

                {/* ② 買賣紀錄 */}
                <div style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <Upload size={16} color="var(--c-positive)" />
                        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>買賣紀錄</span>
                        <span style={{ fontSize: '11px', backgroundColor: 'color-mix(in srgb, var(--c-positive) 15%, transparent)', color: 'var(--c-positive)', padding: '1px 7px', borderRadius: '20px' }}>CSV</span>
                    </div>
                    <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '6px', padding: '7px 10px', marginBottom: '12px', border: '1px solid var(--c-border)', fontSize: '11px', color: 'var(--c-muted)', lineHeight: 1.8 }}>
                        <span style={{ color: 'var(--c-accent)' }}>必填：</span>日期、類型（買入/賣出）、代號、名稱、價格、股數<br />
                        <span style={{ color: 'var(--c-muted)' }}>選填：</span>手續費、交易稅、收付金額、備註
                    </div>
                    <label style={{ ...btn('var(--c-positive)'), width: 'fit-content', cursor: 'pointer', opacity: tradeImporting ? 0.6 : 1, fontSize: '13px' }}>
                        <Upload size={14} />{tradeImporting ? '匯入中...' : '選擇 CSV 匯入'}
                        <input type="file" accept=".csv" onChange={handleImportTradesCSV} disabled={tradeImporting} style={{ display: 'none' }} />
                    </label>
                    {tradeImportResult && (
                        <div style={{ marginTop: '10px', padding: '10px 14px', backgroundColor: 'var(--c-bg)', borderRadius: '8px', border: '1px solid var(--c-border)', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                            <div><div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>成功</div><div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--c-positive)' }}>{tradeImportResult.success}</div></div>
                            {tradeImportResult.failed > 0 && <div><div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>失敗</div><div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--c-danger)' }}>{tradeImportResult.failed}</div></div>}
                            {tradeImportResult.skipped > 0 && <div><div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>略過</div><div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--c-muted)' }}>{tradeImportResult.skipped}</div></div>}
                        </div>
                    )}
                </div>

                {/* ③ 除權息 */}
                <div style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <Upload size={16} color="var(--c-warning)" />
                        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>除權息紀錄</span>
                        <span style={{ fontSize: '11px', backgroundColor: 'rgba(245,166,35,0.15)', color: 'var(--c-warning)', padding: '1px 7px', borderRadius: '20px' }}>CSV</span>
                    </div>
                    <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '6px', padding: '7px 10px', marginBottom: '12px', border: '1px solid var(--c-border)', fontSize: '11px', color: 'var(--c-muted)', lineHeight: 1.8 }}>
                        <span style={{ color: 'var(--c-accent)' }}>必填：</span>日期、代號<br />
                        <span style={{ color: 'var(--c-muted)' }}>選填：</span>名稱、現金股利、股票股利、備註
                    </div>
                    <label style={{ ...btn('var(--c-warning)'), width: 'fit-content', cursor: 'pointer', opacity: divImporting ? 0.6 : 1, fontSize: '13px' }}>
                        <Upload size={14} />{divImporting ? '匯入中...' : '選擇 CSV 匯入'}
                        <input type="file" accept=".csv" onChange={handleImportDividendCSV} disabled={divImporting} style={{ display: 'none' }} />
                    </label>
                    {divImportResult && (
                        <div style={{ marginTop: '10px', padding: '10px 14px', backgroundColor: 'var(--c-bg)', borderRadius: '8px', border: '1px solid var(--c-border)', display: 'flex', gap: '16px' }}>
                            <div><div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>成功</div><div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--c-positive)' }}>{divImportResult.success}</div></div>
                            {divImportResult.failed > 0 && <div><div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>失敗</div><div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--c-danger)' }}>{divImportResult.failed}</div></div>}
                        </div>
                    )}
                </div>

                {/* ④ 出入金 */}
                <div style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <Upload size={16} color="var(--c-accent)" />
                        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>出入金紀錄</span>
                        <span style={{ fontSize: '11px', backgroundColor: 'color-mix(in srgb, var(--c-accent) 15%, transparent)', color: 'var(--c-accent)', padding: '1px 7px', borderRadius: '20px' }}>CSV</span>
                    </div>
                    <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '6px', padding: '7px 10px', marginBottom: '12px', border: '1px solid var(--c-border)', fontSize: '11px', color: 'var(--c-muted)', lineHeight: 1.8 }}>
                        <span style={{ color: 'var(--c-accent)' }}>必填：</span>日期、類型（入金/出金）、金額<br />
                        <span style={{ color: 'var(--c-muted)' }}>選填：</span>備註
                    </div>
                    <label style={{ ...btn('var(--c-accent)'), width: 'fit-content', cursor: 'pointer', opacity: cashImporting ? 0.6 : 1, fontSize: '13px' }}>
                        <Upload size={14} />{cashImporting ? '匯入中...' : '選擇 CSV 匯入'}
                        <input type="file" accept=".csv" onChange={handleImportCashCSV} disabled={cashImporting} style={{ display: 'none' }} />
                    </label>
                    {cashImportResult && (
                        <div style={{ marginTop: '10px', padding: '10px 14px', backgroundColor: 'var(--c-bg)', borderRadius: '8px', border: '1px solid var(--c-border)', display: 'flex', gap: '16px' }}>
                            <div><div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>成功</div><div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--c-positive)' }}>{cashImportResult.success}</div></div>
                            {cashImportResult.failed > 0 && <div><div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>失敗</div><div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--c-danger)' }}>{cashImportResult.failed}</div></div>}
                        </div>
                    )}
                </div>

                {/* ⑤ 顯示名稱 */}
                <div style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <User size={16} color="var(--c-muted)" />
                        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>顯示名稱</span>
                    </div>
                    <p style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '12px', lineHeight: 1.6 }}>
                        設定後顯示在 Sidebar 的「使用者：」欄位。
                    </p>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <input
                            value={nameInput}
                            onChange={e => setNameInput(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') saveName() }}
                            maxLength={20}
                            placeholder="輸入名稱…"
                            style={{ flex: 1, backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '8px 10px', color: 'var(--c-text)', fontSize: '13px', outline: 'none', minWidth: 0 }}
                        />
                        <button
                            onClick={saveName}
                            disabled={nameSaving || !nameInput.trim() || nameInput.trim() === displayName}
                            style={{ ...btn('var(--c-accent)'), padding: '8px 14px', fontSize: '13px', flexShrink: 0, opacity: (nameSaving || !nameInput.trim() || nameInput.trim() === displayName) ? 0.5 : 1, cursor: (nameSaving || !nameInput.trim() || nameInput.trim() === displayName) ? 'not-allowed' : 'pointer' }}
                        >
                            {nameSaving ? '儲存中…' : '儲存'}
                        </button>
                    </div>
                    {displayName && (
                        <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--c-muted)' }}>
                            目前：<span style={{ color: 'var(--c-accent)', fontWeight: 600 }}>{displayName}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* ── 匯出區（兩欄） ── */}
            <div style={{ marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Download size={15} color="var(--c-muted)" />
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--c-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>匯出報表</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '14px' }}>

                {/* ⑤ 完整備份 */}
                <div style={{ ...card, border: '1px solid var(--c-accent)', background: 'linear-gradient(135deg, var(--c-sidebar) 0%, var(--c-card) 100%)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <Database size={16} color="var(--c-accent)" />
                        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>完整備份</span>
                        <span style={{ fontSize: '11px', backgroundColor: 'rgba(79,142,247,0.2)', color: 'var(--c-accent)', padding: '1px 7px', borderRadius: '20px' }}>xlsx 多工作表</span>
                    </div>
                    <p style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '14px', lineHeight: 1.6 }}>
                        買賣紀錄、出入金、除權息、股票字典全部一次匯出，含 Firestore ID 方便核查錯誤資料。
                    </p>
                    <button style={{ ...btn('var(--c-accent)'), opacity: fullExportLoading ? 0.6 : 1, fontSize: '13px' }} onClick={exportAllData} disabled={fullExportLoading}>
                        <FileDown size={14} />{fullExportLoading ? '匯出中...' : '匯出完整備份 (.xlsx)'}
                    </button>
                </div>

                {/* ⑥ 分項匯出 */}
                <div style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <Download size={16} color="var(--c-warning)" />
                        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>分項匯出</span>
                        <span style={{ fontSize: '11px', backgroundColor: 'rgba(245,166,35,0.15)', color: 'var(--c-warning)', padding: '1px 7px', borderRadius: '20px' }}>CSV</span>
                    </div>
                    <p style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '14px' }}>匯出後可直接用 Excel 開啟，中文字符完整顯示。</p>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button style={{ ...btn('var(--c-accent)'), fontSize: '13px' }} onClick={exportTrades} disabled={exportLoading}>
                            <Download size={14} />買賣紀錄
                        </button>
                        <button style={{ ...btn('var(--c-positive)'), fontSize: '13px' }} onClick={exportCashFlow}>
                            <Download size={14} />出入金
                        </button>
                        <button style={{ ...btn('var(--c-warning)'), fontSize: '13px' }} onClick={exportDividends}>
                            <Download size={14} />除權息
                        </button>
                    </div>
                </div>

                {/* ⑦ 資產趨勢匯出 */}
                <div style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <Download size={16} color="var(--c-positive)" />
                        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>資產趨勢</span>
                        <span style={{ fontSize: '11px', backgroundColor: 'color-mix(in srgb, var(--c-positive) 15%, transparent)', color: 'var(--c-positive)', padding: '1px 7px', borderRadius: '20px' }}>CSV / xlsx</span>
                    </div>
                    <p style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '14px', lineHeight: 1.6 }}>
                        匯出所有資產快照紀錄（日期、總資產、股票市值、現金），完整備份也已包含此資料。
                    </p>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button style={{ ...btn('var(--c-positive)'), fontSize: '13px', opacity: trendExportLoading ? 0.6 : 1 }} onClick={exportTrendCSV} disabled={trendExportLoading}>
                            <Download size={14} />CSV
                        </button>
                        <button style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)', fontSize: '13px', opacity: trendExportLoading ? 0.6 : 1 }} onClick={exportTrendXLSX} disabled={trendExportLoading}>
                            <Download size={14} />Excel
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}