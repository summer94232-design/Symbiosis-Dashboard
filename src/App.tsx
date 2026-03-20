import { useState, useEffect } from 'react'
import { Routes, Route, NavLink, useLocation, Navigate } from 'react-router-dom'
import { LayoutDashboard, ArrowLeftRight, TrendingUp, History, DollarSign, Scissors, BarChart2, Settings, BookOpen, Network, Menu, X, ChevronRight, ChevronDown, FolderOpen, Folder, Tag, Trash2, LogOut } from 'lucide-react'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { kmsDB } from './lib/firebase'
import { signOutAll } from './lib/auth'
import Dashboard from './pages/invest/Dashboard'
import Trades from './pages/invest/Trades'
import CashFlow from './pages/invest/CashFlow'
import Dividend from './pages/invest/Dividend'
import Holdings from './pages/invest/Holdings'
import AssetTrend from './pages/invest/AssetTrend'
import YearReview from './pages/invest/YearReview'
import HistoryPnL from './pages/invest/HistoryPnL'
import InvestSettings from './pages/invest/InvestSettings'
import KMSHome from './pages/kms/KMSHome'
import KMSGraph from './pages/kms/KMSGraph'
import KMSTrash from './pages/kms/KMSTrash'
import KMSTags from './pages/kms/KMSTags'

const investNav = [
  { to: '/invest', icon: LayoutDashboard, label: '儀表板' },
  { to: '/invest/trades', icon: ArrowLeftRight, label: '買賣紀錄' },
  { to: '/invest/holdings', icon: TrendingUp, label: '股票持倉' },
  { to: '/invest/history', icon: History, label: '歷史損益' },
  { to: '/invest/cashflow', icon: DollarSign, label: '出入金' },
  { to: '/invest/dividend', icon: Scissors, label: '除權息' },
  { to: '/invest/trend', icon: BarChart2, label: '資產趨勢' },
  { to: '/invest/review', icon: BarChart2, label: '年度復盤' },
  { to: '/invest/settings', icon: Settings, label: '設定與備份' },
]

function buildTagTree(tags: string[]): Record<string, string[]> {
  const tree: Record<string, string[]> = {}
  tags.forEach(tag => {
    const parts = tag.split('/')
    const parent = parts[0]
    if (!tree[parent]) tree[parent] = []
    if (parts.length > 1 && !tree[parent].includes(tag)) tree[parent].push(tag)
  })
  tags.forEach(tag => { if (!tag.includes('/') && !tree[tag]) tree[tag] = [] })
  return tree
}

