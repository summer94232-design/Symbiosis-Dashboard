import { getDocsFromServer } from 'firebase/firestore'
import { investDB } from './firebase'
import { captureUserSession } from './userDB'
import { calcPositions, calcSharesBeforeTrade, type TradeRecord, type DividendRecord } from './calc'

interface Ledger { trades: TradeRecord[]; dividends: DividendRecord[] }
type LedgerChange = { collection: 'trades'; id: string; data?: TradeRecord }
    | { collection: 'dividends'; id: string; data?: DividendRecord }

/** Permit repairs to existing incomplete ledgers, but never add or worsen a shortfall. */
export function assertNoNewOversells(before: Ledger, after: Ledger): void {
    // 股數短缺與指定批次有效性分開檢查，允許修復已有壞連結，禁止新增壞連結。
    const shortfalls = (ledger: Ledger) => {
        const trades = ledger.trades.map(t => ({ ...t, inventoryMatches: undefined }))
        return new Map(trades.filter(t => t.type === 'sell').map(t => [
            t.id, Math.max(0, t.shares - calcSharesBeforeTrade(t, trades, ledger.dividends)),
        ]))
    }
    const previous = shortfalls(before)
    const current = shortfalls(after)
    const invalid = after.trades.find(t => t.type === 'sell'
        && (current.get(t.id) || 0) > (previous.get(t.id) || 0) + 1e-8
        // A newly entered sell-first day trade is an explicitly supported incomplete record.
        && !(t.dayTradePending && !previous.has(t.id)))
    if (invalid) throw new Error(`這項操作會讓 ${invalid.date} ${invalid.code} 的賣出缺少 ${current.get(invalid.id)} 股。請核對現股／融資類別、零股買入日期，以及是否漏登買入或配股；已成交的資料請依元大紀錄補齊。`)
    if (after.trades.some(t => t.inventoryMatches !== undefined)) calcPositions(after.trades, after.dividends)
}

/** Read the server ledger before an interactive edit/delete; no cache or remote writes.
 * This is a preflight guard, not a transaction locking all concurrent ledger writers.
 */
export async function validateLedgerChange(change: LedgerChange, session = captureUserSession()): Promise<void> {
    const [trades, dividends] = await Promise.all(['trades', 'dividends'].map(name => getDocsFromServer(session.col(investDB, name))))
    session.assertActive()
    const before: Ledger = {
        trades: trades.docs.map(d => ({ ...d.data(), id: d.id }) as TradeRecord),
        dividends: dividends.docs.map(d => ({ ...d.data(), id: d.id }) as DividendRecord),
    }
    const after: Ledger = change.collection === 'trades'
        ? { ...before, trades: [...before.trades.filter(t => t.id !== change.id), ...(change.data ? [{ ...change.data, id: change.id }] : [])] }
        : { ...before, dividends: [...before.dividends.filter(d => d.id !== change.id), ...(change.data ? [{ ...change.data, id: change.id }] : [])] }
    assertNoNewOversells(before, after)
}
