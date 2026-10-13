import { confirmAction } from '../ui/dialogs'
import { useEffect, useState } from 'react'
import { Activity, AlertCircle, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'
import { analyzeDataHealth, type HealthReport, type HealthSeverity } from '../lib/dataHealth'
import { fetchAssetSnapshots, fetchCashflow, fetchDividends, fetchTrades, invalidateAllInvestData } from '../lib/investData'
import { fetchKmsNotes, fetchKmsTrash, invalidateAllKmsData } from '../lib/kmsData'
import { repairKmsConsistency } from '../lib/kmsConsistency'
import { getDoc, updateDoc } from 'firebase/firestore'
import { investDB } from '../lib/firebase'
import { userDoc, userDocNested } from '../lib/userDB'
import { buildPortfolioSnapshot } from '../lib/portfolioSnapshot'
import type { TradeRecord, DividendRecord } from '../lib/calc'
import type { CashflowRecord } from '../lib/portfolioSnapshot'
import { useInvestSync } from '../InvestSyncContext'

const severityStyle: Record<HealthSeverity, { color: string; label: string }> = {
  critical: { color: 'var(--c-danger)', label: '嚴重' },
  warning: { color: 'var(--c-warning)', label: '警告' },
  info: { color: 'var(--c-accent)', label: '提醒' },
}

type RepairCollection = 'trades' | 'dividends' | 'cashflow' | 'assetSnapshots'
interface RepairCandidate {
  key: string
  collection: RepairCollection
  recordId: string
  title: string
  before: string
  after: string
  patch: Record<string, unknown>
  fixable: boolean
}

const normalizedLegacyDate = (value: unknown): string | null => {
  const match = String(value ?? '').trim().match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/)
  if (!match) return null
  const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  const parsed = new Date(`${date}T00:00:00`)
  return Number.isNaN(parsed.getTime()) || parsed.getFullYear() !== Number(match[1]) || parsed.getMonth() + 1 !== Number(match[2]) || parsed.getDate() !== Number(match[3]) ? null : date
}

