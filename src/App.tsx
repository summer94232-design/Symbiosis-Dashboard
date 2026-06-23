import { useState, useEffect, lazy, Suspense, memo, useRef } from 'react'
import { Routes, Route, NavLink, useLocation, Navigate } from 'react-router-dom'
import { LayoutDashboard, ArrowLeftRight, TrendingUp, TrendingDown, History, DollarSign, Scissors, BarChart2, Settings, BookOpen, Network, Menu, X, ChevronRight, ChevronDown, Tag, Trash2, LogOut, Download, Calendar, List, CheckSquare, Newspaper, CreditCard, Folder, Wrench, Target, Map, Users, Loader } from 'lucide-react'
import { getDocs, getDoc, orderBy, query } from 'firebase/firestore'
import { kmsDB, investDB } from './lib/firebase'
import { userCol, userDocNested } from './lib/userDB'
import { signOutAll, switchAccount, investAuth } from './lib/auth'
import { loadAccounts, removeAccount, type SavedAccount } from './lib/accountStore'
import { PriceProvider } from './PriceContext'

const Dashboard = lazy(() => import('./pages/invest/Dashboard'))
const Trades = lazy(() => import('./pages/invest/Trades'))
const CashFlow = lazy(() => import('./pages/invest/CashFlow'))
const Dividend = lazy(() => import('./pages/invest/Dividend'))
const Holdings = lazy(() => import('./pages/invest/Holdings'))
const AssetTrend = lazy(() => import('./pages/invest/AssetTrend'))
const YearReview = lazy(() => import('./pages/invest/YearReview'))
const HistoryPnL = lazy(() => import('./pages/invest/HistoryPnL'))
const Watchlist = lazy(() => import('./pages/invest/Watchlist'))
const MarginManager = lazy(() => import('./pages/invest/MarginManager'))
const InvestSettings = lazy(() => import('./pages/invest/InvestSettings'))
const SentimentTracker = lazy(() => import('./pages/invest/SentimentTracker'))
const IndustryMap = lazy(() => import('./pages/invest/IndustryMap'))
const SoldTracker = lazy(() => import('./pages/invest/SoldTracker'))
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
    { to: '/invest/trend', icon: BarChart2, label: '資產趨勢' },
    { to: '/invest/industry', icon: Map, label: '產業地圖' },
    { to: '/invest/watchlist', icon: TrendingUp, label: '選股追蹤' },
]

const investManageNav = [
    { to: '/invest/history', icon: History, label: '歷史損益' },
    { to: '/invest/cashflow', icon: DollarSign, label: '出入金' },
    { to: '/invest/dividend', icon: Scissors, label: '除權息' },
    { to: '/invest/review', icon: BarChart2, label: '年度復盤' },
    { to: '/invest/settings', icon: Settings, label: '設定與備份' },
]

