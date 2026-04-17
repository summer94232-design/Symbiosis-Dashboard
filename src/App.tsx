import { useState, useEffect, lazy, Suspense } from 'react'
import { Routes, Route, NavLink, useLocation, Navigate } from 'react-router-dom'
import { LayoutDashboard, ArrowLeftRight, TrendingUp, History, DollarSign, Scissors, BarChart2, Settings, BookOpen, Network, Menu, X, ChevronRight, ChevronDown, Tag, Trash2, LogOut, Download, Calendar, List, CheckSquare, Newspaper } from 'lucide-react'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { kmsDB } from './lib/firebase'
import { signOutAll } from './lib/auth'

const Dashboard = lazy(() => import('./pages/invest/Dashboard'))
const Trades = lazy(() => import('./pages/invest/Trades'))
const CashFlow = lazy(() => import('./pages/invest/CashFlow'))
const Dividend = lazy(() => import('./pages/invest/Dividend'))
const Holdings = lazy(() => import('./pages/invest/Holdings'))
const AssetTrend = lazy(() => import('./pages/invest/AssetTrend'))
const YearReview = lazy(() => import('./pages/invest/YearReview'))
const HistoryPnL = lazy(() => import('./pages/invest/HistoryPnL'))
const Watchlist = lazy(() => import('./pages/invest/Watchlist'))
const InvestSettings = lazy(() => import('./pages/invest/InvestSettings'))
const KMSHome = lazy(() => import('./pages/kms/KMSHome'))
const KMSGraph = lazy(() => import('./pages/kms/KMSGraph'))
const KMSTrash = lazy(() => import('./pages/kms/KMSTrash'))
const KMSTags = lazy(() => import('./pages/kms/KMSTags'))
const KMSExport = lazy(() => import('./pages/kms/KMSExport'))
const CalendarHome = lazy(() => import('./pages/calendar/CalendarHome'))
const CalendarSettings = lazy(() => import('./pages/calendar/CalendarSettings'))
const TaskManager = lazy(() => import('./pages/calendar/TaskManager'))
const DailyBrief = lazy(() => import('./pages/calendar/DailyBrief'))

const investNav = [
  { to: '/invest', icon: LayoutDashboard, label: '儀表板' },
  { to: '/invest/trades', icon: ArrowLeftRight, label: '買賣紀錄' },
  { to: '/invest/holdings', icon: TrendingUp, label: '股票持倉' },
  { to: '/invest/brief', icon: Newspaper, label: '今日簡報' },
  { to: '/invest/watchlist', icon: TrendingUp, label: '自選股追蹤' },
  { to: '/invest/trend', icon: BarChart2, label: '資產趨勢' },
  { to: '/invest/history', icon: History, label: '歷史損益' },
  { to: '/invest/cashflow', icon: DollarSign, label: '出入金' },
  { to: '/invest/dividend', icon: Scissors, label: '除權息' },
  { to: '/invest/review', icon: BarChart2, label: '年度復盤' },
  { to: '/invest/settings', icon: Settings, label: '設定與備份' },
]

const calendarNav = [
  { to: '/calendar', icon: Calendar, label: '月曆' },
  { to: '/calendar/tasks', icon: CheckSquare, label: '任務管理' },
  { to: '/calendar/settings', icon: List, label: '法說會關注清單' },
]

interface TreeNode {
  name: string
  fullPath: string
  children: Record<string, TreeNode>
}

function buildTree(tags: string[]): Record<string, TreeNode> {
  const root: Record<string, TreeNode> = {}
  tags.forEach(tag => {
    const parts = tag.split('/')
    let current = root
    parts.forEach((part, i) => {
      const fullPath = parts.slice(0, i + 1).join('/')
      if (!current[part]) current[part] = { name: part, fullPath, children: {} }
      current = current[part].children
    })
  })
  return root
}

