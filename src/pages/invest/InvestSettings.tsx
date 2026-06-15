import { useState, useEffect } from 'react'
import { getDocs, getDoc, setDoc, orderBy, query, addDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { invalidateTrades, invalidateCashflow, invalidateDividends } from '../../lib/investData'
import { userCol, userDoc, userDocNested, getUID } from '../../lib/userDB'
import { buildFullBackup, downloadBackup, parseBackup, restoreFullBackup, backupSummary, countBackupDocs, type FullBackup } from '../../lib/backup'
import { calcFee, calcTax, calcTradeTotal } from '../../lib/calc'
// ✅ 1-2：共用 CSV 解析模組
import { parseCSVLine, toNum, toInt } from '../../lib/csv'
import { Download, Upload, FileSpreadsheet, Database, FileDown, User, Calendar, FileJson, AlertTriangle } from 'lucide-react'
import * as XLSX from 'xlsx'

interface SnapshotRecord {
    date: string
    totalAssets: number
    marketValue: number
    cash: number
    marginDebt?: number  // 融資借款（負債），記錄用，總資產已扣除（與 AssetTrend.tsx 一致）
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
    isMargin?: boolean
    marginRatio?: number
    marginRepay?: number
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

type ExportFormat = 'csv' | 'xlsx'

const card: React.CSSProperties = { backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '24px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '10px 18px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' })

/**
 * 將物件陣列序列化成 CSV 字串。
 * 欄位含逗號、引號或換行時自動以雙引號包裹（與 parseCSVLine 對應，可正確 round-trip）。
 */
function objectsToCSV(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) return ''
    const headers = Object.keys(rows[0])
    const escape = (v: unknown) => {
        const s = v === null || v === undefined ? '' : String(v)
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [headers.join(',')]
    for (const row of rows) {
        lines.push(headers.map(h => escape(row[h])).join(','))
    }
    return lines.join('\n')
}

export default function InvestSettings() {
    const [importing, setImporting] = useState(false)
    const [importResult, setImportResult] = useState<{ success: number; failed: number } | null>(null)
    const [tradeImportResult, setTradeImportResult] = useState<{ success: number; failed: number; skipped: number; duplicated: number } | null>(null)
    const [cashImportResult, setCashImportResult] = useState<{ success: number; failed: number; duplicated: number } | null>(null)
    const [divImportResult, setDivImportResult] = useState<{ success: number; failed: number; duplicated: number } | null>(null)
    const [exportLoading, setExportLoading] = useState(false)
    const [fullExportLoading, setFullExportLoading] = useState(false)
    const [trendExportLoading, setTrendExportLoading] = useState(false)
    const [tradeImporting, setTradeImporting] = useState(false)
    const [cashImporting, setCashImporting] = useState(false)
    const [divImporting, setDivImporting] = useState(false)
    const [msg, setMsg] = useState('')

    // ── JSON 完整備份／還原（2-4）──────────────────────────────────────────
    const [jsonExportLoading, setJsonExportLoading] = useState(false)
    const [restorePreview, setRestorePreview] = useState<FullBackup | null>(null)
    const [restoreUidMismatch, setRestoreUidMismatch] = useState(false)
    const [restoring, setRestoring] = useState(false)
    const [restoreProgress, setRestoreProgress] = useState(0)

    // ── 匯出日期區間 ─────────────────────────────────────────────────────────
    // 留空表示不限。日期皆為 ISO 字串（YYYY-MM-DD），可直接字串比較。
    const [dateFrom, setDateFrom] = useState('')
    const [dateTo, setDateTo] = useState('')

    /** 判斷單筆日期是否落在選定區間內（兩端皆含；留空則不限該端） */
    const inRange = (date: string) =>
        (!dateFrom || (date ?? '') >= dateFrom) && (!dateTo || (date ?? '') <= dateTo)

    /** 依目前區間產生檔名後綴，無區間時退回今日日期 */
    const rangeSuffix = () => {
        if (dateFrom && dateTo) return `_${dateFrom}_至_${dateTo}`
        if (dateFrom) return `_${dateFrom}起`
        if (dateTo) return `_至${dateTo}`
        return `_${today()}`
    }

    /** 套用快捷區間 */
    const setPresetThisYear = () => {
        const y = new Date().getFullYear()
        setDateFrom(`${y}-01-01`)
        setDateTo(`${y}-12-31`)
    }
    const setPresetLastYear = () => {
        const d = new Date()
        const to = d.toISOString().split('T')[0]
        d.setFullYear(d.getFullYear() - 1)
        setDateFrom(d.toISOString().split('T')[0])
        setDateTo(to)
    }
    const clearRange = () => { setDateFrom(''); setDateTo('') }

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

        // ── 重複偵測：key = 日期|代號|類型|價格|股數 ──
        const existTradesSnap = await getDocs(userCol(investDB, 'trades'))
        const tradeKeys = new Set(existTradesSnap.docs.map(d => {
            const t = d.data()
            return `${t.date}|${t.code}|${t.type}|${Number(t.price)}|${Number(t.shares)}`
        }))
        let duplicated = 0

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
            const validTypes = ['買入', '賣出', '買進', '現貨買入', '現貨賣出', '融資買入', '融資賣出']
            if (!validTypes.includes(typeStr)) { skipped++; continue }
            if (!code || !price || !shares) { failed++; continue }

            const tradeType: 'buy' | 'sell' = (typeStr === '買入' || typeStr === '買進' || typeStr === '現貨買入' || typeStr === '融資買入') ? 'buy' : 'sell'
            const tradeKey = `${date}|${code}|${tradeType}|${Number(price)}|${Number(shares)}`
            if (tradeKeys.has(tradeKey)) { duplicated++; continue }
            tradeKeys.add(tradeKey)
            const isMargin = typeStr === '融資買入' || typeStr === '融資賣出'
            const marginRatio = isMargin
                ? (row['融資成數'] !== undefined && row['融資成數'] !== '' ? toNum(row['融資成數']) || 0.6 : 0.6)
                : 0
            const marginRepay = isMargin && tradeType === 'sell'
                ? (row['融資償還金額'] !== undefined && row['融資償還金額'] !== '' ? toNum(row['融資償還金額']) : 0)
                : 0

            const feeRaw = row['手續費'] !== undefined && row['手續費'] !== '' ? toNum(row['手續費']) : null
            const taxRaw = row['交易稅'] !== undefined && row['交易稅'] !== '' ? toNum(row['交易稅']) : null
            const fee = feeRaw !== null ? feeRaw : calcFee(price, shares)
            const tax = taxRaw !== null ? taxRaw : (tradeType === 'sell' ? calcTax(price, shares, code) : 0)
            const totalRaw = row['收付金額'] !== undefined && row['收付金額'] !== '' ? toNum(row['收付金額']) : null
            const total = totalRaw !== null ? totalRaw
                : calcTradeTotal({ type: tradeType, price, shares, fee, tax, isMargin, marginRatio, marginRepay })

            try {
                await addDoc(userCol(investDB, 'trades'), {
                    date, type: tradeType, code, name, price, shares, fee, tax, total, note,
                    isMargin, marginRatio: isMargin ? marginRatio : 0, marginRepay
                })
                if (name && code) await setDoc(userDoc(investDB, 'stockDict', code), { name })
                success++
            } catch { failed++ }
        }

        invalidateTrades()   // ✅ 1-1：匯入寫入後清快取
        setTradeImportResult({ success, failed, skipped, duplicated })
        showMsg(`✅ 買賣紀錄匯入完成！成功 ${success} 筆，失敗 ${failed} 筆，略過 ${skipped} 筆，重複略過 ${duplicated} 筆`)
        setTradeImporting(false)
        e.target.value = ''
    }

    // ── 匯入出入金 CSV ────────────────────────────────────────────────────
    const handleImportCashCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        setCashImporting(true)
        setCashImportResult(null)

        // ── 重複偵測：key = 日期|類型|金額|備註 ──
        const existCashSnap = await getDocs(userCol(investDB, 'cashflow'))
        const cashKeys = new Set(existCashSnap.docs.map(d => {
            const c = d.data()
            return `${c.date}|${c.type}|${Number(c.amount)}|${c.note || ''}`
        }))
        let duplicated = 0

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

            const cashKey = `${date}|${cashType}|${Number(amount)}|${note}`
            if (cashKeys.has(cashKey)) { duplicated++; continue }
            cashKeys.add(cashKey)

            try {
                await addDoc(userCol(investDB, 'cashflow'), { date, type: cashType, amount, note })
                success++
            } catch { failed++ }
        }

        invalidateCashflow()   // ✅ 1-1：匯入寫入後清快取
        setCashImportResult({ success, failed, duplicated })
        showMsg(`✅ 出入金匯入完成！成功 ${success} 筆，失敗 ${failed} 筆，重複略過 ${duplicated} 筆`)
        setCashImporting(false)
        e.target.value = ''
    }

    // ── 匯入除權息 CSV ────────────────────────────────────────────────────
    const handleImportDividendCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        setDivImporting(true)
        setDivImportResult(null)

        // ── 重複偵測：key = 日期|代號|現金股利|股票股利 ──
        const existDivSnap = await getDocs(userCol(investDB, 'dividends'))
        const divKeys = new Set(existDivSnap.docs.map(d => {
            const r = d.data()
            return `${r.date}|${r.code}|${Number(r.cashDividend) || 0}|${Number(r.stockDividend) || 0}`
        }))
        let duplicated = 0

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

            const divKey = `${date}|${code}|${Number(cashDividend) || 0}|${Number(stockDividend) || 0}`
            if (divKeys.has(divKey)) { duplicated++; continue }
            divKeys.add(divKey)

            try {
                await addDoc(userCol(investDB, 'dividends'), { date, code, name, cashDividend, stockDividend, note })
                if (name && code) await setDoc(userDoc(investDB, 'stockDict', code), { name })
                success++
            } catch { failed++ }
        }

        invalidateDividends()   // ✅ 1-1：匯入寫入後清快取
        setDivImportResult({ success, failed, duplicated })
        showMsg(`✅ 除權息匯入完成！成功 ${success} 筆，失敗 ${failed} 筆，重複略過 ${duplicated} 筆`)
        setDivImporting(false)
        e.target.value = ''
    }

    // ── 一鍵匯出全部資料（多工作表 Excel）──────────────────────────────
    //    買賣 / 出入金 / 除權息 / 資產趨勢 套用日期區間；股票字典無日期，永遠完整匯出。
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

            const tradesData = tradesSnap.docs
                .filter(d => inRange((d.data() as TradeRow).date))
                .map(d => {
                    const t = d.data() as TradeRow
                    return {
                        'Firestore ID': d.id,
                        '日期': t.date,
                        '類型': t.isMargin ? (t.type === 'buy' ? '融資買入' : '融資賣出') : (t.type === 'buy' ? '買入' : '賣出'),
                        '代號': t.code,
                        '名稱': t.name,
                        '價格': t.price,
                        '股數': t.shares,
                        '手續費': t.fee,
                        '交易稅': t.tax,
                        '收付金額': t.total,
                        '融資成數': t.isMargin ? (t.marginRatio ?? 0.6) : '',
                        '融資償還金額': t.isMargin && t.type === 'sell' ? (t.marginRepay ?? 0) : '',
                        '備註': t.note ?? '',
                    }
                })

            const cashData = cashSnap.docs
                .filter(d => inRange((d.data() as CashflowRow).date))
                .map(d => {
                    const r = d.data() as CashflowRow
                    return {
                        'Firestore ID': d.id,
                        '日期': r.date,
                        '類型': r.type === 'in' ? '入金' : '出金',
                        '金額': r.amount,
                        '備註': r.note ?? '',
                    }
                })

            const dividendsData = dividendsSnap.docs
                .filter(d => inRange((d.data() as DividendRow).date))
                .map(d => {
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

            const snapshotsData = snapshotsSnap.docs
                .filter(d => inRange((d.data() as SnapshotRecord).date))
                .map(d => {
                    const s = d.data() as SnapshotRecord
                    return {
                        '日期': s.date,
                        '總資產': s.totalAssets,
                        '股票市值': s.marketValue,
                        '現金': s.cash,
                        '融資借款': s.marginDebt ?? 0,
                    }
                })

            const rangeLabel = (dateFrom || dateTo) ? `${dateFrom || '最早'} ~ ${dateTo || '最新'}` : '全部'

            const wb = XLSX.utils.book_new()
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tradesData.length ? tradesData : [{}]), '買賣紀錄')
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cashData.length ? cashData : [{}]), '出入金紀錄')
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dividendsData.length ? dividendsData : [{}]), '除權息紀錄')
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dictData.length ? dictData : [{}]), '股票字典')
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(snapshotsData.length ? snapshotsData : [{}]), '資產趨勢')
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
                { '項目': '匯出區間', '筆數': rangeLabel },
                { '項目': '買賣紀錄', '筆數': tradesData.length },
                { '項目': '出入金紀錄', '筆數': cashData.length },
                { '項目': '除權息紀錄', '筆數': dividendsData.length },
                { '項目': '股票字典', '筆數': dictData.length },
                { '項目': '資產趨勢快照', '筆數': snapshotsData.length },
                { '項目': '匯出時間', '筆數': new Date().toLocaleString('zh-TW') },
            ]), '摘要')

            XLSX.writeFile(wb, `投資系統完整備份${rangeSuffix()}.xlsx`)
            showMsg(`✅ 全部資料匯出完成！共 ${tradesData.length + cashData.length + dividendsData.length} 筆紀錄`)
        } catch (err) {
            showMsg('❌ 匯出失敗，請稍後再試')
            console.error(err)
        }
        setFullExportLoading(false)
    }

    // ── 共用：依格式輸出單一工作表 ───────────────────────────────────────────
    const exportRows = (
        rows: Record<string, unknown>[],
        sheetName: string,
        baseName: string,
        format: ExportFormat,
        colWidths?: number[],
    ) => {
        if (format === 'xlsx') {
            const ws = XLSX.utils.json_to_sheet(rows)
            if (colWidths) ws['!cols'] = colWidths.map(w => ({ wch: w }))
            const wb = XLSX.utils.book_new()
            XLSX.utils.book_append_sheet(wb, ws, sheetName)
            XLSX.writeFile(wb, `${baseName}.xlsx`)
        } else {
            downloadCSV(objectsToCSV(rows), `${baseName}.csv`)
        }
    }

    // ── 分項匯出（CSV / Excel，皆套用日期區間）──────────────────────────────
    const exportTrades = async (format: ExportFormat) => {
        setExportLoading(true)
        try {
            const snap = await getDocs(query(userCol(investDB, 'trades'), orderBy('date', 'desc')))
            const trades = snap.docs.map(d => d.data() as TradeRow).filter(t => inRange(t.date))
            if (trades.length === 0) { showMsg('⚠️ 此區間沒有買賣紀錄'); setExportLoading(false); return }
            const rows = trades.map(t => ({
                '日期': t.date,
                '類型': t.isMargin ? (t.type === 'buy' ? '融資買入' : '融資賣出') : (t.type === 'buy' ? '買入' : '賣出'),
                '代號': t.code,
                '名稱': t.name,
                '價格': t.price,
                '股數': t.shares,
                '手續費': t.fee,
                '交易稅': t.tax,
                '收付金額': t.total,
                '融資成數': t.isMargin ? (t.marginRatio ?? 0.6) : '',
                '融資償還金額': t.isMargin && t.type === 'sell' ? (t.marginRepay ?? 0) : '',
                '備註': t.note ?? '',
            }))
            exportRows(rows, '買賣紀錄', `買賣紀錄${rangeSuffix()}`, format,
                [12, 10, 8, 12, 8, 8, 8, 8, 12, 8, 12, 16])
            showMsg(`✅ 已匯出買賣紀錄（${format.toUpperCase()}）共 ${rows.length} 筆`)
        } catch { showMsg('❌ 匯出失敗，請稍後再試') }
        setExportLoading(false)
    }

    const exportCashFlow = async (format: ExportFormat) => {
        setExportLoading(true)
        try {
            const snap = await getDocs(query(userCol(investDB, 'cashflow'), orderBy('date', 'desc')))
            const records = snap.docs.map(d => d.data() as CashflowRow).filter(r => inRange(r.date))
            if (records.length === 0) { showMsg('⚠️ 此區間沒有出入金紀錄'); setExportLoading(false); return }
            const rows = records.map(r => ({
                '日期': r.date,
                '類型': r.type === 'in' ? '入金' : '出金',
                '金額': r.amount,
                '備註': r.note ?? '',
            }))
            exportRows(rows, '出入金紀錄', `出入金紀錄${rangeSuffix()}`, format, [12, 8, 12, 20])
            showMsg(`✅ 已匯出出入金紀錄（${format.toUpperCase()}）共 ${rows.length} 筆`)
        } catch { showMsg('❌ 匯出失敗，請稍後再試') }
        setExportLoading(false)
    }

    const exportDividends = async (format: ExportFormat) => {
        setExportLoading(true)
        try {
            const snap = await getDocs(query(userCol(investDB, 'dividends'), orderBy('date', 'desc')))
            const records = snap.docs.map(d => d.data() as DividendRow).filter(r => inRange(r.date))
            if (records.length === 0) { showMsg('⚠️ 此區間沒有除權息紀錄'); setExportLoading(false); return }
            const rows = records.map(r => ({
                '日期': r.date,
                '代號': r.code,
                '名稱': r.name,
                '現金股利': r.cashDividend,
                '股票股利': r.stockDividend,
                '備註': r.note ?? '',
            }))
            exportRows(rows, '除權息紀錄', `除權息紀錄${rangeSuffix()}`, format, [12, 8, 12, 10, 10, 20])
            showMsg(`✅ 已匯出除權息紀錄（${format.toUpperCase()}）共 ${rows.length} 筆`)
        } catch { showMsg('❌ 匯出失敗，請稍後再試') }
        setExportLoading(false)
    }

    // ── 資產趨勢匯出（CSV / Excel，套用日期區間）─────────────────────────────
    const exportTrend = async (format: ExportFormat) => {
        setTrendExportLoading(true)
        try {
            const snap = await getDocs(query(userCol(investDB, 'assetSnapshots'), orderBy('date', 'asc')))
            const records = snap.docs.map(d => d.data() as SnapshotRecord).filter(r => inRange(r.date))
            if (records.length === 0) { showMsg('⚠️ 此區間沒有資產趨勢資料'); setTrendExportLoading(false); return }
            const rows = records.map(r => ({ '日期': r.date, '總資產': r.totalAssets, '股票市值': r.marketValue, '現金': r.cash, '融資借款': r.marginDebt ?? 0 }))
            exportRows(rows, '資產趨勢', `資產趨勢${rangeSuffix()}`, format, [14, 14, 14, 14, 14])
            showMsg(`✅ 已匯出資產趨勢（${format.toUpperCase()}）共 ${rows.length} 筆`)
        } catch { showMsg('❌ 匯出失敗，請稍後再試') }
        setTrendExportLoading(false)
    }

    const downloadCSV = (csv: string, filename: string) => {
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = filename; a.click()
        URL.revokeObjectURL(url)
    }

    // ── JSON 完整備份／還原 handlers（2-4）────────────────────────────────

    const handleExportJSON = async () => {
        setJsonExportLoading(true)
        try {
            const backup = await buildFullBackup()
            downloadBackup(backup)
            showMsg(`✅ JSON 完整備份匯出完成！共 ${countBackupDocs(backup)} 筆文件`)
        } catch (err) {
            console.error('[backup] export failed:', err)
            showMsg('❌ JSON 備份匯出失敗，請稍後再試')
        }
        setJsonExportLoading(false)
    }

    const handlePickRestoreFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = (evt) => {
            try {
                const backup = parseBackup(String(evt.target?.result ?? ''))
                let mismatch = false
                try { mismatch = !!backup.uid && backup.uid !== getUID() } catch { /* 未登入時不判斷 */ }
                setRestoreUidMismatch(mismatch)
                setRestoreProgress(0)
                setRestorePreview(backup)   // 顯示預覽面板，等使用者按「確認還原」
            } catch (err) {
                showMsg(`❌ ${err instanceof Error ? err.message : '備份檔讀取失敗'}`)
            }
            e.target.value = ''
        }
        reader.onerror = () => { showMsg('❌ 備份檔讀取失敗'); e.target.value = '' }
        reader.readAsText(file)
    }

    const handleConfirmRestore = async () => {
        if (!restorePreview || restoring) return
        setRestoring(true)
        setRestoreProgress(0)
        try {
            const res = await restoreFullBackup(restorePreview, (done, total) => {
                setRestoreProgress(total > 0 ? Math.round((done / total) * 100) : 100)
            })
            showMsg(`✅ 還原完成！寫入 ${res.written} 筆${res.skipped > 0 ? `，略過 ${res.skipped} 筆異常資料` : ''}。建議重新整理頁面以載入最新資料。`)
            setRestorePreview(null)
        } catch (err) {
            console.error('[backup] restore failed:', err)
            showMsg('❌ 還原中途失敗。已寫入的批次不會回復；備份還原可重複執行，請直接再試一次即可補齊。')
        }
        setRestoring(false)
    }

    const handleCancelRestore = () => {
        if (restoring) return
        setRestorePreview(null)
        setRestoreProgress(0)
    }

    const today = () => new Date().toISOString().split('T')[0]

    // 共用小元件：分項匯出列（標籤 + CSV / Excel 兩顆按鈕）
    const ExportRowItem = ({ label, color, onExport }: { label: string; color: string; onExport: (f: ExportFormat) => void }) => (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '8px 0', borderBottom: '1px solid var(--c-border)' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--c-text)' }}>{label}</span>
            <div style={{ display: 'flex', gap: '8px' }}>
                <button style={{ ...btn(color), padding: '6px 12px', fontSize: '12px', opacity: exportLoading ? 0.6 : 1 }} onClick={() => onExport('csv')} disabled={exportLoading}>
                    <Download size={13} />CSV
                </button>
                <button style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)', padding: '6px 12px', fontSize: '12px', color: 'var(--c-text)', opacity: exportLoading ? 0.6 : 1 }} onClick={() => onExport('xlsx')} disabled={exportLoading}>
                    <FileSpreadsheet size={13} />Excel
                </button>
            </div>
        </div>
    )

    const inputStyle: React.CSSProperties = { backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '8px 10px', color: 'var(--c-text)', fontSize: '13px', outline: 'none', colorScheme: 'dark' }
    const chip = (active: boolean): React.CSSProperties => ({ backgroundColor: active ? 'var(--c-accent)' : 'var(--c-bg)', border: `1px solid ${active ? 'var(--c-accent)' : 'var(--c-border)'}`, borderRadius: '20px', padding: '5px 12px', color: active ? '#fff' : 'var(--c-muted)', fontSize: '12px', cursor: 'pointer' })

    const thisYear = `${new Date().getFullYear()}`
    const isThisYearPreset = dateFrom === `${thisYear}-01-01` && dateTo === `${thisYear}-12-31`

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
                            {tradeImportResult.duplicated > 0 && <div><div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>重複略過</div><div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--c-warning)' }}>{tradeImportResult.duplicated}</div></div>}
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
                            {divImportResult.duplicated > 0 && <div><div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>重複略過</div><div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--c-warning)' }}>{divImportResult.duplicated}</div></div>}
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
                            {cashImportResult.duplicated > 0 && <div><div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>重複略過</div><div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--c-warning)' }}>{cashImportResult.duplicated}</div></div>}
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

            {/* ── 匯出區 ── */}
            <div style={{ marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Download size={15} color="var(--c-muted)" />
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--c-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>匯出報表</span>
            </div>

            {/* 日期區間選擇器（套用到下方所有匯出，留空＝不限） */}
            <div style={{ ...card, marginBottom: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                    <Calendar size={16} color="var(--c-accent)" />
                    <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>匯出日期區間</span>
                    <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>套用於下方所有匯出（含完整備份），留空＝不限</span>
                </div>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <input type="date" value={dateFrom} max={dateTo || undefined} onChange={e => setDateFrom(e.target.value)} style={inputStyle} />
                    <span style={{ color: 'var(--c-muted)', fontSize: '13px' }}>～</span>
                    <input type="date" value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)} style={inputStyle} />
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginLeft: '4px' }}>
                        <button style={chip(!dateFrom && !dateTo)} onClick={clearRange}>全部</button>
                        <button style={chip(isThisYearPreset)} onClick={setPresetThisYear}>今年</button>
                        <button style={chip(false)} onClick={setPresetLastYear}>近一年</button>
                    </div>
                </div>
                {(dateFrom || dateTo) && (
                    <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--c-muted)' }}>
                        目前區間：<span style={{ color: 'var(--c-accent)', fontWeight: 600 }}>{dateFrom || '最早'} ～ {dateTo || '最新'}</span>
                    </div>
                )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '14px' }}>

                {/* 完整備份 */}
                <div style={{ ...card, border: '1px solid var(--c-accent)', background: 'linear-gradient(135deg, var(--c-sidebar) 0%, var(--c-card) 100%)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <Database size={16} color="var(--c-accent)" />
                        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>完整備份</span>
                        <span style={{ fontSize: '11px', backgroundColor: 'rgba(79,142,247,0.2)', color: 'var(--c-accent)', padding: '1px 7px', borderRadius: '20px' }}>xlsx 多工作表</span>
                    </div>
                    <p style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '14px', lineHeight: 1.6 }}>
                        買賣紀錄、出入金、除權息、股票字典全部一次匯出，含 Firestore ID 方便核查錯誤資料。股票字典不受日期區間限制。
                    </p>
                    <button style={{ ...btn('var(--c-accent)'), opacity: fullExportLoading ? 0.6 : 1, fontSize: '13px' }} onClick={exportAllData} disabled={fullExportLoading}>
                        <FileDown size={14} />{fullExportLoading ? '匯出中...' : '匯出完整備份 (.xlsx)'}
                    </button>
                </div>

                {/* ── JSON 完整備份／還原（2-4：災難復原）── */}
                <div style={{ ...card, border: '1px solid var(--c-positive)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <FileJson size={16} color="var(--c-positive)" />
                        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>JSON 完整備份</span>
                        <span style={{ fontSize: '11px', backgroundColor: 'color-mix(in srgb, var(--c-positive) 15%, transparent)', color: 'var(--c-positive)', padding: '1px 7px', borderRadius: '20px' }}>災難復原</span>
                    </div>
                    <p style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '14px', lineHeight: 1.6 }}>
                        全系統資料打包成單一 JSON：投資紀錄、族群分類等全部設定、情緒／賣出追蹤、選股、產業地圖、行事曆、任務，以及 <strong style={{ color: 'var(--c-positive)' }}>KMS 筆記與回收桶</strong>。
                        不受上方日期區間影響、永遠全量匯出。還原以文件 ID 覆蓋（可重複執行、不產生重複資料）。KMS 圖片存於雲端 Storage，不在備份範圍。
                    </p>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button style={{ ...btn('var(--c-positive)'), fontSize: '13px', opacity: jsonExportLoading ? 0.6 : 1 }} onClick={handleExportJSON} disabled={jsonExportLoading}>
                            <FileDown size={14} />{jsonExportLoading ? '匯出中...' : '匯出 JSON 備份'}
                        </button>
                        <label style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)', color: 'var(--c-text)', cursor: restoring ? 'not-allowed' : 'pointer', fontSize: '13px', opacity: restoring ? 0.6 : 1, width: 'fit-content' }}>
                            <Upload size={14} />從 JSON 還原
                            <input type="file" accept=".json,application/json" onChange={handlePickRestoreFile} disabled={restoring} style={{ display: 'none' }} />
                        </label>
                    </div>

                    {restorePreview && (
                        <div style={{ marginTop: '14px', border: '1px solid var(--c-warning)', borderRadius: '10px', padding: '14px', backgroundColor: 'color-mix(in srgb, var(--c-warning) 6%, transparent)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px', color: 'var(--c-warning)', fontSize: '13px', fontWeight: 700 }}>
                                <AlertTriangle size={14} />還原前確認
                            </div>
                            <div style={{ fontSize: '12px', color: 'var(--c-muted)', lineHeight: 1.7, marginBottom: '10px' }}>
                                備份時間：{restorePreview.exportedAt ? new Date(restorePreview.exportedAt).toLocaleString('zh-TW') : '未知'}
                                {restoreUidMismatch && (
                                    <span style={{ display: 'block', color: 'var(--c-warning)', fontWeight: 600 }}>
                                        ⚠ 此備份來自其他帳號，確認後將還原到「目前登入」的帳號。
                                    </span>
                                )}
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
                                {backupSummary(restorePreview).map(s => (
                                    <span key={s.label} style={{ fontSize: '11px', backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '20px', padding: '3px 10px', color: 'var(--c-text)' }}>
                                        {s.label} {s.count}
                                    </span>
                                ))}
                            </div>
                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', lineHeight: 1.7, marginBottom: '12px' }}>
                                還原規則：同 ID 文件以備份內容覆蓋、備份外的既有資料保留不動（不會刪除任何資料）。
                            </div>
                            <div style={{ display: 'flex', gap: '8px' }}>
                                <button style={{ ...btn('var(--c-warning)'), fontSize: '13px', opacity: restoring ? 0.6 : 1 }} onClick={handleConfirmRestore} disabled={restoring}>
                                    {restoring ? `還原中… ${restoreProgress}%` : '確認還原'}
                                </button>
                                <button style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)', color: 'var(--c-text)', fontSize: '13px', opacity: restoring ? 0.6 : 1 }} onClick={handleCancelRestore} disabled={restoring}>
                                    取消
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {/* 分項匯出（CSV / Excel） */}
                <div style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <Download size={16} color="var(--c-warning)" />
                        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>分項匯出</span>
                        <span style={{ fontSize: '11px', backgroundColor: 'rgba(245,166,35,0.15)', color: 'var(--c-warning)', padding: '1px 7px', borderRadius: '20px' }}>CSV / Excel</span>
                    </div>
                    <p style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>各類紀錄可單獨匯出，中文字符完整顯示。</p>
                    <div>
                        <ExportRowItem label="買賣紀錄" color="var(--c-accent)" onExport={exportTrades} />
                        <ExportRowItem label="出入金紀錄" color="var(--c-positive)" onExport={exportCashFlow} />
                        <div style={{ borderBottom: 'none' }}>
                            <ExportRowItem label="除權息紀錄" color="var(--c-warning)" onExport={exportDividends} />
                        </div>
                    </div>
                </div>

                {/* 資產趨勢匯出（CSV / Excel） */}
                <div style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <Download size={16} color="var(--c-positive)" />
                        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>資產趨勢</span>
                        <span style={{ fontSize: '11px', backgroundColor: 'color-mix(in srgb, var(--c-positive) 15%, transparent)', color: 'var(--c-positive)', padding: '1px 7px', borderRadius: '20px' }}>CSV / xlsx</span>
                    </div>
                    <p style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '14px', lineHeight: 1.6 }}>
                        匯出資產快照紀錄（日期、總資產、股票市值、現金），完整備份也已包含此資料。
                    </p>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button style={{ ...btn('var(--c-positive)'), fontSize: '13px', opacity: trendExportLoading ? 0.6 : 1 }} onClick={() => exportTrend('csv')} disabled={trendExportLoading}>
                            <Download size={14} />CSV
                        </button>
                        <button style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)', fontSize: '13px', color: 'var(--c-text)', opacity: trendExportLoading ? 0.6 : 1 }} onClick={() => exportTrend('xlsx')} disabled={trendExportLoading}>
                            <FileSpreadsheet size={14} />Excel
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}