const investToolsNav = [
    { to: '/invest/margin', icon: CreditCard, label: '融資管理' },
    { to: '/invest/sentiment', icon: Target, label: '觀點追蹤' },
    { to: '/invest/brief', icon: Newspaper, label: '每日重點' },
    { to: '/invest/sold-tracker', icon: TrendingDown, label: '賣出追蹤' },
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

function sortTreeByOrder(
    tree: Record<string, TreeNode>,
    parentOrder: string[],
    childOrder: Record<string, string[]>
): Record<string, TreeNode> {
    const allParents = Object.keys(tree)
    const orderedParents = [
        ...parentOrder.filter(p => allParents.includes(p)),
        ...allParents.filter(p => !parentOrder.includes(p)).sort((a, b) => a.localeCompare(b, 'zh-TW')),
    ]
    const sorted: Record<string, TreeNode> = {}
    orderedParents.forEach(pName => {
        const node = tree[pName]
        if (!node) return
        const allChildren = Object.keys(node.children)
        const order = childOrder[pName] || []
        const orderedChildren = [
            ...order.filter(c => allChildren.includes(c)),
            ...allChildren.filter(c => !order.includes(c)).sort((a, b) => a.localeCompare(b, 'zh-TW')),
        ]
        const sortedChildren: Record<string, TreeNode> = {}
        orderedChildren.forEach(cName => { sortedChildren[cName] = node.children[cName] })
        sorted[pName] = { ...node, children: sortedChildren }
    })
    return sorted
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
            <div style={{ display: 'flex', alignItems: 'center', padding: `6px 8px 6px ${paddingLeft}px`, borderRadius: '8px', marginBottom: '1px', cursor: 'pointer', backgroundColor: isSelected ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)' : 'transparent', color: isSelected ? 'var(--c-accent)' : 'var(--c-muted)', fontSize: depth === 0 ? '13px' : '12px' }}
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
                        <div style={{ padding: `2px 8px 2px ${paddingLeft + 16}px`, fontSize: '10px', color: 'var(--c-accent)', opacity: 0.6, marginBottom: '2px' }}>
                            {node.fullPath.split('/').join(' › ')}
                        </div>
                    )}
                    {Object.values(node.children).map(child => (
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
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--c-muted)', fontSize: '14px', gap: '10px', flexDirection: 'column' }}>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        <div style={{ width: '24px', height: '24px', border: '2px solid var(--c-border)', borderTopColor: 'var(--c-accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <span>載入中...</span>
    </div>
)

// ─────────────────────────────────────────────────────────────
// ★ 核心修復：Sidebar 移到 App 函式外部，用 memo 避免不必要重繪
// ─────────────────────────────────────────────────────────────
interface SidebarProps {
    isMobile: boolean
    setSidebarOpen: (open: boolean) => void
    currentSystem: string
    isKMSHome: boolean
    tagTree: Record<string, TreeNode>
    kmsExpanded: boolean
    setKmsExpanded: (v: boolean | ((prev: boolean) => boolean)) => void
    selectedTag: string
    setSelectedTag: (tag: string) => void
    expandedNodes: Set<string>
    toggleNode: (path: string) => void
    displayName: string
}

// ── 可收合群組元件（統一樣式，避免重複） ──────────────────────────────────
function NavGroup({ label, icon: Icon, isOpen, onToggle, children }: {
    label: string
    icon: React.ElementType
    isOpen: boolean
    onToggle: () => void
    children: React.ReactNode
}) {
    return (
        <div style={{ marginTop: '4px' }}>
            <button onClick={onToggle}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px', color: 'var(--c-muted)', fontWeight: 400 }}>
                <Icon size={15} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
            {isOpen && (
                <div style={{ marginLeft: '8px', borderLeft: '1px solid var(--c-border)', paddingLeft: '8px', marginBottom: '4px' }}>
                    {children}
                </div>
            )}
        </div>
    )
}

// ── 帳號切換下拉（內嵌，接收 displayName prop）────────────────
function AccountSwitcherInline({ displayName }: { displayName: string }) {
    const [open, setOpen] = useState(false)
    const [accounts, setAccounts] = useState<SavedAccount[]>([])
    const [currentEmail, setCurrentEmail] = useState<string | null>(null)
    const [switching, setSwitching] = useState<string | null>(null)
    const [error, setError] = useState('')
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const unsub = investAuth.onAuthStateChanged(user => setCurrentEmail(user?.email ?? null))
        return unsub
    }, [])

    useEffect(() => {
        if (open) { setAccounts(loadAccounts()); setError('') }
    }, [open])

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [])

    const otherAccounts = accounts.filter(a => a.email !== currentEmail)

    // 優先顯示設定裡的 displayName，fallback 到 email @ 前段
    const label = displayName || currentEmail?.split('@')[0] || '未登入'

    const handleSwitch = async (email: string) => {
        setSwitching(email)
        setError('')
        try {
            await switchAccount(email)
            setOpen(false)
        } catch (err: any) {
            setError(err.message ?? '切換失敗')
        } finally {
            setSwitching(null)
        }
    }

    const handleRemove = (e: React.MouseEvent, email: string) => {
        e.stopPropagation()
        removeAccount(email)
        setAccounts(loadAccounts())
    }

    return (
        <div ref={ref} style={{ position: 'relative', flex: '6' }}>
            {/* 帳號按鈕 */}
            <button
                onClick={() => setOpen(v => !v)}
                title={currentEmail ?? ''}
                style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', gap: '6px', backgroundColor: 'transparent', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '8px 8px', color: 'var(--c-muted)', fontSize: '12px', cursor: 'pointer', transition: 'all 0.15s', overflow: 'hidden' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--c-accent)'; e.currentTarget.style.color = 'var(--c-accent)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--c-border)'; e.currentTarget.style.color = 'var(--c-muted)' }}
            >
                <Users size={13} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{label}</span>
                <ChevronDown size={11} style={{ flexShrink: 0, transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }} />
            </button>

            {/* 下拉選單 */}
            {open && (
                <div style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, right: 0, backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '10px', padding: '6px', zIndex: 200, boxShadow: '0 4px 20px rgba(0,0,0,0.3)', minWidth: '160px' }}>
                    {/* 目前帳號 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', borderRadius: '6px', backgroundColor: 'color-mix(in srgb, var(--c-accent) 8%, transparent)', marginBottom: otherAccounts.length > 0 ? '4px' : 0 }}>
                        <div style={{ width: '18px', height: '18px', borderRadius: '50%', backgroundColor: 'var(--c-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                            {label.charAt(0).toUpperCase()}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '12px', color: 'var(--c-text)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
                            <div style={{ fontSize: '10px', color: 'var(--c-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentEmail}</div>
                        </div>
                    </div>

                    {/* 其他帳號 */}
                    {otherAccounts.length > 0 && (
                        <>
                            <div style={{ fontSize: '10px', color: 'var(--c-muted)', padding: '4px 10px 2px', letterSpacing: '0.5px' }}>切換帳號</div>
                            {otherAccounts.map(acc => (
                                <div key={acc.email} onClick={() => !switching && handleSwitch(acc.email)}
                                    style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', borderRadius: '6px', cursor: switching ? 'wait' : 'pointer', transition: 'background 0.15s' }}
                                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--c-accent) 6%, transparent)')}
                                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                                >
                                    <div style={{ width: '18px', height: '18px', borderRadius: '50%', backgroundColor: 'var(--c-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', fontWeight: 700, color: 'var(--c-muted)', flexShrink: 0 }}>
                                        {acc.displayName.charAt(0).toUpperCase()}
                                    </div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: '12px', color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acc.displayName}</div>
                                        <div style={{ fontSize: '10px', color: 'var(--c-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acc.email}</div>
                                    </div>
                                    {switching === acc.email
                                        ? <Loader size={11} style={{ color: 'var(--c-accent)', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
                                        : <button onClick={e => handleRemove(e, acc.email)} title="移除" style={{ background: 'none', border: 'none', padding: '2px', color: 'var(--c-muted)', cursor: 'pointer', display: 'flex', borderRadius: '4px', flexShrink: 0, opacity: 0.5 }}
                                            onMouseEnter={e => { e.currentTarget.style.color = 'var(--c-danger)'; e.currentTarget.style.opacity = '1' }}
                                            onMouseLeave={e => { e.currentTarget.style.color = 'var(--c-muted)'; e.currentTarget.style.opacity = '0.5' }}>
                                            <Trash2 size={11} />
                                        </button>
                                    }
                                </div>
                            ))}
                        </>
                    )}
                    {otherAccounts.length === 0 && (
                        <div style={{ fontSize: '11px', color: 'var(--c-muted)', padding: '6px 10px', textAlign: 'center' }}>尚無其他已儲存帳號</div>
                    )}
                    {error && (
                        <div style={{ fontSize: '11px', color: 'var(--c-danger)', padding: '6px 10px', marginTop: '4px', backgroundColor: 'color-mix(in srgb, var(--c-danger) 10%, transparent)', borderRadius: '6px' }}>{error}</div>
                    )}
                </div>
            )}
        </div>
    )
}

