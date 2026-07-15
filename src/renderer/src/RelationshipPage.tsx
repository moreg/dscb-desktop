import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCollide,
  forceCenter,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum
} from 'd3-force'
import type {
  Character,
  Relationship,
  ChapterMeta,
  CreateRelationshipInput
} from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
  onOpenChapter?: (n: number) => void
  onOpenCharacters?: () => void
}

interface Node extends SimulationNodeDatum {
  id: string
  name: string
  role?: string
  faction: string
  fx?: number | null
  fy?: number | null
}

interface Edge extends SimulationLinkDatum<Node> {
  id: string
  type: string
  description?: string
  strength?: number
}

interface RelSuggestion {
  characterA: string
  characterB: string
  relationType: string
  description: string
  strength: number
  /** 解析后匹配到的人物 id */
  aId?: string
  bId?: string
  /** 是否已存在于关系库（双向判断） */
  exists: boolean
  applied: boolean
}

function parseRelJson(text: string): Omit<RelSuggestion, 'aId' | 'bId' | 'exists' | 'applied'>[] {
  const m = text.match(/\[\s*[\s\S]*\]/)
  const candidate = m ? m[0] : text
  try {
    const arr = JSON.parse(candidate)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((x) => x && typeof x === 'object' && typeof x.characterA === 'string')
      .map((x) => ({
        characterA: String(x.characterA).trim(),
        characterB: String(x.characterB ?? '').trim(),
        relationType: String(x.relationType ?? '').trim(),
        description: typeof x.description === 'string' ? x.description.trim() : '',
        strength: Number(x.strength) || 0
      }))
      .filter((x) => x.characterA && x.characterB)
  } catch {
    return []
  }
}

// 守护断言 (tests/relationship-layout.test.ts) 要求保留这两个字面常量
const GRAPH_WIDTH = 1120
const GRAPH_HEIGHT = 720
const NODE_RADIUS = 30
const FORCE_CHARGE_STRENGTH = -260
const FORCE_LINK_DISTANCE = 150
const FORCE_LINK_STRENGTH = 0.35
const FORCE_COLLIDE_RADIUS = 38
const FORCE_CENTER_STRENGTH = 0.05
const FORCE_ALPHA_DECAY = 0.02
const MIN_ZOOM = 0.4
const MAX_ZOOM = 3
const LABEL_MAX_CHARS = 4

/** 把 name 截到前 4 字（中文按 1 字算），长名末尾加省略号。 */
function shortLabel(name: string): string {
  const chars = [...name]
  if (chars.length <= LABEL_MAX_CHARS) return name
  return chars.slice(0, LABEL_MAX_CHARS).join('') + '…'
}

const ROLE_BUCKETS = [
  { match: ['主角'], label: '主角', cls: 'role-protagonist' },
  { match: ['配角', '女主', '男主'], label: '重要角色', cls: 'role-supporting' },
  { match: ['反派', 'BOSS', 'boss', '敌'], label: '反派', cls: 'role-antagonist' }
] as const

/** 在画布中心区域做一次圆形随机分布，避免初始堆中心。 */
function seedPositions(nodes: Node[]) {
  const cx = GRAPH_WIDTH / 2
  const cy = GRAPH_HEIGHT / 2
  const maxR = Math.min(GRAPH_WIDTH, GRAPH_HEIGHT) / 3
  for (const n of nodes) {
    const r = Math.sqrt(Math.random()) * maxR
    const a = Math.random() * Math.PI * 2
    n.x = cx + Math.cos(a) * r
    n.y = cy + Math.sin(a) * r
    n.vx = 0
    n.vy = 0
  }
}

/** Helper to get node ID from edge source/target which can be string or Node object (mutated by d3) */
function getEdgeNodeId(val: any): string {
  if (val && typeof val === 'object' && 'id' in val) {
    return val.id
  }
  return String(val)
}

const FACTION_PRESETS: Record<string, { fill: string; stroke: string; labelBg: string }> = {
  '主角': { fill: 'rgba(184, 51, 31, 0.03)', stroke: 'rgba(184, 51, 31, 0.25)', labelBg: 'var(--vermilion)' },
  '重要角色': { fill: 'rgba(61, 90, 110, 0.03)', stroke: 'rgba(61, 90, 110, 0.25)', labelBg: 'var(--inkstone)' },
  '反派': { fill: 'rgba(168, 56, 40, 0.03)', stroke: 'rgba(168, 56, 40, 0.25)', labelBg: 'var(--danger)' },
  '天玄宗': { fill: 'rgba(95, 39, 205, 0.03)', stroke: 'rgba(95, 39, 205, 0.25)', labelBg: '#5f27cd' },
  '魔门': { fill: 'rgba(77, 112, 72, 0.03)', stroke: 'rgba(77, 112, 72, 0.25)', labelBg: 'var(--success)' },
  '其他': { fill: 'rgba(138, 130, 117, 0.02)', stroke: 'rgba(138, 130, 117, 0.18)', labelBg: 'var(--ink-3)' }
}

