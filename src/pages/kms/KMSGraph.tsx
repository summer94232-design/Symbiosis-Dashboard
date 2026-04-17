import { useState, useEffect, useRef } from 'react'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { useNavigate } from 'react-router-dom'
import { kmsDB } from '../../lib/firebase'
import { userCol } from '../../lib/userDB'
import { ExternalLink } from 'lucide-react'

interface Note {
  id: string
  title: string
  hashtags: string[]
  type: string
  content?: string
  url?: string
}

interface GraphNode {
  id: string
  label: string
  type: 'note' | 'tag'
  x: number
  y: number
  vx: number
  vy: number
}

interface GraphEdge {
  source: string
  target: string
}

const NODE_COLORS = { note: '#4f8ef7', tag: '#00c896' }

export default function KMSGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const [notes, setNotes] = useState<Note[]>([])
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [loading, setLoading] = useState(true)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  const animRef = useRef<number | null>(null)
  const nodesRef = useRef<GraphNode[]>([])
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null)
  const sizeRef = useRef({ w: 800, h: 480 })

  useEffect(() => {
    const handle = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handle)
    return () => window.removeEventListener('resize', handle)
  }, [])

  const load = async () => {
    setLoading(true)
    const q = query(userCol(kmsDB, 'notes'), orderBy('createdAt', 'desc'))
    const snap = await getDocs(q)
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() } as Note))
    setNotes(data)
    buildGraph(data)
    setLoading(false)
  }

  const buildGraph = (data: Note[]) => {
    const newNodes: GraphNode[] = []
    const newEdges: GraphEdge[] = []
    const tagSet = new Set<string>()
    const W = 800, H = 480
    const total = data.length

    // 筆記節點用圓形分布避免重疊
    data.forEach((note, i) => {
      const angle = (i / total) * Math.PI * 2
      const r = Math.min(W, H) * 0.35
      newNodes.push({
        id: `note-${note.id}`,
        label: note.title.slice(0, 12),
        type: 'note',
        x: W / 2 + Math.cos(angle) * r + (Math.random() - 0.5) * 40,
        y: H / 2 + Math.sin(angle) * r + (Math.random() - 0.5) * 40,
        vx: 0, vy: 0
      })
      note.hashtags?.forEach(tag => {
        if (!tagSet.has(tag)) {
          tagSet.add(tag)
          const tagAngle = Math.random() * Math.PI * 2
          const tagR = Math.min(W, H) * 0.18
          newNodes.push({
            id: `tag-${tag}`,
            label: `#${tag.split('/').pop()}`,
            type: 'tag',
            x: W / 2 + Math.cos(tagAngle) * tagR,
            y: H / 2 + Math.sin(tagAngle) * tagR,
            vx: 0, vy: 0
          })
        }
        newEdges.push({ source: `note-${note.id}`, target: `tag-${tag}` })
      })
    })

    setNodes(newNodes)
    setEdges(newEdges)
    nodesRef.current = newNodes
  }

  useEffect(() => { load() }, [])

  const setupCanvas = () => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const dpr = window.devicePixelRatio || 1
    const W = container.clientWidth
    const H = isMobile ? Math.round(W * 0.9) : Math.round(W * 0.58)
    sizeRef.current = { w: W, h: H }
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`
    const ctx = canvas.getContext('2d')
    if (ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(dpr, dpr) }
  }

  useEffect(() => {
    if (nodes.length === 0) return
    setupCanvas()
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const simulate = () => {
      const { w: W, h: H } = sizeRef.current
      const ns = [...nodesRef.current]

      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          const dx = ns[j].x - ns[i].x, dy = ns[j].y - ns[i].y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          const force = 4000 / (dist * dist)
          const fx = (dx / dist) * force, fy = (dy / dist) * force
          ns[i].vx -= fx; ns[i].vy -= fy
          ns[j].vx += fx; ns[j].vy += fy
        }
      }

      edges.forEach(edge => {
        const s = ns.find(n => n.id === edge.source)
        const t = ns.find(n => n.id === edge.target)
        if (!s || !t) return
        const dx = t.x - s.x, dy = t.y - s.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const force = (dist - 100) * 0.025
        s.vx += (dx / dist) * force; s.vy += (dy / dist) * force
        t.vx -= (dx / dist) * force; t.vy -= (dy / dist) * force
      })

      ns.forEach(n => {
        n.vx += (W / 2 - n.x) * 0.003; n.vy += (H / 2 - n.y) * 0.003
        n.vx *= 0.82; n.vy *= 0.82
        if (!dragRef.current || dragRef.current.id !== n.id) { n.x += n.vx; n.y += n.vy }
        n.x = Math.max(55, Math.min(W - 55, n.x))
        n.y = Math.max(55, Math.min(H - 55, n.y))
      })
      nodesRef.current = ns

      ctx.clearRect(0, 0, W, H)

      edges.forEach(edge => {
        const s = ns.find(n => n.id === edge.source)
        const t = ns.find(n => n.id === edge.target)
        if (!s || !t) return
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y)
        ctx.strokeStyle = 'rgba(79,142,247,0.18)'; ctx.lineWidth = 1; ctx.stroke()
      })

      ns.forEach(n => {
        const r = n.type === 'note' ? 11 : 8
        const isHovered = hoveredNode === n.id
        const color = NODE_COLORS[n.type]
        ctx.beginPath(); ctx.arc(n.x, n.y, r + (isHovered ? 3 : 0), 0, Math.PI * 2)
        ctx.fillStyle = isHovered ? color : `${color}cc`; ctx.fill()
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke()

        const fontSize = isMobile ? 11 : 12
        ctx.font = `500 ${fontSize}px -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif`
        ctx.textAlign = 'center'; ctx.textBaseline = 'top'
        const labelY = n.y + r + 5
        const metrics = ctx.measureText(n.label)
        const padding = 3
        ctx.fillStyle = 'rgba(15,17,23,0.82)'
        ctx.beginPath()
        ctx.roundRect(n.x - metrics.width / 2 - padding, labelY - 1, metrics.width + padding * 2, fontSize + 4, 3)
        ctx.fill()
        ctx.fillStyle = '#e2e8f0'; ctx.fillText(n.label, n.x, labelY)
      })

      animRef.current = requestAnimationFrame(simulate)
    }

    animRef.current = requestAnimationFrame(simulate)
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current) }
  }, [nodes, edges, hoveredNode, isMobile])

  const getScale = () => {
    const canvas = canvasRef.current
    if (!canvas) return 1
    return sizeRef.current.w / canvas.getBoundingClientRect().width
  }

  const getNodeAt = (x: number, y: number) => nodesRef.current.find(n => {
    const r = n.type === 'note' ? 18 : 14
    return Math.sqrt((n.x - x) ** 2 + (n.y - y) ** 2) < r
  })

  // 滑鼠事件
  const getMousePos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const scale = getScale()
    return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getMousePos(e)
    setHoveredNode(getNodeAt(x, y)?.id || null)
    if (dragRef.current) {
      const n = nodesRef.current.find(n => n.id === dragRef.current!.id)
      if (n) { n.x = x + dragRef.current.offsetX; n.y = y + dragRef.current.offsetY }
    }
  }

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getMousePos(e)
    const node = getNodeAt(x, y)
    if (node) {
      dragRef.current = { id: node.id, offsetX: node.x - x, offsetY: node.y - y }
      setSelectedNode(node)
    }
  }

  const handleMouseUp = () => { dragRef.current = null }

  // 觸控事件（手機）
  const getTouchPos = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const touch = e.touches[0] || e.changedTouches[0]
    const scale = getScale()
    return { x: (touch.clientX - rect.left) * scale, y: (touch.clientY - rect.top) * scale }
  }

  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const { x, y } = getTouchPos(e)
    const node = getNodeAt(x, y)
    if (node) {
      dragRef.current = { id: node.id, offsetX: node.x - x, offsetY: node.y - y }
      setSelectedNode(node)
      setHoveredNode(node.id)
    }
  }

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const { x, y } = getTouchPos(e)
    if (dragRef.current) {
      const n = nodesRef.current.find(n => n.id === dragRef.current!.id)
      if (n) { n.x = x + dragRef.current.offsetX; n.y = y + dragRef.current.offsetY }
    }
  }

  const handleTouchEnd = () => {
    dragRef.current = null
    setHoveredNode(null)
  }

  const handleGoToNote = (noteId: string) => { navigate(`/kms?note=${noteId}`) }

  const relatedNotes = selectedNode?.type === 'tag'
    ? notes.filter(n => n.hashtags?.includes(selectedNode.label.replace('#', '').split('/').join('/')))
    : notes.filter(n => n.id === selectedNode?.id.replace('note-', ''))

  const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '16px' }

  return (
    <div style={{ padding: 'clamp(12px, 2vw, 24px)' }}>
      <div style={{ marginBottom: '14px' }}>
        <h1 style={{ fontSize: 'clamp(16px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>知識圖譜</h1>
        <p style={{ fontSize: '12px', color: '#8892a4', margin: '4px 0 0', display: 'flex', gap: '14px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: '#4f8ef7', display: 'inline-block' }} />藍色 = 筆記
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: '#00c896', display: 'inline-block' }} />綠色 = 標籤
          </span>
          {isMobile && <span style={{ color: '#8892a4' }}>點擊節點查看詳情</span>}
        </p>
      </div>

      {/* 手機：上下排列；桌面：左右排列 */}
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: '14px', alignItems: 'flex-start' }}>
        <div ref={containerRef} style={{ ...card, flex: 1, width: '100%', minWidth: 0, padding: '12px' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>載入中...</div>
          ) : nodes.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>
              <p style={{ fontSize: '14px' }}>還沒有筆記</p>
            </div>
          ) : (
            <canvas ref={canvasRef}
              style={{ display: 'block', width: '100%', height: 'auto', borderRadius: '6px', cursor: hoveredNode ? 'grab' : 'default', touchAction: 'none' }}
              onMouseMove={handleMouseMove}
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            />
          )}
        </div>

        {/* 詳情欄 */}
        {selectedNode && (
          <div style={{ ...card, width: isMobile ? '100%' : '240px', minWidth: isMobile ? 'unset' : '240px', flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                {selectedNode.type === 'tag' ? '標籤詳情' : '筆記詳情'}
              </span>
              <button onClick={() => setSelectedNode(null)}
                style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer', fontSize: '16px', lineHeight: 1 }}>×</button>
            </div>

            <p style={{ fontSize: '14px', fontWeight: 600, color: selectedNode.type === 'tag' ? '#00c896' : '#4f8ef7', margin: '0 0 10px', wordBreak: 'break-all' }}>
              {selectedNode.label}
            </p>

            <p style={{ fontSize: '11px', color: '#8892a4', margin: '0 0 8px' }}>相關筆記 ({relatedNotes.length})</p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: isMobile ? '240px' : '380px', overflowY: 'auto' }}>
              {relatedNotes.map(n => (
                <div key={n.id}
                  style={{ backgroundColor: '#0f1117', borderRadius: '8px', padding: '9px 11px', fontSize: '12px', color: '#e2e8f0', cursor: 'pointer', border: '1px solid #2e3349' }}
                  onClick={() => handleGoToNote(n.id)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '6px' }}>
                    <span style={{ flex: 1, lineHeight: 1.4, fontSize: '13px' }}>{n.title}</span>
                    <ExternalLink size={12} style={{ color: '#4f8ef7', flexShrink: 0, marginTop: '2px' }} />
                  </div>
                  {n.content && (
                    <p style={{ margin: '5px 0 0', fontSize: '11px', color: '#8892a4', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {n.content}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}