const isValidIsoDate = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00`))

export default function DataHealthCenter() {
  const { version: syncVersion } = useInvestSync()
  const [report, setReport] = useState<HealthReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [repairing, setRepairing] = useState(false)
  const [repairMessage, setRepairMessage] = useState('')
  const [repairCandidates, setRepairCandidates] = useState<RepairCandidate[]>([])
  const [selectedRepairs, setSelectedRepairs] = useState<Set<string>>(new Set())
  const [showRepairPreview, setShowRepairPreview] = useState(false)

  const scan = async (force = false) => {
    setLoading(true)
    setError('')
    try {
      if (force) {
        invalidateAllInvestData()
        invalidateAllKmsData()
      }
      const [trades, dividends, cashflow, snapshots, notes, trash, priceDoc, groupDoc] = await Promise.all([
        fetchTrades<Record<string, unknown>>(),
        fetchDividends<Record<string, unknown>>(),
        fetchCashflow<Record<string, unknown>>(),
        fetchAssetSnapshots<Record<string, unknown>>(),
        fetchKmsNotes<Record<string, unknown>>(),
        fetchKmsTrash<Record<string, unknown>>(),
        getDoc(userDocNested(investDB, 'settings', 'lastPrices')),
        getDoc(userDocNested(investDB, 'settings', 'stockGroups')),
      ])
      const savedPrices = priceDoc.exists() ? priceDoc.data() : {}
      const stockGroups = groupDoc.exists() ? groupDoc.data() : {}
      const portfolio = buildPortfolioSnapshot({
        trades: trades as unknown as TradeRecord[],
        dividends: dividends as unknown as DividendRecord[],
        cashflow: cashflow as unknown as CashflowRecord[],
        savedPrices,
      })
      const namesByCode = new Map<string, string>()
      ;[...trades, ...dividends].forEach(row => {
        const code = String(row.code || '').trim().toUpperCase()
        const name = String(row.name || '').trim()
        if (code && name && !namesByCode.has(code)) namesByCode.set(code, name)
      })
      const candidates: RepairCandidate[] = []
      const collections: Array<[RepairCollection, Record<string, unknown>[]]> = [
        ['trades', trades], ['dividends', dividends], ['cashflow', cashflow], ['assetSnapshots', snapshots],
      ]
      collections.forEach(([collectionName, rows]) => rows.forEach(row => {
        const recordId = String(row.id || '')
        if (!recordId) return
        const normalizedDate = normalizedLegacyDate(row.date)
        if (normalizedDate && normalizedDate !== row.date) candidates.push({
          key: `${collectionName}:${recordId}:date`, collection: collectionName, recordId,
          title: '日期格式標準化', before: String(row.date || '空白'), after: normalizedDate,
          patch: { date: normalizedDate }, fixable: true,
        })
        else if (!isValidIsoDate(row.date)) candidates.push({
          key: `${collectionName}:${recordId}:date-manual`, collection: collectionName, recordId,
          title: '日期需要人工確認', before: String(row.date || '空白'), after: '無法安全推測，請到原紀錄確認日期',
          patch: {}, fixable: false,
        })
        if ((collectionName === 'trades' || collectionName === 'dividends') && !String(row.name || '').trim()) {
          const code = String(row.code || '').trim().toUpperCase()
          const inferred = namesByCode.get(code)
          candidates.push({
            key: `${collectionName}:${recordId}:name`, collection: collectionName, recordId,
            title: `${code || '未識別代號'} 補齊名稱`, before: '空白', after: inferred || '找不到可安全推測的名稱',
            patch: inferred ? { name: inferred } : {}, fixable: Boolean(inferred),
          })
        }
      }))
      const now = new Date()
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const todaySnapshot = snapshots.find(row => String(row.date) === today && row.id)
      if (todaySnapshot) {
        const before = { totalAssets: Number(todaySnapshot.totalAssets), marketValue: Number(todaySnapshot.marketValue), cash: Number(todaySnapshot.cash), marginDebt: Number(todaySnapshot.marginDebt ?? 0) }
        const after = { totalAssets: portfolio.netAssets, marketValue: portfolio.marketValue, cash: portfolio.cash, marginDebt: portfolio.marginDebt }
        const differs = Object.keys(after).some(key => Math.abs(before[key as keyof typeof before] - after[key as keyof typeof after]) > Math.max(10, Math.abs(after[key as keyof typeof after]) * 0.001))
        if (differs) candidates.push({
          key: `assetSnapshots:${todaySnapshot.id}:values`, collection: 'assetSnapshots', recordId: String(todaySnapshot.id),
          title: '今日資產快照同步',
          before: `淨值 ${Math.round(before.totalAssets).toLocaleString()}／市值 ${Math.round(before.marketValue).toLocaleString()}／現金 ${Math.round(before.cash).toLocaleString()}／負債 ${Math.round(before.marginDebt).toLocaleString()}`,
          after: `淨值 ${Math.round(after.totalAssets).toLocaleString()}／市值 ${Math.round(after.marketValue).toLocaleString()}／現金 ${Math.round(after.cash).toLocaleString()}／負債 ${Math.round(after.marginDebt).toLocaleString()}`,
          patch: after, fixable: true,
        })
      }
      setRepairCandidates(candidates)
      setSelectedRepairs(new Set())
      setReport(analyzeDataHealth({
        trades, dividends, cashflow, snapshots, notes, trash, stockGroups,
        investmentSummary: {
          holdingCodes: portfolio.holdings.map(holding => holding.code),
          missingPriceCodes: portfolio.missingPriceCodes,
          marketValue: portfolio.marketValue,
          cash: portfolio.cash,
          marginDebt: portfolio.marginDebt,
          totalAssets: portfolio.netAssets,
          priceUpdatedAt: portfolio.priceUpdatedAt,
        },
      }))
    } catch (err) {
      console.error('資料健康檢查失敗', err)
      setError('無法完成檢查，請確認網路或資料庫權限後重試。')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void scan() }, [syncVersion])

  const healthy = report && report.issues.length === 0
  const hasRepairableKmsIssues = report?.issues.some(issue =>
    ['broken-note-links', 'self-note-links', 'asymmetric-note-links', 'note-trash-collision', 'expired-trash'].includes(issue.id)
  ) ?? false

  const repairKms = async () => {
    if (!await confirmAction('將移除失效連結、補齊反向連結、清除與有效筆記重複的垃圾桶資料，以及刪除超過 30 天的垃圾資料。確定執行？')) return
    setRepairing(true)
    setRepairMessage('')
    setError('')
    try {
      const result = await repairKmsConsistency()
      setRepairMessage(`已修復 ${result.repairedNotes} 則筆記：移除 ${result.removedBrokenLinks} 個失效連結、補上 ${result.addedBacklinks} 個反向連結；另清除 ${result.removedTrashCollisions} 筆重複垃圾資料與 ${result.removedExpiredTrash} 筆逾期資料。`)
      await scan(true)
    } catch (err) {
      console.error('KMS 關聯修復失敗', err)
      setError('KMS 關聯修復失敗，未完成的批次可安全重新執行。')
    } finally {
      setRepairing(false)
    }
  }

  const applySelectedRepairs = async () => {
    const selected = repairCandidates.filter(candidate => candidate.fixable && selectedRepairs.has(candidate.key))
    if (!selected.length) return
    if (!await confirmAction(`將套用 ${selected.length} 項已勾選修正；未勾選資料不會變更。確定繼續？`)) return
    setRepairing(true); setError(''); setRepairMessage('')
    try {
      const grouped = new Map<string, { collection: RepairCollection; recordId: string; patch: Record<string, unknown> }>()
      selected.forEach(candidate => {
        const key = `${candidate.collection}:${candidate.recordId}`
        const current = grouped.get(key)
        grouped.set(key, { collection: candidate.collection, recordId: candidate.recordId, patch: { ...(current?.patch ?? {}), ...candidate.patch } })
      })
      await Promise.all([...grouped.values()].map(item => updateDoc(userDoc(investDB, item.collection, item.recordId), item.patch)))
      invalidateAllInvestData()
      setRepairMessage(`已套用 ${selected.length} 項修正；其他資料維持原狀。`)
      await scan(true)
    } catch (err) {
      console.error('舊資料修正失敗', err)
      setError('修正未完整套用，請重新掃描確認；已成功的項目不會重複產生。')
    } finally { setRepairing(false) }
  }

  return (
    <div style={{ backgroundColor: 'var(--c-sidebar)', border: `1px solid ${healthy ? 'var(--c-positive)' : 'var(--c-border)'}`, borderRadius: '12px', padding: '24px', gridColumn: '1 / -1' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
          <Activity size={18} color="var(--c-accent)" />
          <div>
            <div style={{ color: 'var(--c-text)', fontSize: '15px', fontWeight: 700 }}>資料健康中心</div>
            <div style={{ color: 'var(--c-muted)', fontSize: '12px', marginTop: '2px' }}>檢查投資資料完整性、跨頁口徑、現價與知識筆記連結</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {hasRepairableKmsIssues && (
            <button onClick={() => void repairKms()} disabled={repairing || loading} style={{ border: '1px solid var(--c-warning)', background: 'color-mix(in srgb, var(--c-warning) 10%, var(--c-bg))', color: 'var(--c-warning)', borderRadius: '8px', padding: '8px 12px', cursor: repairing ? 'wait' : 'pointer', opacity: repairing ? 0.65 : 1 }}>
              {repairing ? '修復中…' : '修復 KMS 關聯'}
            </button>
          )}
          <button onClick={() => void scan(true)} disabled={loading || repairing} style={{ border: '1px solid var(--c-border)', background: 'var(--c-bg)', color: 'var(--c-text)', borderRadius: '8px', padding: '8px 12px', cursor: loading ? 'wait' : 'pointer', display: 'flex', gap: '6px', alignItems: 'center', opacity: loading ? 0.65 : 1 }}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />{loading ? '檢查中…' : '重新掃描'}
          </button>
          <button onClick={() => setShowRepairPreview(value => !value)} disabled={loading} style={{ border: '1px solid var(--c-accent)', background: 'color-mix(in srgb, var(--c-accent) 10%, var(--c-bg))', color: 'var(--c-accent)', borderRadius: '8px', padding: '8px 12px', cursor: 'pointer' }}>
            {showRepairPreview ? '收合修正預覽' : `舊資料修正預覽${repairCandidates.length ? ` (${repairCandidates.length})` : ''}`}
          </button>
        </div>
      </div>

      {error && <div style={{ color: 'var(--c-danger)', fontSize: '13px', marginTop: '14px' }}>{error}</div>}
      {repairMessage && <div style={{ color: 'var(--c-positive)', fontSize: '12px', lineHeight: 1.6, marginTop: '14px' }}>{repairMessage}</div>}
      {showRepairPreview && (
        <div style={{ marginTop: '14px', background: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '10px', padding: '12px' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--c-text)' }}>一次性健檢與修正預覽</div>
          <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginTop: '3px' }}>只會套用你勾選並再次確認的項目；無法安全推測的資料只提示、不自動修正。</div>
          {repairCandidates.length === 0 ? <div style={{ color: 'var(--c-positive)', fontSize: '12px', marginTop: '10px' }}>沒有可預覽的舊資料修正。</div> : (
            <div style={{ display: 'grid', gap: '7px', marginTop: '10px' }}>
              {repairCandidates.map(candidate => (
                <label key={candidate.key} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px', alignItems: 'start', padding: '9px', border: '1px solid var(--c-border)', borderRadius: '8px', opacity: candidate.fixable ? 1 : 0.65 }}>
                  <input type="checkbox" disabled={!candidate.fixable || repairing} checked={selectedRepairs.has(candidate.key)} onChange={event => setSelectedRepairs(current => { const next = new Set(current); if (event.target.checked) next.add(candidate.key); else next.delete(candidate.key); return next })} />
                  <span><strong style={{ color: 'var(--c-text)', fontSize: '12px' }}>{candidate.title}</strong><br /><span style={{ color: 'var(--c-danger)', fontSize: '11px' }}>原：{candidate.before}</span><br /><span style={{ color: candidate.fixable ? 'var(--c-positive)' : 'var(--c-warning)', fontSize: '11px' }}>建議：{candidate.after}</span></span>
                </label>
              ))}
              <button onClick={() => void applySelectedRepairs()} disabled={repairing || selectedRepairs.size === 0} style={{ border: 0, borderRadius: '8px', padding: '9px 12px', background: 'var(--c-button-accent)', color: 'var(--c-on-accent)', cursor: selectedRepairs.size ? 'pointer' : 'not-allowed', opacity: selectedRepairs.size ? 1 : 0.5 }}>套用已選修正（{selectedRepairs.size}）</button>
            </div>
          )}
        </div>
      )}
      {!report && !error && <div style={{ color: 'var(--c-muted)', fontSize: '13px', marginTop: '16px' }}>正在讀取資料並執行檢查…</div>}

      {report && (
        <>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '16px' }}>
            {healthy ? (
              <span style={{ display: 'flex', gap: '6px', alignItems: 'center', color: 'var(--c-positive)', fontSize: '13px', fontWeight: 700 }}><CheckCircle2 size={16} />未發現資料問題</span>
            ) : (
              <>
                <span style={{ color: 'var(--c-danger)', background: 'color-mix(in srgb, var(--c-danger) 12%, transparent)', borderRadius: '20px', padding: '5px 10px', fontSize: '12px' }}>嚴重 {report.counts.critical}</span>
                <span style={{ color: 'var(--c-warning)', background: 'color-mix(in srgb, var(--c-warning) 12%, transparent)', borderRadius: '20px', padding: '5px 10px', fontSize: '12px' }}>警告 {report.counts.warning}</span>
                <span style={{ color: 'var(--c-accent)', background: 'color-mix(in srgb, var(--c-accent) 12%, transparent)', borderRadius: '20px', padding: '5px 10px', fontSize: '12px' }}>提醒 {report.counts.info}</span>
              </>
            )}
            <span style={{ color: 'var(--c-muted)', fontSize: '12px', padding: '5px 2px' }}>已檢查 {report.recordsChecked.toLocaleString()} 筆資料</span>
          </div>

          {report.issues.length > 0 && (
            <div style={{ display: 'grid', gap: '8px', marginTop: '14px' }}>
              {report.issues.map(issue => {
                const style = severityStyle[issue.severity]
                const Icon = issue.severity === 'critical' ? AlertCircle : AlertTriangle
                return (
                  <div key={issue.id} style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)', borderLeft: `3px solid ${style.color}`, borderRadius: '8px', padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: '7px', alignItems: 'center', color: style.color, fontSize: '13px', fontWeight: 700 }}>
                      <Icon size={14} />{style.label} · {issue.title}（{issue.count} 筆）
                    </div>
                    <div style={{ color: 'var(--c-muted)', fontSize: '12px', lineHeight: 1.6, marginTop: '4px' }}>{issue.detail}</div>
                    {issue.samples?.length ? <div style={{ color: 'var(--c-text)', fontSize: '11px', marginTop: '3px' }}>範例：{issue.samples.join('、')}</div> : null}
                  </div>
                )
              })}
            </div>
          )}
          <div style={{ color: 'var(--c-muted)', fontSize: '11px', marginTop: '12px' }}>上次檢查：{new Date(report.checkedAt).toLocaleString('zh-TW')}</div>
        </>
      )}
    </div>
  )
}
