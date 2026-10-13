import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
const calcSource = readFileSync(new URL('../src/lib/calc.ts', import.meta.url), 'utf8')
const output = ts.transpileModule(calcSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { calcAvailableCash, aggregateMarginDebt } = await import('data:text/javascript;base64,' + Buffer.from(output).toString('base64'))

/** Read-only: never rewrites NAV or pretends that historical prices were verified. */
export function auditBackupHistory(backup) {
  if (!backup?.invest || typeof backup.invest !== 'object') throw Error('缺少 invest 備份資料')
  const rows = col => (backup.invest[col] || []).map(row => ({ ...row.data, id: row.id }))
  const trades = rows('trades'), dividends = rows('dividends'), cashflow = rows('cashflow')
  const findings = rows('assetSnapshots').filter(snapshot => snapshot._placeholder !== true).map(snapshot => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.date || '') || !Number.isFinite(Date.parse(snapshot.date + 'T00:00:00Z')) || new Date(snapshot.date + 'T00:00:00Z').toISOString().slice(0, 10) !== snapshot.date || !Number.isFinite(snapshot.totalAssets)) return { id: snapshot.id, status: 'invalid' }
    const cash = Math.round(calcAvailableCash(cashflow, trades, dividends, snapshot.date))
    const marginDebt = Math.round(aggregateMarginDebt(trades, snapshot.date))
    const issues = []
    if (!Number.isFinite(cash) || !Number.isFinite(snapshot.cash) || Math.abs(snapshot.cash - cash) > 1) issues.push('cash-mismatch')
    if (!Number.isFinite(marginDebt) || !Number.isFinite(snapshot.marginDebt) || Math.abs(snapshot.marginDebt - marginDebt) > 1) issues.push('debt-mismatch')
    if (!Number.isFinite(snapshot.marketValue) || !Number.isFinite(snapshot.cash) || !Number.isFinite(snapshot.marginDebt) || Math.abs(snapshot.totalAssets - (snapshot.marketValue + snapshot.cash - snapshot.marginDebt)) > 1) issues.push('nav-components-mismatch')
    return { id: snapshot.id, date: snapshot.date, issues, expectedCash: cash, expectedMarginDebt: marginDebt, historicalMarketValueVerified: false }
  })
  return { readOnly: true, note: '僅依備份帳本核對現金、負債與淨值組成；歷史價格與券商帳務未驗證。', findings }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw Error('用法：node scripts/audit-backup-history.mjs <備份.json>（唯讀）')
  console.log(JSON.stringify(auditBackupHistory(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2))
}
