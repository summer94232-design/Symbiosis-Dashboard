import { getDocFromServer, getDocsFromServer, runTransaction } from 'firebase/firestore'
import { investDB } from './firebase'
import { captureUserSession } from './userDB'
import { assertNoNewOversells } from './ledgerIntegrity'
import { analyzeDayTrades, type TradeRecord, type DividendRecord } from './calc'
import { validateTradeForWrite, validateDividendForWrite } from './investmentValidation'

export interface LedgerWrite {
    collection: 'trades' | 'dividends'
    id: string
    data?: Record<string, unknown>
    mode?: 'create' | 'update' | 'upsert'
    expected?: Record<string, unknown>
}
type Ledger = { trades: TradeRecord[]; dividends: DividendRecord[] }
class LedgerChanged extends Error {}
const revisionValue = (data: Record<string, unknown> | undefined): number => {
    const value = data?.revision ?? 0
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('帳本版本無效，請先確認資料。')
    return value as number
}
const comparable = (value: unknown): string => JSON.stringify(value, (key, item) => key === 'id' ? undefined
    : item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)

export function applyLedgerWrites(before: Ledger, writes: LedgerWrite[]): Ledger {
    const trades = new Map(before.trades.map(row => [row.id, row]))
    const dividends = new Map(before.dividends.map(row => [row.id, row]))
    for (const write of writes) {
        const rows = write.collection === 'trades' ? trades : dividends
        if (write.data) rows.set(write.id, { ...write.data, id: write.id } as TradeRecord & DividendRecord)
        else rows.delete(write.id)
    }
    return { trades: [...trades.values()], dividends: [...dividends.values()] }
}

export function validateLedgerWrites(before: Ledger, writes: LedgerWrite[]): Ledger {
    const after = applyLedgerWrites(before, writes)
    const eventKey = (row: DividendRecord) => `${row.code.trim().toUpperCase().replace(/\.(TW|TWO)$/, '')}-${row.date}`
    for (const write of writes) {
        if (write.collection !== 'dividends' || !write.data) continue
        const key = eventKey(write.data as unknown as DividendRecord)
        const previous = before.dividends.filter(row => eventKey(row) === key)
        const current = after.dividends.filter(row => eventKey(row) === key)
        if (current.length > Math.max(previous.length, 1) && current.some(row => row.sourceAnnouncementId)) {
            throw new Error('這筆除權息已有紀錄，請重新載入並核對實領金額；尚未重複新增。')
        }
    }
    assertNoNewOversells(before, after)
    const issues = new Map(analyzeDayTrades(before.trades, false).issues.map(issue => [issue.trade.id, issue.message]))
    const invalid = analyzeDayTrades(after.trades, false).issues.find(issue => issues.get(issue.trade.id) !== issue.message)
    if (invalid) throw new Error(`${invalid.trade.date} ${invalid.trade.code}：${invalid.message}`)
    return after
}