function getFactionStyle(faction: string) {
  const matched = Object.keys(FACTION_PRESETS).find((k) => faction.includes(k))
  if (matched) return FACTION_PRESETS[matched]

  let hash = 0
  for (let i = 0; i < faction.length; i++) {
    hash = faction.charCodeAt(i) + ((hash << 5) - hash)
  }
  const h = Math.abs(hash % 360)
  return {
    fill: `hsla(${h}, 45%, 45%, 0.03)`,
    stroke: `hsla(${h}, 45%, 45%, 0.25)`,
    labelBg: `hsl(${h}, 45%, 40%)`
  }
}

export default function RelationshipPage({ projectId, onOpenChapter, onOpenCharacters }: Props) {
  const [relationships, setRelationships] = useState<Relationship[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [chapters, setChapters] = useState<ChapterMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [detectingRels, setDetectingRels] = useState(false)
  const [relSuggestions, setRelSuggestions] = useState<RelSuggestion[]>([])
  const [showRelPanel, setShowRelPanel] = useState(false)
  const relDetectRef = useRef(0)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const simRef = useRef<Simulation<Node, Edge> | null>(null)
  const nodesRef = useRef<Node[]>([])
  /** 拖拽/pan 共享：'idle' | 'node' | 'pan' */
  const dragRef = useRef<
    | { kind: 'node'; id: string; offsetX: number; offsetY: number }
    | { kind: 'pan'; startClientX: number; startClientY: number; startTx: number; startTy: number }
    | null
  >(null)

  // pan/zoom：transform 用 ref 保存避免每帧 setState；zoom 状态同步 setState 触发 React 重渲染
  const transformRef = useRef({ x: 0, y: 0, k: 1 })
  const [zoomTick, setZoomTick] = useState(0)

  const refresh = () => {
    setLoading(true)
    void Promise.all([
      window.api.listRelationships(projectId),
      window.api.listCharacters(projectId),
      window.api.listChapters(projectId)
    ]).then(([rels, chars, chs]) => {
      setRelationships(rels)
      setCharacters(chars)
      setChapters(chs)
      setLoading(false)
    })
  }

  useEffect(refresh, [projectId])

  const factionOf = (c: Character): string => {
    if (c.role && ROLE_BUCKETS.some((b) => b.match.some((m) => c.role!.includes(m)))) {
      return c.role
    }
    const factionTag = (c.tags ?? []).find((t) =>
      ['天玄宗', '魔门', '皇室', '书院', '门派'].some((k) => t.includes(k))
    )
    return factionTag ?? (c.role ?? '其他')
  }

  const factionList = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of characters) {
      const f = factionOf(c)
      m.set(f, (m.get(f) ?? 0) + 1)
    }
    return [...m.entries()]
  }, [characters])

  // 把 characters + edges → 给 d3-force 用的 Node[] / Edge[]
  const nodeList = useMemo<Node[]>(() => {
    return characters.map((c) => {
      const existing = nodesRef.current.find((n) => n.id === c.id)
      return {
        id: c.id,
        name: c.name,
        role: c.role,
        faction: factionOf(c),
        x: existing?.x ?? GRAPH_WIDTH / 2 + (Math.random() - 0.5) * GRAPH_WIDTH * 0.6,
        y: existing?.y ?? GRAPH_HEIGHT / 2 + (Math.random() - 0.5) * GRAPH_HEIGHT * 0.6,
        vx: existing?.vx ?? 0,
        vy: existing?.vy ?? 0,
        fx: existing?.fx ?? null,
        fy: existing?.fy ?? null
      }
    })
  }, [characters])

  // 一份 edges，d3-force 和业务侧都用它。source/target 是字符串 id。
  const edges = useMemo<Edge[]>(() => {
    const charIds = new Set(characters.map((c) => c.id))
    return relationships
      .filter((r) => charIds.has(r.characterAId) && charIds.has(r.characterBId))
      .map((r) => ({
        id: r.id,
        source: r.characterAId,
        target: r.characterBId,
        type: r.relationType,
        description: r.description,
        strength: r.strength
      }))
  }, [relationships, characters])

  // 构造/重建 d3 simulation
  useEffect(() => {
    if (nodeList.length === 0) {
      simRef.current?.stop()
      simRef.current = null
      nodesRef.current = []
      return
    }
    nodesRef.current = nodeList
    seedPositions(nodeList)

    const sim = forceSimulation<Node>(nodeList)
      .force(
        'charge',
        forceManyBody<Node>().strength(FORCE_CHARGE_STRENGTH).distanceMax(320)
      )
      .force(
        'link',
        forceLink<Node, Edge>(edges)
          .id((d) => d.id)
          .distance(FORCE_LINK_DISTANCE)
          .strength(FORCE_LINK_STRENGTH)
      )
      .force(
        'collide',
        forceCollide<Node>().radius(FORCE_COLLIDE_RADIUS).strength(0.9)
      )
      .force(
        'center',
        forceCenter(GRAPH_WIDTH / 2, GRAPH_HEIGHT / 2).strength(FORCE_CENTER_STRENGTH)
      )
      .alphaDecay(FORCE_ALPHA_DECAY)
      .on('tick', () => setTick((t) => (t + 1) % 1_000_000))

    simRef.current = sim
    return () => {
      sim.stop()
    }
  }, [nodeList, edges])

  const remove = async (r: Relationship) => {
    if (!window.confirm('删除该关系？')) return
    await window.api.deleteRelationship(projectId, r.id)
    setSelectedEdge(null)
    refresh()
  }

  const startDetectRelationships = async () => {
    if (!(await window.api.hasLlmKey())) {
      window.alert('请先在「⚙ 设置 → 模型服务」中配置 provider')
      return
    }
    setShowRelPanel(true)
    setDetectingRels(true)
    setRelSuggestions([])
    const mine = ++relDetectRef.current
    let buffer = ''
    try {
      const result = await window.api.detectRelationshipsStream(projectId, (token, done) => {
        if (relDetectRef.current !== mine) return
        if (token) buffer += token
        if (done) setDetectingRels(false)
      })
      if (relDetectRef.current !== mine) return
      if (!result.ok) {
        setDetectingRels(false)
        window.alert('关系推断失败：' + (result.error ?? '未知错误'))
        return
      }
      const parsed = parseRelJson(buffer)
      const idByName = new Map(characters.map((c) => [c.name, c.id]))
      const existsPair = (aId: string, bId: string) =>
        relationships.some(
          (r) =>
            (r.characterAId === aId && r.characterBId === bId) ||
            (r.characterAId === bId && r.characterBId === aId)
        )
      const merged: RelSuggestion[] = parsed.map((p) => {
        const aId = idByName.get(p.characterA)
        const bId = idByName.get(p.characterB)
        return {
          ...p,
          aId,
          bId,
          exists: !!(aId && bId && existsPair(aId, bId)),
          applied: false
        }
      })
      setRelSuggestions(merged)
    } catch {
      if (relDetectRef.current === mine) setDetectingRels(false)
    }
  }

  const applyRelSuggestions = async () => {
    const toAdd = relSuggestions.filter(
      (s) => s.aId && s.bId && !s.exists && !s.applied
    )
    if (toAdd.length === 0) return
    for (const s of toAdd) {
      await window.api.createRelationship(projectId, {
        characterAId: s.aId!,
        characterBId: s.bId!,
        relationType: s.relationType,
        description: s.description || undefined,
        strength: s.strength || undefined
      })
    }
    setRelSuggestions((arr) =>
      arr.map((s) => (toAdd.find((t) => t === s) ? { ...s, applied: true, exists: true } : s))
    )
    refresh()
  }

  const nameOf = (id: any) => {
    const strId = getEdgeNodeId(id)
    return characters.find((c) => c.id === strId)?.name ?? '（已删除）'
  }
  const charOf = (id: string) => characters.find((c) => c.id === id)

  const selectedChar = selectedNode ? charOf(selectedNode) : null
  const selectedEdgeObj = selectedEdge ? edges.find((e) => e.id === selectedEdge) : null

  /** 客户端坐标 → SVG viewBox 坐标。
   * 屏幕归一化 * GRAPH_WIDTH = SVG 用户坐标 = viewBox 单位 * k + tx，
   * 反推 viewBox 单位 = (屏幕归一化 * GRAPH_WIDTH - tx) / k。
   */
  const clientToSvg = (clientX: number, clientY: number) => {
    if (!svgRef.current) return null
    const rect = svgRef.current.getBoundingClientRect()
    const { x: tx, y: ty, k } = transformRef.current
    return {
      x: (((clientX - rect.left) / rect.width) * GRAPH_WIDTH - tx) / k,
      y: (((clientY - rect.top) / rect.height) * GRAPH_HEIGHT - ty) / k
    }
  }

  /** 「重新排布」：重置随机位置并重启 simulation */
  const reshuffle = () => {
    if (!simRef.current || nodesRef.current.length === 0) return
    seedPositions(nodesRef.current)
    simRef.current.nodes().forEach((n) => {
      n.fx = null
      n.fy = null
    })
    simRef.current.alpha(0.9).restart()
  }

  // ------- 拖拽/pan/zoom 三套交互 -------

  // 节点按下：进入节点拖拽
  const onNodePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation()
    const point = clientToSvg(e.clientX, e.clientY)
    const node = nodesRef.current.find((n) => n.id === id)
    if (!point || !node || !simRef.current) return
    dragRef.current = {
      kind: 'node',
      id,
      offsetX: point.x - (node.x ?? 0),
      offsetY: point.y - (node.y ?? 0)
    }
    setSelectedNode(id)
    setSelectedEdge(null)
    simRef.current.alphaTarget(0.3).restart()
    node.fx = node.x
    node.fy = node.y
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }

  // 全局 pointermove：按 kind 分别处理（窗口级监听，避免出 SVG 后中断）
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      if (d.kind === 'node') {
        const p = clientToSvg(ev.clientX, ev.clientY)
        const n = nodesRef.current.find((x) => x.id === d.id)
        if (p && n) {
          n.fx = p.x - d.offsetX
          n.fy = p.y - d.offsetY
        }
      } else if (d.kind === 'pan') {
        // pan 的单位：dx 是屏幕像素，tx 是 SVG 用户坐标。
        // 用户坐标 = 屏幕像素 / (svgRect.width / GRAPH_WIDTH)，
        // 与缩放 k 无关——k 只决定 viewBox 单位被放大的程度，不决定 pan 的屏幕拖动量。
        if (!svgRef.current) return
        const rect = svgRef.current.getBoundingClientRect()
        const rx = GRAPH_WIDTH / rect.width
        const ry = GRAPH_HEIGHT / rect.height
        const dx = ev.clientX - d.startClientX
        const dy = ev.clientY - d.startClientY
        transformRef.current.x = d.startTx + dx * rx
        transformRef.current.y = d.startTy + dy * ry
        setZoomTick((t) => (t + 1) % 1_000_000)
      }
    }
    const onUp = () => {
      const d = dragRef.current
      dragRef.current = null
      if (d?.kind === 'node' && simRef.current) {
        simRef.current.alphaTarget(0)
        const n = nodesRef.current.find((x) => x.id === d.id)
        if (n) {
          n.fx = null
          n.fy = null
        }
      }
    }
    // Esc 取消当前拖拽：Alt+Tab 切走后 dragRef 残留，按 Esc 强制释放。
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !dragRef.current) return
      onUp()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // 背景按下：进入 pan
  const onBgPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    dragRef.current = {
      kind: 'pan',
      startClientX: e.clientX,
      startClientY: e.clientY,
      startTx: transformRef.current.x,
      startTy: transformRef.current.y
    }
  }

  // 滚轮缩放：以鼠标位置为缩放中心。
  //   viewBox 单位 m 经变换映射到屏幕：screen = m * k + tx
  //   缩放前后要让鼠标下的 viewBox 单位 m 不变（保持锚点）：
  //     m * k_old + tx_old === m * k_new + tx_new
  //   → tx_new = tx_old - m * (k_new - k_old)
  //   m 可从屏幕位置反推：m = (screen - tx_old) / k_old
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const rect = el.getBoundingClientRect()
      const { x: tx, y: ty, k } = transformRef.current
      const factor = Math.exp(-ev.deltaY * 0.0015)
      const nextK = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, k * factor))
      if (nextK === k) return
      const sx = ((ev.clientX - rect.left) / rect.width) * GRAPH_WIDTH
      const sy = ((ev.clientY - rect.top) / rect.height) * GRAPH_HEIGHT
      const mx = (sx - tx) / k
      const my = (sy - ty) / k
      transformRef.current.x = tx - mx * (nextK - k)
      transformRef.current.y = ty - my * (nextK - k)
      transformRef.current.k = nextK
      setZoomTick((t) => (t + 1) % 1_000_000)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [loading, characters])

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>人物关系</h1>
            <p className="desc">
              {characters.length} 个人物 · {relationships.length} 条关系
            </p>
          </div>
          <div className="btn-group">
            <button
              className="btn btn-sm"
              onClick={reshuffle}
              disabled={characters.length === 0}
              title="重新排布节点"
            >
              ⟳ 重新排布
            </button>
            <button
              className="btn btn-sm"
              onClick={startDetectRelationships}
              disabled={detectingRels || characters.length < 2}
              title="让 AI 扫描近期章节，推断人物关系"
            >
              {detectingRels ? '推断中…' : '🤖 AI 推断关系'}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setCreating(true)}
              disabled={characters.length < 2}
            >
              + 新关系
            </button>
          </div>
        </div>
      </div>
      {characters.length < 2 ? (
        <p className="empty" style={{ color: 'var(--warning)' }}>
          至少需要 2 个人物才能建立关系。
        </p>
      ) : null}

      {loading ? (
        <p className="empty">展卷中…</p>
      ) : (
        <div className="rel-layout">
          <div className="relation-graph" ref={wrapRef} onClick={() => {
            setSelectedNode(null)
            setSelectedEdge(null)
          }}>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
              preserveAspectRatio="xMidYMid meet"
            >
              <defs>
                <linearGradient id="grad-protagonist" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="var(--vermilion)" />
                  <stop offset="100%" stopColor="var(--accent)" />
                </linearGradient>
                <linearGradient id="grad-supporting" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="var(--inkstone)" />
                  <stop offset="100%" stopColor="#5c7a90" />
                </linearGradient>
                <linearGradient id="grad-antagonist" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="var(--danger)" />
                  <stop offset="100%" stopColor="var(--ink)" />
                </linearGradient>
                <linearGradient id="grad-default" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="var(--ink-3)" />
                  <stop offset="100%" stopColor="var(--ink-2)" />
                </linearGradient>
                <filter id="shadow-node" x="-20%" y="-20%" width="140%" height="140%">
                  <feDropShadow dx="0" dy="3" stdDeviation="3" floodOpacity="0.1" />
                </filter>
                <filter id="shadow-node-selected" x="-30%" y="-30%" width="160%" height="160%">
                  <feDropShadow dx="0" dy="5" stdDeviation="5" floodColor="var(--vermilion)" floodOpacity="0.35" />
                </filter>
              </defs>
              <g
                transform={`translate(${transformRef.current.x} ${transformRef.current.y}) scale(${transformRef.current.k})`}
              >
                {factionList.length > 0 && nodesRef.current.length > 0
                  ? Array.from(new Set(nodesRef.current.map((n) => n.faction))).map((f) => {
                      const groupNodes = nodesRef.current.filter((n) => n.faction === f)
                      if (groupNodes.length === 0) return null
                      const xs = groupNodes.map((n) => n.x ?? 0)
                      const ys = groupNodes.map((n) => n.y ?? 0)
                      const minX = Math.min(...xs) - 40
                      const maxX = Math.max(...xs) + 40
                      const minY = Math.min(...ys) - 36
                      const maxY = Math.max(...ys) + 48
                      
                      const style = getFactionStyle(f)
                      const labelWidth = Math.max(48, f.length * 12 + 16)
                      
                      return (
                        <g key={f}>
                          <rect
                            className="faction-halo"
                            x={minX}
                            y={minY}
                            width={maxX - minX}
                            height={maxY - minY}
                            rx={12}
                            fill={style.fill}
                            stroke={style.stroke}
                            strokeWidth={1.5}
                          />
                          {/* Faction Tag Label */}
                          <g transform={`translate(${minX + 8}, ${minY + 8})`}>
                            <rect
                              x={0}
                              y={0}
                              width={labelWidth}
                              height={20}
                              rx={4}
                              fill={style.labelBg}
                              opacity={0.9}
                            />
                            <text
                              x={labelWidth / 2}
                              y={10.5}
                              fill="#ffffff"
                              fontSize={10.5}
                              fontWeight={600}
                              textAnchor="middle"
                              dominantBaseline="middle"
                            >
                              {f}
                            </text>
                          </g>
                        </g>
                      )
                    })
                  : null}
                {edges.map((e) => {
                  const a = nodesRef.current.find((n) => n.id === getEdgeNodeId(e.source))
                  const b = nodesRef.current.find((n) => n.id === getEdgeNodeId(e.target))
                  if (!a || !b || a.x == null || b.x == null) return null
                  const mx = (a.x + b.x) / 2
                  const my = (a.y! + b.y!) / 2
                  const selected = selectedEdge === e.id
                  return (
                    <g
                      key={e.id}
                      onClick={(ev) => {
                        ev.stopPropagation()
                        setSelectedEdge(e.id)
                        setSelectedNode(null)
                      }}
                      onDoubleClick={(ev) => {
                        ev.stopPropagation()
                        setSelectedEdge(e.id)
                        setSelectedNode(null)
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      <line
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        className={`rel-edge ${selected ? 'selected' : ''}`}
                      />
                      <rect
                        x={mx - Math.max(20, e.type.length * 6)}
                        y={my - 9}
                        width={Math.max(40, e.type.length * 12)}
                        height={18}
                        rx={9}
                        fill={selected ? 'var(--accent-soft)' : 'var(--surface)'}
                        stroke={selected ? 'var(--accent)' : 'var(--line-strong)'}
                        strokeWidth={selected ? 1.5 : 1}
                      />
                      <text x={mx} y={my + 1} className="rel-edge-label">
                        {e.type}
                      </text>
                    </g>
                  )
                })}
                {nodesRef.current.map((n) => {
                  const x = n.x ?? GRAPH_WIDTH / 2
                  const y = n.y ?? GRAPH_HEIGHT / 2
                  const selected = selectedNode === n.id
                  return (
                    <NodeWithTooltip
                      key={n.id}
                      node={n}
                      x={x}
                      y={y}
                      selected={selected}
                      onPointerDown={(e) => onNodePointerDown(e, n.id)}
                      onDoubleClick={() => onOpenCharacters?.()}
                      transform={transformRef.current}
                      wrapEl={wrapRef.current}
                      svgEl={svgRef.current}
                    />
                  )
                })}
              </g>
              {/* 背景层放在变换外，专吃滚轮/ppan 的全局事件。
                  fill="transparent" 在部分浏览器对 pointer-events=visiblePainted 不响应，
                  显式声明 all 强制捕获鼠标。 */}
              <rect
                className="relation-graph-bg"
                x={0}
                y={0}
                width={GRAPH_WIDTH}
                height={GRAPH_HEIGHT}
                fill="transparent"
                pointerEvents="all"
                onPointerDown={onBgPointerDown}
              />
            </svg>
            {characters.length === 0 ? (
              <div className="empty-graph">尚无人物</div>
            ) : null}
            {/* 用隐藏节点触发 tick 重渲染（d3 tick + zoom tick） */}
            <foreignObject x={0} y={0} width={0} height={0}>
              <span>{`${tick}-${zoomTick}`}</span>
            </foreignObject>
          </div>

          <aside className="rel-detail">
            {!selectedChar && !selectedEdgeObj ? (
              <div>
                <h3 className="sub" style={{ marginTop: 0 }}>说明</h3>
                <p className="muted" style={{ fontSize: 13 }}>
                  点击节点查看人物，点击边查看关系详情。节点可拖拽，滚轮缩放，拖背景平移。
                </p>
                <hr className="soft" />
                <h4 className="sub" style={{ marginTop: 0 }}>统计</h4>
                <p className="meta" style={{ fontSize: 13 }}>
                  {characters.length} 个人物 · {relationships.length} 条关系
                </p>
                <div style={{ marginTop: 12 }}>
                  <h4 className="sub" style={{ marginTop: 0 }}>关系类型</h4>
                  {(() => {
                    const map = new Map<string, number>()
                    for (const r of relationships)
                      map.set(r.relationType, (map.get(r.relationType) ?? 0) + 1)
                    if (map.size === 0) return <p className="empty" style={{ padding: 4 }}>—</p>
                    return [...map.entries()].map(([t, c]) => (
                      <div
                        key={t}
                        className="row"
                        style={{ fontSize: 13, padding: '2px 0' }}
                      >
                        <span>{t}</span>
                        <span className="meta">× {c}</span>
                      </div>
                    ))
                  })()}
                </div>
              </div>
            ) : selectedChar ? (
              <div>
                <h3 className="sub" style={{ marginTop: 0 }}>{selectedChar.name}</h3>
                {selectedChar.role ? (
                  <span className="chip chip-accent">{selectedChar.role}</span>
                ) : null}
                {selectedChar.identity ? (
                  <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                    身份：{selectedChar.identity}
                  </p>
                ) : null}
                {selectedChar.personality ? (
                  <p className="muted" style={{ fontSize: 13 }}>
                    性格：{selectedChar.personality}
                  </p>
                ) : null}
                {selectedChar.abilities ? (
                  <p className="muted" style={{ fontSize: 13 }}>
                    能力：{selectedChar.abilities}
                  </p>
                ) : null}
                {(() => {
                  const appears = chapters
                    .filter((c) => (c.appearingCharacters ?? []).includes(selectedChar.id))
                    .map((c) => c.chapterNumber)
                  if (appears.length === 0) return null
                  return (
                    <>
                      <hr className="soft" />
                      <h4 className="sub" style={{ marginTop: 0 }}>出场章节</h4>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {appears.map((n) => (
                          <span
                            key={n}
                            className="outline-tag emotion"
                            style={{ cursor: onOpenChapter ? 'pointer' : 'default' }}
                            onClick={() => onOpenChapter?.(n)}
                          >
                            第 {n} 章
                          </span>
                        ))}
                      </div>
                    </>
                  )
                })()}
                <hr className="soft" />
                <h4 className="sub" style={{ marginTop: 0 }}>关系</h4>
                {(() => {
                  const list = relationships.filter(
                    (r) => r.characterAId === selectedChar.id || r.characterBId === selectedChar.id
                  )
                  if (list.length === 0)
                    return <p className="empty" style={{ padding: 4 }}>无</p>
                  return list.map((r) => {
                    const otherId = r.characterAId === selectedChar.id ? r.characterBId : r.characterAId
                    return (
                      <div
                        key={r.id}
                        className="row"
                        style={{
                          fontSize: 13,
                          padding: '4px 0',
                          borderBottom: '1px solid var(--line)',
                          cursor: 'pointer'
                        }}
                        onClick={() => {
                          setSelectedEdge(r.id)
                          setSelectedNode(null)
                        }}
                      >
                        <span>
                          <span className="chip chip-accent">{r.relationType}</span>{' '}
                          {nameOf(otherId)}
                        </span>
                      </div>
                    )
                  })
                })()}
                {onOpenCharacters ? (
                  <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
                    <button className="btn btn-sm" onClick={onOpenCharacters}>
                      跳到人物管理 →
                    </button>
                  </div>
                ) : null}
              </div>
            ) : selectedEdgeObj ? (
              <div>
                <h3 className="sub" style={{ marginTop: 0 }}>{selectedEdgeObj.type}</h3>
                <p style={{ fontSize: 14, marginTop: 8 }}>
                  <strong>{nameOf(selectedEdgeObj.source)}</strong>
                  <span className="muted"> ⇄ </span>
                  <strong>{nameOf(selectedEdgeObj.target)}</strong>
                </p>
                {selectedEdgeObj.strength != null ? (
                  <p className="meta" style={{ fontSize: 12 }}>
                    强度：{selectedEdgeObj.strength}
                  </p>
                ) : null}
                {selectedEdgeObj.description ? (
                  <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                    {selectedEdgeObj.description}
                  </p>
                ) : null}
                <hr className="soft" />
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => {
                      const real = relationships.find((r) => r.id === selectedEdgeObj.id)
                      if (real) void remove(real)
                    }}
                  >
                    删除关系
                  </button>
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      )}

      {showRelPanel ? (
        <RelationshipSuggestionPanel
          suggestions={relSuggestions}
          detecting={detectingRels}
          onApply={applyRelSuggestions}
          onClose={() => setShowRelPanel(false)}
        />
      ) : null}

      {creating ? (
        <Dialog
          characters={characters}
          onClose={() => setCreating(false)}
          onSubmit={async (input: CreateRelationshipInput) => {
            await window.api.createRelationship(projectId, input)
            setCreating(false)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}

/** 节点 + tooltip 组合：把 hover 处理直接挂在真实节点 circle 上，避免多叠一层 transparent circle 拦事件 */
function NodeWithTooltip({
  node,
  x,
  y,
  selected,
  onPointerDown,
  onDoubleClick,
  transform,
  wrapEl,
  svgEl
}: {
  node: Node
  x: number
  y: number
  selected: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onDoubleClick: () => void
  transform: { x: number; y: number; k: number }
  wrapEl: HTMLDivElement | null
  svgEl: SVGSVGElement | null
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const closeTimer = useRef<number | null>(null)

  const computePos = () => {
    if (!wrapEl || !svgEl) return
    const svgRect = svgEl.getBoundingClientRect()
    const wrapRect = wrapEl.getBoundingClientRect()
    const rx = ((node.x! + transform.x) / GRAPH_WIDTH) * svgRect.width
    const ry = ((node.y! + transform.y) / GRAPH_HEIGHT) * svgRect.height
    let top = ry - NODE_RADIUS * transform.k - 12
    if (top < 8) top = ry + NODE_RADIUS * transform.k + 12
    const half = 130
    let left = rx - half
    if (left < 8) left = 8
    if (left + 260 > wrapRect.width - 8) left = wrapRect.width - 268
    setPos({ top, left })
  }

  const onEnter = () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    computePos()
    setOpen(true)
  }
  const onLeave = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), 120)
  }

  // 节点位置、transform 变化时若悬浮中要跟
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(computePos)
    return () => cancelAnimationFrame(id)
  })

  let fillUrl = 'url(#grad-default)'
  const roleLower = (node.role ?? '').toLowerCase()
  if (roleLower.includes('主角') || roleLower.includes('男主') || roleLower.includes('女主')) {
    fillUrl = 'url(#grad-protagonist)'
  } else if (roleLower.includes('反派') || roleLower.includes('boss') || roleLower.includes('敌')) {
    fillUrl = 'url(#grad-antagonist)'
  } else if (roleLower.includes('配角') || node.role) {
    fillUrl = 'url(#grad-supporting)'
  }

  return (
    <g>
      <circle
        cx={x}
        cy={y}
        r={NODE_RADIUS}
        className={`rel-node-circle ${selected ? 'selected' : ''}`}
        fill={fillUrl}
        stroke={selected ? 'var(--vermilion)' : 'var(--line-strong)'}
        strokeWidth={selected ? 3 : 1.5}
        filter={selected ? 'url(#shadow-node-selected)' : 'url(#shadow-node)'}
        onPointerDown={onPointerDown}
        onDoubleClick={(ev) => {
          ev.stopPropagation()
          onDoubleClick()
        }}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        style={{ cursor: 'grab' }}
      />
      <text x={x} y={y + 1} className="rel-node-label">
        {shortLabel(node.name)}
      </text>
      {open && wrapEl
        ? createPortal(
            <div
              className="rel-tooltip"
              style={{ position: 'absolute', top: pos.top, left: pos.left, width: 240 }}
              onMouseEnter={onEnter}
              onMouseLeave={onLeave}
            >
              <div className="rel-tooltip-name">{node.name}</div>
              {node.role ? <div className="rel-tooltip-role">角色：{node.role}</div> : null}
              <div className="rel-tooltip-faction">阵营：{node.faction}</div>
              <div className="rel-tooltip-meta">拖拽移动 · 单击查看 · 双击进入人物页</div>
            </div>,
            wrapEl
          )
        : null}
    </g>
  )
}

function RelationshipSuggestionPanel({
  suggestions,
  detecting,
  onApply,
  onClose
}: {
  suggestions: RelSuggestion[]
  detecting: boolean
  onApply: () => void | Promise<void>
  onClose: () => void
}) {
  const addable = suggestions.filter((s) => s.aId && s.bId && !s.exists && !s.applied)
  const unknown = suggestions.filter((s) => !s.aId || !s.bId)
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>🤖 AI 关系推断</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            关闭
          </button>
        </div>
        {detecting ? (
          <p className="muted" style={{ fontSize: 13 }}>正在让 AI 扫描近期章节并推断关系…</p>
        ) : suggestions.length === 0 ? (
          <p className="empty" style={{ padding: 8 }}>AI 未发现明确的人物关系。</p>
        ) : (
          <>
            {unknown.length > 0 ? (
              <div style={{ background: 'var(--warning-soft)', borderRadius: 6, padding: 8, marginBottom: 10 }}>
                <strong style={{ fontSize: 12.5, color: 'var(--warning)' }}>
                  ⚠ {unknown.length} 条涉及未知人物（名字未匹配人物库）
                </strong>
                <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {unknown.map((s) => `${s.characterA}↔${s.characterB}`).join('、')}
                </p>
              </div>
            ) : null}
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="meta">
                共 {suggestions.length} 条 · 可新增 {addable.length}
              </span>
              <button
                className="btn btn-primary btn-sm"
                onClick={onApply}
                disabled={addable.length === 0}
              >
                全部新增（{addable.length}）
              </button>
            </div>
            <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
              {suggestions.map((s, i) => (
                <div
                  key={i}
                  className="cast-suggestion"
                  style={{
                    borderLeft: `3px solid ${s.exists ? 'var(--success)' : s.aId && s.bId ? 'var(--accent)' : 'var(--warning)'}`,
                    opacity: s.applied ? 0.55 : 1
                  }}
                >
                  <div className="row" style={{ alignItems: 'baseline' }}>
                    <span className="name">
                      {s.characterA} <span className="muted">↔</span> {s.characterB}
                    </span>
                    <span className="meta" style={{ marginLeft: 'auto', fontSize: 11.5 }}>
                      {s.applied
                        ? '已新增'
                        : s.exists
                          ? '已存在'
                          : s.aId && s.bId
                            ? '可新增'
                            : '人物未知'}
                    </span>
                  </div>
                  <div style={{ marginTop: 4 }}>
                    <span className="chip chip-accent">{s.relationType}</span>
                    {s.strength ? <span className="chip" style={{ marginLeft: 4 }}>强度 {s.strength}</span> : null}
                  </div>
                  {s.description ? <div className="reason">{s.description}</div> : null}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Dialog({
  characters,
  onClose,
  onSubmit
}: {
  characters: Character[]
  onClose: () => void
  onSubmit: (input: CreateRelationshipInput) => Promise<void>
}) {
  const [a, setA] = useState(characters[0]?.id ?? '')
  const [b, setB] = useState(characters[1]?.id ?? '')
  const [relationType, setRelationType] = useState('')
  const [description, setDescription] = useState('')
  const [strength, setStrength] = useState('')
  const [saving, setSaving] = useState(false)
  const presets = ['师徒', '敌对', '恋人', '兄弟', '同门', '仇人', '朋友']
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>新建关系</h3>
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>人物甲</label>
            <select className="select" value={a} onChange={(e) => setA(e.target.value)}>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>人物乙</label>
            <select className="select" value={b} onChange={(e) => setB(e.target.value)}>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label>关系类型</label>
          <input
            className="input"
            value={relationType}
            onChange={(e) => setRelationType(e.target.value)}
            placeholder="师徒 / 敌对 / 恋人…"
          />
          <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
            {presets.map((p) => (
              <span
                key={p}
                className="filter-chip"
                onClick={() => setRelationType(p)}
              >
                {p}
              </span>
            ))}
          </div>
        </div>
        <div className="field">
          <label>描述</label>
          <textarea
            className="textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>
        <div className="field">
          <label>强度（0-100，可留空）</label>
          <input
            className="input"
            type="number"
            min={0}
            max={100}
            value={strength}
            onChange={(e) => setStrength(e.target.value)}
          />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={saving || !a || !b || a === b || !relationType.trim()}
            onClick={async () => {
              setSaving(true)
              try {
                await onSubmit({
                  characterAId: a,
                  characterBId: b,
                  relationType: relationType.trim(),
                  description: description.trim() || undefined,
                  strength: strength ? Number(strength) : undefined
                })
              } finally {
                setSaving(false)
              }
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
