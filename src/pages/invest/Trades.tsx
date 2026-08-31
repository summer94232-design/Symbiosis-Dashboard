import TradeDayTradeExceptions from '../../components/TradeDayTradeExceptions'
import TradeMarginToggle from '../../components/TradeMarginToggle'
import TradeDayTradeBadge from '../../components/TradeDayTradeBadge'
import { compareTradeListRecords } from '../../lib/tradeList'
import TradeSettlementDetails from '../../components/TradeSettlementDetails'
import { importDayTradeFields, orderTradeImportRows } from '../../lib/dayTradeCsv'
import { useState, useEffect, useRef, useMemo } from 'react'
import { addDoc, getDocs, setDoc, updateDoc, deleteDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc } from '../../lib/userDB'
import { calcFee, calcTax, calcMarginDebt, calcTradeTotal, calcSharesBeforeTrade, inferTradingSession, aggregateMarginPositions, estimateMarginRepayment, DEFAULT_MARGIN_INTEREST_RATE, type DividendRecord, type MarginRepaymentEstimate } from '../../lib/calc'
import { fetchTrades, fetchDividends, invalidateTrades, invalidateCashflow } from '../../lib/investData'
// ✅ 1-2：共用模組（CSV 解析 / 股票字典 / UI 樣式）
import { parseCSVLine, toNum, toInt } from '../../lib/csv'
import { toLocalDateString } from '../../lib/date'
import { lookupStockName, cacheStockName, saveStockName, searchStockByCodePrefix, searchStockByNamePrefix, type StockCandidate } from '../../lib/stockDict'
import { card, inp, lbl, btn } from '../../ui/styles'
import { Pencil, Trash2, X, Check, Upload, Search, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react'
import ActionNotice, { type ActionNoticeState } from '../../components/ActionNotice'
import { useInvestSync } from '../../InvestSyncContext'
import { validateCashflowForWrite, validateTradeForWrite } from '../../lib/investmentValidation'
import { DEFAULT_MARGIN_RULES, loadMarginRules, resolveMarginInterestRate } from '../../lib/marginSettings'
import DayTradePanel from '../../components/DayTradePanel'
import { analyzeDayTrades, type TradeRecord } from '../../lib/calc'

interface Trade extends TradeRecord {
    id?: string
    date: string
    type: 'buy' | 'sell'
    code: string
    name: string
    price: number
    shares: number
    fee: number
    tax: number
    total: number
    note: string
    isMargin?: boolean     // 是否為融資交易
    marginRatio?: number   // 融資成數（例：0.6）
    marginAmount?: number  // 融資借款金額
    marginRepay?: number   // 融資賣出償還的借款（本金＋利息）
    marginPrincipal?: number
    marginInterest?: number
    marginInterestRate?: number
    marginRepayManual?: boolean
    createdAt?: string     // 同日交易穩定排序時間
    sequence?: number      // 批次匯入的原始順序
}

const emptyTrade: Trade = {
    date: toLocalDateString(),
    type: 'buy', code: '', name: '', price: 0, shares: 0, fee: 0, tax: 0, total: 0, note: '',
    isMargin: false, marginRatio: 0.6, marginAmount: 0, marginRepay: 0,
    marginPrincipal: 0, marginInterest: 0, marginInterestRate: DEFAULT_MARGIN_INTEREST_RATE, marginRepayManual: false
}

const isOddLot = (shares: number) => shares > 0 && shares < 1000

function parseTradeDate(input: string): string | null {
    const normalized = input.trim()
    const compact = normalized.match(/^\d{8}$/)
    const separated = normalized.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
    const year = compact ? Number(normalized.slice(0, 4)) : separated ? Number(separated[1]) : NaN
    const month = compact ? Number(normalized.slice(4, 6)) : separated ? Number(separated[2]) : NaN
    const day = compact ? Number(normalized.slice(6, 8)) : separated ? Number(separated[3]) : NaN
    const date = new Date(year, month - 1, day)
    if (!Number.isFinite(year) || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const displayTradeDate = (value: string) => value.replaceAll('-', '/')

function TradeDateField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
    const rootRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const [draft, setDraft] = useState(displayTradeDate(value))
    const [open, setOpen] = useState(false)
    const [viewMonth, setViewMonth] = useState(() => {
        const selected = parseTradeDate(value) ?? toLocalDateString()
        const [year, month] = selected.split('-').map(Number)
        return new Date(year, month - 1, 1)
    })

    useEffect(() => {
        setDraft(displayTradeDate(value))
    }, [value])

    const commitDraft = () => {
        const parsed = parseTradeDate(draft)
        if (parsed) {
            onChange(parsed)
            setDraft(displayTradeDate(parsed))
        } else {
            setDraft(displayTradeDate(value))
        }
    }

    useEffect(() => {
        if (!open) return
        const closeWhenOutside = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                commitDraft()
                setOpen(false)
            }
        }
        document.addEventListener('pointerdown', closeWhenOutside)
        return () => document.removeEventListener('pointerdown', closeWhenOutside)
    })

    const openCalendar = () => {
        const selected = parseTradeDate(draft) ?? parseTradeDate(value) ?? toLocalDateString()
        const [year, month] = selected.split('-').map(Number)
        setViewMonth(new Date(year, month - 1, 1))
        setOpen(true)
    }

    const selectDate = (date: Date) => {
        const selected = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        onChange(selected)
        setDraft(displayTradeDate(selected))
        setOpen(false)
        inputRef.current?.focus()
    }

    const year = viewMonth.getFullYear()
    const month = viewMonth.getMonth()
    const firstDay = new Date(year, month, 1).getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const selectedDate = parseTradeDate(value)
    const today = toLocalDateString()

    return (
        <div ref={rootRef} style={{ position: 'relative' }}>
            <input
                ref={inputRef}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                aria-label="交易日期"
                placeholder="YYYY/MM/DD"
                value={draft}
                onClick={openCalendar}
                onFocus={openCalendar}
                onChange={event => {
                    const next = event.target.value
                    setDraft(next)
                    const parsed = parseTradeDate(next)
                    if (parsed) onChange(parsed)
                }}
                onKeyDown={event => {
                    if (event.key === 'Enter') {
                        event.preventDefault()
                        commitDraft()
                        setOpen(false)
                    } else if (event.key === 'Escape') {
                        setDraft(displayTradeDate(value))
                        setOpen(false)
                    }
                }}
                style={{ ...inp, paddingRight: '36px' }}
            />
            <CalendarDays size={15} aria-hidden="true" style={{ position: 'absolute', right: '11px', top: '50%', transform: 'translateY(-50%)', color: 'var(--c-muted)', pointerEvents: 'none' }} />
            {open && (
                <div className="trade-date-calendar" style={{ position: 'absolute', zIndex: 1200, top: 'calc(100% + 6px)', left: 0, width: 'min(300px, calc(100vw - 56px))', padding: '12px', borderRadius: '10px', border: '1px solid var(--c-border)', backgroundColor: 'var(--c-card)', boxShadow: '0 14px 36px rgba(0,0,0,0.32)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '34px 1fr 34px', alignItems: 'center', marginBottom: '8px' }}>
                        <button type="button" aria-label="上個月" onClick={() => setViewMonth(current => new Date(current.getFullYear(), current.getMonth() - 1, 1))} style={{ background: 'none', border: 0, color: 'var(--c-muted)', cursor: 'pointer', padding: '6px' }}><ChevronLeft size={17} /></button>
                        <strong style={{ textAlign: 'center', fontSize: '13px' }}>{year} 年 {month + 1} 月</strong>
                        <button type="button" aria-label="下個月" onClick={() => setViewMonth(current => new Date(current.getFullYear(), current.getMonth() + 1, 1))} style={{ background: 'none', border: 0, color: 'var(--c-muted)', cursor: 'pointer', padding: '6px' }}><ChevronRight size={17} /></button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '3px', textAlign: 'center' }}>
                        {['日', '一', '二', '三', '四', '五', '六'].map(day => <span key={day} style={{ padding: '4px 0', color: 'var(--c-muted)', fontSize: '11px' }}>{day}</span>)}
                        {Array.from({ length: firstDay }, (_, index) => <span key={`blank-${index}`} />)}
                        {Array.from({ length: daysInMonth }, (_, index) => {
                            const date = new Date(year, month, index + 1)
                            const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`
                            const selected = iso === selectedDate
                            const isToday = iso === today
                            return <button key={iso} type="button" aria-label={iso} aria-pressed={selected} onClick={() => selectDate(date)} style={{ minWidth: 0, aspectRatio: '1', borderRadius: '7px', border: `1px solid ${selected ? 'var(--c-accent)' : isToday ? 'var(--c-muted)' : 'transparent'}`, backgroundColor: selected ? 'color-mix(in srgb, var(--c-accent) 18%, transparent)' : 'transparent', color: selected ? 'var(--c-accent)' : 'var(--c-text)', fontWeight: selected || isToday ? 700 : 400, cursor: 'pointer', fontSize: '12px' }}>{index + 1}</button>
                        })}
                    </div>
                </div>
            )}
        </div>
    )
}

function TradeTypeButtons({ value, onChange }: {
    value: 'buy' | 'sell'
    onChange: (value: 'buy' | 'sell') => void
}) {
    return (
        <div role="group" aria-label="交易類型" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
            {([
                { value: 'buy' as const, label: '買入', color: 'var(--c-danger)' },
                { value: 'sell' as const, label: '賣出', color: 'var(--c-positive)' },
            ]).map(option => {
                const selected = value === option.value
                return (
                    <button
                        key={option.value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onChange(option.value)}
                        style={{
                            minHeight: '38px', padding: '8px 12px', borderRadius: '8px', cursor: 'pointer',
                            border: `1px solid ${selected ? option.color : 'var(--c-border)'}`,
                            backgroundColor: selected ? `color-mix(in srgb, ${option.color} 15%, transparent)` : 'var(--c-bg)',
                            color: selected ? option.color : 'var(--c-muted)',
                            fontWeight: selected ? 700 : 500,
                        }}
                    >
                        {option.label}
                    </button>
                )
            })}
        </div>
    )
}

function MarginTradeFields({
    form,
    estimate,
    onChange,
    onRepayChange,
}: {
    form: Trade
    estimate: MarginRepaymentEstimate
    onChange: <K extends keyof Trade>(key: K, value: Trade[K]) => void
    onRepayChange: (value: number) => void
}) {
    if (!form.isMargin) return null
    if (form.type === 'buy') {
        return <>
            <div>
                <label style={lbl}>融資成數 <span style={{ color: 'var(--c-warning)', fontSize: '11px' }}>（例：0.6 = 六成）</span></label>
                <input type="number" step="0.1" min="0" max="1" style={inp} value={form.marginRatio || 0.6} onChange={e => onChange('marginRatio', parseFloat(e.target.value) || 0.6)} />
            </div>
            <div>
                <label style={lbl}>融資年利率 <span style={{ color: 'var(--c-muted)', fontSize: '11px' }}>（可修改）</span></label>
                <input type="number" step="0.01" min="0" style={inp} value={Number(((form.marginInterestRate || DEFAULT_MARGIN_INTEREST_RATE) * 100).toFixed(4))} onChange={e => onChange('marginInterestRate', Math.max(parseFloat(e.target.value) || 0, 0) / 100)} />
            </div>
            <div>
                <label style={lbl}>融資金額 <span style={{ color: 'var(--c-warning)', fontSize: '11px' }}>（自動計算）</span></label>
                <input type="number" style={{ ...inp, color: 'var(--c-warning)' }} value={form.marginAmount ?? 0} readOnly />
            </div>
        </>
    }
    return <>
        <div>
            <label style={lbl}>償還本金 <span style={{ color: 'var(--c-muted)', fontSize: '11px' }}>（系統估算）</span></label>
            <input type="number" style={inp} value={form.marginPrincipal || 0} readOnly />
        </div>
        <div>
            <label style={lbl}>融資利息 <span style={{ color: 'var(--c-muted)', fontSize: '11px' }}>（系統估算）</span></label>
            <input type="number" style={inp} value={form.marginInterest || 0} readOnly />
        </div>
        <div className="span2">
            <label style={lbl}>融資償還總額 <span style={{ color: 'var(--c-warning)', fontSize: '11px' }}>（可依券商金額修正）</span></label>
            <input type="number" style={{ ...inp, color: 'var(--c-warning)' }} value={form.marginRepay || ''} onChange={e => onRepayChange(parseFloat(e.target.value) || 0)} />
            {form.marginRepayManual && <div style={{ color: 'var(--c-warning)', fontSize: '10px', marginTop: '4px' }}>已使用手動修正金額；利息依「總額－本金」更新。</div>}
            {estimate.unmatchedShares > 0 && <div style={{ color: 'var(--c-danger)', fontSize: '10px', marginTop: '4px' }}>找不到 {estimate.unmatchedShares.toLocaleString()} 股對應的融資買入紀錄，請補登後再確認金額。</div>}
        </div>
    </>
}

function RequiredFieldMessage({ show, label }: { show: boolean; label: string }) {
    return show ? <div style={{ color: 'var(--c-danger)', fontSize: '10px', marginTop: '4px' }}>請填寫{label}</div> : null
}

export default function Trades() {
    const { version: syncVersion } = useInvestSync()
    const [trades, setTrades] = useState<Trade[]>([])
    // ✅ 2-5：防呆需要正確持股數（含配股攞薄），故一併載入除權息紀錄
    const [dividends, setDividends] = useState<DividendRecord[]>([])
    const [editingId, setEditingId] = useState<string | null>(null)
    const [form, setForm] = useState<Trade>(emptyTrade)
    const [marginRules, setMarginRules] = useState(DEFAULT_MARGIN_RULES)
    const [lastTradeDate, setLastTradeDate] = useState(emptyTrade.date)
    const [loading, setLoading] = useState(false)
    const [lookingUp, setLookingUp] = useState(false)
    const [lookingUpName, setLookingUpName] = useState(false)
    const [codeSuggestions, setCodeSuggestions] = useState<StockCandidate[]>([])
    const [nameSuggestions, setNameSuggestions] = useState<StockCandidate[]>([])
    const [showCodeSuggestions, setShowCodeSuggestions] = useState(false)
    const [showNameSuggestions, setShowNameSuggestions] = useState(false)
    const [importing, setImporting] = useState(false)
    const [importResult, setImportResult] = useState<{ success: number; failed: number; skipped: number; duplicated: number } | null>(null)
    const [search, setSearch] = useState('')
    const [showForm, setShowForm] = useState(false)
    const [showDayTradeDetails, setShowDayTradeDetails] = useState(false)
    const [expandedId, setExpandedId] = useState<string | null>(null)
    const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
    const [editModal, setEditModal] = useState(false)
    const [desktopPage, setDesktopPage] = useState(1)
    const [notice, setNotice] = useState<ActionNoticeState | null>(null)
    const [saveAttempted, setSaveAttempted] = useState(false)
    const fileRef = useRef<HTMLInputElement>(null)
    const newCodeInputRef = useRef<HTMLInputElement>(null)
    const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    // debounce refs for code/name lookup
    const codeLookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const nameLookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        const handle = () => setIsMobile(window.innerWidth < 768)
        window.addEventListener('resize', handle)
        return () => window.removeEventListener('resize', handle)
    }, [])

    useEffect(() => () => {
        if (codeLookupTimer.current) clearTimeout(codeLookupTimer.current)
        if (nameLookupTimer.current) clearTimeout(nameLookupTimer.current)
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    }, [])

    const showNotice = (next: ActionNoticeState) => {
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
        setNotice(next)
        noticeTimerRef.current = setTimeout(() => setNotice(null), 4200)
    }

    const load = async () => {
        // ✅ 1-1：改走共用快取層（lib/investData）
        const [rawTrades, divs] = await Promise.all([
            fetchTrades<Trade>('desc'),
            fetchDividends<DividendRecord>('asc'),
        ])
        setDividends(divs)
        // 統一所有舊格式：spot_buy/margin_buy → buy+isMargin, spot_sell/margin_sell → sell+isMargin
        const normalized = rawTrades.map(t => {
            const type = t.type as string
            if (type === 'spot_buy') return { ...t, type: 'buy' as const, isMargin: false }
            if (type === 'spot_sell') return { ...t, type: 'sell' as const, isMargin: false }
            if (type === 'margin_buy') return { ...t, type: 'buy' as const, isMargin: true }
            if (type === 'margin_sell') return { ...t, type: 'sell' as const, isMargin: true }
            return t
        })
        setTrades(normalized)
    }

    useEffect(() => { void load() }, [syncVersion])
    useEffect(() => {
        void loadMarginRules().then(rules => {
            setMarginRules(rules)
            setForm(current => ({ ...current, marginInterestRate: resolveMarginInterestRate(rules, current.code) }))
        })
    }, [])

    // ★ 輸入代號後 debounce 500ms 再查詢，避免每按一個字就打 Firebase
    const handleCodeChange = (code: string) => {
        const upper = code.toUpperCase()
        setForm(f => {
            const fee = f.price && f.shares ? calcFee(f.price, f.shares) : f.fee
            const tax = f.type === 'sell' && f.price && f.shares ? calcTax(f.price, f.shares, upper) : 0
            const u = { ...f, code: upper, fee, tax, marginInterestRate: editingId ? f.marginInterestRate : resolveMarginInterestRate(marginRules, upper) }
            u.total = calcTradeTotal(u)
            return u
        })

        if (codeLookupTimer.current) clearTimeout(codeLookupTimer.current)
        if (upper.length < 3) {
            setCodeSuggestions([])
            setShowCodeSuggestions(false)
            return
        }

        codeLookupTimer.current = setTimeout(async () => {
            setLookingUp(true)
            const [name, candidates] = await Promise.all([
                lookupStockName(upper),
                searchStockByCodePrefix(upper),
            ])
            if (name) {
                setForm(f => ({ ...f, name }))
            }
            // 顯示前綴相關代號候選（例如輸入 00631 → 列出 00631、00631L）
            setCodeSuggestions(candidates)
            setShowCodeSuggestions(candidates.length > 0)
            setLookingUp(false)
        }, 500)
    }

    // 輸入股票名稱後反查代號；完全命中或只有一個候選時直接自動帶入。
    const handleNameChange = (name: string) => {
        setForm(f => ({ ...f, name }))
        if (nameLookupTimer.current) clearTimeout(nameLookupTimer.current)
        const normalized = name.trim()
        if (!normalized) {
            setNameSuggestions([])
            setShowNameSuggestions(false)
            return
        }

        nameLookupTimer.current = setTimeout(async () => {
            setLookingUpName(true)
            try {
                const candidates = await searchStockByNamePrefix(normalized)
                const exact = candidates.find(c => c.name === normalized)
                const autoMatch = exact ?? (candidates.length === 1 ? candidates[0] : null)
                if (autoMatch) {
                    handleSelectSuggestion(autoMatch)
                } else {
                    setNameSuggestions(candidates)
                    setShowNameSuggestions(candidates.length > 0)
                }
            } finally {
                setLookingUpName(false)
            }
        }, 400)
    }

    // 點選下拉候選：直接帶入該代號的 code + name，並重算手續費/交易稅/總額
    const handleSelectSuggestion = (c: StockCandidate) => {
        setForm(f => {
            const fee = f.price && f.shares ? calcFee(f.price, f.shares) : f.fee
            const tax = f.type === 'sell' && f.price && f.shares ? calcTax(f.price, f.shares, c.code) : 0
            const u = { ...f, code: c.code, name: c.name, fee, tax }
            u.total = calcTradeTotal(u)
            return u
        })
        cacheStockName(c.code, c.name)
        setShowCodeSuggestions(false)
        setShowNameSuggestions(false)
        setCodeSuggestions([])
        setNameSuggestions([])
    }

    const calcTotal = (f: Trade) => calcTradeTotal(f)

    const handleChange = <K extends keyof Trade>(key: K, value: Trade[K]) => {
        setForm(f => {
            const u = { ...f, [key]: value }
            if (u.type !== 'sell' || u.isMargin || u.dayTradeExcluded || inferTradingSession(u) !== 'regular') u.dayTradePending = false
            if (['price', 'shares', 'type', 'code', 'marginRatio', 'isMargin', 'marginRepay'].includes(key)) {
                if (u.price && u.shares) {
                    u.fee = calcFee(u.price, u.shares)
                    u.tax = u.type === 'sell' ? calcTax(u.price, u.shares, u.code) : 0
                    if (u.type === 'buy' && u.isMargin) {
                        u.marginAmount = calcMarginDebt(u.price * u.shares, u.marginRatio || 0.6)
                    }
                }
            }
            u.total = calcTotal(u)
            return u
        })
    }

    // ── 防呆：現股賣出但該代號目前有融資部位 ──
    // 現股賣出不會歸還融資借款（aggregateMarginPositions 只處理 isMargin 交易），
    // 若使用者融資買進後賣出時忘了勾「融資」，維持率分母不會減少且永遠不歸零。
    const sellMarginWarning = useMemo(() => {
        if (form.type !== 'sell' || form.isMargin || !form.code) return null
        const pos = aggregateMarginPositions(trades).find(m => m.code === form.code)
        return pos && pos.shares > 0 ? pos : null
    }, [trades, form.type, form.isMargin, form.code])

    // ── 防呆（2-5）：賣出股數 > 目前持股 ──
    // calc.ts 對負持倉雖有歸零防呆，但超賣會讓該筆已實現損益用到錯誤均價，
    // 後續持倉/損益數字都會失真，故在表單即時警告並禁止儲存。
    // 持股數依交易日期與穩定順序計算（含更早日期的配股）；編輯既有紀錄時
    // 會排除該筆本身，避免同一筆賣出被重複扣除造成誤報。
    const oversellWarning = useMemo(() => {
        if (form.type !== 'sell' || !form.code || !form.shares) return null
        const target: Trade = {
            ...form,
            id: editingId ?? '__new_trade__',
            // 新增交易視為該日期最後輸入；既有交易沿用保存的 createdAt。
            createdAt: form.createdAt || (editingId ? undefined : '9999-12-31T23:59:59.999Z'),
            sequence: form.sequence ?? (editingId ? undefined : Number.MAX_SAFE_INTEGER),
        }
        const held = calcSharesBeforeTrade(target, trades, dividends)
        return form.shares > held && !(!form.isMargin && form.dayTradePending) ? { held } : null
    }, [trades, dividends, form, editingId])

    const duplicateTrade = useMemo(() => {
        if (!form.date || !form.code || !form.price || !form.shares) return null
        return trades.find(trade => trade.id !== editingId
            && (trade.brokerAccount || '').trim() === (form.brokerAccount || '').trim()
            && trade.date === form.date
            && trade.type === form.type
            && trade.code.replace('.TW', '').toUpperCase() === form.code.replace('.TW', '').toUpperCase()
            && Number(trade.price) === Number(form.price)
            && Number(trade.shares) === Number(form.shares)) ?? null
    }, [trades, form.date, form.type, form.code, form.price, form.shares, form.brokerAccount, editingId])

    const missingRequiredFields = useMemo(() => [
        !form.date ? '日期' : '',
        !form.code.trim() ? '股票代號' : '',
        !(form.price > 0) ? '價格' : '',
        !(form.shares > 0) ? '股數' : '',
    ].filter(Boolean), [form.date, form.code, form.price, form.shares])

    const requiredErrorStyle = (hasError: boolean) => hasError
        ? { ...inp, borderColor: 'var(--c-danger)', boxShadow: '0 0 0 1px color-mix(in srgb, var(--c-danger) 30%, transparent)' }
        : inp

    const handleSave = async () => {
        setSaveAttempted(true)
        if (missingRequiredFields.length > 0) return
        const validation = validateTradeForWrite(form)
        if (!validation.valid) {
            showNotice({ type: 'error', message: `無法儲存：${validation.errors.join('；')}` })
            return
        }
        // 超賣不是一般多頭交易的合法狀態；若要支援放空，必須使用獨立模型。
        if (oversellWarning) return
        const nextTrades = [...trades.filter(t => t.id !== editingId), { ...form, id: editingId || '__new_trade__' }]
        const existingIssues = new Set(analyzeDayTrades(trades).issues.map(issue => issue.trade.id))
        if (analyzeDayTrades(nextTrades).issues.some(issue => !existingIssues.has(issue.trade.id))) {
            showNotice({ type: 'error', message: '這項修改會使已確認當沖失效。請先在當沖核對區取消相關配對，再修改交易。' })
            return
        }
        if (duplicateTrade) {
            const proceed = confirm(`可能重複：${form.date} ${form.code} ${form.type === 'buy' ? '買入' : '賣出'} ${form.shares.toLocaleString()} 股，價格 ${form.price}。\n\n確定仍要儲存？`)
            if (!proceed) return
        }
        if (form.type === 'sell' && form.isMargin && !(form.marginRepay && form.marginRepay > 0)) {
            const ok = confirm('融資賣出未填「融資償還金額」，可用現金將被高估（賣出淨入帳少扣了還款）。確定仍要儲存？')
            if (!ok) return
        }
        setLoading(true)
        const wasEditing = Boolean(editingId)
        try {
            if (form.name && form.code) {
                await saveStockName(form.code, form.name)
            }
            const now = new Date().toISOString()
            // 舊資料沒有 createdAt 時，編輯後仍保留以文件 ID 排序，避免一次普通編輯改變歷史順序。
            const payload = editingId
                ? { ...form }
                : { ...form, createdAt: now, sequence: Date.now() }
            if (editingId) {
                await updateDoc(userDoc(investDB, 'trades', editingId), payload)
            } else {
                await addDoc(userCol(investDB, 'trades'), payload)
            }
            invalidateTrades()   // ✅ 1-1：寫入後清快取，其他頁面才會拿到最新資料
            if (!wasEditing) setLastTradeDate(form.date)
            setEditingId(null)
            setForm({ ...emptyTrade, date: wasEditing ? lastTradeDate : form.date, marginInterestRate: marginRules.defaultInterestRate })
            setShowForm(!wasEditing)
            setEditModal(false)
            setSaveAttempted(false)
            setCodeSuggestions([]); setNameSuggestions([]); setShowCodeSuggestions(false); setShowNameSuggestions(false)
            await load()
            if (!wasEditing) requestAnimationFrame(() => newCodeInputRef.current?.focus())
            showNotice({ type: 'success', message: wasEditing ? '交易紀錄已更新。' : '交易紀錄已新增，可繼續輸入下一筆。' })
        } catch (err) {
            console.error(err)
            showNotice({ type: 'error', message: '交易紀錄儲存失敗，表單內容已保留。' })
        } finally {
            setLoading(false)
        }
    }

    const handleEdit = (t: Trade) => {
        if (t.code && t.name) cacheStockName(t.code, t.name)
        const estimate = estimateMarginRepayment(t, trades)
        const principal = t.marginPrincipal ?? estimate.principal
        setForm({
            ...emptyTrade,
            ...t,
            marginInterestRate: t.marginInterestRate || DEFAULT_MARGIN_INTEREST_RATE,
            marginPrincipal: principal,
            marginInterest: t.marginInterest ?? Math.max((t.marginRepay || 0) - principal, 0),
            marginRepayManual: t.marginRepayManual ?? Boolean(t.marginRepay),
        }); setEditingId(t.id!); setEditModal(true)
        setSaveAttempted(false)
        setCodeSuggestions([]); setNameSuggestions([]); setShowCodeSuggestions(false); setShowNameSuggestions(false)
    }
    const handleCancel = () => {
        setForm({ ...emptyTrade, date: lastTradeDate, marginInterestRate: marginRules.defaultInterestRate }); setEditingId(null); setShowForm(false); setEditModal(false)
        setSaveAttempted(false)
        setCodeSuggestions([]); setNameSuggestions([]); setShowCodeSuggestions(false); setShowNameSuggestions(false)
    }
    const handleDelete = async (id: string) => {
        const linked = trades.some(t => t.dayTradeMatches?.some(link => link.buyId === id))
        if (!confirm(linked ? '此買入有已確認的當沖配對。刪除後配對會失效、損益將重算，請再到當沖核對區處理。確定刪除？' : '確定要刪除？')) return
        try {
            await deleteDoc(userDoc(investDB, 'trades', id))
            invalidateTrades()   // ✅ 1-1：寫入後清快取
            await load()
            showNotice({ type: 'success', message: '交易紀錄已刪除。' })
        } catch (err) {
            console.error(err)
            showNotice({ type: 'error', message: '交易紀錄刪除失敗，請稍後再試。' })
        }
    }

    const marginRepaymentEstimate = useMemo(() => {
        const target: Trade = {
            ...form,
            id: editingId ?? '__new_margin_sell__',
            createdAt: form.createdAt || (editingId ? undefined : '9999-12-31T23:59:59.999Z'),
            sequence: form.sequence ?? (editingId ? undefined : Number.MAX_SAFE_INTEGER),
        }
        return estimateMarginRepayment(target, trades)
    }, [trades, form, editingId])

    useEffect(() => {
        if (form.type !== 'sell' || !form.isMargin || form.marginRepayManual) return
        setForm(current => {
            if (current.type !== 'sell' || !current.isMargin || current.marginRepayManual) return current
            if (current.marginPrincipal === marginRepaymentEstimate.principal
                && current.marginInterest === marginRepaymentEstimate.interest
                && current.marginRepay === marginRepaymentEstimate.total) return current
            const updated = {
                ...current,
                marginPrincipal: marginRepaymentEstimate.principal,
                marginInterest: marginRepaymentEstimate.interest,
                marginRepay: marginRepaymentEstimate.total,
            }
            updated.total = calcTradeTotal(updated)
            return updated
        })
    }, [form.type, form.isMargin, form.marginRepayManual, marginRepaymentEstimate.principal, marginRepaymentEstimate.interest, marginRepaymentEstimate.total])

    const handleMarginRepayChange = (value: number) => {
        setForm(current => {
            const principal = current.marginPrincipal || marginRepaymentEstimate.principal
            const updated = {
                ...current,
                marginRepay: value,
                marginPrincipal: principal,
                marginInterest: Math.max(value - principal, 0),
                marginRepayManual: true,
            }
            updated.total = calcTradeTotal(updated)
            return updated
        })
    }

    const handleImportCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        setImporting(true); setImportResult(null)

        const text = await file.text()
        const lines = text
            .replace(/^\uFEFF/, '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .split('\n')
            .filter(l => l.trim())

        if (lines.length < 2) {
            setImporting(false); e.target.value = ''; return
        }

        const headers = parseCSVLine(lines[0])
        let success = 0, failed = 0, skipped = 0, duplicated = 0

        // ── 重複偵測：以既有資料建 key 集合，命中者略過不寫入 ──
        //    交易 key = 日期|代號|類型|價格|股數；出入金 key = 日期|類型|金額|備註
        //    ⚠️ 同日同價同量的「真實重複交易」也會被當成重複，匯入結果會單獨顯示重複筆數供核對。
        const [existTradesSnap, existCashSnap] = await Promise.all([
            getDocs(userCol(investDB, 'trades')),
            getDocs(userCol(investDB, 'cashflow')),
        ])
        const tradeKeys = new Set(existTradesSnap.docs.map(d => {
            const t = d.data()
            return `${t.date}|${t.code}|${t.type}|${Number(t.price)}|${Number(t.shares)}|${String(t.brokerAccount || '').trim()}`
        }))
        const existingIds = new Set(existTradesSnap.docs.map(d => d.id))
        const cashKeys = new Set(existCashSnap.docs.map(d => {
            const c = d.data()
            return `${c.date}|${c.type}|${Number(c.amount)}|${c.note || ''}`
        }))
        const validationTrades: Trade[] = existTradesSnap.docs.map(d => ({ id: d.id, ...d.data() } as Trade))

        const importBaseTime = Date.now()
        const importRows = orderTradeImportRows(lines.slice(1).map((line, index) => {
            const cols = parseCSVLine(line)
            return { row: Object.fromEntries(headers.map((h, idx) => [h, cols[idx] || ''])), sourceIndex: index + 1 }
        }))
        for (const { row, sourceIndex: i } of importRows) {

            const type = row['類型']
            const date = row['日期']
            const sourceId = (row['Firestore ID'] || '').trim()

            if (type === '入金' || type === '出金') {
                const amount = toNum(row['價格/金額'] || row['金額'] || '')
                if (amount > 0) {
                    const cashNote = row['備註/筆記'] || row['備註'] || ''
                    const cashCandidate = { date, type: type === '入金' ? 'in' : 'out', amount }
                    if (!validateCashflowForWrite(cashCandidate).valid) { failed++; continue }
                    const cashKey = `${date}|${type === '入金' ? 'in' : 'out'}|${Number(amount)}|${cashNote}`
                    if (cashKeys.has(cashKey)) { duplicated++; continue }
                    cashKeys.add(cashKey)
                    await addDoc(userCol(investDB, 'cashflow'), {
                        date,
                        type: type === '入金' ? 'in' : 'out',
                        amount,
                        note: cashNote
                    })
                    success++
                } else { skipped++ }
                continue
            }
            // 支援新舊格式：現貨買入/現貨賣出/融資買入/融資賣出/買進/賣出
            const validTypes = ['買入', '買進', '賣出', '現貨買入', '現貨賣出', '融資買入', '融資賣出']
            if (!validTypes.includes(type)) { skipped++; continue }

            const isMarginCSV = type === '融資買入' || type === '融資賣出'
            const tradeType = (type === '賣出' || type === '現貨賣出' || type === '融資賣出') ? 'sell' : 'buy'

            const rawCode = (row['代號'] || '').replace('.TW', '').replace('.tw', '').trim()
            const name = (row['名稱'] || '').trim()
            const price = toNum(row['價格/金額'] || row['價格'] || '')
            const shares = toInt(row['股數'])

            if (!rawCode || !price || !shares) { failed++; continue }

            const tradeKey = `${date}|${rawCode}|${tradeType}|${Number(price)}|${Number(shares)}|${(row['券商帳戶'] || '').trim()}`
            if (!sourceId && tradeKeys.has(tradeKey)) { duplicated++; continue }
            if (sourceId && existingIds.has(sourceId)) { duplicated++; continue }

            const isSell = tradeType === 'sell'
            const fee = calcFee(price, shares)
            const tax = isSell ? calcTax(price, shares, rawCode) : 0
            // 若 CSV 含融資欄位（完整備份）則沿用，否則融資成數預設 0.6、償還金額 0。
            // ⚠️ 非備份來源的融資賣出無法得知償還金額（含利息），匯入後請逐筆補上「融資償還金額」。
            const marginRatioCSV = isMarginCSV
                ? (row['融資成數'] ? toNum(row['融資成數']) || 0.6 : 0.6)
                : 0
            const marginRepayCSV = isMarginCSV && isSell
                ? (row['融資償還金額'] ? toNum(row['融資償還金額']) : 0)
                : 0
            const marginPrincipalCSV = isMarginCSV && isSell ? toNum(row['融資本金'] || '') || 0 : 0
            const marginInterestCSV = isMarginCSV && isSell ? toNum(row['融資利息'] || '') || 0 : 0
            const rateValue = toNum(row['融資年利率 (%)'] || '')
            const marginInterestRateCSV = isMarginCSV
                ? (rateValue && rateValue > 1 ? rateValue / 100 : rateValue || resolveMarginInterestRate(marginRules, rawCode))
                : 0
            const totalRawCSV = row['收付金額'] ? toNum(row['收付金額']) : null
            const total = totalRawCSV !== null ? totalRawCSV : calcTradeTotal({
                type: tradeType, price, shares, fee, tax,
                isMargin: isMarginCSV, marginRatio: marginRatioCSV, marginRepay: marginRepayCSV
            })

            const createdAt = (row['建立時間'] || '').trim() || new Date(importBaseTime + i).toISOString()
            const importedSequence = toNum(row['同日順序'] || '')
            const sequence = typeof importedSequence === 'number' && Number.isFinite(importedSequence) ? importedSequence : i
            let dayTradeFields: ReturnType<typeof importDayTradeFields>
            try { dayTradeFields = importDayTradeFields(row) } catch { failed++; continue }
            const candidate: Trade = {
                ...dayTradeFields,
                id: sourceId || `__csv_${i}`, date, type: tradeType, code: rawCode, name, price, shares, fee, tax, total,
                isMargin: isMarginCSV, marginRatio: marginRatioCSV, marginRepay: marginRepayCSV,
                marginPrincipal: marginPrincipalCSV, marginInterest: marginInterestCSV,
                marginInterestRate: marginInterestRateCSV, marginRepayManual: Boolean(marginRepayCSV),
                note: row['備註/筆記'] || row['備註'] || '', createdAt, sequence,
            }
            if (!validateTradeForWrite(candidate).valid) {
                failed++
                continue
            }
            if (isSell && !candidate.dayTradePending && shares > calcSharesBeforeTrade(candidate, validationTrades, dividends)) {
                failed++
                continue
            }

            const existingMatchIssues = new Set(analyzeDayTrades(validationTrades, false).issues.map(issue => issue.trade.id))
            if (analyzeDayTrades([...validationTrades, candidate], false).issues.some(issue => issue.trade === candidate || !existingMatchIssues.has(issue.trade.id))) { failed++; continue }

            try {
                const payload = {
                    ...dayTradeFields,
                    date, type: tradeType, code: rawCode, name, price, shares, fee, tax, total,
                    isMargin: isMarginCSV, marginRatio: marginRatioCSV, marginRepay: marginRepayCSV,
                    marginPrincipal: marginPrincipalCSV, marginInterest: marginInterestCSV,
                    marginInterestRate: marginInterestRateCSV, marginRepayManual: Boolean(marginRepayCSV),
                    note: row['備註/筆記'] || row['備註'] || '',
                    createdAt, sequence,
                }
                let importedId = sourceId
                if (sourceId) {
                    await setDoc(userDoc(investDB, 'trades', sourceId), payload)
                    existingIds.add(sourceId)
                } else {
                    const docRef = await addDoc(userCol(investDB, 'trades'), payload)
                    importedId = docRef.id
                }
                validationTrades.push({ ...candidate, id: importedId })
                tradeKeys.add(tradeKey)
                // ★ CSV 匯入時同步寫入 stockDict（只寫有名稱的）
                if (name && rawCode) {
                    await saveStockName(rawCode, name)
                }
                success++
            } catch { failed++ }
        }

        // ✅ 1-1：匯入會寫入 trades 與 cashflow，兩種快取都要清
        invalidateTrades()
        invalidateCashflow()
        setImportResult({ success, failed, skipped, duplicated })
        setImporting(false); e.target.value = ''
        load()
    }

    const dayTradeAnalysis = useMemo(() => analyzeDayTrades(trades, false), [trades])
    const filtered = useMemo(() => {
        const keyword = search.trim().toLowerCase()
        return trades.filter(t =>
            !keyword || t.code.toLowerCase().includes(keyword) || t.name.toLowerCase().includes(keyword)
        ).sort(compareTradeListRecords)
    }, [trades, search])

    const totalDesktopPages = Math.max(1, Math.ceil(filtered.length / DESKTOP_PAGE_SIZE))
    const safeDesktopPage = Math.min(desktopPage, totalDesktopPages)
    const desktopPageRows = filtered.slice(
        (safeDesktopPage - 1) * DESKTOP_PAGE_SIZE,
        safeDesktopPage * DESKTOP_PAGE_SIZE
    )
    const desktopRangeStart = filtered.length === 0 ? 0 : (safeDesktopPage - 1) * DESKTOP_PAGE_SIZE + 1
    const desktopRangeEnd = Math.min(safeDesktopPage * DESKTOP_PAGE_SIZE, filtered.length)

    // 代號候選下拉清單（新增/編輯表單共用）
    const renderSuggestions = (candidates: StockCandidate[], visible: boolean) => (
        visible && candidates.length > 0 && (
            <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
                backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)',
                borderRadius: '8px', marginTop: '4px', maxHeight: '200px', overflowY: 'auto',
                boxShadow: '0 4px 12px rgba(0,0,0,0.2)'
            }}>
                {candidates.map(c => (
                    <div
                        key={c.code}
                        onMouseDown={() => handleSelectSuggestion(c)}
                        style={{
                            padding: '8px 12px', cursor: 'pointer', fontSize: '13px',
                            display: 'flex', justifyContent: 'space-between', gap: '10px',
                            borderBottom: '1px solid var(--c-border)'
                        }}
                        onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--c-sidebar)')}
                        onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                    >
                        <span style={{ color: 'var(--c-accent)', fontWeight: 700, flexShrink: 0 }}>{c.code}</span>
                        <span style={{ color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || '（無名稱）'}</span>
                    </div>
                ))}
            </div>
        )
    )

    return (
        <>
            {notice && <ActionNotice {...notice} onClose={() => setNotice(null)} />}
            {/* 編輯 Modal */}
            {editModal && (
                <div className="mobile-modal" style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.65)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
                    onClick={e => { if (e.target === e.currentTarget) handleCancel() }}>
                    <div className="mobile-sticky-form" style={{ ...card, width: '100%', maxWidth: '720px', maxHeight: '90vh', overflowY: 'auto', position: 'relative' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                            <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--c-text)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                ✏️ 編輯交易
                                {isOddLot(form.shares) && (
                                    <span style={{ fontSize: '11px', backgroundColor: 'rgba(245,166,35,0.15)', color: 'var(--c-warning)', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>零股</span>
                                )}
                            </div>
                            <button onClick={handleCancel} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer', padding: '4px' }}><X size={18} /></button>
                        </div>
                        <div className="trade-form-fields">
                        <div className="trade-form-identity">
                            <div><label style={lbl}>日期</label><TradeDateField value={form.date} onChange={value => handleChange('date', value)} /></div>
                            <div><label style={lbl}>類型</label><TradeTypeButtons value={form.type} onChange={value => handleChange('type', value)} /></div>
                            <div style={{ position: 'relative' }}>
                                <label style={lbl}>股票代號</label>
                                <input
                                    style={requiredErrorStyle(saveAttempted && !form.code.trim())}
                                    placeholder="例：2330"
                                    value={form.code}
                                    onChange={e => handleCodeChange(e.target.value)}
                                    onFocus={() => { if (codeSuggestions.length > 0) setShowCodeSuggestions(true) }}
                                    onBlur={() => setTimeout(() => setShowCodeSuggestions(false), 150)}
                                />
                                <RequiredFieldMessage show={saveAttempted && !form.code.trim()} label="股票代號" />
                                {renderSuggestions(codeSuggestions, showCodeSuggestions)}
                            </div>
                            <div style={{ position: 'relative' }}>
                                <label style={lbl}>股票名稱 {(lookingUp || lookingUpName) && <span style={{ color: 'var(--c-muted)', fontSize: '10px' }}>查詢中...</span>}</label>
                                <input style={inp} placeholder="可輸入名稱反查代號" value={form.name} onChange={e => handleNameChange(e.target.value)}
                                    onFocus={() => { if (nameSuggestions.length > 0) setShowNameSuggestions(true) }}
                                    onBlur={() => setTimeout(() => setShowNameSuggestions(false), 150)} />
                                {renderSuggestions(nameSuggestions, showNameSuggestions)}
                            </div>
                        </div>
                        <div className="trade-form-execution">
                            <div>
                                <label style={lbl}>價格</label>
                                <input type="number" style={requiredErrorStyle(saveAttempted && !(form.price > 0))} placeholder="0" value={form.price || ''} onChange={e => handleChange('price', parseFloat(e.target.value) || 0)} />
                                <RequiredFieldMessage show={saveAttempted && !(form.price > 0)} label="價格" />
                            </div>
                            <div>
                                <label style={lbl}>股數</label>
                                <input type="number" style={requiredErrorStyle(saveAttempted && !(form.shares > 0))} placeholder="0" value={form.shares || ''} onChange={e => handleChange('shares', parseInt(e.target.value) || 0)} />
                                <RequiredFieldMessage show={saveAttempted && !(form.shares > 0)} label="股數" />
                            </div>
                            <TradeSettlementDetails form={form} onChange={(key, value) => handleChange(key, value)} />
                            <div>
                                <label style={lbl}>備註</label>
                                <input style={inp} placeholder="選填" value={form.note} onChange={e => handleChange('note', e.target.value)} />
                            </div>
                            <TradeMarginToggle checked={!!form.isMargin} onChange={value => handleChange('isMargin', value)} />
                        </div>
                        <div className="trades-grid trade-form-extra">
                            {duplicateTrade && (
                                <div className="span2" style={{ backgroundColor: 'color-mix(in srgb, var(--c-warning) 10%, transparent)', border: '1px solid var(--c-warning)', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: 'var(--c-warning)', lineHeight: 1.6 }}>
                                    ⚠️ 已有相同日期、買賣、代號、價格與股數的交易，這筆可能重複。
                                </div>
                            )}
                            <MarginTradeFields form={form} estimate={marginRepaymentEstimate} onChange={handleChange} onRepayChange={handleMarginRepayChange} />
                            {oversellWarning && (
                                <div className="span2" style={{ backgroundColor: 'color-mix(in srgb, var(--c-danger) 10%, transparent)', border: '1px solid var(--c-danger)', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: 'var(--c-danger)', lineHeight: 1.6 }}>
                                    ⚠️ 賣出股數（{form.shares.toLocaleString()}）超過 {form.code} 目前持股（{oversellWarning.held.toLocaleString()} 股）。
                                    系統已禁止儲存超賣；請降低股數或先補登該日期以前的買入紀錄。
                                </div>
                            )}
                            {sellMarginWarning && (
                                <div className="span2" style={{ backgroundColor: 'color-mix(in srgb, var(--c-warning) 10%, transparent)', border: '1px solid var(--c-warning)', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: 'var(--c-warning)', lineHeight: 1.6 }}>
                                    ⚠️ {form.code} 目前有融資部位（{sellMarginWarning.shares.toLocaleString()} 股、借款約 {Math.round(sellMarginWarning.marginAmount).toLocaleString()} 元）。
                                    此筆為「現股賣出」，不會歸還融資借款；若實際是融資賣出，請開啟「融資」開關並填入償還金額，否則維持率與可用現金會失真。
                                </div>
                            )}
                        </div>
                        </div>
                        <div className="mobile-sticky-actions trade-form-footer">
                            <div className="trade-form-actions">
                            <button style={btn('var(--c-border)')} onClick={handleCancel}><X size={14} />取消</button>
                            <TradeDayTradeExceptions form={form} onChange={handleChange} />
                            <button style={btn('var(--c-accent)')} onClick={handleSave} disabled={loading || !!oversellWarning}>
                                <Check size={14} />{loading ? '儲存中...' : '確認更新'}
                            </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            <style>{`
        .trades-grid { display: grid; gap: 12px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .trades-grid .span2 { grid-column: 1 / -1; }
        @media (max-width: 1100px) { .trades-grid { grid-template-columns: repeat(3, 1fr); } }
        @media (max-width: 700px) { .trades-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .trades-grid { grid-template-columns: 1fr; } .trades-grid .span2 { grid-column: span 1; } }
        @media (max-width: 700px) { .trade-date-calendar { position: fixed !important; top: 84px !important; left: 50% !important; width: min(340px, calc(100vw - 32px)) !important; transform: translateX(-50%); } }
        .trade-sticky-controls { position: sticky; top: 0; z-index: 30; margin: -4px -4px 12px; padding: 4px; background: color-mix(in srgb, var(--c-bg) 94%, transparent); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
        .trade-search-toolbar { display: block; }
        .trade-search-box { position: relative; flex: 1; min-width: 0; }
        .trade-table-wrap { max-height: min(64vh, 620px); overflow: auto; }
        .trade-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .trade-table th { position: sticky; top: 0; z-index: 5; padding: 8px 10px; text-align: left; color: var(--c-muted); background: var(--c-sidebar); font-weight: 500; border-bottom: 1px solid var(--c-border); white-space: nowrap; }
        .trade-table td { padding: 10px; border-bottom: 1px solid var(--c-border); color: var(--c-text); white-space: nowrap; }
        .trade-table tr:hover td { background-color: rgba(79,142,247,0.04); }
        .trade-pagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; color: var(--c-muted); font-size: 12px; }
        .trade-pagination-actions { display: flex; align-items: center; gap: 8px; }
        .trade-pagination button { display: inline-flex; min-height: 36px; align-items: center; gap: 5px; padding: 6px 10px; border: 1px solid var(--c-border); border-radius: 8px; color: var(--c-text); background: var(--c-card); cursor: pointer; }
        .trade-pagination button:disabled { opacity: .45; cursor: not-allowed; }
        .trade-card { background: var(--c-bg); border-radius: 10px; padding: 12px 14px; border: 1px solid var(--c-border); margin-bottom: 8px; }
        .trade-card:active { border-color: var(--c-accent); }
        @media (max-width: 767px) {
            .trade-sticky-controls { position: static; margin: 0 0 12px; padding: 0; background: transparent; backdrop-filter: none; -webkit-backdrop-filter: none; }
            .trade-search-toolbar { display: block; }
        }
      `}</style>

            <div style={{ padding: 'clamp(12px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>

                <div className="trade-sticky-controls">
                    {/* 標題列 */}
                    <div className="page-header" style={{ marginBottom: '12px' }}>
                        <div className="page-heading">
                            <h1 className="page-title">買賣紀錄</h1>
                            <p className="page-subtitle">共 {trades.length} 筆交易</p>
                        </div>
                        <div className="page-actions">
                            <label className="ui-button ui-button-secondary">
                                <Upload size={13} />{isMobile ? 'CSV' : importing ? '匯入中...' : '匯入歷史紀錄 CSV'}
                                <input ref={fileRef} type="file" accept=".csv" onChange={handleImportCSV} disabled={importing} style={{ display: 'none' }} />
                            </label>
                            <button className="ui-button ui-button-primary" onClick={() => {
                                const opening = !showForm
                                setForm({ ...emptyTrade, date: lastTradeDate, marginInterestRate: marginRules.defaultInterestRate })
                                setEditingId(null)
                                setSaveAttempted(false)
                                setShowForm(opening)
                                if (opening) requestAnimationFrame(() => newCodeInputRef.current?.focus())
                            }}>
                                {showForm ? <X size={13} /> : <Check size={13} />}{showForm ? '收起' : '新增交易'}
                            </button>
                        </div>
                    </div>

                    {/* 搜尋 */}
                    <div className="trade-search-toolbar">
                        <div className="trade-search-box">
                            <Search size={14} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--c-muted)' }} />
                            <input
                                style={{ ...inp, paddingLeft: '36px', backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)' }}
                                placeholder="搜尋代號或名稱..."
                                value={search}
                                onChange={e => { setSearch(e.target.value); setDesktopPage(1) }}
                            />
                        </div>
                    </div>
                </div>

                {importResult && (
                    <div style={{ backgroundColor: 'rgba(0,200,150,0.08)', border: '1px solid rgba(0,200,150,0.25)', borderRadius: '10px', padding: '12px 16px', marginBottom: '12px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                        <div><span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>成功匯入</span><div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--c-positive)' }}>{importResult.success} 筆</div></div>
                        {importResult.failed > 0 && <div><span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>失敗</span><div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--c-danger)' }}>{importResult.failed} 筆</div></div>}
                        {importResult.skipped > 0 && <div><span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>略過</span><div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--c-muted)' }}>{importResult.skipped} 筆</div></div>}
                        {importResult.duplicated > 0 && <div><span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>重複略過</span><div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--c-warning)' }}>{importResult.duplicated} 筆</div></div>}
                    </div>
                )}

                {/* 表單 */}
                {showForm && (
                    <div className="mobile-sticky-form" style={{ ...card, marginBottom: '16px' }}>
                        <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '16px' }}>
                            {editingId ? '✏️ 編輯交易' : '➕ 新增交易'}
                            {isOddLot(form.shares) && (
                                <span style={{ marginLeft: '10px', fontSize: '11px', backgroundColor: 'rgba(245,166,35,0.15)', color: 'var(--c-warning)', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>
                                    零股交易
                                </span>
                            )}
                        </div>
                        <div className="trade-form-fields">
                        <div className="trade-form-identity">
                            <div><label style={lbl}>日期</label><TradeDateField value={form.date} onChange={value => handleChange('date', value)} /></div>
                            <div><label style={lbl}>類型</label><TradeTypeButtons value={form.type} onChange={value => handleChange('type', value)} /></div>
                            <div style={{ position: 'relative' }}>
                                <label style={lbl}>股票代號</label>
                                <input
                                    ref={newCodeInputRef}
                                    style={requiredErrorStyle(saveAttempted && !form.code.trim())}
                                    placeholder="例：2330"
                                    value={form.code}
                                    onChange={e => handleCodeChange(e.target.value)}
                                    onFocus={() => { if (codeSuggestions.length > 0) setShowCodeSuggestions(true) }}
                                    onBlur={() => setTimeout(() => setShowCodeSuggestions(false), 150)}
                                />
                                <RequiredFieldMessage show={saveAttempted && !form.code.trim()} label="股票代號" />
                                {renderSuggestions(codeSuggestions, showCodeSuggestions)}
                            </div>
                            <div style={{ position: 'relative' }}>
                                <label style={lbl}>股票名稱 {(lookingUp || lookingUpName) && <span style={{ color: 'var(--c-muted)', fontSize: '10px' }}>查詢中...</span>}</label>
                                <input style={inp} placeholder="可輸入名稱反查代號" value={form.name} onChange={e => handleNameChange(e.target.value)}
                                    onFocus={() => { if (nameSuggestions.length > 0) setShowNameSuggestions(true) }}
                                    onBlur={() => setTimeout(() => setShowNameSuggestions(false), 150)} />
                                {renderSuggestions(nameSuggestions, showNameSuggestions)}
                            </div>
                        </div>
                        <div className="trade-form-execution">
                            <div>
                                <label style={lbl}>價格</label>
                                <input type="number" style={requiredErrorStyle(saveAttempted && !(form.price > 0))} placeholder="0" value={form.price || ''} onChange={e => handleChange('price', parseFloat(e.target.value) || 0)} />
                                <RequiredFieldMessage show={saveAttempted && !(form.price > 0)} label="價格" />
                            </div>
                            <div>
                                <label style={lbl}>股數</label>
                                <input type="number" style={requiredErrorStyle(saveAttempted && !(form.shares > 0))} placeholder="0" value={form.shares || ''} onChange={e => handleChange('shares', parseInt(e.target.value) || 0)} />
                                <RequiredFieldMessage show={saveAttempted && !(form.shares > 0)} label="股數" />
                            </div>
                            <TradeSettlementDetails form={form} onChange={(key, value) => handleChange(key, value)} />
                            <div>
                                <label style={lbl}>備註</label>
                                <input style={inp} placeholder="選填" value={form.note} onChange={e => handleChange('note', e.target.value)} />
                            </div>
                            <TradeMarginToggle checked={!!form.isMargin} onChange={value => handleChange('isMargin', value)} />
                        </div>
                        <div className="trades-grid trade-form-extra">
                            {duplicateTrade && (
                                <div className="span2" style={{ backgroundColor: 'color-mix(in srgb, var(--c-warning) 10%, transparent)', border: '1px solid var(--c-warning)', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: 'var(--c-warning)', lineHeight: 1.6 }}>
                                    ⚠️ 已有相同日期、買賣、代號、價格與股數的交易，這筆可能重複。
                                </div>
                            )}
                            <MarginTradeFields form={form} estimate={marginRepaymentEstimate} onChange={handleChange} onRepayChange={handleMarginRepayChange} />
                            {oversellWarning && (
                                <div className="span2" style={{ backgroundColor: 'color-mix(in srgb, var(--c-danger) 10%, transparent)', border: '1px solid var(--c-danger)', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: 'var(--c-danger)', lineHeight: 1.6 }}>
                                    ⚠️ 賣出股數（{form.shares.toLocaleString()}）超過 {form.code} 目前持股（{oversellWarning.held.toLocaleString()} 股）。
                                    系統已禁止儲存超賣；請降低股數或先補登該日期以前的買入紀錄。
                                </div>
                            )}
                            {sellMarginWarning && (
                                <div className="span2" style={{ backgroundColor: 'color-mix(in srgb, var(--c-warning) 10%, transparent)', border: '1px solid var(--c-warning)', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: 'var(--c-warning)', lineHeight: 1.6 }}>
                                    ⚠️ {form.code} 目前有融資部位（{sellMarginWarning.shares.toLocaleString()} 股、借款約 {Math.round(sellMarginWarning.marginAmount).toLocaleString()} 元）。
                                    此筆為「現股賣出」，不會歸還融資借款；若實際是融資賣出，請開啟「融資」開關並填入償還金額，否則維持率與可用現金會失真。
                                </div>
                            )}
                        </div>
                        </div>
                        <div className="mobile-sticky-actions trade-form-footer">
                            <div className="trade-form-actions">
                            {editingId && <button style={btn('var(--c-border)')} onClick={handleCancel}><X size={14} />取消</button>}
                            <TradeDayTradeExceptions form={form} onChange={handleChange} onReview={() => {
                                setShowDayTradeDetails(true)
                                requestAnimationFrame(() => document.getElementById('day-trade-review')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
                            }} />
                            <button style={btn('var(--c-accent)')} onClick={handleSave} disabled={loading || !!oversellWarning}>
                                <Check size={14} />{loading ? '儲存中...' : editingId ? '確認更新' : '確認新增'}
                            </button>
                            </div>
                        </div>
                    </div>
                )}

                <DayTradePanel trades={trades} onChanged={load} showDetails={showDayTradeDetails} onClose={() => setShowDayTradeDetails(false)} />
                {/* 列表 */}
                <div style={card}>
                    {filtered.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '48px', color: 'var(--c-muted)' }}>
                            {search ? `找不到「${search}」相關紀錄` : '還沒有交易紀錄'}
                        </div>
                    ) : isMobile ? (
                        <div>
                            {filtered.map(trade => (
                                <div key={trade.id} className="trade-card">
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                                        onClick={() => setExpandedId(expandedId === trade.id ? null : trade.id!)}>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', flex: 1, minWidth: 0 }}>
                                            <span style={{ backgroundColor: trade.type === 'buy' ? 'rgba(255,87,87,0.15)' : 'color-mix(in srgb, var(--c-positive) 15%, transparent)', color: trade.type === 'buy' ? 'var(--c-danger)' : 'var(--c-positive)', padding: '2px 8px', borderRadius: '20px', fontSize: '11px', fontWeight: 600, flexShrink: 0 }}>
                                                {trade.type === 'buy' ? '買' : '賣'}
                                            </span>
                                            {trade.isMargin && (
                                                <span style={{ backgroundColor: 'rgba(245,166,35,0.15)', color: 'var(--c-warning)', padding: '1px 6px', borderRadius: '20px', fontSize: '10px', fontWeight: 600, flexShrink: 0 }}>融資</span>
                                            )}
                                            {isOddLot(trade.shares) && (
                                                <span style={{ backgroundColor: 'color-mix(in srgb, var(--c-warning) 12%, transparent)', color: 'var(--c-warning)', padding: '1px 6px', borderRadius: '20px', fontSize: '10px', fontWeight: 600, flexShrink: 0 }}>零股</span>
                                            )}
                                            <TradeDayTradeBadge shares={trade.shares} matchedShares={dayTradeAnalysis.matchedShares.get(trade) || 0} />
                                            <span style={{ color: 'var(--c-accent)', fontWeight: 700, fontSize: '14px', flexShrink: 0 }}>{trade.code}</span>
                                            <span style={{ color: 'var(--c-text)', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{trade.name}</span>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                                            <span style={{ color: trade.type === 'buy' ? 'var(--c-danger)' : 'var(--c-positive)', fontWeight: 600, fontSize: '13px' }}>
                                                ${trade.total.toLocaleString()}
                                            </span>
                                            {expandedId === trade.id ? <ChevronUp size={14} color="var(--c-muted)" /> : <ChevronDown size={14} color="var(--c-muted)" />}
                                        </div>
                                    </div>
                                    {expandedId === trade.id && (
                                        <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--c-border)' }}>
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '10px' }}>
                                                {[
                                                    { label: '日期', value: trade.date },
                                                    { label: '價格', value: trade.price.toLocaleString() },
                                                    { label: '股數', value: `${trade.shares.toLocaleString()}${isOddLot(trade.shares) ? ' (零股)' : ''}` },
                                                    { label: '手續費', value: trade.fee.toLocaleString() },
                                                    { label: '交易稅', value: trade.tax.toLocaleString() },
                                                    { label: '備註', value: trade.note || '—' },
                                                ].map(({ label, value }) => (
                                                    <div key={label}>
                                                        <div style={{ fontSize: '10px', color: 'var(--c-muted)' }}>{label}</div>
                                                        <div style={{ fontSize: '13px', color: 'var(--c-text)' }}>{value}</div>
                                                    </div>
                                                ))}
                                            </div>
                                            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                                                <button onClick={() => handleEdit(trade)} style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)', fontSize: '12px', padding: '6px 12px' }}>
                                                    <Pencil size={12} />編輯
                                                </button>
                                                <button onClick={() => handleDelete(trade.id!)} style={{ ...btn('rgba(255,87,87,0.15)'), color: 'var(--c-danger)', fontSize: '12px', padding: '6px 12px' }}>
                                                    <Trash2 size={12} />刪除
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <>
                        <div className="trade-table-wrap">
                            <table className="trade-table">
                                <thead>
                                    <tr>
                                        <th>日期</th>
                                        <th>類型</th>
                                        <th>代號</th>
                                        <th>名稱</th>
                                        <th>價格</th>
                                        <th>股數</th>
                                        <th>手續費</th>
                                        <th>交易稅</th>
                                        <th>收付金額</th>
                                        <th>備註</th>
                                        <th aria-label="操作" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {desktopPageRows.map(trade => (
                                        <tr key={trade.id} style={{ backgroundColor: editingId === trade.id ? 'rgba(79,142,247,0.06)' : 'transparent' }}>
                                            <td>{trade.date}</td>
                                            <td>
                                                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                                                    <span style={{ backgroundColor: trade.type === 'buy' ? 'rgba(255,87,87,0.15)' : 'color-mix(in srgb, var(--c-positive) 15%, transparent)', color: trade.type === 'buy' ? 'var(--c-danger)' : 'var(--c-positive)', padding: '2px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 600 }}>{trade.type === 'buy' ? '買入' : '賣出'}</span>
                                                    {trade.isMargin && <span style={{ backgroundColor: 'rgba(245,166,35,0.15)', color: 'var(--c-warning)', padding: '2px 6px', borderRadius: '20px', fontSize: '10px', fontWeight: 600 }}>融資</span>}
                                                    {isOddLot(trade.shares) && <span style={{ backgroundColor: 'color-mix(in srgb, var(--c-warning) 12%, transparent)', color: '#d3d3d3', padding: '2px 6px', borderRadius: '20px', fontSize: '10px', fontWeight: 600 }}>零股</span>}
                                                    <TradeDayTradeBadge shares={trade.shares} matchedShares={dayTradeAnalysis.matchedShares.get(trade) || 0} />
                                                </div>
                                            </td>
                                            <td style={{ color: 'var(--c-accent)', fontWeight: 700 }}>{trade.code}</td>
                                            <td>{trade.name}</td>
                                            <td>{trade.price.toLocaleString()}</td>
                                            <td>{trade.shares.toLocaleString()}</td>
                                            <td>{trade.fee.toLocaleString()}</td>
                                            <td>{trade.tax.toLocaleString()}</td>
                                            <td style={{ color: trade.type === 'buy' ? 'var(--c-danger)' : 'var(--c-positive)', fontWeight: 600 }}>{trade.total.toLocaleString()}</td>
                                            <td style={{ color: 'var(--c-muted)' }}>{trade.note}</td>
                                            <td>
                                                <div style={{ display: 'flex', gap: '8px' }}>
                                                    <button onClick={() => handleEdit(trade)} style={{ background: 'none', border: 'none', color: 'var(--c-accent)', cursor: 'pointer' }}><Pencil size={15} /></button>
                                                    <button onClick={() => handleDelete(trade.id!)} style={{ background: 'none', border: 'none', color: 'var(--c-danger)', cursor: 'pointer' }}><Trash2 size={15} /></button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <div className="trade-pagination">
                            <span>顯示 {desktopRangeStart}–{desktopRangeEnd} 筆，共 {filtered.length} 筆</span>
                            <div className="trade-pagination-actions">
                                <button type="button" onClick={() => setDesktopPage(Math.max(1, safeDesktopPage - 1))} disabled={safeDesktopPage <= 1}>
                                    <ChevronLeft size={14} />上一頁
                                </button>
                                <span>第 {safeDesktopPage}／{totalDesktopPages} 頁</span>
                                <button type="button" onClick={() => setDesktopPage(Math.min(totalDesktopPages, safeDesktopPage + 1))} disabled={safeDesktopPage >= totalDesktopPages}>
                                    下一頁<ChevronRight size={14} />
                                </button>
                            </div>
                        </div>
                        </>
                    )}
                </div>
            </div>
        </>
    )
}

const DESKTOP_PAGE_SIZE = 50