/** All inventory-changing writers share this revision. A conflicting transaction reloads the whole ledger. */
export async function commitLedgerWrites(writes: LedgerWrite[], session = captureUserSession(), stockNames: Record<string, string> = {}): Promise<void> {
    if (!writes.length) return
    if (writes.length > 400) throw new Error('單次帳本寫入超過 400 筆，請分批處理。')
    if (writes.length + Object.keys(stockNames).length > 499 || Object.keys(stockNames).some(code => !code || code.includes('/'))) throw new Error('股票名稱更新格式無效或筆數過多。')
    const keys = new Set<string>()
    for (const write of writes) {
        const key = `${write.collection}/${write.id}`
        if (!write.id || write.id.includes('/') || keys.has(key)) throw new Error('帳本文件 ID 無效或重複')
        keys.add(key)
        if (write.data) {
            const data = { fee: 0, tax: 0, ...write.data }
            const validation = write.collection === 'trades' ? validateTradeForWrite(data as unknown as TradeRecord)
                : validateDividendForWrite(data as unknown as DividendRecord)
            if (!validation.valid) throw new Error(validation.errors.join('；'))
        }
    }
    const revisionRef = session.doc(investDB, 'ledgerControl', 'revision')
    for (let attempt = 0; attempt < 5; attempt++) {
        session.assertActive()
        const baseline = await getDocFromServer(revisionRef)
        const revision = revisionValue(baseline.data())
        const [trades, dividends] = await Promise.all(['trades', 'dividends'].map(name => getDocsFromServer(session.col(investDB, name))))
        session.assertActive()
        const before: Ledger = {
            trades: trades.docs.map(row => ({ ...row.data(), id: row.id }) as TradeRecord),
            dividends: dividends.docs.map(row => ({ ...row.data(), id: row.id }) as DividendRecord),
        }
        try {
            await runTransaction(investDB, async tx => {
                const currentRevision = await tx.get(revisionRef)
                session.assertActive()
                if (revisionValue(currentRevision.data()) !== revision) throw new LedgerChanged()
                const refs = writes.map(write => session.doc(investDB, write.collection, write.id))
                const current = await Promise.all(refs.map(ref => tx.get(ref)))
                session.assertActive()
                const effective = writes.filter((write, index) => {
                    const previous = before[write.collection].find(row => row.id === write.id)
                    if (comparable(current[index].data()) !== comparable(previous)) throw new LedgerChanged()
                    if (write.expected && comparable(current[index].data()) !== comparable(write.expected)) throw new Error('成交資料已變更，請重新核對。')
                    if (write.mode === 'update' && !current[index].exists()) throw new Error('紀錄已被刪除，請重新整理。')
                    if (write.mode === 'create' && current[index].exists()) {
                        const plain = (row: Record<string, unknown>) => { const copy = { ...row }; delete copy.createdAt; delete copy.sequence; return copy }
                        if (comparable(plain(current[index].data()!)) !== comparable(plain(write.data!))) throw new Error('這個文件 ID 已有不同資料，尚未覆寫。')
                        return false // Stable-ID retry after a lost response.
                    }
                    return true
                })
                validateLedgerWrites(before, effective)
                for (const write of effective) {
                    const ref = session.doc(investDB, write.collection, write.id)
                    if (write.data) tx.set(ref, write.data)
                    else tx.delete(ref)
                }
                if (effective.length) tx.set(revisionRef, { revision: revision + 1, updatedAt: new Date().toISOString() })
                for (const [code, name] of Object.entries(stockNames)) tx.set(session.doc(investDB, 'stockDict', code), { name })
            })
            return
        } catch (error) {
            if (error instanceof LedgerChanged) continue
            // Rules can reject a stale revision before the SDK reports a transaction conflict.
            const code = (error as { code?: string })?.code
            if (code === 'permission-denied' || code === 'aborted') {
                const latest = await getDocFromServer(revisionRef)
                session.assertActive()
                if (revisionValue(latest.data()) !== revision) continue
            }
            throw error
        }
    }
    throw new Error('帳本持續由其他裝置更新，尚未寫入；請重新整理後再試。')
}

/** Plan every intermediate state before a large restore starts writing. */
export function planLedgerRestore(before: Ledger, writes: LedgerWrite[]): LedgerWrite[][] {
    validateLedgerWrites(before, writes)
    if (writes.length <= 400) return writes.length ? [writes] : []
    const batches: LedgerWrite[][] = []
    let state = before, remaining = [...writes], chunk: LedgerWrite[] = []
    while (remaining.length) {
        const deferred: LedgerWrite[] = []
        let progressed = false
        for (const write of remaining) {
            try { state = validateLedgerWrites(state, [write]) } catch { deferred.push(write); continue }
            chunk.push(write); progressed = true
            if (chunk.length === 400) { batches.push(chunk); chunk = [] }
        }
        if (!progressed) throw new Error('這份大型備份的相依帳務無法安全分批還原，尚未寫入；請先將相依交易整理為 400 筆以內。')
        remaining = deferred
    }
    if (chunk.length) batches.push(chunk)
    return batches
}

export async function commitLedgerRestore(writes: LedgerWrite[], session = captureUserSession(), onCommitted?: (count: number) => void): Promise<void> {
    if (!writes.length) return
    const [trades, dividends] = await Promise.all(['trades', 'dividends'].map(name => getDocsFromServer(session.col(investDB, name))))
    session.assertActive()
    const before = {
        trades: trades.docs.map(row => ({ ...row.data(), id: row.id }) as TradeRecord),
        dividends: dividends.docs.map(row => ({ ...row.data(), id: row.id }) as DividendRecord),
    }
    for (const batch of planLedgerRestore(before, writes)) {
        await commitLedgerWrites(batch, session)
        onCommitted?.(batch.length)
    }
}