const Sidebar = memo(({
    isMobile,
    setSidebarOpen,
    currentSystem,
    isKMSHome,
    tagTree,
    kmsExpanded,
    setKmsExpanded,
    selectedTag,
    setSelectedTag,
    expandedNodes,
    toggleNode,
    displayName,
}: SidebarProps) => {
    const managePaths = investManageNav.map(n => n.to)
    const toolsPaths = investToolsNav.map(n => n.to)
    const [manageOpen, setManageOpen] = useState(() => managePaths.some(p => window.location.pathname.startsWith(p)))
    const [toolsOpen, setToolsOpen] = useState(() => toolsPaths.some(p => window.location.pathname.startsWith(p)))

    return (
        <aside style={{ width: '224px', minWidth: '224px', backgroundColor: 'var(--c-sidebar)', borderRight: '1px solid var(--c-border)', display: 'flex', flexDirection: 'column', height: '100vh', position: isMobile ? 'fixed' : 'relative', top: 0, left: 0, zIndex: 100 }}>
            <div style={{ padding: '20px', borderBottom: '1px solid var(--c-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>Symbiosis 管理系統</div>
                    {displayName && (
                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginTop: '3px' }}>使用者：{displayName}</div>
                    )}
                </div>
                {isMobile && <button onClick={() => setSidebarOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><X size={20} /></button>}
            </div>

            {/* 三系統切換 */}
            <div style={{ display: 'flex', margin: '12px', backgroundColor: 'var(--c-card)', borderRadius: '8px', padding: '4px', gap: '4px' }}>
                {[
                    { to: '/invest', label: '投資', key: 'invest' },
                    { to: '/kms', label: '知識', key: 'kms' },
                    { to: '/calendar', label: '行事曆', key: 'calendar' },
                ].map(({ to, label, key }) => (
                    <NavLink key={key} to={to} style={{ flex: 1, textAlign: 'center', fontSize: '11px', padding: '6px 4px', borderRadius: '6px', textDecoration: 'none', backgroundColor: currentSystem === key ? 'var(--c-accent)' : 'transparent', color: currentSystem === key ? '#fff' : 'var(--c-muted)', fontWeight: currentSystem === key ? 600 : 400 }}>
                        {label}
                    </NavLink>
                ))}
            </div>

            <nav style={{ flex: 1, padding: '0 12px', overflowY: 'auto' }}>
                {currentSystem === 'invest' && (
                    <>
                        {investNav.map(({ to, icon: Icon, label }) => (
                            <NavLink key={to} to={to} end={to === '/invest'}
                                style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)' : 'transparent', color: isActive ? 'var(--c-accent)' : 'var(--c-muted)', fontWeight: isActive ? 600 : 400 })}>
                                <Icon size={16} /><span>{label}</span>
                            </NavLink>
                        ))}
                        <NavGroup label="工具管理" icon={Wrench} isOpen={toolsOpen} onToggle={() => setToolsOpen(v => !v)}>
                            {investToolsNav.map(({ to, icon: Icon, label }) => (
                                <NavLink key={to} to={to}
                                    style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)' : 'transparent', color: isActive ? 'var(--c-accent)' : 'var(--c-muted)', fontWeight: isActive ? 600 : 400 })}>
                                    <Icon size={16} /><span>{label}</span>
                                </NavLink>
                            ))}
                        </NavGroup>
                        <NavGroup label="帳戶管理" icon={Folder} isOpen={manageOpen} onToggle={() => setManageOpen(v => !v)}>
                            {investManageNav.map(({ to, icon: Icon, label }) => (
                                <NavLink key={to} to={to}
                                    style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)' : 'transparent', color: isActive ? 'var(--c-accent)' : 'var(--c-muted)', fontWeight: isActive ? 600 : 400 })}>
                                    <Icon size={16} /><span>{label}</span>
                                </NavLink>
                            ))}
                        </NavGroup>
                    </>
                )}

                {currentSystem === 'calendar' && (
                    calendarNav.map(({ to, icon: Icon, label }) => (
                        <NavLink key={to} to={to} end={to === '/calendar'}
                            style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)' : 'transparent', color: isActive ? 'var(--c-accent)' : 'var(--c-muted)', fontWeight: isActive ? 600 : 400 })}>
                            <Icon size={16} /><span>{label}</span>
                        </NavLink>
                    ))
                )}

                {currentSystem === 'kms' && (
                    <>
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', borderRadius: '8px', marginBottom: '2px', backgroundColor: isKMSHome ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)' : 'transparent' }}>
                                <NavLink to="/kms" end onClick={() => { setSelectedTag(''); setKmsExpanded(true) }}
                                    style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', textDecoration: 'none', fontSize: '14px', color: isKMSHome ? 'var(--c-accent)' : 'var(--c-muted)', fontWeight: isKMSHome ? 600 : 400 }}>
                                    <BookOpen size={16} /><span>知識庫</span>
                                </NavLink>
                                {Object.keys(tagTree).length > 0 && (
                                    <button onClick={() => setKmsExpanded(v => !v)}
                                        style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer', padding: '10px 8px', display: 'flex' }}>
                                        {kmsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                    </button>
                                )}
                            </div>
                            {kmsExpanded && Object.keys(tagTree).length > 0 && (
                                <div style={{ marginBottom: '4px' }}>
                                    {Object.values(tagTree).map(node => (
                                        <TreeNodeComponent key={node.fullPath} node={node} depth={0}
                                            selectedTag={selectedTag} setSelectedTag={setSelectedTag}
                                            expandedNodes={expandedNodes} toggleNode={toggleNode} />
                                    ))}
                                </div>
                            )}
                        </div>
                        <NavLink to="/kms/tags" style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)' : 'transparent', color: isActive ? 'var(--c-accent)' : 'var(--c-muted)', fontWeight: isActive ? 600 : 400 })}>
                            <Tag size={16} /><span>標籤管理</span>
                        </NavLink>
                        <NavLink to="/kms/export" style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'color-mix(in srgb, var(--c-positive) 10%, transparent)' : 'transparent', color: isActive ? 'var(--c-positive)' : 'var(--c-muted)', fontWeight: isActive ? 600 : 400 })}>
                            <Download size={16} /><span>匯出筆記</span>
                        </NavLink>
                        <NavLink to="/kms/graph" style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)' : 'transparent', color: isActive ? 'var(--c-accent)' : 'var(--c-muted)', fontWeight: isActive ? 600 : 400 })}>
                            <Network size={16} /><span>知識圖譜</span>
                        </NavLink>
                        <NavLink to="/kms/trash" style={({ isActive }) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', marginBottom: '2px', textDecoration: 'none', fontSize: '14px', backgroundColor: isActive ? 'color-mix(in srgb, var(--c-danger) 10%, transparent)' : 'transparent', color: isActive ? 'var(--c-danger)' : 'var(--c-muted)', fontWeight: isActive ? 600 : 400 })}>
                            <Trash2 size={16} /><span>垃圾桶</span>
                        </NavLink>
                    </>
                )}
            </nav>

            <div style={{ padding: '12px', borderTop: '1px solid var(--c-border)' }}>
                {/* ── 帳號切換 + 登出 並排（6:4） ── */}
                <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                    <AccountSwitcherInline displayName={displayName} />
                    <button onClick={() => signOutAll()}
                        style={{ flex: '4', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', backgroundColor: 'transparent', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '8px 6px', color: 'var(--c-muted)', fontSize: '12px', cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap' }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--c-danger)'; e.currentTarget.style.color = 'var(--c-danger)' }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--c-border)'; e.currentTarget.style.color = 'var(--c-muted)' }}>
                        <LogOut size={13} />登出
                    </button>
                </div>

                {/* ── 版本代號 ── */}
                <div style={{ textAlign: 'center' }}>
                    <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>v26.6.23</span>
                </div>
            </div>
        </aside>
    )
})

