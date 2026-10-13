import { confirmAction } from '../ui/dialogs'
import { useMemo, useState } from 'react'
import { getDocsFromServer } from 'firebase/firestore'
import { analyzeDayTrades, usesManualDayTradeMatching, type DayTradePair, type TradeRecord } from '../lib/calc'
import { investDB } from '../lib/firebase'
import { captureUserSession } from '../lib/userDB'
import { commitLedgerWrites } from '../lib/ledgerWrites'
import { invalidateTrades } from '../lib/investData'
import { card, inp, btn } from '../ui/styles'
import { getDayTradeAttention } from '../lib/dayTradePresentation'

type PairStatus = 'automatic' | 'confirmed' | 'candidate'
type Action = 'manual' | 'auto' | 'exclude'

function PairRow({ pair, status, busy, onSave }: {
    pair: DayTradePair; status: PairStatus; busy: boolean
    onSave: (pair: DayTradePair, shares: number) => void
}) {
    const [quantity, setQuantity] = useState(pair.shares)
    const [editing, setEditing] = useState(false)
    return <div style={{ borderTop: '1px solid var(--c-border)', padding: '10px 0', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', fontSize: '13px' }}>
        <span style={{ flex: '1 1 260px' }}>
            <strong>{status === 'automatic' ? '自動沖抵' : status === 'confirmed' ? '人工指定' : '待核對'} · {pair.sell.date} · {pair.sell.code} {pair.sell.name}</strong><br />
            買 {pair.buy.price} → 賣 {pair.sell.price} · {pair.shares.toLocaleString()} 股
        </span>
        {!editing ? <button type="button" className="ui-button ui-button-secondary" disabled={busy} onClick={() => setEditing(true)}>{status === 'candidate' ? '依券商指定' : '修正股數'}</button> : <>
            <input aria-label={`${pair.sell.code} 沖抵股數`} type="number" min={0} max={pair.shares} step={1000} value={quantity}
                onChange={e => setQuantity(Number(e.target.value))} style={{ ...inp, width: '110px' }} />
            <button type="button" style={btn('var(--c-accent)')} disabled={busy || !Number.isInteger(quantity) || quantity < 0 || quantity > pair.shares || quantity % 1000 !== 0}
                onClick={() => onSave(pair, quantity)}>套用修正</button>
            <button type="button" className="ui-button ui-button-secondary" onClick={() => setEditing(false)}>取消</button>
        </>}
    </div>
}

export default function DayTradePanel({ trades, onChanged, showDetails = false, onClose }: {
    trades: TradeRecord[]; onChanged: () => Promise<void>; showDetails?: boolean; onClose?: () => void
}) {
    const analysis = useMemo(() => analyzeDayTrades(trades), [trades])
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState('')
    const { pending, tradesNeedingAttention, count } = getDayTradeAttention(trades, analysis)
    const overrides = trades.filter(t => t.type === 'sell' && (usesManualDayTradeMatching(t) || t.dayTradeExcluded))
    const autoSells = [...new Set(analysis.automatic.map(pair => pair.sell))]

    const save = async (sellId: string, action: Action, pair?: DayTradePair, shares = 0, candidate = false) => {
        const prompt = action === 'auto' ? '恢復依同日買賣自動沖抵？持倉成本與損益將重新計算。'
            : action === 'exclude' ? '依券商結果排除此筆賣出的當沖，改用一般庫存成本？'
            : '依券商實際股數修正此筆賣出的沖抵？未指定的剩餘股數將使用一般庫存成本，費稅不變。'
        if (!await confirmAction(prompt)) return
        setBusy(true); setMessage('')
        try {
            const session = captureUserSession()
            const fresh = await getDocsFromServer(session.col(investDB, 'trades'))
            session.assertActive()
            const source = fresh.docs.find(d => d.id === sellId)
            if (!source) throw new Error('賣出紀錄已不存在，請重新載入。')
            const group = fresh.docs.filter(d => d.id === sellId || (d.data().date === source.data().date && d.data().code === source.data().code))
            {
                const rows = group.map(d => ({ ...d.data(), id: d.id }) as TradeRecord)
                const sell = rows.find(t => t.id === sellId)
                if (!sell) throw new Error('賣出紀錄已不存在，請重新載入。')
                const before = analyzeDayTrades(rows)
                let links: NonNullable<TradeRecord['dayTradeMatches']> = []
                if (action === 'manual' && pair) {
                    const buy = rows.find(t => t.id === pair.buy.id)
                    if (!buy || [buy, sell].some((row, i) => {
                        const previous = i === 0 ? pair.buy : pair.sell
                        return row.price !== previous.price || row.shares !== previous.shares || row.code !== previous.code
                            || row.date !== previous.date || (row.brokerAccount || '') !== (previous.brokerAccount || '')
                    })) throw new Error('成交資料已變更，請重新核對。')
                    const availablePair = (candidate ? before.candidates : [...before.automatic, ...before.confirmed]).find(p => p.sell === sell && p.buy === buy)
                    if (!availablePair || availablePair.shares !== pair.shares || shares > availablePair.shares) throw new Error('配對股數已變更，請重新核對。')
                    links = [...before.confirmed, ...before.automatic].filter(p => p.sell === sell).map(p => ({ buyId: p.buy.id!, shares: p.shares }))
                    const prior = links.filter(link => link.buyId === buy.id).reduce((sum, link) => sum + link.shares, 0)
                    links = links.filter(link => link.buyId !== buy.id)
                    const qty = shares + (candidate ? prior : 0)
                    if (qty > 0) links.push({ buyId: buy.id!, shares: qty })
                }
                const patch = { dayTradeMode: action === 'auto' ? 'auto' as const : 'manual' as const,
                    dayTradeExcluded: action === 'exclude', dayTradeMatches: links,
                    ...(action === 'exclude' ? { dayTradePending: false } : {}) }
                const next = { ...sell, ...patch }
                const after = analyzeDayTrades(rows.map(t => t === sell ? next : t))
                const oldIssues = new Set(before.issues.map(issue => issue.trade.id))
                if (after.issues.some(issue => issue.trade === next || !oldIssues.has(issue.trade.id))) throw new Error('配對條件不符或超過可用股數，請重新核對。')
                await commitLedgerWrites([{ collection: 'trades', id: sellId, data: { ...next }, mode: 'update', expected: source.data() }], session)
            }
            invalidateTrades(); await onChanged()
            setMessage('沖抵方式已更新，持倉成本與損益會同步重算；費稅不變。')
        } catch (error) { setMessage(error instanceof Error ? error.message : '更新失敗，請稍後再試。') }
        finally { setBusy(false) }
    }

    if (!showDetails && count === 0) return null

    return <details id="day-trade-review" style={{ ...card, marginBottom: '16px' }} open>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>{showDetails
            ? '當日沖銷明細'
            : `當沖交易待核對 · ${count} 筆`}</summary>
        {showDetails && onClose && <button type="button" className="ui-button ui-button-secondary" style={{ marginTop: '10px' }} onClick={onClose}>關閉明細</button>}
        <p style={{ color: 'var(--c-muted)', fontSize: '12px', lineHeight: 1.7 }}>同股同日的現股整張自動沖抵，剩餘列庫存；零股、鉅額、融資及排除交易不配對，以券商認列為準。</p>
        {message && <p role="status">{message}</p>}
        {analysis.issues.map(issue => <div key={issue.trade.id} role="alert" style={{ color: 'var(--c-danger)', marginBottom: '10px' }}>
            {issue.trade.date} {issue.trade.code}：{issue.message}
            <button type="button" style={btn('var(--c-accent)')} disabled={busy} onClick={() => void save(issue.trade.id!, 'auto')}>清除失效指定，恢復自動</button>
        </div>)}
        {analysis.uncertain.length > 0 && <p role="alert" style={{ color: 'var(--c-warning)', fontSize: '12px' }}>有 {analysis.uncertain.length} 筆同日買賣含混合股數，無法僅憑股數區分普通交易或零股彙總；未自動沖抵不明類別的股數，請拆成實際成交或依券商指定下方配對。</p>}
        {pending.length > 0 && <p role="alert" style={{ color: 'var(--c-warning)', fontSize: '12px' }}>有 {pending.length} 筆待回補尚未完全沖抵。補登買入後會自動重算；未配對且超出庫存的賣出不納入持倉損益，現金仍按原始收付計算，報表暫不完整。</p>}
        {[...analysis.automatic.map(pair => ({ pair, status: 'automatic' as const })), ...analysis.confirmed.map(pair => ({ pair, status: 'confirmed' as const })), ...analysis.candidates.map(pair => ({ pair, status: 'candidate' as const }))]
            .filter(({ pair }) => showDetails || tradesNeedingAttention.has(pair.sell))
            .map(({ pair, status }) => <PairRow key={`${pair.sell.id}:${pair.buy.id}:${status}:${pair.shares}`} pair={pair} status={status} busy={busy}
                onSave={(p, qty) => void save(p.sell.id!, 'manual', p, qty, status === 'candidate')} />)}
        {[...autoSells, ...overrides].filter(sell => showDetails || tradesNeedingAttention.has(sell)).map(sell => <div key={sell.id} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginTop: '8px', fontSize: '12px', color: 'var(--c-muted)' }}>
            <span>{sell.date} {sell.code} · 賣出 {sell.shares.toLocaleString()} 股{sell.dayTradeExcluded ? '（已排除）' : ''}</span>
            <button type="button" className="ui-button ui-button-secondary" disabled={busy}
                onClick={() => void save(sell.id!, autoSells.includes(sell) ? 'exclude' : 'auto')}>{autoSells.includes(sell) ? '券商未認列，排除此筆' : '恢復自動沖抵'}</button>
        </div>)}
        {!analysis.automatic.length && !analysis.confirmed.length && !analysis.candidates.length && <p style={{ color: 'var(--c-muted)', fontSize: '12px' }}>目前沒有可沖抵的現股買賣。</p>}
    </details>
}
