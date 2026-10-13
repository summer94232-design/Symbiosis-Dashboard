import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { auditBackupHistory } from './audit-backup-history.mjs'

// Use the same pure functions as the application, without Firebase or mutations.
async function load(name) {
    const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8')
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    return import('data:text/javascript;base64,' + Buffer.from(output).toString('base64'))
}
const calc = await load('calc')
const broker = await load('brokerReconciliation')
const monthly = await load('brokerMonthlyReconciliation')
const round = value => Math.round(value * 100) / 100
const rows = (backup, collection) => (backup.invest[collection] ?? []).filter(row => !row.data?._placeholder).map(row => ({ ...row.data, id: row.id }))
const net = trades => trades.reduce((sum, row) => sum + (row.type === 'buy' ? -row.total : row.total), 0)

export function auditBrokerStatement(backup, rawText, sourceFile = '') {
    if (!backup?.invest || !Array.isArray(backup.invest.trades)) throw new Error('缺少 invest.trades 備份資料')
    if ((rawText.match(/對帳單期間\s*[:：]/g) ?? []).length !== 1) throw new Error('請逐份核對單月對帳單')
    const period = broker.extractBrokerStatementPeriod(rawText)
    if (!period) throw new Error('未讀到對帳單期間')
    const trades = rows(backup, 'trades'), dividends = rows(backup, 'dividends'), cashflows = rows(backup, 'cashflow')
    const brokerTrades = broker.parseBrokerStatementText(rawText)
    const details = monthly.parseYuantaMonthlyDetails(rawText)
    const systemTrades = trades.filter(row => row.date >= period.from && row.date <= period.to).map(row => {
        if (!row.isMargin || row.type !== 'sell') return row
        const principal = row.marginPrincipal ?? calc.estimateMarginRepayment(row, trades).principal
        return { ...row, marginPrincipal: principal, marginInterest: row.marginInterest ?? (row.marginRepay !== undefined ? row.marginRepay - principal : undefined) }
    })
    const tradeChecks = broker.reconcileBrokerTrades(brokerTrades, systemTrades, 'monthly')
    const holdings = calc.calcPositions(trades, dividends, { asOf: period.to }).holdings
    const combinedHoldings = monthly.combinedBrokerHoldings(details)
    const holdingChecks = monthly.reconcileMonthlyHoldings(combinedHoldings, holdings)
    const cash = monthly.reconcileMonthlyCash(details.cashBalance, calc.calcAvailableCash(cashflows, trades, dividends, period.to), period.to, brokerTrades)
    const snapshot = rows(backup, 'assetSnapshots').find(row => row.date === period.to)
    const debt = calc.aggregateMarginDebt(trades, period.to)
    const missingPrices = Object.values(holdings).filter(row => row.shares > 0 && !combinedHoldings.some(b => b.code === row.code && b.referencePrice !== undefined)).map(row => row.code)
    const systemMarketValueAtStatementPrices = missingPrices.length ? null : combinedHoldings.reduce((sum, row) => sum + calc.calcGrossAmount(row.referencePrice ?? 0, holdings[row.code]?.shares ?? 0), 0)
    const brokerMarketValue = combinedHoldings.reduce((sum, row) => sum + (row.marketValue ?? 0), 0)
    const brokerTradeDateNetAssets = details.netAssets === undefined ? null : details.netAssets + cash.unsettledNet
    return {
        sourceFile, period, controls: broker.verifyBrokerStatementTotals(rawText, brokerTrades),
        counts: { broker: brokerTrades.length, candidates: broker.countBrokerTradeCandidates(rawText), system: systemTrades.length, groups: tradeChecks.length, matchedGroups: tradeChecks.filter(row => row.status === 'matched').length },
        monthlyTradeNet: { broker: round(brokerTrades.reduce((sum, row) => sum + (row.total ?? 0), 0)), system: round(net(systemTrades)), systemMinusBroker: round(net(systemTrades) - brokerTrades.reduce((sum, row) => sum + (row.total ?? 0), 0)) },
        tradeIssues: tradeChecks.filter(row => row.status !== 'matched'),
        holdingChecks, cash, details,
        dividendChecks: monthly.reconcileMonthlyDividends(monthly.resolveBrokerDividendCodes(details.dividends, dividends, combinedHoldings), dividends, period.from, period.to),
        valuation: { brokerMarketValue, systemMarketValueAtStatementPrices, missingPrices, debt,
            brokerReportedNetAssets: details.netAssets, brokerTradeDateNetAssets,
            rebuiltSystemTradeDateNetAssets: systemMarketValueAtStatementPrices === null ? null : round(systemMarketValueAtStatementPrices + cash.systemProjectedCash - debt),
            storedSnapshot: snapshot,
            snapshotMinusBrokerTradeDateNetAssets: snapshot && brokerTradeDateNetAssets !== null ? round(snapshot.totalAssets - brokerTradeDateNetAssets) : null },
        brokerTrades, systemTrades,
    }
}

export async function readStatementPdf(path) {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: true })
    const doc = await task.promise
    const pages = []
    try {
        for (let n = 1; n <= doc.numPages; n++) {
            const content = await (await doc.getPage(n)).getTextContent()
            pages.push(`--- ${basename(path)} 第 ${n} 頁 ---\n` + content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim())
        }
    } finally { await task.destroy() }
    return pages.join('\n')
}