function TreeNodeComponent({ node, depth, selectedTag, setSelectedTag, expandedNodes, toggleNode }: {
  node: TreeNode; depth: number; selectedTag: string
  setSelectedTag: (tag: string) => void; expandedNodes: Set<string>; toggleNode: (path: string) => void
}) {
  const hasChildren = Object.keys(node.children).length > 0
  const isSelected = selectedTag === node.fullPath
  const isExpanded = expandedNodes.has(node.fullPath)
  const paddingLeft = 8 + depth * 14

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', padding: `6px 8px 6px ${paddingLeft}px`, borderRadius: '8px', marginBottom: '1px', cursor: 'pointer', backgroundColor: isSelected ? 'rgba(79,142,247,0.12)' : 'transparent', color: isSelected ? '#4f8ef7' : '#8892a4', fontSize: depth === 0 ? '13px' : '12px' }}
        onClick={() => { setSelectedTag(isSelected ? '' : node.fullPath); if (hasChildren) toggleNode(node.fullPath) }}>
        <span onClick={e => { e.stopPropagation(); if (hasChildren) toggleNode(node.fullPath) }} style={{ marginRight: '5px', display: 'flex', flexShrink: 0 }}>
          {hasChildren
            ? (isExpanded ? <ChevronDown size={11} style={{ opacity: 0.6 }} /> : <ChevronRight size={11} style={{ opacity: 0.6 }} />)
            : <ChevronRight size={10} style={{ opacity: 0.25 }} />}
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
      </div>
      {isExpanded && hasChildren && (
        <div>
          {depth > 0 && (
            <div style={{ padding: `2px 8px 2px ${paddingLeft + 16}px`, fontSize: '10px', color: '#4f8ef7', opacity: 0.6, marginBottom: '2px' }}>
              {node.fullPath.split('/').join(' › ')}
            </div>
          )}
          {Object.values(node.children).sort((a, b) => a.name.localeCompare(b.name, 'zh-TW')).map(child => (
            <TreeNodeComponent key={child.fullPath} node={child} depth={depth + 1}
              selectedTag={selectedTag} setSelectedTag={setSelectedTag}
              expandedNodes={expandedNodes} toggleNode={toggleNode} />
          ))}
        </div>
      )}
    </div>
  )
}

