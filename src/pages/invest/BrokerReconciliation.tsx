import { useEffect, useMemo, useRef, useState } from 'react'
import DisclosureNote from '../../components/DisclosureNote'
import { AlertTriangle, CheckCircle2, FileSearch, History, Image, Loader, Plus, RefreshCw, Save, ShieldCheck, Trash2, Upload } from 'lucide-react'
import { fetchCashflow, fetchDividends, fetchTrades } from '../../lib/investData'
import { calcAvailableCash, calcPositions, estimateMarginRepayment, type DividendRecord, type TradeRecord } from '../../lib/calc'
import { countBrokerTradeCandidates, extractBrokerStatementPeriod, isYuantaMonthlyStatement, parseBrokerStatementText, reconcileBrokerTrades, reconciliationGroupKey, resolveBrokerTradeCodes, verifyBrokerStatementTotals, type BrokerTradeRow, type ReconciliationMode, type ReconciliationStatus } from '../../lib/brokerReconciliation'
import { combinedBrokerHoldings, parseYuantaMonthlyDetails, reconcileMonthlyCash, reconcileMonthlyDividends, reconcileMonthlyHoldings, resolveBrokerDividendCodes, type BrokerMonthlyDetails, type MonthlyCheckStatus } from '../../lib/brokerMonthlyReconciliation'
import { fetchReconciliationReports, saveReconciliationReport, type ReconciliationSuggestion, type SavedReconciliationReport } from '../../lib/reconciliationStore'
import { readBrokerDocuments } from '../../lib/brokerDocumentReader'
import { useInvestSync } from '../../InvestSyncContext'
import { btn, card, inp, lbl } from '../../ui/styles'

const statusMeta: Record<ReconciliationStatus, { label: string; color: string }> = {
    matched: { label: '一致', color: 'var(--c-positive)' },
    mismatch: { label: '資料不同', color: 'var(--c-warning)' },
    'missing-system': { label: '系統缺少', color: 'var(--c-negative)' },
    'missing-broker': { label: '對帳單缺少', color: 'var(--c-negative)' },
    'coverage-unknown': { label: '截圖未涵蓋', color: 'var(--c-muted)' },
}

const monthlyStatusMeta: Record<MonthlyCheckStatus, { label: string; color: string }> = {
    matched: { label: '一致', color: 'var(--c-positive)' },
    mismatch: { label: '資料不同', color: 'var(--c-warning)' },
    'missing-system': { label: '系統缺少', color: 'var(--c-negative)' },
    'missing-broker': { label: '對帳單缺少', color: 'var(--c-negative)' },
    'pending-broker': { label: '尚未在券商入帳', color: 'var(--c-muted)' },
}

const emptyMonthlyDetails: BrokerMonthlyDetails = { holdings: [], dividends: [] }

// Intentionally kept only in JavaScript memory: survives route changes in this tab,
// but is cleared by refresh/close and is never serialized to browser storage.
let rememberedPdfPassword = ''