export function renderAuditMarkdown(report) {
    const money = value => value == null ? '未驗證' : round(value).toLocaleString('zh-TW', { maximumFractionDigits: 2 })
    const lines = ['# 元大月結與備份核對', '', '唯讀核對；原始備份、雲端帳務及歷史快照均未修改。差額方向為「券商 − 系統」，金額為新台幣元。', '',
        '| 月份 | 券商／系統成交筆數 | 相同交易組 | 月底股數一致 | 券商 CMA | 系統換算 CMA | 現金差額 |',
        '|---|---:|---:|---:|---:|---:|---:|']
    for (const m of report.months) lines.push(`| ${m.period.to.slice(0, 7)} | ${m.counts.broker}／${m.counts.system} | ${m.counts.matchedGroups}／${m.counts.groups} | ${m.holdingChecks.filter(row => row.status === 'matched').length}／${m.holdingChecks.length} | ${money(m.cash.brokerBalance)} | ${money(m.cash.systemExpectedSettledCash)} | ${money(m.cash.difference)} |`)
    lines.push('', '交易按同日、同股、同買賣方向、現股／融資彙總；合併成交不視為漏單。原始金額保留到分，只有浮點噪音容差。', '')
    for (const m of report.months) {
        lines.push(`## ${m.period.to.slice(0, 7)}`, '', `PDF 合計交叉驗證：${m.controls.length ? m.controls.join('；') : '成交金額、手續費、交易稅、客戶淨收付四項均一致'}。`, '',
            `月底後待交割淨額 ${money(m.cash.unsettledNet)}；已驗證出借市值 ${money(m.details.lentMarketValue)}。`, '',
            '| 項目 | 金額 |', '|---|---:|',
            `| 券商列示資產淨額（CMA 交割口徑） | ${money(m.valuation.brokerReportedNetAssets)} |`,
            `| 券商換算交易日淨值 | ${money(m.valuation.brokerTradeDateNetAssets)} |`,
            `| 系統按券商期末參考價重算交易日淨值 | ${money(m.valuation.rebuiltSystemTradeDateNetAssets)} |`,
            `| 備份原存快照淨值 | ${money(m.valuation.storedSnapshot?.totalAssets)} |`,
            `| 原存快照 − 券商交易日淨值 | ${money(m.valuation.snapshotMinusBrokerTradeDateNetAssets)} |`, '', '成交差異：', '')
        for (const row of m.tradeIssues) lines.push(`- ${row.key}：${row.differences.join('；')}`)
        lines.push('', '股利核對：', '')
        for (const row of m.dividendChecks) lines.push(`- ${row.date} ${row.code || row.name}：${row.status}，券商 ${money(row.brokerAmount)}／系統 ${money(row.systemAmount)}`)
        for (const row of m.details.cashEntries ?? []) if (['lending-income', 'interest', 'deposit'].includes(row.category)) lines.push(`- CMA ${row.date} ${row.description}：${money(row.amount)}`)
        lines.push('')
    }
    const history = report.history.findings
    lines.push('## 歷史快照檢查', '', `${history.length} 筆非占位快照；${history.filter(row => row.status === 'invalid').length} 筆格式錯誤；${history.filter(row => row.issues?.includes('cash-mismatch')).length} 筆現金與最新帳本不符；${history.filter(row => row.issues?.includes('debt-mismatch')).length} 筆負債不符；${history.filter(row => row.issues?.includes('nav-components-mismatch')).length} 筆組成不符。`, '',
        '除本報告核對的月底參考價外，沒有證據能驗證其他日子的收盤價或盤中／收盤時間。不可將維持舊淨值、倒推出來的市值當成券商已核實市值，也不可從月報重建每日精確 TWR。', '')
    return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [backupPath, outputDir, ...pdfs] = process.argv.slice(2)
    if (!backupPath || !outputDir || !pdfs.length) throw new Error('用法：node scripts/audit-broker-statements.mjs <備份.json> <輸出資料夾> <月結.pdf> ...')
    const backup = JSON.parse(readFileSync(backupPath, 'utf8').replace(/^\uFEFF/, ''))
    const months = []
    for (const pdf of pdfs) months.push(auditBrokerStatement(backup, await readStatementPdf(pdf), basename(pdf)))
    months.sort((a, b) => a.period.to.localeCompare(b.period.to))
    const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
    const report = { readOnly: true, generatedAt: new Date().toISOString(), sources: [backupPath, ...pdfs].map(path => ({ file: basename(path), sha256: hash(path) })), months, history: auditBackupHistory(backup) }
    mkdirSync(outputDir, { recursive: true })
    for (const path of [join(outputDir, 'audit.json'), join(outputDir, 'audit.md')]) {
        if ([backupPath, ...pdfs].some(input => resolve(input).toLowerCase() === resolve(path).toLowerCase())) throw new Error('輸出不可覆寫來源檔案')
    }
    writeFileSync(join(outputDir, 'audit.json'), JSON.stringify(report, null, 2))
    writeFileSync(join(outputDir, 'audit.md'), renderAuditMarkdown(report))
    console.log(`完成 ${months.length} 個月份：${resolve(outputDir)}`)
}
