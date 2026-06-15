import { useState, useEffect } from 'react'
import { getDocs, setDoc, deleteDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc } from '../../lib/userDB'
import { Plus, Trash2, Search } from 'lucide-react'

const card: React.CSSProperties = { backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '8px 12px', color: 'var(--c-text)', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

export default function CalendarSettings() {
    const [watchList, setWatchList] = useState<{ code: string; name: string }[]>([])
    const [newCode, setNewCode] = useState('')
    const [newName, setNewName] = useState('')
    const [stockDict, setStockDict] = useState<Record<string, string>>({})
    const [search, setSearch] = useState('')

    const load = async () => {
        const snap = await getDocs(userCol(investDB, 'calendarWatchList'))
        setWatchList(snap.docs.map(d => ({ code: d.id, name: d.data().name || d.id })))
        const dictSnap = await getDocs(userCol(investDB, 'stockDict'))
        const dict: Record<string, string> = {}
        dictSnap.docs.forEach(d => { dict[d.id] = d.data().name })
        setStockDict(dict)
    }

    useEffect(() => { load() }, [])

    const handleAdd = async () => {
        if (!newCode.trim()) return
        const code = newCode.trim()
        const name = newName.trim() || stockDict[code] || code
        await setDoc(userDoc(investDB, 'calendarWatchList', code), { code, name })
        setNewCode(''); setNewName(''); load()
    }

    const handleDelete = async (code: string) => {
        await deleteDoc(userDoc(investDB, 'calendarWatchList', code)); load()
    }

    // 自動帶入股票名稱
    const handleCodeChange = (code: string) => {
        setNewCode(code)
        if (stockDict[code]) setNewName(stockDict[code])
    }

    const filtered = watchList.filter(w =>
        w.code.includes(search) || w.name.includes(search)
    )

    return (
        <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '800px', margin: '0 auto' }}>
            <div style={{ marginBottom: '24px' }}>
                <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>法說會關注清單</h1>
                <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>設定要追蹤法說會的股票，行事曆會自動顯示相關法說會</p>
            </div>

            <div style={{ ...card, marginBottom: '16px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '16px' }}>新增關注股票</div>
                <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: '1fr 1fr auto' }}>
                    <div>
                        <input style={inp} placeholder="股票代號（如 2330）" value={newCode}
                            onChange={e => handleCodeChange(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleAdd()} />
                    </div>
                    <div>
                        <input style={inp} placeholder="股票名稱（自動帶入）" value={newName}
                            onChange={e => setNewName(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleAdd()} />
                    </div>
                    <button style={btn('var(--c-accent)')} onClick={handleAdd}><Plus size={14} />新增</button>
                </div>
            </div>

            <div style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>關注清單 ({watchList.length})</div>
                    <div style={{ position: 'relative', width: '200px' }}>
                        <Search size={13} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--c-muted)' }} />
                        <input style={{ ...inp, paddingLeft: '30px', fontSize: '13px' }} placeholder="搜尋..." value={search} onChange={e => setSearch(e.target.value)} />
                    </div>
                </div>

                {filtered.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '32px', color: 'var(--c-muted)', fontSize: '13px' }}>
                        {search ? '找不到符合的股票' : '還沒有關注的股票，請先新增'}
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {filtered.map(w => (
                            <div key={w.code} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', backgroundColor: 'var(--c-bg)', borderRadius: '8px' }}>
                                <div>
                                    <span style={{ fontSize: '14px', color: 'var(--c-accent)', fontWeight: 600, marginRight: '10px' }}>{w.code}</span>
                                    <span style={{ fontSize: '14px', color: 'var(--c-text)' }}>{w.name}</span>
                                </div>
                                <button onClick={() => handleDelete(w.code)} style={{ background: 'none', border: 'none', color: 'var(--c-danger)', cursor: 'pointer' }}>
                                    <Trash2 size={15} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}