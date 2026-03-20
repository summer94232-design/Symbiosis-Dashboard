import { useState, useEffect, useRef } from 'react'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { useNavigate } from 'react-router-dom'
import { kmsDB } from '../../lib/firebase'
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
  const animRef = useRef<number | null>(null)
  const nodesRef = useRef<GraphNode[]>([])
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null)
  const sizeRef = useRef({ w: 800, h: 480 })

  const load = async () => {
    setLoading(true)
    const q = query(collection(kmsDB, 'notes'), orderBy('createdAt', 'desc'))
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

    data.forEach(note => {
      newNodes.push({
        id: `note-${note.id}`, label: note.title.slice(0, 16),
        type: 'note', x: Math.random() * W, y: Math.random() * H, vx: 0, vy: 0
      })
      note.hashtags?.forEach(tag => {
        if (!tagSet.has(tag)) {
          tagSet.add(tag)
          newNodes.push({
            id: `tag-${tag}`, label: `#${tag}`,
            type: 'tag', x: Math.random() * W, y: Math.random() * H, vx: 0, vy: 0
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
    const W = container.clientWidth - 40
    const H = Math.round(W * 0.58)
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
          const force = 3500 / (dist * dist)
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
        const force = (dist - 120) * 0.03
        s.vx += (dx / dist) * force; s.vy += (dy / dist) * force
        t.vx -= (dx / dist) * force; t.vy -= (dy / dist) * force
      })

      ns.forEach(n => {
        n.vx += (W / 2 - n.x) * 0.002; n.vy += (H / 2 - n.y) * 0.002
        n.vx *= 0.85; n.vy *= 0.85
        if (!dragRef.current || dragRef.current.id !== n.id) { n.x += n.vx; n.y += n.vy }
        n.x = Math.max(50, Math.min(W - 50, n.x))
        n.y = Math.max(50, Math.min(H - 50, n.y))
      })
      nodesRef.current = ns

      ctx.clearRect(0, 0, W, H)

      edges.forEach(edge => {
        const s = ns.find(n => n.id === edge.source)
        const t = ns.find(n => n.id === edge.target)
        if (!s || !t) return
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y)
        ctx.strokeStyle = 'rgba(79,142,247,0.2)'; ctx.lineWidth = 1; ctx.stroke()
      })

      ns.forEach(n => {
        const r = n.type === 'note' ? 12 : 9
        const isHovered = hoveredNode === n.id
        const color = NODE_COLORS[n.type]
        ctx.beginPath(); ctx.arc(n.x, n.y, r + (isHovered ? 3 : 0), 0, Math.PI * 2)
        ctx.fillStyle = isHovered ? color : `${color}cc`; ctx.fill()
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke()

        const fontSize = n.type === 'note' ? 13 : 12
        ctx.font = `500 ${fontSize}px -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif`
        ctx.textAlign = 'center'; ctx.textBaseline = 'top'
        const labelY = n.y + r + 6
        const metrics = ctx.measureText(n.label)
        const padding = 4
        ctx.fillStyle = 'rgba(15,17,23,0.78)'
        ctx.beginPath()
        ctx.roundRect(n.x - metrics.width / 2 - padding, labelY - 1, metrics.width + padding * 2, fontSize + 4, 3)
        ctx.fill()
        ctx.fillStyle = '#e2e8f0'; ctx.fillText(n.label, n.x, labelY)
      })

      animRef.current = requestAnimationFrame(simulate)
    }

    animRef.current = requestAnimationFrame(simulate)
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current) }
  }, [nodes, edges, hoveredNode])

  const getNodeAt = (x: number, y: number) => nodesRef.current.find(n => {
    const r = n.type === 'note' ? 15 : 12
    return Math.sqrt((n.x - x) ** 2 + (n.y - y) ** 2) < r
  })

  const getPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const scale = sizeRef.current.w / rect.width
    return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getPos(e)
    setHoveredNode(getNodeAt(x, y)?.id || null)
    if (dragRef.current) {
      const n = nodesRef.current.find(n => n.id === dragRef.current!.id)
      if (n) { n.x = x + dragRef.current.offsetX; n.y = y + dragRef.current.offsetY }
    }
  }

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getPos(e)
    const node = getNodeAt(x, y)
    if (node) {
      dragRef.current = { id: node.id, offsetX: node.x - x, offsetY: node.y - y }
      setSelectedNode(node)
    }
  }

  const handleMouseUp = () => { dragRef.current = null }

  // 點擊筆記跳轉到知識庫並展開該筆記
  const handleGoToNote = (noteId: string) => {
    navigate(`/kms?note=${noteId}`)
  }

  const relatedNotes = selectedNode?.type === 'tag'
    ? notes.filter(n => n.hashtags?.includes(selectedNode.label.replace('#', '')))
    : notes.filter(n => n.id === selectedNode?.id.replace('note-', ''))

  const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }

  return (
    <div style={{ padding: 'clamp(16px, 2vw, 24px)', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ marginBottom: '16px' }}>
        <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>知識圖譜</h1>
        <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0', display: 'flex', gap: '16px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#4f8ef7', display: 'inline-block' }} />藍色 = 筆記
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#00c896', display: 'inline-block' }} />綠色 = 標籤
          </span>
        </p>
      </div>

      <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
        {/* 圖譜 */}
        <div ref={containerRef} style={{ ...card, flex: 1, minWidth: 0 }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>載入中...</div>
          ) : nodes.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>
              <p style={{ fontSize: '15px' }}>還沒有筆記</p>
              <p style={{ fontSize: '13px', marginTop: '8px' }}>請先在知識庫新增筆記</p>
            </div>
          ) : (
            <canvas ref={canvasRef}
              style={{ display: 'block', width: '100%', height: 'auto', borderRadius: '8px', cursor: hoveredNode ? 'grab' : 'default' }}
              onMouseMove={handleMouseMove} onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} />
          )}
        </div>

        {/* 右側資訊欄 */}
        {selectedNode && (
          <div style={{ ...card, width: '260px', minWidth: '260px', flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>
                {selectedNode.type === 'tag' ? '標籤詳情' : '筆記詳情'}
              </span>
              <button onClick={() => setSelectedNode(null)}
                style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer', fontSize: '18px', lineHeight: 1 }}>×</button>
            </div>

            <p style={{ fontSize: '15px', fontWeight: 600, color: selectedNode.type === 'tag' ? '#00c896' : '#4f8ef7', margin: '0 0 12px', wordBreak: 'break-all' }}>
              {selectedNode.label}
            </p>

            <p style={{ fontSize: '12px', color: '#8892a4', margin: '0 0 8px' }}>相關筆記 ({relatedNotes.length})</p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '420px', overflowY: 'auto' }}>
              {relatedNotes.map(n => (
                <div key={n.id} style={{ backgroundColor: '#0f1117', borderRadius: '8px', padding: '10px 12px', fontSize: '13px', color: '#e2e8f0', cursor: 'pointer', border: '1px solid transparent', transition: 'border-color 0.15s' }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = '#2e3349')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = 'transparent')}
                  onClick={() => handleGoToNote(n.id)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                    <span style={{ flex: 1, lineHeight: 1.4 }}>{n.title}</span>
                    <ExternalLink size={13} style={{ color: '#4f8ef7', flexShrink: 0, marginTop: '2px' }} />
                  </div>
                  {n.content && (
                    <p style={{ margin: '6px 0 0', fontSize: '12px', color: '#8892a4', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {n.content}
                    </p>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                    {n.hashtags?.map(t => (
                      <span key={t} style={{ fontSize: '11px', color: '#4f8ef7', backgroundColor: 'rgba(79,142,247,0.1)', borderRadius: '10px', padding: '1px 6px' }}>
                        #{t}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}