function localDate(offsetDays = 0): string {
    const date = new Date()
    date.setDate(date.getDate() + offsetDays)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

function monthStart(): string {
    const date = new Date()
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`
}

function normalizeSystemTrade(trade: TradeRecord): TradeRecord {
    const rawType = trade.type as string
    if (rawType === 'spot_buy') return { ...trade, type: 'buy', isMargin: false }
    if (rawType === 'spot_sell') return { ...trade, type: 'sell', isMargin: false }
    if (rawType === 'margin_buy') return { ...trade, type: 'buy', isMargin: true }
    if (rawType === 'margin_sell') return { ...trade, type: 'sell', isMargin: true }
    return trade
}

function BrokerTradeEditor({ row, onUpdate, onDelete }: {
    row: BrokerTradeRow
    onUpdate: (id: string, key: keyof BrokerTradeRow, value: BrokerTradeRow[keyof BrokerTradeRow]) => void
    onDelete: (id: string) => void
}) {
    const fieldStyle = { ...inp, padding: '7px 9px', minWidth: 0 }
    return <div style={{ border: '1px solid var(--c-border)', borderRadius: '9px', padding: '11px', display: 'grid', gap: '9px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}><strong>{row.date}・{row.code || '代號未辨識'} {row.name}</strong><button type="button" aria-label="刪除這列" onClick={() => onDelete(row.id)} style={{ background: 'none', border: 'none', color: 'var(--c-negative)', cursor: 'pointer' }}><Trash2 size={15} /></button></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: '8px' }}>
            <label style={lbl}>日期<input type="date" value={row.date} onChange={event => onUpdate(row.id, 'date', event.target.value)} style={fieldStyle} /></label>
            <label style={lbl}>買賣<select value={row.type} onChange={event => onUpdate(row.id, 'type', event.target.value as 'buy' | 'sell')} style={fieldStyle}><option value="buy">買進</option><option value="sell">賣出</option></select></label>
            <label style={lbl}>代號<input value={row.code} onChange={event => onUpdate(row.id, 'code', event.target.value.toUpperCase())} style={fieldStyle} /></label>
            <label style={lbl}>名稱<input value={row.name} onChange={event => onUpdate(row.id, 'name', event.target.value)} style={fieldStyle} /></label>
            <label style={lbl}>成交價<input type="number" value={row.price} onChange={event => onUpdate(row.id, 'price', Number(event.target.value))} style={fieldStyle} /></label>
            <label style={lbl}>股數<input type="number" value={row.shares} onChange={event => onUpdate(row.id, 'shares', Number(event.target.value))} style={fieldStyle} /></label>
        </div>
        <details style={{ fontSize: '12px', color: 'var(--c-muted)' }}><summary style={{ cursor: 'pointer' }}>淨收付、手續費與交易稅</summary><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: '8px', marginTop: '8px' }}>
            <label style={lbl}>淨收付<input type="number" value={row.total ?? ''} onChange={event => onUpdate(row.id, 'total', event.target.value === '' ? undefined : Number(event.target.value))} style={fieldStyle} /></label>
            <label style={lbl}>手續費<input type="number" value={row.fee ?? ''} onChange={event => onUpdate(row.id, 'fee', event.target.value === '' ? undefined : Number(event.target.value))} style={fieldStyle} /></label>
            <label style={lbl}>交易稅<input type="number" value={row.tax ?? ''} onChange={event => onUpdate(row.id, 'tax', event.target.value === '' ? undefined : Number(event.target.value))} style={fieldStyle} /></label>
        </div></details>
    </div>
}

function ReconciliationModeButtons({ value, onChange }: {
    value: ReconciliationMode
    onChange: (value: ReconciliationMode) => void
}) {
    return (
        <div role="group" aria-label="核對類型" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px', maxWidth: '620px' }}>
            {([
                { value: 'interim' as const, title: '月中截圖', note: '暫時核對' },
                { value: 'monthly' as const, title: 'PDF 總對帳單', note: '正式月結' },
            ]).map(option => {
                const selected = value === option.value
                return (
                    <button
                        key={option.value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onChange(option.value)}
                        style={{
                            minHeight: '50px', padding: '8px 12px', borderRadius: '9px', cursor: 'pointer',
                            border: `1px solid ${selected ? 'var(--c-accent)' : 'var(--c-border)'}`,
                            backgroundColor: selected ? 'color-mix(in srgb, var(--c-accent) 15%, transparent)' : 'var(--c-bg)',
                            color: selected ? 'var(--c-accent)' : 'var(--c-muted)',
                            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px',
                        }}
                    >
                        <span style={{ fontWeight: 700 }}>{option.title}</span>
                        <span style={{ fontSize: '11px', opacity: 0.85 }}>{option.note}</span>
                    </button>
                )
            })}
        </div>
    )
}

export default function BrokerReconciliation() {
    const { version: syncVersion } = useInvestSync()
    const fileRef = useRef<HTMLInputElement>(null)
    const [mode, setMode] = useState<ReconciliationMode>('interim')
    const [dateFrom, setDateFrom] = useState(monthStart())
    const [dateTo, setDateTo] = useState(localDate())
    const [files, setFiles] = useState<File[]>([])
    const [rawText, setRawText] = useState('')
    const [brokerRows, setBrokerRows] = useState<BrokerTradeRow[]>([])
    const [systemRows, setSystemRows] = useState<TradeRecord[]>([])
    const [dividends, setDividends] = useState<DividendRecord[]>([])
    const [cashflows, setCashflows] = useState<Array<{ date: string; type: string; amount: number }>>([])
    const [monthlyDetails, setMonthlyDetails] = useState<BrokerMonthlyDetails>(emptyMonthlyDetails)
    const [savedReports, setSavedReports] = useState<SavedReconciliationReport[]>([])
    const [savingReport, setSavingReport] = useState(false)
    const [saveMessage, setSaveMessage] = useState('')
    const [reading, setReading] = useState(false)
    const [progress, setProgress] = useState({ message: '', progress: 0 })
    const [error, setError] = useState('')
    const [parseWarning, setParseWarning] = useState('')
    const [pdfPassword, setPdfPassword] = useState(rememberedPdfPassword)
    const [rememberPassword, setRememberPassword] = useState(true)

    const hasPdf = useMemo(
        () => files.some(file => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')),
        [files],
    )

    useEffect(() => {
        void Promise.all([
            fetchTrades<TradeRecord>('asc'),
            fetchDividends<DividendRecord>('asc'),
            fetchCashflow<{ date: string; type: string; amount: number }>('asc'),
            fetchReconciliationReports().catch(() => []),
        ]).then(([trades, dividendRows, cashRows, reports]) => {
            setSystemRows(trades.map(normalizeSystemTrade))
            setDividends(dividendRows)
            setCashflows(cashRows)
            setSavedReports(reports)
        })
    }, [syncVersion])

    const scopedSystemRows = useMemo(
        () => systemRows.filter(row => row.date >= dateFrom && row.date <= dateTo).map(row => {
            if (!row.isMargin || row.type !== 'sell') return row
            const estimate = estimateMarginRepayment(row, systemRows, dividends)
            const principal = row.marginPrincipal ?? estimate.principal
            return {
                ...row,
                marginPrincipal: principal,
                // 舊資料可能把同日分筆的本金與利息交叉分配；此處允許單筆為負，
                // 彙整同日同股後會回到正確的總利息。
                marginInterest: row.marginInterest ?? (row.marginRepay !== undefined ? row.marginRepay - principal : undefined),
            }
        }),
        [systemRows, dividends, dateFrom, dateTo],
    )
    const scopedBrokerRows = useMemo(
        () => resolveBrokerTradeCodes(brokerRows.filter(row => row.date >= dateFrom && row.date <= dateTo), systemRows),
        [brokerRows, systemRows, dateFrom, dateTo],
    )
    const results = useMemo(
        () => reconcileBrokerTrades(scopedBrokerRows, scopedSystemRows, mode),
        [scopedBrokerRows, scopedSystemRows, mode],
    )
    const summary = useMemo(() => results.reduce<Record<ReconciliationStatus, number>>((acc, row) => {
        acc[row.status] += 1
        return acc
    }, { matched: 0, mismatch: 0, 'missing-system': 0, 'missing-broker': 0, 'coverage-unknown': 0 }), [results])

    const datedSystemRows = useMemo(() => systemRows.filter(row => row.date <= dateTo), [systemRows, dateTo])
    const systemHoldings = useMemo(() => calcPositions(datedSystemRows, dividends, { asOf: dateTo }).holdings, [datedSystemRows, dividends, dateTo])
    const holdingChecks = useMemo(() => reconcileMonthlyHoldings(combinedBrokerHoldings(monthlyDetails), systemHoldings), [monthlyDetails, systemHoldings])
    const resolvedBrokerDividends = useMemo(
        () => resolveBrokerDividendCodes(monthlyDetails.dividends, dividends, monthlyDetails.holdings),
        [monthlyDetails.dividends, monthlyDetails.holdings, dividends],
    )
    const dividendChecks = useMemo(
        () => reconcileMonthlyDividends(resolvedBrokerDividends, dividends, dateFrom, dateTo),
        [resolvedBrokerDividends, dividends, dateFrom, dateTo],
    )
    const incompleteBrokerRows = useMemo(() => brokerRows.filter(row => !row.date || !row.code || !row.name || row.price <= 0 || row.shares <= 0), [brokerRows])
    const tradeIssues = useMemo(() => results.filter(row => row.status !== 'matched'), [results])
    const matchedTradeResults = useMemo(() => results.filter(row => row.status === 'matched'), [results])
    const holdingIssues = useMemo(() => holdingChecks.filter(row => row.status !== 'matched'), [holdingChecks])
    const dividendIssues = useMemo(() => dividendChecks.filter(row => row.status !== 'matched'), [dividendChecks])
    const systemProjectedCash = useMemo(() => calcAvailableCash(
        cashflows.filter(row => row.date <= dateTo),
        datedSystemRows,
        dividends,
        dateTo,
    ), [cashflows, datedSystemRows, dividends, dateTo])
    const cashCheck = useMemo(
        () => reconcileMonthlyCash(monthlyDetails.cashBalance, systemProjectedCash, dateTo, scopedBrokerRows),
        [monthlyDetails.cashBalance, systemProjectedCash, dateTo, scopedBrokerRows],
    )
    const suggestions = useMemo<ReconciliationSuggestion[]>(() => {
        const next: ReconciliationSuggestion[] = []
        if (cashCheck.status === 'unavailable') next.push({ category: 'cash', severity: 'warning', message: '未讀取到 CMA 月底結餘，本月現金尚未完成核對。' })
        if (!monthlyDetails.holdings.length) next.push({ category: 'holding', severity: 'warning', message: '未讀取到庫存明細，請確認完整 PDF；不能視為零庫存或核對完成。' })
        if (monthlyDetails.lendingVerified === false) next.push({ category: 'holding', severity: 'warning', message: '出借庫存尚無法與出借市值相互驗證，需檢查有價證券借貸頁。' })
        if (parseWarning) next.push({ category: 'trade', severity: 'warning', message: parseWarning })
        const income = (monthlyDetails.cashEntries ?? []).filter(row => row.category === 'interest' || row.category === 'lending-income')
        if (income.length) next.push({ category: 'cash', severity: 'warning', message: `CMA 有 ${income.length} 筆出借收入／存款利息，共 ${income.reduce((sum, row) => sum + row.amount, 0).toLocaleString()} 元。請核對收益是否已記錄；此類收入不屬於外部入金，請勿用補入金代替。` })
        results.filter(row => row.status !== 'matched' && row.status !== 'coverage-unknown').forEach(row => {
            const source = row.broker ?? row.system
            if (row.marginCorrection) {
                const correction = row.marginCorrection
                next.push({
                    category: 'margin', severity: 'warning',
                    message: correction.brokerPrincipal !== undefined
                        ? `${source?.date ?? ''} ${source?.code ?? ''}：請依券商明細修正本金為 ${correction.brokerPrincipal.toLocaleString()} 元${correction.brokerInterest !== undefined ? `、利息為 ${Math.round(correction.brokerInterest).toLocaleString()} 元` : ''}；償還總額為 ${correction.brokerRepay.toLocaleString()} 元。`
                        : `${source?.date ?? ''} ${source?.code ?? ''}：建議將融資償還總額由 ${Math.round(correction.systemRepay).toLocaleString()} 元修正為 ${Math.round(correction.brokerRepay).toLocaleString()} 元${correction.brokerInterest !== undefined ? `（券商利息 ${Math.round(correction.brokerInterest).toLocaleString()} 元）` : ''}，並核對本金與利息拆分。`,
                })
            } else {
                next.push({ category: 'trade', severity: 'danger', message: `${source?.date ?? ''} ${source?.code ?? ''} ${row.differences.join('；')}`.trim() })
            }
        })
        if (cashCheck.status === 'mismatch') next.push({ category: 'cash', severity: 'danger', message: `CMA 月底餘額與系統交割口徑相差 ${(cashCheck.difference ?? 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 })} 元，請檢查出入金、股利或未交割款。` })
        holdingChecks.filter(row => row.status !== 'matched').forEach(row => next.push({
            category: 'holding', severity: 'warning',
            message: `${row.code} ${row.name}：券商 ${row.brokerShares?.toLocaleString() ?? '無'} 股／系統 ${row.systemShares?.toLocaleString() ?? '無'} 股${row.difference < 0 ? '；若有出借股票，請先確認是否屬於券商庫存未顯示。' : ''}`,
        }))
        dividendChecks.filter(row => row.status !== 'matched').forEach(row => next.push({
            category: 'dividend', severity: 'warning',
            message: row.status === 'pending-broker'
                ? `${row.date} ${row.code || row.name}：系統已記錄 ${row.systemAmount?.toLocaleString() ?? '—'} 元，但尚未在本月 CMA 入帳，請於後續月份確認。`
                : `${row.date} ${row.code || row.name}：券商股利 ${row.brokerAmount?.toLocaleString() ?? '無'} 元／系統 ${row.systemAmount?.toLocaleString() ?? '無'} 元。`,
        }))
        return next
    }, [results, cashCheck, holdingChecks, dividendChecks, monthlyDetails, parseWarning])

    const parseText = (text = rawText) => {
        if ((text.match(/對帳單期間\s*[:：]/g) ?? []).length > 1) {
            setBrokerRows([])
            setMonthlyDetails(emptyMonthlyDetails)
            setParseWarning('一次請核對一份完整月份的 PDF；多份月結混合會使 CMA、庫存與期間無法正確對應。')
            setSaveMessage('')
            return
        }
        const parsed = parseBrokerStatementText(text)
        const candidateCount = countBrokerTradeCandidates(text)
        const isMonthlyStatement = isYuantaMonthlyStatement(text)
        const statementPeriod = extractBrokerStatementPeriod(text)
        if (isMonthlyStatement) setMode('monthly')
        if (statementPeriod) {
            setDateFrom(statementPeriod.from)
            setDateTo(statementPeriod.to)
        }
        setMonthlyDetails(isMonthlyStatement ? parseYuantaMonthlyDetails(text) : emptyMonthlyDetails)
        setSaveMessage('')
        setBrokerRows(resolveBrokerTradeCodes(parsed, systemRows))
        setParseWarning(candidateCount > parsed.length
            ? isMonthlyStatement
                ? `交易明細共有 ${candidateCount} 筆，目前完整解析 ${parsed.length} 筆；另有 ${candidateCount - parsed.length} 筆格式需要人工確認，請查看下方辨識文字。`
                : `偵測到 ${candidateCount} 個可能的交易區塊，但只完整解析 ${parsed.length} 筆。可能有 ${candidateCount - parsed.length} 筆被畫面底部截斷，請再補一張向下滾動後的截圖。`
            : isMonthlyStatement ? verifyBrokerStatementTotals(text, parsed).join('；') : '')
        if (parsed.length === 0) {
            setError('找不到可確認的成交列。請檢查截圖是否包含日期、買賣、代號、價格及股數，或直接修正下方辨識文字。')
        } else {
            setError('')
        }
    }

    const handleRead = async () => {
        if (files.length === 0) {
            setError('請先選擇截圖或 PDF 對帳單。')
            return
        }
        setReading(true)
        setError('')
        setProgress({ message: '準備讀取檔案', progress: 0 })
        try {
            const text = await readBrokerDocuments(
                files,
                next => setProgress({ message: next.message, progress: next.progress ?? 0 }),
                { pdfPassword: pdfPassword || undefined },
            )
            setRawText(text)
            parseText(text)
            if (hasPdf) {
                if (rememberPassword) {
                    rememberedPdfPassword = pdfPassword
                } else {
                    rememberedPdfPassword = ''
                    setPdfPassword('')
                }
            }
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : '檔案辨識失敗')
        } finally {
            setReading(false)
        }
    }

    const updateRow = <K extends keyof BrokerTradeRow>(id: string, key: K, value: BrokerTradeRow[K]) => {
        setBrokerRows(rows => rows.map(row => row.id === id ? { ...row, [key]: value } : row))
    }

    const addManualRow = () => {
        setBrokerRows(rows => [...rows, {
            id: `manual-${Date.now()}`,
            date: dateTo,
            type: 'buy',
            code: '',
            name: '',
            price: 0,
            shares: 0,
            rawText: '人工更正',
        }])
    }

    const handleSaveReport = async () => {
        if (mode !== 'monthly' || brokerRows.length === 0) return
        const statementPeriod = extractBrokerStatementPeriod(rawText)
        if (parseWarning || !statementPeriod || statementPeriod.from !== dateFrom || statementPeriod.to !== dateTo) {
            setSaveMessage('保存失敗：請先完整解析單月對帳單，並使用該對帳單的原始起迄日期。')
            return
        }
        setSavingReport(true)
        setSaveMessage('')
        try {
            const saved = await saveReconciliationReport({
                periodStart: dateFrom,
                periodEnd: dateTo,
                sourceFiles: files.map(file => file.name),
                tradeSystemCount: scopedSystemRows.length,
                tradeBrokerCount: scopedBrokerRows.length,
                tradeGroupCount: results.length,
                tradeMatchedGroups: summary.matched,
                cashStatus: cashCheck.status,
                holdingMatched: holdingChecks.filter(row => row.status === 'matched').length,
                holdingIssues: holdingChecks.filter(row => row.status !== 'matched').length,
                dividendMatched: dividendChecks.filter(row => row.status === 'matched').length,
                dividendIssues: dividendChecks.filter(row => row.status !== 'matched').length,
                suggestions,
            })
            setSavedReports(reports => [saved, ...reports.filter(report => report.id !== saved.id)])
            setSaveMessage(`已保存 ${dateTo.slice(0, 7)} 月結結果；不包含 PDF 原文與密碼。`)
        } catch (reason) {
            setSaveMessage(reason instanceof Error ? `保存失敗：${reason.message}` : '保存失敗')
        } finally {
            setSavingReport(false)
        }
    }

    return (
        <div style={{ padding: 'clamp(14px, 3vw, 24px)', maxWidth: '1280px', margin: '0 auto' }}>
            <div style={{ marginBottom: '20px' }}>
                <h1 style={{ margin: 0, fontSize: '24px', display: 'flex', alignItems: 'center', gap: '10px' }}><FileSearch size={24} />對帳核對</h1>
                
            </div>

            <section style={{ ...card, marginBottom: '16px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', alignItems: 'end' }}>
                    <div style={{ gridColumn: '1 / -1' }}>
                        <label style={lbl}>核對類型</label>
                        <ReconciliationModeButtons value={mode} onChange={setMode} />
                    </div>
                    <div><label style={lbl}>開始日期</label><input type="date" value={dateFrom} onChange={event => setDateFrom(event.target.value)} style={inp} /></div>
                    <div><label style={lbl}>結束日期</label><input type="date" value={dateTo} onChange={event => setDateTo(event.target.value)} style={inp} /></div>
                </div>

                <div style={{ marginTop: '16px', border: '1px dashed var(--c-border)', borderRadius: '10px', padding: '18px', display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
                    <input ref={fileRef} type="file" accept="image/*,.pdf,application/pdf" multiple hidden onChange={event => {
                        const selected = Array.from(event.target.files ?? [])
                        setFiles(selected)
                        if (selected.some(file => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) setMode('monthly')
                    }} />
                    <button type="button" onClick={() => fileRef.current?.click()} style={btn('var(--c-accent)')}><Upload size={16} />選擇截圖或 PDF</button>
                    <div style={{ flex: 1, minWidth: '220px', color: files.length ? 'var(--c-text)' : 'var(--c-muted)', fontSize: '13px' }}>
                        {files.length ? `已選擇 ${files.length} 個檔案：${files.map(file => file.name).join('、')}` : '可選擇多張 JPG、PNG 截圖，或一份 PDF'}
                    </div>
                    <button type="button" disabled={reading || files.length === 0} onClick={() => void handleRead()} style={{ ...btn(reading ? 'var(--c-muted)' : 'var(--c-positive)'), opacity: reading || files.length === 0 ? 0.65 : 1 }}>
                        {reading ? <Loader size={16} className="spin" /> : <Image size={16} />}{reading ? '辨識中' : '讀取並核對'}
                    </button>
                </div>

                {hasPdf && <div style={{ marginTop: '12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', alignItems: 'end' }}>
                    <div>
                        <label style={lbl}>PDF 對帳單密碼（如有）</label>
                        <input
                            type="password"
                            value={pdfPassword}
                            onChange={event => setPdfPassword(event.target.value)}
                            autoComplete="off"
                            placeholder="請輸入 PDF 開啟密碼"
                            style={inp}
                        />
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--c-muted)', fontSize: '12px', paddingBottom: '9px', cursor: 'pointer' }}>
                        <input
                            type="checkbox"
                            checked={rememberPassword}
                            onChange={event => {
                                setRememberPassword(event.target.checked)
                                if (!event.target.checked) rememberedPdfPassword = ''
                            }}
                        />
                        只在目前分頁的記憶體中記住（重新整理或關閉後清除）
                    </label>
                </div>}

                {reading && <div style={{ marginTop: '12px' }}>
                    <div style={{ color: 'var(--c-muted)', fontSize: '12px', marginBottom: '5px' }}>{progress.message}</div>
                    <div style={{ height: '6px', background: 'var(--c-bg)', borderRadius: '6px', overflow: 'hidden' }}><div style={{ height: '100%', width: `${Math.max(3, progress.progress * 100)}%`, background: 'var(--c-accent)', transition: 'width .2s' }} /></div>
                </div>}
                {error && <div role="alert" style={{ marginTop: '12px', color: 'var(--c-negative)', fontSize: '13px', display: 'flex', gap: '7px' }}><AlertTriangle size={16} />{error}</div>}
                {parseWarning && <div role="status" style={{ marginTop: '12px', color: 'var(--c-warning)', fontSize: '13px', display: 'flex', gap: '7px' }}><AlertTriangle size={16} style={{ flexShrink: 0 }} />{parseWarning}</div>}
                <div style={{ marginTop: '12px', padding: '10px 12px', borderRadius: '8px', background: 'color-mix(in srgb, var(--c-accent) 8%, transparent)', color: 'var(--c-muted)', fontSize: '12px', display: 'flex', gap: '8px' }}>
                    <ShieldCheck size={16} style={{ flexShrink: 0 }} />檔案在本機解析，不上傳。
                </div>
            </section>

            {rawText && <section style={{ ...card, marginBottom: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '10px' }}>
                    <div><div style={{ fontWeight: 700 }}>原始辨識文字</div><div style={{ fontSize: '12px', color: 'var(--c-muted)', marginTop: '3px' }}>只有解析異常時才需要查看或修改。</div></div>
                    <button type="button" onClick={() => parseText()} style={btn('var(--c-accent)')}><RefreshCw size={15} />重新解析</button>
                </div>
                <details><summary style={{ cursor: 'pointer', color: 'var(--c-muted)', fontSize: '13px' }}>查看或修改原始文字</summary><textarea value={rawText} onChange={event => setRawText(event.target.value)} style={{ ...inp, minHeight: '150px', resize: 'vertical', fontFamily: 'monospace', lineHeight: 1.5, marginTop: '10px' }} /></details>
            </section>}

            {(brokerRows.length > 0 || rawText) && <section style={{ ...card, marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', marginBottom: '12px' }}>
                    <div><div style={{ fontWeight: 700 }}>券商成交辨識</div><div style={{ color: 'var(--c-muted)', fontSize: '12px', marginTop: '3px' }}>已辨識 {brokerRows.length} 筆・完整 {brokerRows.length - incompleteBrokerRows.length} 筆・需確認 {incompleteBrokerRows.length} 筆</div></div>
                    <button type="button" onClick={addManualRow} style={btn('var(--c-accent)')}><Plus size={15} />補一列</button>
                </div>
                {incompleteBrokerRows.length === 0 ? <div style={{ color: 'var(--c-positive)', display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}><CheckCircle2 size={16} />所有必要欄位皆已完整辨識，不需要逐筆檢查。</div> : <div style={{ display: 'grid', gap: '9px' }}>{incompleteBrokerRows.map(row => <BrokerTradeEditor key={row.id} row={row} onUpdate={updateRow} onDelete={id => setBrokerRows(rows => rows.filter(item => item.id !== id))} />)}</div>}
                {brokerRows.length > 0 && <details style={{ marginTop: '12px' }}><summary style={{ cursor: 'pointer', color: 'var(--c-accent)', fontSize: '13px' }}>查看或編輯全部 {brokerRows.length} 筆</summary><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: '10px', marginTop: '10px' }}>{brokerRows.map(row => <BrokerTradeEditor key={row.id} row={row} onUpdate={updateRow} onDelete={id => setBrokerRows(rows => rows.filter(item => item.id !== id))} />)}</div></details>}
            </section>}

            {brokerRows.length > 0 && <section style={{ ...card, marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: '14px' }}>
                    <div><div style={{ fontWeight: 700, fontSize: '16px' }}>成交核對結果</div><div style={{ color: 'var(--c-muted)', fontSize: '12px', marginTop: '4px' }}>{dateFrom} 至 {dateTo}，系統 {scopedSystemRows.length} 筆、券商 {scopedBrokerRows.length} 筆原始成交，彙整為 {results.length} 組核對。</div></div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>{tradeIssues.length === 0 && <span style={{ border: '1px solid var(--c-positive)', color: 'var(--c-positive)', borderRadius: '999px', padding: '5px 9px', fontSize: '12px' }}>全部一致</span>}{(Object.keys(statusMeta) as ReconciliationStatus[]).filter(status => status !== 'matched').map(status => summary[status] > 0 && <span key={status} style={{ border: `1px solid ${statusMeta[status].color}`, color: statusMeta[status].color, borderRadius: '999px', padding: '5px 9px', fontSize: '12px' }}>{statusMeta[status].label} {summary[status]} 組</span>)}</div>
                </div>
                {mode === 'interim' && <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'color-mix(in srgb, var(--c-warning) 10%, transparent)', color: 'var(--c-warning)', fontSize: '12px', marginBottom: '12px' }}>截圖可能只是部分頁面，因此「截圖未涵蓋」只是提醒，不會判定為系統錯誤。</div>}
                {tradeIssues.length === 0 ? <div style={{ color: 'var(--c-positive)', display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}><CheckCircle2 size={16} />{scopedBrokerRows.length} 筆券商成交均已涵蓋且資料一致。</div> : <div style={{ display: 'grid', gap: '8px' }}>{tradeIssues.map(result => {
                    const source = result.broker ?? result.system
                    const meta = statusMeta[result.status]
                    const brokerSources = scopedBrokerRows.filter(row => reconciliationGroupKey(row) === result.key)
                    const systemSources = scopedSystemRows.filter(row => reconciliationGroupKey(row) === result.key)
                    return <div key={result.key} style={{ border: '1px solid var(--c-border)', borderRadius: '9px', padding: '10px 12px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', alignItems: 'center' }}>
                            <div style={{ color: meta.color, fontWeight: 700, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '5px' }}>{result.status === 'matched' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}{meta.label}</div>
                            <div><div style={{ fontWeight: 600 }}>{source?.date} {source?.code} {source?.name}</div><div style={{ color: 'var(--c-muted)', fontSize: '12px', marginTop: '2px' }}>{source?.type === 'buy' ? '買進' : '賣出'}・{source?.shares.toLocaleString()} 股・均價 {source?.price.toFixed(2)}</div></div>
                            <div style={{ color: result.differences.length ? 'var(--c-text)' : 'var(--c-positive)', fontSize: '12px' }}>{result.differences.length ? result.differences.join('；') : '券商與系統資料一致'}</div>
                        </div>
                        {(brokerSources.length > 1 || systemSources.length > 1) && <details style={{ marginTop: '9px', fontSize: '12px', color: 'var(--c-muted)' }}>
                            <summary style={{ cursor: 'pointer', color: 'var(--c-accent)' }}>查看原始成交（券商 {brokerSources.length} 筆／系統 {systemSources.length} 筆）</summary>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px', marginTop: '8px' }}>
                                <div><strong style={{ color: 'var(--c-text)' }}>券商</strong>{brokerSources.map(row => <div key={row.id}>{row.date}・{row.shares.toLocaleString()} 股 × {row.price.toFixed(2)}・淨收付 {row.total?.toLocaleString() ?? '—'}</div>)}</div>
                                <div><strong style={{ color: 'var(--c-text)' }}>系統</strong>{systemSources.map((row, index) => <div key={row.id ?? index}>{row.date}・{row.shares.toLocaleString()} 股 × {row.price.toFixed(2)}・淨收付 {row.total?.toLocaleString() ?? '—'}</div>)}</div>
                            </div>
                        </details>}
                    </div>
                })}</div>}
                {matchedTradeResults.length > 0 && <details style={{ marginTop: '12px', fontSize: '12px' }}><summary style={{ cursor: 'pointer', color: 'var(--c-muted)' }}>查看已一致的 {matchedTradeResults.length} 組摘要</summary><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '6px', marginTop: '8px', color: 'var(--c-muted)' }}>{matchedTradeResults.map(result => { const row = result.broker ?? result.system; return <div key={result.key}>{row?.date}・{row?.code} {row?.name}</div> })}</div></details>}
            </section>}

            {mode === 'monthly' && rawText && <>
                <section style={{ ...card, marginBottom: '16px' }}>
                    <div style={{ fontWeight: 700, fontSize: '16px', marginBottom: '12px' }}>CMA 現金核對</div>
                    {cashCheck.status === 'unavailable' ? <div style={{ color: 'var(--c-warning)', fontSize: '13px' }}>這份文件沒有讀到「月底結餘」，請確認 PDF 是否包含 CMA 交易明細頁。</div> : cashCheck.status === 'matched' ? <div style={{ color: 'var(--c-positive)', display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}><CheckCircle2 size={16} />CMA 月底餘額與系統換算後的交割日餘額一致。</div> : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
                        {[
                            ['券商 CMA 月底餘額', cashCheck.brokerBalance],
                            ['系統成交日帳面現金', cashCheck.systemProjectedCash],
                            ['月底後待交割淨額', cashCheck.unsettledNet],
                            ['系統換算交割日餘額', cashCheck.systemExpectedSettledCash],
                        ].map(([label, value]) => <div key={String(label)} style={{ border: '1px solid var(--c-border)', borderRadius: '9px', padding: '12px' }}><div style={{ color: 'var(--c-muted)', fontSize: '12px' }}>{label}</div><div style={{ fontWeight: 700, marginTop: '5px' }}>{Number(value).toLocaleString('zh-TW', { maximumFractionDigits: 2 })} 元</div></div>)}
                        <div style={{ border: '1px solid var(--c-negative)', borderRadius: '9px', padding: '12px' }}><div style={{ color: 'var(--c-muted)', fontSize: '12px' }}>交割口徑差額</div><div style={{ fontWeight: 700, marginTop: '5px', color: 'var(--c-negative)' }}>{(cashCheck.difference ?? 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 })} 元・需要確認</div></div>
                    </div>}
                    {cashCheck.status === 'mismatch' && <DisclosureNote summary="以交割日口徑核對 CMA。" style={{ marginTop: '10px' }}>系統仍以成交日計算帳面現金；此處只把月底尚未交割的款項加回／扣回，用相同交割日口徑與 CMA 比較。</DisclosureNote>}
                </section>

                <section style={{ ...card, marginBottom: '16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', marginBottom: '12px' }}><div><div style={{ fontWeight: 700, fontSize: '16px' }}>月底庫存核對</div><div style={{ color: 'var(--c-muted)', fontSize: '12px', marginTop: '3px' }}>比較集保、信用及已驗證的出借庫存。已辨識出借 {(monthlyDetails.lentHoldings ?? []).reduce((sum, row) => sum + row.shares, 0).toLocaleString()} 股。</div></div>{holdingIssues.length > 0 && <span style={{ color: 'var(--c-warning)', fontSize: '12px' }}>{holdingIssues.length} 項待確認</span>}</div>
                    {!monthlyDetails.holdings.length || monthlyDetails.lendingVerified === false ? <div style={{ color: 'var(--c-warning)' }}>庫存資料尚未完整驗證，請檢查 PDF 庫存及出借明細。</div> : holdingIssues.length === 0 ? <div style={{ color: 'var(--c-positive)', display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}><CheckCircle2 size={16} />{holdingChecks.length} 檔月底庫存全部一致。</div> : <div style={{ display: 'grid', gap: '8px' }}>{holdingIssues.map(row => {
                        const meta = monthlyStatusMeta[row.status]
                        return <div key={row.key} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px', border: '1px solid var(--c-border)', borderRadius: '9px', padding: '10px 12px', fontSize: '13px' }}><div style={{ color: meta.color, fontWeight: 700 }}>{meta.label}</div><div><strong>{row.code}</strong> {row.name}</div><div>券商 {row.brokerShares?.toLocaleString() ?? '—'} 股</div><div>系統 {row.systemShares?.toLocaleString() ?? '—'} 股</div><div>差額 {row.difference.toLocaleString()} 股</div></div>
                    })}</div>}
                </section>

                <section style={{ ...card, marginBottom: '16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}><div><div style={{ fontWeight: 700, fontSize: '16px' }}>現金股利核對</div><div style={{ color: 'var(--c-muted)', fontSize: '12px', marginTop: '3px' }}>以股票與金額配對；系統日期與 CMA 入帳日期可以不同。</div></div>{dividendIssues.length > 0 && <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', fontSize: '12px' }}>{dividendIssues.filter(row => row.status === 'missing-system').length > 0 && <span style={{ color: 'var(--c-negative)' }}>系統缺少 {dividendIssues.filter(row => row.status === 'missing-system').length}</span>}{dividendIssues.filter(row => row.status === 'mismatch').length > 0 && <span style={{ color: 'var(--c-warning)' }}>金額不同 {dividendIssues.filter(row => row.status === 'mismatch').length}</span>}{dividendIssues.filter(row => row.status === 'pending-broker').length > 0 && <span style={{ color: 'var(--c-muted)' }}>尚未入帳 {dividendIssues.filter(row => row.status === 'pending-broker').length}</span>}</div>}</div>
                    {dividendChecks.length === 0 ? <div style={{ color: 'var(--c-muted)', fontSize: '13px' }}>本月券商與系統皆沒有現金股利紀錄。</div> : dividendIssues.length === 0 ? <div style={{ color: 'var(--c-positive)', display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}><CheckCircle2 size={16} />{dividendChecks.length} 筆現金股利全部一致。</div> : <div style={{ display: 'grid', gap: '8px' }}>{dividendIssues.map(row => {
                        const meta = monthlyStatusMeta[row.status]
                        return <div key={row.key} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', border: '1px solid var(--c-border)', borderRadius: '9px', padding: '10px 12px', fontSize: '13px' }}><div style={{ color: meta.color, fontWeight: 700 }}>{meta.label}</div><div>{row.date}・{row.code || row.name}</div><div>{row.status === 'pending-broker' ? `系統 ${row.systemAmount?.toLocaleString() ?? '—'} 元，等待後續 CMA 入帳` : `券商 ${row.brokerAmount?.toLocaleString() ?? '—'} 元／系統 ${row.systemAmount?.toLocaleString() ?? '—'} 元`}</div></div>
                    })}</div>}
                </section>

                <section style={{ ...card, marginBottom: '16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}><div><div style={{ fontWeight: 700, fontSize: '16px' }}>月結與修正建議</div><div style={{ color: 'var(--c-muted)', fontSize: '12px', marginTop: '3px' }}>只提供檢查方向，不會自動修改任何帳務資料。</div></div><button type="button" onClick={() => void handleSaveReport()} disabled={savingReport} style={btn('var(--c-positive)')}><Save size={15} />{savingReport ? '保存中' : '保存本月核對結果'}</button></div>
                    {suggestions.length === 0 ? <div style={{ color: 'var(--c-positive)', display: 'flex', gap: '7px', alignItems: 'center' }}><CheckCircle2 size={17} />成交、CMA、庫存與股利均未發現差異。</div> : <div style={{ display: 'grid', gap: '8px' }}>{suggestions.map((suggestion, index) => <div key={`${suggestion.category}-${index}`} style={{ padding: '10px 12px', borderRadius: '8px', border: `1px solid ${suggestion.severity === 'danger' ? 'var(--c-negative)' : 'var(--c-warning)'}`, color: 'var(--c-text)', fontSize: '13px' }}><strong>{suggestion.category === 'trade' ? '成交' : suggestion.category === 'margin' ? '融資' : suggestion.category === 'cash' ? 'CMA' : suggestion.category === 'holding' ? '庫存' : '股利'}：</strong>{suggestion.message}</div>)}</div>}
                    {saveMessage && <div role="status" style={{ marginTop: '10px', color: saveMessage.startsWith('保存失敗') ? 'var(--c-negative)' : 'var(--c-positive)', fontSize: '12px' }}>{saveMessage}</div>}
                </section>
            </>}

            {savedReports.length > 0 && <section style={card}>
                <div style={{ fontWeight: 700, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '12px' }}><History size={17} />月結歷史</div>
                <div style={{ display: 'grid', gap: '8px' }}>{savedReports.map(report => {
                    const suggestionCount = report.suggestions?.length ?? 0
                    return <div key={report.id} style={{ border: '1px solid var(--c-border)', borderRadius: '9px', padding: '10px 12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px', fontSize: '12px' }}><div><strong>{report.periodStart}～{report.periodEnd}</strong><div style={{ color: 'var(--c-muted)', marginTop: '3px' }}>{new Date(report.savedAt).toLocaleString('zh-TW')}</div></div><div>成交 {report.tradeMatchedGroups}/{report.tradeGroupCount} 組一致</div><div>CMA：{report.cashStatus === 'matched' ? '一致' : '待確認'}</div><div>庫存差異 {report.holdingIssues}・股利差異 {report.dividendIssues}</div><div style={{ color: suggestionCount ? 'var(--c-warning)' : 'var(--c-positive)' }}>{suggestionCount ? `${suggestionCount} 項建議` : '月結完成'}</div></div>
                })}</div>
            </section>}
        </div>
    )
}
