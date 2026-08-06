import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchKmsNoteSummaries, fetchKmsTagOrder } from '../../lib/kmsData'
import { Search, X, ExternalLink, ChevronRight, ChevronDown, Tag } from 'lucide-react'

interface Note {
  id: string
  title: string
  hashtags: string[]
  type: string
  content?: string
  url?: string
}

interface TagNode {
  name: string
  fullTag: string
  noteCount: number
  children: TagNode[]
}

type NodeKind = 'root-tag' | 'child-tag' | 'note'

interface CanvasNode {
  id: string
  kind: NodeKind
  label: string
  x: number; y: number; vx: number; vy: number
  r: number
  color: string
  parentId: string | null
  noteId?: string
  fullTag?: string
  expanded?: boolean
}

interface CanvasEdge {
  s: string; t: string; color: string
}

const TAG_COLORS = [
  '#4f8ef7', '#00c896', '#f7a94f', '#e05c8a',
  '#7f77dd', '#d85a30', '#1d9e75', '#ba7517',
  '#378add', '#d4537e', '#639922', '#5f5e5a',
]

export default function KMSGraph() {
  const navigate = useNavigate()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const animRef = useRef<number | null>(null)

  const [notes, setNotes] = useState<Note[]>([])
  const [tagTree, setTagTree] = useState<TagNode[]>([])
  const [tagColorMap, setTagColorMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  const [focusedNote, setFocusedNote] = useState<Note | null>(null)
  const [, forceRender] = useState(0)

  const nodesRef = useRef<CanvasNode[]>([])
  const edgesRef = useRef<CanvasEdge[]>([])
  const hovRef = useRef<string | null>(null)
  const focusedNodeRef = useRef<string | null>(null)
  const dragRef = useRef<{ id: string; ox: number; oy: number; moved: boolean } | null>(null)
  const sizeRef = useRef({ w: 600, h: 420 })

  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', h)
    return () => window.removeEventListener('resize', h)
  }, [])

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      const [data, tagOrder] = await Promise.all([
        fetchKmsNoteSummaries<Note>(),
        fetchKmsTagOrder(),
      ])
      setNotes(data)
      const parentOrder = tagOrder.parentOrder
      const childOrder = tagOrder.childOrder
      const tree = buildTagTree(data, parentOrder, childOrder)
      setTagTree(tree)

      const colorMap: Record<string, string> = {}
      tree.forEach((root, i) => {
        const c = TAG_COLORS[i % TAG_COLORS.length]
        colorMap[root.fullTag] = c
        root.children.forEach(child => { colorMap[child.fullTag] = c })
      })
      setTagColorMap(colorMap)
      setLoading(false)
    }
    load()
  }, [])

  function buildTagTree(data: Note[], parentOrder: string[], childOrder: Record<string, string[]>): TagNode[] {
    const tagNoteIds: Record<string, Set<string>> = {}
    data.forEach(n => n.hashtags?.forEach(tag => {
      if (!tagNoteIds[tag]) tagNoteIds[tag] = new Set()
      tagNoteIds[tag].add(n.id)
    }))
    const parentMap: Record<string, TagNode> = {}
    Object.keys(tagNoteIds).forEach(tag => {
      const root = tag.split('/')[0]
      if (!parentMap[root]) parentMap[root] = { name: root, fullTag: root, noteCount: 0, children: [] }
    })
    Object.entries(tagNoteIds).forEach(([tag, ids]) => {
      const parts = tag.split('/')
      const root = parts[0]
      if (!parentMap[root]) return
      if (parts.length === 1) {
        parentMap[root].noteCount += ids.size
      } else {
        if (!parentMap[root].children.find(c => c.fullTag === tag))
          parentMap[root].children.push({ name: parts.slice(1).join('/'), fullTag: tag, noteCount: ids.size, children: [] })
        parentMap[root].noteCount += ids.size
      }
    })
    const ordered: TagNode[] = []
    const seen = new Set<string>()
    parentOrder.forEach(name => { if (parentMap[name]) { ordered.push(parentMap[name]); seen.add(name) } })
    Object.values(parentMap).forEach(n => { if (!seen.has(n.name)) ordered.push(n) })
    ordered.forEach(parent => {
      const kids = childOrder[parent.name]; if (!kids?.length) return
      const cm = Object.fromEntries(parent.children.map(c => [c.fullTag, c]))
      const sorted: TagNode[] = []; const cs = new Set<string>()
      kids.forEach(ft => { if (cm[ft]) { sorted.push(cm[ft]); cs.add(ft) } })
      parent.children.forEach(c => { if (!cs.has(c.fullTag)) sorted.push(c) })
      parent.children = sorted
    })
    return ordered
  }

  // ── 建立/更新 canvas 節點 ────────────────────────────
  // 核心邏輯變更：
  // - activeRoots 決定哪些「根標籤節點」出現在畫面
  // - expandedChildTags 決定哪些「子標籤節點」和其筆記出現在畫面
  // - 取消根標籤選取：只移除根標籤節點，已展開的子標籤和筆記保留
  //   → 子標籤此時 parentId 設為 null（浮動節點），不依附任何根標籤
  const rebuild = useCallback((
    activeRoots: string[],
    expandedChildTags: Set<string>,
    colorMap: Record<string, string>,
    allNotes: Note[],
    prevNodes: CanvasNode[],
    allTagTree: TagNode[]
  ) => {
    const { w: W, h: H } = sizeRef.current
    const newNodes: CanvasNode[] = []
    const newEdges: CanvasEdge[] = []

    const cx = W / 2, cy = H / 2

    // Step 1：建立選中的根標籤節點
    const rootPositions: Record<string, { x: number; y: number }> = {}
    activeRoots.forEach((rootTag, i) => {
      const angle = (i / activeRoots.length) * Math.PI * 2 - Math.PI / 2
      const r = activeRoots.length === 1 ? 0 : Math.min(W, H) * 0.2
      const prev = prevNodes.find(n => n.id === 'root-' + rootTag)
      rootPositions[rootTag] = {
        x: prev?.x ?? cx + Math.cos(angle) * r,
        y: prev?.y ?? cy + Math.sin(angle) * r,
      }
      const color = colorMap[rootTag] || TAG_COLORS[0]
      newNodes.push({
        id: 'root-' + rootTag, kind: 'root-tag',
        label: '#' + rootTag.split('/').pop()!,
        x: rootPositions[rootTag].x, y: rootPositions[rootTag].y,
        vx: 0, vy: 0, r: 24, color,
        parentId: null, fullTag: rootTag,
      })
    })

    // Step 2：建立每個選中根標籤旗下的子標籤節點（但只有根標籤在 activeRoots 時才建立子標籤節點）
    activeRoots.forEach(rootTag => {
      const rootPos = rootPositions[rootTag]
      const color = colorMap[rootTag] || TAG_COLORS[0]
      const rootNode = allTagTree.find(t => t.fullTag === rootTag)
      const childTags = rootNode?.children ?? []

      if (childTags.length > 0) {
        childTags.forEach((child, ci) => {
          const angle = (ci / childTags.length) * Math.PI * 2 - Math.PI / 2
          const orbitR = Math.min(W, H) * 0.28
          const prev = prevNodes.find(n => n.id === 'child-' + child.fullTag)
          const childX = prev?.x ?? rootPos.x + Math.cos(angle) * orbitR + (Math.random() - 0.5) * 20
          const childY = prev?.y ?? rootPos.y + Math.sin(angle) * orbitR + (Math.random() - 0.5) * 20
          const isExpanded = expandedChildTags.has(child.fullTag)

          newNodes.push({
            id: 'child-' + child.fullTag, kind: 'child-tag',
            label: '#' + child.name.split('/').pop()!,
            x: childX, y: childY,
            vx: 0, vy: 0, r: 17, color,
            // 子標籤的 parentId 指向根標籤節點（根標籤還在 activeRoots 中）
            parentId: 'root-' + rootTag, fullTag: child.fullTag,
            expanded: isExpanded,
          })
          newEdges.push({ s: 'root-' + rootTag, t: 'child-' + child.fullTag, color })

          if (isExpanded) {
            const childNotes = allNotes.filter(n =>
              n.hashtags?.some(t => t === child.fullTag || t.startsWith(child.fullTag + '/'))
            )
            childNotes.forEach((note, ni) => {
              const nAngle = (ni / Math.max(childNotes.length, 1)) * Math.PI * 2 - Math.PI / 2
              const nOrbit = Math.min(W, H) * 0.16
              const prev = prevNodes.find(n => n.id === 'note-' + note.id + '-' + child.fullTag)
              newNodes.push({
                id: 'note-' + note.id + '-' + child.fullTag, kind: 'note',
                label: note.title,
                x: prev?.x ?? childX + Math.cos(nAngle) * nOrbit + (Math.random() - 0.5) * 15,
                y: prev?.y ?? childY + Math.sin(nAngle) * nOrbit + (Math.random() - 0.5) * 15,
                vx: 0, vy: 0, r: 11, color,
                parentId: 'child-' + child.fullTag, noteId: note.id,
              })
              newEdges.push({ s: 'child-' + child.fullTag, t: 'note-' + note.id + '-' + child.fullTag, color })
            })
          }
        })

        // 根標籤直接掛的筆記
        const directNotes = allNotes.filter(n => n.hashtags?.includes(rootTag))
        if (directNotes.length > 0) {
          directNotes.forEach((note, ni) => {
            const angle = (ni / directNotes.length) * Math.PI * 2 + Math.PI / 4
            const orbitR = Math.min(W, H) * 0.14
            const prev = prevNodes.find(n => n.id === 'note-' + note.id + '-direct')
            newNodes.push({
              id: 'note-' + note.id + '-direct', kind: 'note',
              label: note.title,
              x: prev?.x ?? rootPos.x + Math.cos(angle) * orbitR,
              y: prev?.y ?? rootPos.y + Math.sin(angle) * orbitR,
              vx: 0, vy: 0, r: 11, color,
              parentId: 'root-' + rootTag, noteId: note.id,
            })
            newEdges.push({ s: 'root-' + rootTag, t: 'note-' + note.id + '-direct', color })
          })
        }

      } else {
        // 沒有子標籤 → 直接顯示筆記
        const directNotes = allNotes.filter(n => n.hashtags?.includes(rootTag))
        directNotes.forEach((note, ni) => {
          const angle = (ni / Math.max(directNotes.length, 1)) * Math.PI * 2 - Math.PI / 2
          const orbitR = Math.min(W, H) * 0.28
          const prev = prevNodes.find(n => n.id === 'note-' + note.id + '-direct')
          newNodes.push({
            id: 'note-' + note.id + '-direct', kind: 'note',
            label: note.title,
            x: prev?.x ?? rootPos.x + Math.cos(angle) * orbitR,
            y: prev?.y ?? rootPos.y + Math.sin(angle) * orbitR,
            vx: 0, vy: 0, r: 11, color,
            parentId: 'root-' + rootTag, noteId: note.id,
          })
          newEdges.push({ s: 'root-' + rootTag, t: 'note-' + note.id + '-direct', color })
        })
      }
    })

    // Step 3：處理「根標籤已取消選取，但子標籤仍在 expandedChildTags」的情況
    // 這些子標籤的根標籤不在 activeRoots，所以上面沒有建立它們的節點
    // 現在把這些「孤立的子標籤」加回來，parentId = null（浮動）
    expandedChildTags.forEach(childFullTag => {
      // 找到這個子標籤的根標籤
      const parentRootTag = childFullTag.split('/')[0]
      // 如果根標籤還在 activeRoots，它已經在 Step 2 處理了，跳過
      if (activeRoots.includes(parentRootTag)) return
      // 根標籤不在 activeRoots → 子標籤需要單獨存在（浮動）
      const color = colorMap[childFullTag] || colorMap[parentRootTag] || TAG_COLORS[0]
      const prev = prevNodes.find(n => n.id === 'child-' + childFullTag)
      // 如果沒有舊位置，放在畫面中間附近
      const fx = prev?.x ?? cx + (Math.random() - 0.5) * Math.min(W, H) * 0.3
      const fy = prev?.y ?? cy + (Math.random() - 0.5) * Math.min(W, H) * 0.3

      // 找 tagTree 中這個子標籤的資訊
      const parentTagNode = allTagTree.find(t => t.fullTag === parentRootTag)
      const childTagNode = parentTagNode?.children.find(c => c.fullTag === childFullTag)
      if (!childTagNode) return

      newNodes.push({
        id: 'child-' + childFullTag, kind: 'child-tag',
        label: '#' + childTagNode.name.split('/').pop()!,
        x: fx, y: fy,
        vx: 0, vy: 0, r: 17, color,
        parentId: null,   // 浮動：根標籤已取消，不依附任何節點
        fullTag: childFullTag,
        expanded: true,
      })
      // 展開筆記
      const childNotes = allNotes.filter(n =>
        n.hashtags?.some(t => t === childFullTag || t.startsWith(childFullTag + '/'))
      )
      childNotes.forEach((note, ni) => {
        const nAngle = (ni / Math.max(childNotes.length, 1)) * Math.PI * 2 - Math.PI / 2
        const nOrbit = Math.min(W, H) * 0.16
        const prevNote = prevNodes.find(n => n.id === 'note-' + note.id + '-' + childFullTag)
        newNodes.push({
          id: 'note-' + note.id + '-' + childFullTag, kind: 'note',
          label: note.title,
          x: prevNote?.x ?? fx + Math.cos(nAngle) * nOrbit + (Math.random() - 0.5) * 15,
          y: prevNote?.y ?? fy + Math.sin(nAngle) * nOrbit + (Math.random() - 0.5) * 15,
          vx: 0, vy: 0, r: 11, color,
          parentId: 'child-' + childFullTag, noteId: note.id,
        })
        newEdges.push({ s: 'child-' + childFullTag, t: 'note-' + note.id + '-' + childFullTag, color })
      })
    })

    nodesRef.current = newNodes
    edgesRef.current = newEdges
  }, [tagTree])

  const [activeRoots, setActiveRoots] = useState<string[]>([])
  const [expandedChildTags, setExpandedChildTags] = useState<Set<string>>(new Set())

  useEffect(() => {
    rebuild(activeRoots, expandedChildTags, tagColorMap, notes, nodesRef.current, tagTree)
    forceRender(v => v + 1)
  }, [activeRoots, expandedChildTags, tagColorMap, notes, rebuild, tagTree])

  const toggleRoot = (fullTag: string) => {
    setActiveRoots(prev =>
      prev.includes(fullTag) ? prev.filter(t => t !== fullTag) : [...prev, fullTag]
    )
    // ★ 關鍵修改：取消根標籤時，不清除 expandedChildTags
    // 讓已展開的子標籤和筆記保留在畫面上（變成浮動節點）
    setFocusedNote(null)
    focusedNodeRef.current = null
  }

  const toggleChildTag = (fullTag: string) => {
    setExpandedChildTags(prev => {
      const next = new Set(prev)
      next.has(fullTag) ? next.delete(fullTag) : next.add(fullTag)
      return next
    })
    setFocusedNote(null)
    focusedNodeRef.current = null
  }

  // ── Canvas setup ─────────────────────────────────────
  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current, container = containerRef.current
    if (!canvas || !container) return
    const dpr = window.devicePixelRatio || 1
    const W = container.clientWidth
    const H = isMobile ? Math.round(W * 0.9) : Math.round(W * 0.65)
    sizeRef.current = { w: W, h: H }
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`
    const ctx = canvas.getContext('2d')
    if (ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(dpr, dpr) }
  }, [isMobile])

  // ── Animation loop ───────────────────────────────────
  useEffect(() => {
    setupCanvas()
    const canvas = canvasRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d'); if (!ctx) return
    if (animRef.current) cancelAnimationFrame(animRef.current)

    const simulate = () => {
      const { w: W, h: H } = sizeRef.current
      const ns = nodesRef.current
      const es = edgesRef.current

      if (ns.length === 0) {
        ctx.clearRect(0, 0, W, H)
        animRef.current = requestAnimationFrame(simulate)
        return
      }

      // 斥力（同層之間）
      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          const a = ns[i], b = ns[j]
          if (a.parentId !== b.parentId && a.parentId !== b.id && b.parentId !== a.id) continue
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1
          if (d < 100) {
            const f = 2500 / (d * d)
            a.vx -= (dx / d) * f * 0.5; a.vy -= (dy / d) * f * 0.5
            b.vx += (dx / d) * f * 0.5; b.vy += (dy / d) * f * 0.5
          }
        }
      }

      // 彈簧：每個節點拉向父節點
      ns.forEach(n => {
        if (!n.parentId) return
        const parent = ns.find(p => p.id === n.parentId); if (!parent) return
        const dx = parent.x - n.x, dy = parent.y - n.y, d = Math.sqrt(dx * dx + dy * dy) || 1
        const ideal = n.kind === 'child-tag' ? Math.min(W, H) * 0.28
          : n.kind === 'note' && ns.find(p => p.id === n.parentId)?.kind === 'child-tag'
            ? Math.min(W, H) * 0.17
            : Math.min(W, H) * 0.22
        const f = (d - ideal) * 0.007
        n.vx += (dx / d) * f; n.vy += (dy / d) * f
        parent.vx -= (dx / d) * f * 0.1; parent.vy -= (dy / d) * f * 0.1
      })

      // 根標籤輕拉回畫面中心；浮動的子標籤（parentId=null）也輕拉向中心
      ns.forEach(n => {
        if (n.kind === 'root-tag') {
          n.vx += (W / 2 - n.x) * 0.001; n.vy += (H / 2 - n.y) * 0.001
        } else if (n.kind === 'child-tag' && n.parentId === null) {
          // 浮動子標籤：輕拉向畫面中心，確保不飄出去
          n.vx += (W / 2 - n.x) * 0.0008; n.vy += (H / 2 - n.y) * 0.0008
        }
      })

      // 積分 + 阻尼 + 邊界
      ns.forEach(n => {
        if (dragRef.current?.id === n.id) return
        n.vx *= 0.74; n.vy *= 0.74; n.x += n.vx; n.y += n.vy
        n.x = Math.max(n.r + 4, Math.min(W - n.r - 4, n.x))
        n.y = Math.max(n.r + 4, Math.min(H - n.r - 4, n.y))
      })

      ctx.clearRect(0, 0, W, H)

      // 邊
      es.forEach(e => {
        const s = ns.find(n => n.id === e.s), t = ns.find(n => n.id === e.t)
        if (!s || !t) return
        const isHov = hovRef.current === s.id || hovRef.current === t.id
        const isFoc = focusedNodeRef.current === t.id
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y)
        ctx.strokeStyle = isFoc ? e.color + 'ee' : isHov ? e.color + 'aa' : e.color + '30'
        ctx.lineWidth = isFoc ? 2 : isHov ? 1.5 : 1; ctx.stroke()
      })

      // 節點
      ns.forEach(n => {
        const isHov = hovRef.current === n.id
        const isFoc = focusedNodeRef.current === n.id
        const r = n.r + (isHov ? 3 : 0) + (isFoc ? 2 : 0)

        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2)

        if (n.kind === 'root-tag') {
          ctx.fillStyle = n.color; ctx.fill()
          ctx.strokeStyle = n.color + '55'; ctx.lineWidth = 3; ctx.stroke()
        } else if (n.kind === 'child-tag') {
          // 浮動子標籤（根標籤已取消）用虛線邊框區分
          const isFloating = n.parentId === null
          ctx.fillStyle = n.color + (n.expanded ? 'cc' : '55'); ctx.fill()
          ctx.strokeStyle = n.color; ctx.lineWidth = 2
          if (isFloating) {
            ctx.setLineDash([4, 3])
          }
          ctx.stroke()
          ctx.setLineDash([])
          if (n.expanded) {
            ctx.beginPath(); ctx.arc(n.x + r - 3, n.y - r + 3, 3, 0, Math.PI * 2)
            ctx.fillStyle = '#fff'; ctx.fill()
          }
        } else {
          ctx.fillStyle = isFoc ? n.color + '55' : n.color + '30'; ctx.fill()
          ctx.strokeStyle = n.color + (isFoc ? 'ff' : '99'); ctx.lineWidth = isFoc ? 2 : 1.5; ctx.stroke()
        }

        // 文字
        const maxLen = n.kind === 'root-tag' ? 7 : n.kind === 'child-tag' ? 6 : 5
        const line1 = n.label.replace(/^#/, '').slice(0, maxLen)
        const hasMore = n.label.replace(/^#/, '').length > maxLen
        const line2 = hasMore ? n.label.replace(/^#/, '').slice(maxLen, maxLen * 2) + (n.label.replace(/^#/, '').length > maxLen * 2 ? '…' : '') : ''
        const fs = n.kind === 'root-tag' ? 11 : n.kind === 'child-tag' ? 10 : 9
        ctx.font = `${n.kind === 'root-tag' ? '500 ' : ''}${fs}px -apple-system,"PingFang TC",sans-serif`
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'
        ctx.fillText(line1, n.x, n.y - (line2 ? fs / 2 + 1 : 0))
        if (line2) ctx.fillText(line2, n.x, n.y + fs / 2 + 1)
      })

      animRef.current = requestAnimationFrame(simulate)
    }

    animRef.current = requestAnimationFrame(simulate)
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current) }
  }, [setupCanvas, activeRoots, expandedChildTags])

  // ── Pointer helpers ──────────────────────────────────
  const getScale = () => { const c = canvasRef.current; return c ? sizeRef.current.w / c.getBoundingClientRect().width : 1 }
  const nodeAt = (x: number, y: number) => nodesRef.current.find(n => Math.sqrt((n.x - x) ** 2 + (n.y - y) ** 2) < n.r + 6)
  const getPos = (e: React.MouseEvent<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(), s = getScale(); return { x: (e.clientX - r.left) * s, y: (e.clientY - r.top) * s } }
  const getTouchPos = (e: React.TouchEvent<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(), t = e.touches[0] || e.changedTouches[0], s = getScale(); return { x: (t.clientX - r.left) * s, y: (t.clientY - r.top) * s } }

  const handleClick = (id: string) => {
    const n = nodesRef.current.find(n => n.id === id); if (!n) return
    if (n.kind === 'root-tag' && n.fullTag) {
      toggleRoot(n.fullTag)
    } else if (n.kind === 'child-tag' && n.fullTag) {
      toggleChildTag(n.fullTag)
    } else if (n.kind === 'note' && n.noteId) {
      const note = notes.find(n2 => n2.id === n.noteId)
      if (note) { setFocusedNote(note); focusedNodeRef.current = id }
    }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getPos(e); const hit = nodeAt(x, y)
    hovRef.current = hit?.id ?? null
    const cursor = hit ? (hit.kind === 'note' ? 'pointer' : 'grab') : 'default'
    e.currentTarget.style.cursor = cursor
    if (dragRef.current) {
      const n = nodesRef.current.find(n => n.id === dragRef.current!.id)
      if (n) { n.x = x + dragRef.current.ox; n.y = y + dragRef.current.oy; dragRef.current.moved = true }
    }
  }
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getPos(e); const hit = nodeAt(x, y)
    if (hit) dragRef.current = { id: hit.id, ox: hit.x - x, oy: hit.y - y, moved: false }
  }
  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return
    const wasMoved = dragRef.current.moved
    const id = dragRef.current.id
    dragRef.current = null
    if (!wasMoved) handleClick(id)
  }
  const handleMouseLeave = () => { dragRef.current = null; hovRef.current = null }

  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault(); const { x, y } = getTouchPos(e); const hit = nodeAt(x, y)
    if (hit) { dragRef.current = { id: hit.id, ox: hit.x - x, oy: hit.y - y, moved: false }; hovRef.current = hit.id }
  }
  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault(); const { x, y } = getTouchPos(e)
    if (dragRef.current) { const n = nodesRef.current.find(n => n.id === dragRef.current!.id); if (n) { n.x = x + dragRef.current.ox; n.y = y + dragRef.current.oy; dragRef.current.moved = true } }
  }
  const handleTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    if (dragRef.current && !dragRef.current.moved) handleClick(dragRef.current.id)
    dragRef.current = null; hovRef.current = null
  }

  const toggleSidebarExpand = (tag: string) => setExpanded(prev => { const next = new Set(prev); next.has(tag) ? next.delete(tag) : next.add(tag); return next })

  const filteredTree = search.trim()
    ? tagTree.filter(root => root.name.toLowerCase().includes(search.toLowerCase()) || root.children.some(c => c.name.toLowerCase().includes(search.toLowerCase())))
    : tagTree

  // 判斷畫布上是否有任何節點（含浮動子標籤）
  const hasAnyNodes = activeRoots.length > 0 || expandedChildTags.size > 0

  const card: React.CSSProperties = { backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '12px', overflow: 'hidden' }

  return (
    <div style={{ padding: 'clamp(12px, 2vw, 24px)' }}>
      <div style={{ marginBottom: '14px' }}>
        <h1 style={{ fontSize: 'clamp(16px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>知識圖譜</h1>
        <p style={{ fontSize: '12px', color: 'var(--c-muted)', margin: '4px 0 0' }}>
          點擊標籤展開 · 子標籤再點一次顯示筆記 · 可拖曳節點 · 取消根標籤只隱藏根節點
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: '12px', alignItems: 'flex-start' }}>

        {/* ── 左側：標籤樹 ── */}
        <div style={{ ...card, width: isMobile ? '100%' : '200px', flexShrink: 0 }}>
          <div style={{ padding: '10px', borderBottom: '1px solid var(--c-border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '6px 10px' }}>
              <Search size={13} style={{ color: 'var(--c-muted)', flexShrink: 0 }} />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜尋標籤..."
                style={{ flex: 1, background: 'none', border: 'none', outline: 'none', fontSize: '12px', color: 'var(--c-text)', minWidth: 0 }} />
            </div>
          </div>

          <div style={{ maxHeight: isMobile ? '180px' : '500px', overflowY: 'auto', padding: '8px 6px' }}>
            {loading ? (
              <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: 'var(--c-muted)' }}>載入中...</div>
            ) : filteredTree.map(root => {
              const isActive = activeRoots.includes(root.fullTag)
              const color = tagColorMap[root.fullTag] || '#888'
              return (
                <div key={root.fullTag}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                    {root.children.length > 0 ? (
                      <button onClick={() => toggleSidebarExpand(root.fullTag)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'var(--c-muted)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                        {expanded.has(root.fullTag) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                    ) : <div style={{ width: '18px' }} />}

                    <button onClick={() => toggleRoot(root.fullTag)}
                      style={{ flex: 1, textAlign: 'left', padding: '5px 6px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '12px', background: isActive ? color + '18' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, backgroundColor: color, opacity: isActive ? 1 : 0.3, transition: 'opacity .15s' }} />
                        <span style={{ color: isActive ? 'var(--c-text)' : 'var(--c-muted)', fontWeight: isActive ? 600 : 400 }}>{root.name}</span>
                      </span>
                      <span style={{ fontSize: '10px', color: 'var(--c-muted)', fontWeight: 400 }}>{root.noteCount}</span>
                    </button>
                  </div>

                  {expanded.has(root.fullTag) && root.children.map(child => (
                    <div key={child.fullTag} style={{ paddingLeft: '20px' }}>
                      <button onClick={() => { if (!isActive) toggleRoot(root.fullTag); toggleChildTag(child.fullTag) }}
                        style={{ width: '100%', textAlign: 'left', padding: '4px 6px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '11px', background: expandedChildTags.has(child.fullTag) ? color + '14' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0, backgroundColor: color, opacity: expandedChildTags.has(child.fullTag) ? 1 : 0.25 }} />
                          <span style={{ color: expandedChildTags.has(child.fullTag) ? 'var(--c-text)' : 'var(--c-muted)' }}>{child.name}</span>
                        </span>
                        <span style={{ fontSize: '10px', color: 'var(--c-muted)' }}>{child.noteCount}</span>
                      </button>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>

          {/* 底部：已選標籤 + 清除 */}
          {hasAnyNodes && (
            <div style={{ padding: '8px 10px', borderTop: '1px solid var(--c-border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5px' }}>
                <span style={{ fontSize: '10px', color: 'var(--c-muted)' }}>
                  {activeRoots.length > 0 && `已選 ${activeRoots.length} 個標籤`}
                  {expandedChildTags.size > 0 && ` · ${expandedChildTags.size} 個子標籤展開中`}
                </span>
                <button onClick={() => {
                  setActiveRoots([])
                  setExpandedChildTags(new Set())
                  setFocusedNote(null)
                  focusedNodeRef.current = null
                }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '10px', color: 'var(--c-muted)', display: 'flex', alignItems: 'center', gap: '2px' }}>
                  <X size={10} />全清
                </button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                {activeRoots.map(tag => (
                  <span key={tag} onClick={() => toggleRoot(tag)}
                    style={{ fontSize: '10px', padding: '2px 7px', borderRadius: '99px', cursor: 'pointer', backgroundColor: (tagColorMap[tag] || '#888') + '22', color: tagColorMap[tag] || '#888', border: `1px solid ${(tagColorMap[tag] || '#888')}55` }}>
                    #{tag} ×
                  </span>
                ))}
                {/* 顯示浮動中的子標籤（根標籤已取消但子標籤展開中）*/}
                {Array.from(expandedChildTags)
                  .filter(ct => !activeRoots.includes(ct.split('/')[0]))
                  .map(tag => (
                    <span key={tag} onClick={() => toggleChildTag(tag)}
                      style={{ fontSize: '10px', padding: '2px 7px', borderRadius: '99px', cursor: 'pointer', backgroundColor: (tagColorMap[tag] || '#888') + '14', color: tagColorMap[tag] || '#888', border: `1px dashed ${(tagColorMap[tag] || '#888')}55` }}>
                      #{tag.split('/').pop()} ×
                    </span>
                  ))
                }
              </div>
            </div>
          )}
        </div>

        {/* ── 中間：Canvas ── */}
        <div ref={containerRef} style={{ ...card, flex: 1, width: '100%', minWidth: 0, padding: '12px' }}>
          {!hasAnyNodes ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '320px', gap: '8px', color: 'var(--c-muted)' }}>
              <Tag size={32} style={{ opacity: 0.15 }} />
              <p style={{ fontSize: '13px' }}>從左側點擊標籤加入圖譜</p>
              <p style={{ fontSize: '11px', opacity: 0.6 }}>點頂層標籤 → 展開子標籤 → 點子標籤 → 展開筆記</p>
            </div>
          ) : (
            <>
              <canvas ref={canvasRef}
                style={{ display: 'block', width: '100%', height: 'auto', borderRadius: '6px', touchAction: 'none' }}
                onMouseMove={handleMouseMove} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp} onMouseLeave={handleMouseLeave}
                onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} />
              <div style={{ marginTop: '6px', display: 'flex', gap: '14px', fontSize: '11px', color: 'var(--c-muted)', flexWrap: 'wrap' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: '9px', height: '9px', borderRadius: '50%', backgroundColor: 'var(--c-accent)', display: 'inline-block' }} />頂層標籤（點擊移除根節點）
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: '7px', height: '7px', borderRadius: '50%', border: '2px solid var(--c-accent)', display: 'inline-block' }} />子標籤（點擊展開筆記）
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: '7px', height: '7px', borderRadius: '50%', border: '2px dashed var(--c-accent)', display: 'inline-block' }} />子標籤（浮動中，根標籤已隱藏）
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: 'rgba(79,142,247,0.4)', display: 'inline-block' }} />筆記（點擊查看）
                </span>
              </div>
            </>
          )}
        </div>

        {/* ── 右側：筆記詳情 ── */}
        {focusedNote && !isMobile && (
          <div style={{ ...card, width: '200px', flexShrink: 0, padding: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--c-muted)' }}>筆記詳情</span>
              <button onClick={() => { setFocusedNote(null); focusedNodeRef.current = null }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-muted)', display: 'flex' }}>
                <X size={13} />
              </button>
            </div>
            <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--c-text)', lineHeight: 1.4, marginBottom: '10px' }}>
              {focusedNote.title}
            </p>
            {focusedNote.content && (
              <p style={{ fontSize: '11px', color: 'var(--c-muted)', lineHeight: 1.6, marginBottom: '10px', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {focusedNote.content}
              </p>
            )}
            <p style={{ fontSize: '10px', color: 'var(--c-muted)', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>標籤</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '12px' }}>
              {focusedNote.hashtags?.map(t => (
                <span key={t}
                  style={{ fontSize: '10px', padding: '3px 8px', borderRadius: '99px', border: '1px solid var(--c-border)', color: 'var(--c-muted)' }}>
                  #{t.split('/').pop()}
                </span>
              ))}
            </div>
            <button onClick={() => navigate(`/kms?note=${focusedNote.id}`)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', padding: '7px', borderRadius: '8px', border: '1px solid var(--c-border)', background: 'var(--c-bg)', color: 'var(--c-accent)', fontSize: '12px', cursor: 'pointer' }}>
              <ExternalLink size={12} />開啟筆記
            </button>
          </div>
        )}
      </div>

      {/* ── 手機：筆記詳情 ── */}
      {focusedNote && isMobile && (
        <div style={{ ...card, marginTop: '12px', padding: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--c-text)', flex: 1, paddingRight: '8px' }}>{focusedNote.title}</span>
            <button onClick={() => { setFocusedNote(null); focusedNodeRef.current = null }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-muted)', display: 'flex' }}><X size={14} /></button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '10px' }}>
            {focusedNote.hashtags?.map(t => (
              <span key={t} style={{ fontSize: '11px', padding: '3px 9px', borderRadius: '99px', border: '1px solid var(--c-border)', color: 'var(--c-muted)' }}>
                #{t.split('/').pop()}
              </span>
            ))}
          </div>
          <button onClick={() => navigate(`/kms?note=${focusedNote.id}`)}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', padding: '8px', borderRadius: '8px', border: '1px solid var(--c-border)', background: 'var(--c-bg)', color: 'var(--c-accent)', fontSize: '13px', cursor: 'pointer' }}>
            <ExternalLink size={13} />開啟筆記
          </button>
        </div>
      )}
    </div>
  )
}