Sidebar.displayName = 'Sidebar'

// ─────────────────────────────────────────────────────────────

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

    // ── 使用者顯示名稱（讀取供 Sidebar 顯示，編輯入口在設定與備份頁）──
    const [displayName, setDisplayName] = useState('')

    useEffect(() => {
        getDoc(userDocNested(investDB, 'settings', 'profile'))
            .then(snap => { if (snap.exists()) setDisplayName(snap.data().displayName ?? '') })
            .catch(() => { })
    }, [])

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
            const [snap, orderSnap] = await Promise.all([
                getDocs(query(userCol(kmsDB, 'notes'), orderBy('createdAt', 'desc'))),
                getDoc(userDocNested(kmsDB, 'settings', 'tagOrder')).catch(() => null),
            ])
            const tags = new Set<string>()
            snap.docs.forEach(d => { d.data().hashtags?.forEach((t: string) => tags.add(t)) })
            const rawTree = buildTree(Array.from(tags).sort())
            const parentOrder: string[] = orderSnap?.data()?.parentOrder || []
            const childOrder: Record<string, string[]> = orderSnap?.data()?.childOrder || {}
            setTagTree(sortTreeByOrder(rawTree, parentOrder, childOrder))
        }
        loadTags()
    }, [isKMS])

    const toggleNode = (path: string) => {
        setExpandedNodes(prev => {
            const next = new Set(prev)
            if (next.has(path)) next.delete(path); else next.add(path)
            return next
        })
    }

    const sidebarProps: SidebarProps = {
        isMobile,
        setSidebarOpen,
        currentSystem,
        isKMSHome,
        tagTree,
        kmsExpanded,
        setKmsExpanded,
        selectedTag,
        setSelectedTag,
        expandedNodes,
        toggleNode,
        displayName,
    }

    return (
        <PriceProvider>
            <div style={{ display: 'flex', height: '100vh', backgroundColor: 'var(--c-bg)', overflow: 'hidden' }}>
                {!isMobile && <Sidebar {...sidebarProps} />}
                {isMobile && sidebarOpen && (
                    <>
                        <div onClick={() => setSidebarOpen(false)} style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 99 }} />
                        <Sidebar {...sidebarProps} />
                    </>
                )}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    {isMobile && (
                        <header style={{ backgroundColor: 'var(--c-sidebar)', borderBottom: '1px solid var(--c-border)', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
                            <button onClick={() => setSidebarOpen(true)} style={{ background: 'none', border: 'none', color: 'var(--c-text)', cursor: 'pointer', display: 'flex' }}><Menu size={22} /></button>
                            <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--c-text)' }}>共生</span>
                        </header>
                    )}
                    <main style={{ flex: 1, overflowY: 'auto', color: 'var(--c-text)' }}>
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
                                <Route path="/invest/margin" element={<MarginManager />} />
                                <Route path="/invest/sentiment" element={<SentimentTracker />} />
                                <Route path="/invest/industry" element={<IndustryMap />} />
                                <Route path="/invest/sold-tracker" element={<SoldTracker />} />
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
        </PriceProvider>
    )
}