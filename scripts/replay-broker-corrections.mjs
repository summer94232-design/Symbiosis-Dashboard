import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const source = readFileSync(new URL('../src/lib/calc.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const calc = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const rows = (backup, name) => (backup.invest[name] || []).filter(x => !x.data._placeholder).map(x => ({ ...x.data, id: x.id }))
const hash = raw => createHash('sha256').update(raw).digest('hex')
const confirmed = new Set(['statement-confirmed', 'screenshot-confirmed', 'user-confirmed'])
const allowedFields = new Set(['price', 'fee', 'tax', 'total', 'marginPrincipal', 'marginInterest', 'marginRepay', 'marginRepayManual', 'inventoryMatches'])

/** Validate every old value before producing an in-memory scenario. Never writes a ledger. */
export function prepareCorrectionScenario(backup, changes) {
    const copy = structuredClone(backup)
    const seen = new Set()
    for (const change of changes) {
        const key = `${change.collection}/${change.id}`
        if (seen.has(key)) throw Error(`重複更正：${key}`)
        seen.add(key)
        if (!['trades', 'cashflow'].includes(change.collection)) throw Error(`不支援的更正類別：${change.collection}`)
        const collection = copy.invest[change.collection]
        const matches = collection?.filter(x => x.id === change.id) || []
        if (matches.length !== 1) throw Error(`來源紀錄不存在或 ID 重複：${key}`)
        const doc = matches[0]
        if (!change.before || !Object.keys(change.before).length) throw Error(`缺少原值檢查：${key}`)
        const actual = { ...doc.data, id: doc.id }
        for (const [field, expected] of Object.entries(change.before)) {
            if (JSON.stringify(actual[field] ?? null) !== JSON.stringify(expected ?? null)) throw Error(`原值已改變：${key}.${field}`)
        }
        if (change.action === 'remove') {
            if (change.collection !== 'cashflow' || change.certainty !== 'user-confirmed') throw Error(`僅允許使用者確認的非真實現金流移除：${key}`)
            copy.invest.cashflow = collection.filter(x => x.id !== change.id)
        } else {
            if (change.collection !== 'trades' || !change.after || !Object.keys(change.after).length) throw Error(`缺少成交更正值：${key}`)
            if (Object.keys(change.after).some(field => !allowedFields.has(field))) throw Error(`更正欄位不在核對範圍：${key}`)
            Object.assign(doc.data, structuredClone(change.after))
        }
    }
    return copy
}

function summarize(backup, samples, asOf) {
    const trades = rows(backup, 'trades'), dividends = rows(backup, 'dividends')
    const cash = calc.calcAvailableCash(rows(backup, 'cashflow'), trades, dividends, asOf)
    try {
        const positions = calc.calcPositions(trades, dividends, { asOf })
        const comparisons = samples.map(sample => {
            const system = positions.realized.filter(x => x.code === sample.code && x.date === sample.date).reduce((sum, x) => sum + x.realized, 0)
            return { date: sample.date, code: sample.code, broker: sample.brokerRealized, system, difference: Number((system - sample.brokerRealized).toFixed(8)) }
        })
        return { status: 'computed', cash, comparisons, exact: comparisons.filter(x => x.difference === 0).length, sampleCount: comparisons.length,
            holdings: Object.values(positions.holdings).filter(x => x.shares > 0) }
    } catch (error) {
        // A directly observed later lot may require an earlier allocation that is still conditional.
        return { status: 'needs-allocation-review', cash, error: error.message }
    }
}

export function replayCorrectionScenarios(backup, proposal, samples = [], asOf) {
    if (proposal.kind !== 'review-only-accounting-proposal' || !Array.isArray(proposal.changes)) throw Error('不是帳務核對草案')
    const unsupported = proposal.changes.filter(x => !confirmed.has(x.certainty) && x.certainty !== 'derived-from-later-offsets')
    if (unsupported.length) throw Error('草案有未分類的證據確定程度，請先標示，不能自動視為已確認')
    const money = proposal.changes.filter(x => confirmed.has(x.certainty) && x.changeKind !== 'inventory-allocation')
    const direct = proposal.changes.filter(x => confirmed.has(x.certainty))
    const conditional = proposal.changes.filter(x => x.certainty === 'derived-from-later-offsets')
    return {
        kind: 'broker-correction-replay-report', notImportable: true, readOnly: true, asOf: asOf || 'all-backup-records',
        note: '只在記憶體重播，輸出是報告而非可還原備份。樣本符合不代表全部帳戶已結案；不包含未證實的股利或手續費調整。',
        original: summarize(backup, samples, asOf),
        confirmedAmounts: { changeCount: money.length, ...summarize(prepareCorrectionScenario(backup, money), samples, asOf) },
        directEvidence: { changeCount: direct.length, ...summarize(prepareCorrectionScenario(backup, direct), samples, asOf) },
        conditionalScenario: { conditions: conditional.map(x => ({ collection: x.collection, id: x.id, date: x.date, code: x.code, reason: x.reason })),
            ...summarize(prepareCorrectionScenario(backup, [...direct, ...conditional]), samples, asOf) },
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [backupPath, proposalPath, samplesPath, outputPath, asOf] = process.argv.slice(2)
    if (!backupPath || !proposalPath || !samplesPath || !outputPath) throw Error('用法：node scripts/replay-broker-corrections.mjs <原始備份> <更正草案> <樣本JSON> <輸出報告JSON> [YYYY-MM-DD]（只讀來源）')
    if ([backupPath, proposalPath, samplesPath].some(path => resolve(path).toLowerCase() === resolve(outputPath).toLowerCase())) throw Error('報告不能覆蓋任何來源檔')
    if (asOf && (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(asOf)) || new Date(asOf).toISOString().slice(0, 10) !== asOf)) throw Error('截止日期無效')
    const raw = readFileSync(backupPath), proposal = JSON.parse(readFileSync(proposalPath, 'utf8'))
    if (hash(raw) !== proposal.sourceSha256) throw Error('備份 SHA-256 與草案來源不同，請先重新核對，不能套用舊草案')
    const sampleFile = JSON.parse(readFileSync(samplesPath, 'utf8'))
    const samples = Array.isArray(sampleFile) ? sampleFile : sampleFile.pnlComparisons
    if (!Array.isArray(samples) || samples.some(x => !x.date || !x.code || !Number.isFinite(x.brokerRealized))) throw Error('樣本欄位不完整')
    const report = { sourceSha256: hash(raw), ...replayCorrectionScenarios(JSON.parse(raw), proposal, samples, asOf) }
    if (hash(readFileSync(backupPath)) !== hash(raw)) throw Error('來源在核對期間改變，報告未寫出')
    writeFileSync(outputPath, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ report: resolve(outputPath), directStatus: report.directEvidence.status,
        directExact: report.directEvidence.exact, sampleCount: report.directEvidence.sampleCount,
        conditionalExact: report.conditionalScenario.exact, conditionCount: report.conditionalScenario.conditions.length, readOnly: true }))
}
