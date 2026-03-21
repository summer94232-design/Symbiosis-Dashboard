import { useState, useEffect } from 'react'
import { collection, getDocs, setDoc, deleteDoc, doc, updateDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { getMultipleQuotes } from '../../lib/fugle'
import { Plus, Trash2, RefreshCw, TrendingUp, TrendingDown, Pencil, Check, X, FileText } from 'lucide-react'

interface WatchItem {
  code: string
  name: string
  targetHigh?: number
  targetLow?: number
  note?: string
  currentPrice?: number
  addedAt: string
}

const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

export default function Watchlist() {
  const [items, setItems] = useState<WatchItem[]>([])
  const [loading, setLoading] = useState(true)
  const [priceLoading, setPriceLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingCode, setEditingCode] = useState<string | null>(null)
  const [expandedNote, setExpandedNote] = useState<string | null>(null)
  const [stockDict, setStockDict] = useState<Record<string, string>>({})
  const [form, setForm] = useState({ code: '', name: '', targetHigh: '', targetLow: '', note: '' })
  const [lastUpdated, setLastUpdated] = useState('')

  const load = async () => {
    setLoading(true)
    const snap = await getDocs(collection(investDB, 'watchlist'))
    const data = snap.docs.map(d => ({ code: d.id, ...d.data() } as WatchItem))
    // 讀取儲存的現價
    const priceDoc = await doc(investDB, 'settings', 'watchlistPrices')
    const priceSnap = await getDocs(collection(investDB, 'settings'))
    const priceData = priceSnap.docs.find(d => d.id === 'watchlistPrices')?.data() || {}
    const savedAt = priceData._updatedAt || ''
    if (savedAt) setLastUpdated(savedAt)
    data.forEach(item => { item.currentPrice = priceData[item.code] ?? undefined })
    setItems(data.sort((a, b) => a.code.localeCompare(b.code)))

    // 讀取股票字典
    const dictSnap = await getDocs(collection(investDB, 'stockDict'))
    const dict: Record<string, string> = {}
    dictSnap.docs.forEach(d => { dict[d.id] = d.data().name })
    setStockDict(dict)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // 更新現價
  const updatePrices = async () => {
    if (items.length === 0) return
    setPriceLoading(true)
    try {
      const codes = items.map(i => i.code)
      const quotes = await getMultipleQuotes(codes)
      const now = new Date().toLocaleString('zh-TW')
      const priceData: Record<string, any> = { _updatedAt: now }
      codes.forEach(c => { if (quotes[c] !== null) priceData[c] = quotes[c] })
      await setDoc(doc(investDB, 'settings', 'watchlistPrices'), priceData)
      setItems(prev => prev.map(item => ({ ...item, currentPrice: quotes[item.code] ?? item.currentPrice })))
      setLastUpdated(now)
    } catch (err) { console.error(err) }
    setPriceLoading(false)
  }

  const handleAdd = async () => {
    if (!form.code.trim()) return
    const code = form.code.trim()
    const name = form.name.trim() || stockDict[code] || code
    await setDoc(doc(investDB, 'watchlist', code), {
      name,
      targetHigh: form.targetHigh ? parseFloat(form.targetHigh) : null,
      targetLow: form.targetLow ? parseFloat(form.targetLow) : null,
      note: form.note || null,
      addedAt: new Date().toISOString()
    })
    setForm({ code: '', name: '', targetHigh: '', targetLow: '', note: '' })
    setShowForm(false); load()
  }

  const handleEdit = async (code: string) => {
    const item = items.find(i => i.code === code)
    if (!item) return
    await updateDoc(doc(investDB, 'watchlist', code), {
      targetHigh: form.targetHigh ? parseFloat(form.targetHigh) : null,
      targetLow: form.targetLow ? parseFloat(form.targetLow) : null,
      note: form.note || null,
      name: form.name || item.name
    })
    setEditingCode(null); load()
  }

  const handleDelete = async (code: string) => {
    if (!confirm(`確定要從自選股移除 ${code}？`)) return
    await deleteDoc(doc(investDB, 'watchlist', code)); load()
  }

  const handleCodeChange = (code: string) => {
    setForm(f => ({ ...f, code, name: stockDict[code] || f.name }))
  }

  const getPriceStatus = (item: WatchItem) => {
    if (!item.currentPrice) return 'normal'
    if (item.targetHigh && item.currentPrice >= item.targetHigh) return 'high'
    if (item.targetLow && item.currentPrice <= item.targetLow) return 'low'
    return 'normal'
  }

  const getDistancePct = (current: number, target: number) =>
    (((target - current) / current) * 100).toFixed(1)

  return (
    <>
      <style>{`
        .watch-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
        @media (max-width: 700px) { .watch-grid { grid-template-columns: 1fr; } }
        .form-grid { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
        @media (max-width: 600px) { .form-grid { grid-template-columns: 1fr; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .watch-card { transition: border-color 0.2s; }
        .watch-card:hover { border-color: #4f8ef7 !important; }
      `}</style>

      <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1400px', margin: '0 auto' }}>
        {/* 標題列 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>自選股追蹤</h1>
            <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>
              {lastUpdated ? `現價更新：${lastUpdated}` : '點「更新現價」取得最新報價'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={updatePrices} disabled={priceLoading || items.length === 0} style={btn('#21253a')}>
              <RefreshCw size={14} style={{ animation: priceLoading ? 'spin 1s linear infinite' : 'none' }} />
              {priceLoading ? '更新中...' : '更新現價'}
            </button>
            <button onClick={() => { setShowForm(true) }} style={btn('#4f8ef7')}>
              <Plus size={14} />新增自選股
            </button>
          </div>
        </div>

        {/* 新增表單 */}
        {showForm && (
          <div style={{ ...card, marginBottom: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <span style={{ fontSize: '15px', fontWeight: 600, color: '#e2e8f0' }}>➕ 新增自選股</span>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><X size={18} /></button>
            </div>
            <div className="form-grid">
              <div>
                <label style={lbl}>股票代號 *</label>
                <input style={inp} placeholder="例如：2330" value={form.code}
                  onChange={e => handleCodeChange(e.target.value)} />
              </div>
              <div>
                <label style={lbl}>股票名稱</label>
                <input style={inp} placeholder="自動帶入" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div>
                <label style={lbl}>目標上標價（賣出參考）</label>
                <input type="number" style={inp} placeholder="0" value={form.targetHigh}
                  onChange={e => setForm(f => ({ ...f, targetHigh: e.target.value }))} />
              </div>
              <div>
                <label style={lbl}>目標下標價（買入參考）</label>
                <input type="number" style={inp} placeholder="0" value={form.targetLow}
                  onChange={e => setForm(f => ({ ...f, targetLow: e.target.value }))} />
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={lbl}>個人評估筆記</label>
                <textarea style={{ ...inp, minHeight: '80px', resize: 'vertical', fontFamily: 'sans-serif' }}
                  placeholder="記錄這支股票的評估理由、觀察重點..."
                  value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
              <button style={btn('#2e3349')} onClick={() => setShowForm(false)}><X size={14} />取消</button>
              <button style={btn('#4f8ef7')} onClick={handleAdd}><Check size={14} />新增</button>
            </div>
          </div>
        )}

        {/* 自選股列表 */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '64px', color: '#8892a4' }}>載入中...</div>
        ) : items.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px', color: '#8892a4' }}>
            <p style={{ fontSize: '15px' }}>還沒有自選股</p>
            <p style={{ fontSize: '13px', marginTop: '8px' }}>點「新增自選股」開始追蹤</p>
          </div>
        ) : (
          <div className="watch-grid">
            {items.map(item => {
              const status = getPriceStatus(item)
              const isEditing = editingCode === item.code
              const borderColor = status === 'high' ? '#00c896' : status === 'low' ? '#ff5757' : '#2e3349'

              return (
                <div key={item.code} className="watch-card"
                  style={{ ...card, border: `1px solid ${borderColor}`, display: 'flex', flexDirection: 'column', gap: '12px' }}>

                  {/* 卡片頭 */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '18px', fontWeight: 700, color: '#4f8ef7' }}>{item.code}</span>
                        {status === 'high' && <span style={{ fontSize: '11px', backgroundColor: 'rgba(0,200,150,0.15)', color: '#00c896', borderRadius: '10px', padding: '2px 8px' }}>🎯 達到上標</span>}
                        {status === 'low' && <span style={{ fontSize: '11px', backgroundColor: 'rgba(255,87,87,0.15)', color: '#ff5757', borderRadius: '10px', padding: '2px 8px' }}>🎯 達到下標</span>}
                      </div>
                      <div style={{ fontSize: '14px', color: '#e2e8f0', marginTop: '2px' }}>{item.name}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button onClick={() => {
                        setEditingCode(item.code)
                        setForm({ code: item.code, name: item.name, targetHigh: item.targetHigh?.toString() || '', targetLow: item.targetLow?.toString() || '', note: item.note || '' })
                      }} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><Pencil size={14} /></button>
                      <button onClick={() => handleDelete(item.code)} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><Trash2 size={14} /></button>
                    </div>
                  </div>

                  {/* 現價 */}
                  <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '2px' }}>現價</div>
                      <div style={{ fontSize: '22px', fontWeight: 700, color: '#e2e8f0' }}>
                        {item.currentPrice ? item.currentPrice.toFixed(2) : '—'}
                      </div>
                    </div>
                    {item.currentPrice && item.targetHigh && (
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>
                          上標 {item.targetHigh}
                          <span style={{ color: item.currentPrice >= item.targetHigh ? '#00c896' : '#f5a623', marginLeft: '4px' }}>
                            ({item.currentPrice >= item.targetHigh ? '+' : ''}{getDistancePct(item.currentPrice, item.targetHigh)}%)
                          </span>
                        </div>
                        <div style={{ height: '4px', backgroundColor: '#2e3349', borderRadius: '2px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', backgroundColor: '#00c896', borderRadius: '2px', width: `${Math.min(100, (item.currentPrice / item.targetHigh) * 100)}%` }} />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 目標價 */}
                  {isEditing ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <div style={{ flex: 1 }}>
                          <label style={lbl}>名稱</label>
                          <input style={inp} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <div style={{ flex: 1 }}>
                          <label style={lbl}>上標價</label>
                          <input type="number" style={inp} placeholder="賣出參考" value={form.targetHigh}
                            onChange={e => setForm(f => ({ ...f, targetHigh: e.target.value }))} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={lbl}>下標價</label>
                          <input type="number" style={inp} placeholder="買入參考" value={form.targetLow}
                            onChange={e => setForm(f => ({ ...f, targetLow: e.target.value }))} />
                        </div>
                      </div>
                      <div>
                        <label style={lbl}>評估筆記</label>
                        <textarea style={{ ...inp, minHeight: '60px', resize: 'vertical', fontFamily: 'sans-serif' }}
                          value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
                      </div>
                      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                        <button style={{ ...btn('#2e3349'), fontSize: '12px', padding: '6px 12px' }} onClick={() => setEditingCode(null)}><X size={12} />取消</button>
                        <button style={{ ...btn('#4f8ef7'), fontSize: '12px', padding: '6px 12px' }} onClick={() => handleEdit(item.code)}><Check size={12} />儲存</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* 目標價顯示 */}
                      <div style={{ display: 'flex', gap: '12px' }}>
                        {item.targetLow && (
                          <div style={{ flex: 1, backgroundColor: 'rgba(255,87,87,0.08)', borderRadius: '8px', padding: '8px 12px' }}>
                            <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '2px' }}>下標（買入）</div>
                            <div style={{ fontSize: '15px', fontWeight: 600, color: '#ff5757' }}>
                              {item.targetLow}
                              {item.currentPrice && (
                                <span style={{ fontSize: '11px', color: '#8892a4', marginLeft: '6px' }}>
                                  ({getDistancePct(item.currentPrice, item.targetLow)}%)
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                        {item.targetHigh && (
                          <div style={{ flex: 1, backgroundColor: 'rgba(0,200,150,0.08)', borderRadius: '8px', padding: '8px 12px' }}>
                            <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '2px' }}>上標（賣出）</div>
                            <div style={{ fontSize: '15px', fontWeight: 600, color: '#00c896' }}>
                              {item.targetHigh}
                              {item.currentPrice && (
                                <span style={{ fontSize: '11px', color: '#8892a4', marginLeft: '6px' }}>
                                  ({getDistancePct(item.currentPrice, item.targetHigh)}%)
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* 評估筆記 */}
                      {item.note && (
                        <div style={{ borderTop: '1px solid #2e3349', paddingTop: '10px' }}>
                          <button onClick={() => setExpandedNote(expandedNote === item.code ? null : item.code)}
                            style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer', fontSize: '12px', padding: 0, marginBottom: '6px' }}>
                            <FileText size={12} />評估筆記
                          </button>
                          {expandedNote === item.code && (
                            <p style={{ fontSize: '12px', color: '#8892a4', margin: 0, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{item.note}</p>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  <div style={{ fontSize: '11px', color: '#8892a4', borderTop: '1px solid #2e3349', paddingTop: '8px' }}>
                    加入於 {new Date(item.addedAt).toLocaleDateString('zh-TW')}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}