const PageLoader = () => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#8892a4', fontSize: '14px', gap: '10px', flexDirection: 'column' }}>
    <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    <div style={{ width: '24px', height: '24px', border: '2px solid #2e3349', borderTopColor: '#4f8ef7', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
    <span>載入中...</span>
  </div>
)

export default function App() {
  const location = useLocation()
  const isKMS = location.pathname.startsWith('/kms')
  const isKMSHome = location.pathname === '/kms'
  const isCalendar = location.pathname.startsWith('/calendar')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  const [tagTree, setTagTree] = useState<Record<string, TreeNode>>({})
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [selectedTag, setSelectedTag] = useState('')
  const [kmsExpanded, setKmsExpanded] = useState(false)

  const currentSystem = isKMS ? 'kms' : isCalendar ? 'calendar' : 'invest'

  useEffect(() => {
    const handle = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handle)
    return () => window.removeEventListener('resize', handle)
  }, [])

  useEffect(() => { setSidebarOpen(false) }, [location.pathname])

  useEffect(() => {
    if (isKMSHome) { setKmsExpanded(true) } else { setKmsExpanded(false); setSelectedTag('') }
  }, [isKMSHome])

  useEffect(() => {
    if (!isKMS) return
    const loadTags = async () => {
      const q = query(userCol(kmsDB, 'notes'), orderBy('createdAt', 'desc'))
      const snap = await getDocs(q)
      const tags = new Set<string>()
      snap.docs.forEach(d => { d.data().hashtags?.forEach((t: string) => tags.add(t)) })
      setTagTree(buildTree(Array.from(tags).sort()))
    }
    loadTags()
  }, [isKMS, location.pathname])

  const toggleNode = (path: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path); else next.add(path)
      return next
    })
  }

  const Sidebar = () => (
    <aside style={{ width: '224px', minWidth: '224px', backgroundColor: '#1a1d27', borderRight: '1px solid #2e3349', display: 'flex', flexDirection: 'column', height: '100vh', position: isMobile ? 'fixed' : 'relative', top: 0, left: 0, zIndex: 100 }}>
      <div style={{ padding: '20px', borderBottom: '1px solid #2e3349', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: '#e2e8f0' }}>共生</div>
          <div style={{ fontSize: '12px', color: '#8892a4', marginTop: '2px' }}>Symbiosis Dashboard</div>
        </div>
        {isMobile && <button onClick={() => setSidebarOpen(false)} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><X size={20} /></button>}
      </div>

      {/* 三系統切換 */}
      <div style={{ display: 'flex', margin: '12px', backgroundColor: '#21253a', borderRadius: '8px', padding: '4px', gap: '4px' }}>
        {[
          { to: '/invest', label: '投資', key: 'invest' },
          { to: '/kms', label: '知識', key: 'kms' },
          { to: '/calendar', label: '行事曆', key: 'calendar' },
        ].map(({ to, label, key }) => (
          <NavLink key={key} to={to} style={{ flex: 1, textAlign: 'center', fontSize: '11px', padding: '6px 4px', borderRadius: '6px', textDecoration: 'none', backgroundColor: currentSystem === key ? '#4f8ef7' : 'transparent', color: currentSystem === key ? '#fff' : '#8892a4', fontWeight: currentSystem === key ? 600 : 400 }}>
            {label}
          </NavLink>
        ))}
      </div>

      <nav style={{ flex: 1, padding: '0 12px', overflowY: 'auto' }}>
        {currentSystem === 'invest' && (
          investNav.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} end={to === '/invest'}
              style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'rgba(79,142,247,0.12)' : 'transparent', color: isActive ? '#4f8ef7' : '#8892a4', fontWeight: isActive ? 600 : 400 })}>
              <Icon size={16} /><span>{label}</span>
            </NavLink>
          ))
        )}

        {currentSystem === 'calendar' && (
          calendarNav.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} end={to === '/calendar'}
              style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'rgba(79,142,247,0.12)' : 'transparent', color: isActive ? '#4f8ef7' : '#8892a4', fontWeight: isActive ? 600 : 400 })}>
              <Icon size={16} /><span>{label}</span>
            </NavLink>
          ))
        )}

        {currentSystem === 'kms' && (
          <>
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
              {kmsExpanded && Object.keys(tagTree).length > 0 && (
                <div style={{ marginBottom: '4px' }}>
                  {Object.values(tagTree).sort((a, b) => a.name.localeCompare(b.name, 'zh-TW')).map(node => (
                    <TreeNodeComponent key={node.fullPath} node={node} depth={0}
                      selectedTag={selectedTag} setSelectedTag={setSelectedTag}
                      expandedNodes={expandedNodes} toggleNode={toggleNode} />
                  ))}
                </div>
              )}
            </div>
            <NavLink to="/kms/tags" style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'rgba(79,142,247,0.12)' : 'transparent', color: isActive ? '#4f8ef7' : '#8892a4', fontWeight: isActive ? 600 : 400 })}>
              <Tag size={16} /><span>標籤管理</span>
            </NavLink>
            <NavLink to="/kms/export" style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'rgba(0,200,150,0.10)' : 'transparent', color: isActive ? '#00c896' : '#8892a4', fontWeight: isActive ? 600 : 400 })}>
              <Download size={16} /><span>匯出筆記</span>
            </NavLink>
            <NavLink to="/kms/graph" style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'rgba(79,142,247,0.12)' : 'transparent', color: isActive ? '#4f8ef7' : '#8892a4', fontWeight: isActive ? 600 : 400 })}>
              <Network size={16} /><span>知識圖譜</span>
            </NavLink>
            <NavLink to="/kms/trash" style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'rgba(255,87,87,0.10)' : 'transparent', color: isActive ? '#ff5757' : '#8892a4', fontWeight: isActive ? 600 : 400 })}>
              <Trash2 size={16} /><span>垃圾桶</span>
            </NavLink>
          </>
        )}
      </nav>

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
            <span style={{ fontSize: '15px', fontWeight: 600, color: '#e2e8f0' }}>共生</span>
          </header>
        )}
        <main style={{ flex: 1, overflowY: 'auto', color: '#e2e8f0' }}>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<Navigate to="/invest" replace />} />
              <Route path="/invest" element={<Dashboard />} />
              <Route path="/invest/trades" element={<Trades />} />
              <Route path="/invest/holdings" element={<Holdings />} />
              <Route path="/invest/watchlist" element={<Watchlist />} />
              <Route path="/invest/history" element={<HistoryPnL />} />
              <Route path="/invest/cashflow" element={<CashFlow />} />
              <Route path="/invest/dividend" element={<Dividend />} />
              <Route path="/invest/trend" element={<AssetTrend />} />
              <Route path="/invest/review" element={<YearReview />} />
              <Route path="/invest/brief" element={<DailyBrief />} />
              <Route path="/invest/settings" element={<InvestSettings />} />
              <Route path="/kms" element={<KMSHome selectedTag={selectedTag} setSelectedTag={setSelectedTag} />} />
              <Route path="/kms/tags" element={<KMSTags />} />
              <Route path="/kms/export" element={<KMSExport />} />
              <Route path="/kms/graph" element={<KMSGraph />} />
              <Route path="/kms/trash" element={<KMSTrash />} />
              <Route path="/calendar" element={<CalendarHome />} />
              <Route path="/calendar/tasks" element={<TaskManager />} />
              <Route path="/calendar/settings" element={<CalendarSettings />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  )
}