export default function App() {
  const location = useLocation()
  const isKMS = location.pathname.startsWith('/kms')
  const isKMSHome = location.pathname === '/kms'
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  const [tagTree, setTagTree] = useState<Record<string, string[]>>({})
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [selectedTag, setSelectedTag] = useState('')
  const [kmsExpanded, setKmsExpanded] = useState(false)

  useEffect(() => {
    const handle = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handle)
    return () => window.removeEventListener('resize', handle)
  }, [])

  useEffect(() => { setSidebarOpen(false) }, [location.pathname])

  useEffect(() => {
    if (isKMSHome) {
      setKmsExpanded(true)
    } else {
      setKmsExpanded(false)
      setSelectedTag('')
    }
  }, [isKMSHome])

  useEffect(() => {
    if (!isKMS) return
    const loadTags = async () => {
      const q = query(collection(kmsDB, 'notes'), orderBy('createdAt', 'desc'))
      const snap = await getDocs(q)
      const tags = new Set<string>()
      snap.docs.forEach(d => { d.data().hashtags?.forEach((t: string) => tags.add(t)) })
      setTagTree(buildTagTree(Array.from(tags).sort()))
    }
    loadTags()
  }, [isKMS, location.pathname])

  const toggleParent = (parent: string) => {
    setExpandedParents(prev => {
      const next = new Set(prev)
      if (next.has(parent)) next.delete(parent); else next.add(parent)
      return next
    })
  }

  const Sidebar = () => (
    <aside style={{ width: '224px', minWidth: '224px', backgroundColor: '#1a1d27', borderRight: '1px solid #2e3349', display: 'flex', flexDirection: 'column', height: '100vh', position: isMobile ? 'fixed' : 'relative', top: 0, left: 0, zIndex: 100 }}>
      {/* Logo */}
      <div style={{ padding: '20px', borderBottom: '1px solid #2e3349', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: '#e2e8f0' }}>個人系統</div>
          <div style={{ fontSize: '12px', color: '#8892a4', marginTop: '2px' }}>Personal Dashboard</div>
        </div>
        {isMobile && <button onClick={() => setSidebarOpen(false)} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><X size={20} /></button>}
      </div>

      {/* 系統切換 */}
      <div style={{ display: 'flex', margin: '12px', backgroundColor: '#21253a', borderRadius: '8px', padding: '4px', gap: '4px' }}>
        <NavLink to="/invest" style={{ flex: 1, textAlign: 'center', fontSize: '12px', padding: '6px', borderRadius: '6px', textDecoration: 'none', backgroundColor: !isKMS ? '#4f8ef7' : 'transparent', color: !isKMS ? '#fff' : '#8892a4', fontWeight: !isKMS ? 600 : 400 }}>投資</NavLink>
        <NavLink to="/kms" style={{ flex: 1, textAlign: 'center', fontSize: '12px', padding: '6px', borderRadius: '6px', textDecoration: 'none', backgroundColor: isKMS ? '#4f8ef7' : 'transparent', color: isKMS ? '#fff' : '#8892a4', fontWeight: isKMS ? 600 : 400 }}>知識</NavLink>
      </div>

      {/* 導覽列 */}
      <nav style={{ flex: 1, padding: '0 12px', overflowY: 'auto' }}>
        {!isKMS ? (
          investNav.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} end={to === '/invest'}
              style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'rgba(79,142,247,0.12)' : 'transparent', color: isActive ? '#4f8ef7' : '#8892a4', fontWeight: isActive ? 600 : 400 })}>
              <Icon size={16} /><span>{label}</span>
            </NavLink>
          ))
        ) : (
          <>
            {/* 知識庫 + 分類展開 */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', borderRadius: '8px', marginBottom: '2px', backgroundColor: isKMSHome ? 'rgba(79,142,247,0.12)' : 'transparent' }}>
                <NavLink to="/kms" end onClick={() => { setSelectedTag(''); setKmsExpanded(true) }}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', textDecoration: 'none', fontSize: '14px', color: isKMSHome ? '#4f8ef7' : '#8892a4', fontWeight: isKMSHome ? 600 : 400 }}>
                  <BookOpen size={16} /><span>知識庫</span>
                </NavLink>
                {Object.keys(tagTree).length > 0 && (
                  <button onClick={() => setKmsExpanded(v => !v)}
                    style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer', padding: '10px 8px', display: 'flex' }}>
                    {kmsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                )}
              </div>

              {/* 分類樹狀 */}
              {kmsExpanded && Object.keys(tagTree).length > 0 && (
                <div style={{ marginBottom: '4px', paddingLeft: '8px' }}>
                  {Object.entries(tagTree).sort().map(([parent, children]) => (
                    <div key={parent}>
                      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 8px', borderRadius: '8px', marginBottom: '1px', cursor: 'pointer', backgroundColor: selectedTag === parent ? 'rgba(79,142,247,0.12)' : 'transparent', color: selectedTag === parent ? '#4f8ef7' : '#8892a4', fontSize: '12px' }}
                        onClick={() => { setSelectedTag(selectedTag === parent ? '' : parent); if (children.length > 0) toggleParent(parent) }}>
                        {children.length > 0 ? (
                          <span onClick={e => { e.stopPropagation(); toggleParent(parent) }} style={{ marginRight: '5px', display: 'flex' }}>
                            {expandedParents.has(parent) ? <FolderOpen size={12} color="#f5a623" /> : <Folder size={12} color="#f5a623" />}
                          </span>
                        ) : <Tag size={12} style={{ marginRight: '5px', opacity: 0.6 }} />}
                        <span style={{ flex: 1 }}>{parent}</span>
                        {children.length > 0 && (
                          <ChevronRight size={11} style={{ transform: expandedParents.has(parent) ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s', opacity: 0.4 }} />
                        )}
                      </div>
                      {expandedParents.has(parent) && children.map(child => (
                        <div key={child} style={{ display: 'flex', alignItems: 'center', padding: '5px 8px 5px 22px', borderRadius: '8px', marginBottom: '1px', cursor: 'pointer', backgroundColor: selectedTag === child ? 'rgba(79,142,247,0.12)' : 'transparent', color: selectedTag === child ? '#4f8ef7' : '#8892a4', fontSize: '12px' }}
                          onClick={() => setSelectedTag(selectedTag === child ? '' : child)}>
                          <ChevronRight size={10} style={{ marginRight: '5px', opacity: 0.4 }} />
                          <span>{child.split('/').slice(1).join('/')}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 標籤管理 */}
            <NavLink to="/kms/tags"
              style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'rgba(79,142,247,0.12)' : 'transparent', color: isActive ? '#4f8ef7' : '#8892a4', fontWeight: isActive ? 600 : 400 })}>
              <Tag size={16} /><span>標籤管理</span>
            </NavLink>

            {/* 知識圖譜 */}
            <NavLink to="/kms/graph"
              style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'rgba(79,142,247,0.12)' : 'transparent', color: isActive ? '#4f8ef7' : '#8892a4', fontWeight: isActive ? 600 : 400 })}>
              <Network size={16} /><span>知識圖譜</span>
            </NavLink>

            {/* 垃圾桶 */}
            <NavLink to="/kms/trash"
              style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'rgba(255,87,87,0.10)' : 'transparent', color: isActive ? '#ff5757' : '#8892a4', fontWeight: isActive ? 600 : 400 })}>
              <Trash2 size={16} /><span>垃圾桶</span>
            </NavLink>
          </>
        )}
      </nav>

      {/* 底部登出 */}
      <div style={{ padding: '12px', borderTop: '1px solid #2e3349' }}>
        <button onClick={() => signOutAll()}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', backgroundColor: 'transparent', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px', color: '#8892a4', fontSize: '12px', cursor: 'pointer', transition: 'all 0.15s' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#ff5757'; e.currentTarget.style.color = '#ff5757' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#2e3349'; e.currentTarget.style.color = '#8892a4' }}>
          <LogOut size={14} />登出
        </button>
        <div style={{ textAlign: 'center', marginTop: '8px' }}>
          <span style={{ fontSize: '11px', color: '#8892a4' }}>v0.1.0</span>
        </div>
      </div>
    </aside>
  )

  return (
    <div style={{ display: 'flex', height: '100vh', backgroundColor: '#0f1117', overflow: 'hidden' }}>
      {!isMobile && <Sidebar />}
      {isMobile && sidebarOpen && (
        <>
          <div onClick={() => setSidebarOpen(false)} style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 99 }} />
          <Sidebar />
        </>
      )}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {isMobile && (
          <header style={{ backgroundColor: '#1a1d27', borderBottom: '1px solid #2e3349', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
            <button onClick={() => setSidebarOpen(true)} style={{ background: 'none', border: 'none', color: '#e2e8f0', cursor: 'pointer', display: 'flex' }}><Menu size={22} /></button>
            <span style={{ fontSize: '15px', fontWeight: 600, color: '#e2e8f0' }}>個人系統</span>
          </header>
        )}
        <main style={{ flex: 1, overflowY: 'auto', color: '#e2e8f0' }}>
          <Routes>
            <Route path="/" element={<Navigate to="/invest" replace />} />
            <Route path="/invest" element={<Dashboard />} />
            <Route path="/invest/trades" element={<Trades />} />
            <Route path="/invest/holdings" element={<Holdings />} />
            <Route path="/invest/history" element={<HistoryPnL />} />
            <Route path="/invest/cashflow" element={<CashFlow />} />
            <Route path="/invest/dividend" element={<Dividend />} />
            <Route path="/invest/trend" element={<AssetTrend />} />
            <Route path="/invest/review" element={<YearReview />} />
            <Route path="/invest/settings" element={<InvestSettings />} />
            <Route path="/kms" element={<KMSHome selectedTag={selectedTag} setSelectedTag={setSelectedTag} />} />
            <Route path="/kms/tags" element={<KMSTags />} />
            <Route path="/kms/graph" element={<KMSGraph />} />
            <Route path="/kms/trash" element={<KMSTrash />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}