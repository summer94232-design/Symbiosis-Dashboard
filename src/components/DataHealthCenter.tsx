import { useEffect, useState } from 'react'
import { Activity, AlertCircle, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'
import { analyzeDataHealth, type HealthReport, type HealthSeverity } from '../lib/dataHealth'
import { fetchAssetSnapshots, fetchCashflow, fetchDividends, fetchTrades, invalidateAllInvestData } from '../lib/investData'
import { fetchKmsNotes, fetchKmsTrash, invalidateAllKmsData } from '../lib/kmsData'
import { repairKmsConsistency } from '../lib/kmsConsistency'

const severityStyle: Record<HealthSeverity, { color: string; label: string }> = {
  critical: { color: 'var(--c-danger)', label: '嚴重' },
  warning: { color: 'var(--c-warning)', label: '警告' },
  info: { color: 'var(--c-accent)', label: '提醒' },
}

export default function DataHealthCenter() {
  const [report, setReport] = useState<HealthReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [repairing, setRepairing] = useState(false)
  const [repairMessage, setRepairMessage] = useState('')

  const scan = async (force = false) => {
    setLoading(true)
    setError('')
    try {
      if (force) {
        invalidateAllInvestData()
        invalidateAllKmsData()
      }
      const [trades, dividends, cashflow, snapshots, notes, trash] = await Promise.all([
        fetchTrades<Record<string, unknown>>(),
        fetchDividends<Record<string, unknown>>(),
        fetchCashflow<Record<string, unknown>>(),
        fetchAssetSnapshots<Record<string, unknown>>(),
        fetchKmsNotes<Record<string, unknown>>(),
        fetchKmsTrash<Record<string, unknown>>(),
      ])
      setReport(analyzeDataHealth({ trades, dividends, cashflow, snapshots, notes, trash }))
    } catch (err) {
      console.error('資料健康檢查失敗', err)
      setError('無法完成檢查，請確認網路或資料庫權限後重試。')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void scan() }, [])

  const healthy = report && report.issues.length === 0
  const hasRepairableKmsIssues = report?.issues.some(issue =>
    ['broken-note-links', 'self-note-links', 'asymmetric-note-links', 'note-trash-collision', 'expired-trash'].includes(issue.id)
  ) ?? false

  const repairKms = async () => {
    if (!confirm('將移除失效連結、補齊反向連結、清除與有效筆記重複的垃圾桶資料，以及刪除超過 30 天的垃圾資料。確定執行？')) return
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

  return (
    <div style={{ backgroundColor: 'var(--c-sidebar)', border: `1px solid ${healthy ? 'var(--c-positive)' : 'var(--c-border)'}`, borderRadius: '12px', padding: '24px', gridColumn: '1 / -1' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
          <Activity size={18} color="var(--c-accent)" />
          <div>
            <div style={{ color: 'var(--c-text)', fontSize: '15px', fontWeight: 700 }}>資料健康中心</div>
            <div style={{ color: 'var(--c-muted)', fontSize: '12px', marginTop: '2px' }}>檢查投資資料完整性、交易邏輯與知識筆記連結</div>
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
        </div>
      </div>

      {error && <div style={{ color: 'var(--c-danger)', fontSize: '13px', marginTop: '14px' }}>{error}</div>}
      {repairMessage && <div style={{ color: 'var(--c-positive)', fontSize: '12px', lineHeight: 1.6, marginTop: '14px' }}>{repairMessage}</div>}
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
