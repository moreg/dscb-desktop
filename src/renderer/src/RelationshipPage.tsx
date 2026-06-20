import { useEffect, useMemo, useRef, useState } from 'react'
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

interface Node {
  id: string
  name: string
  role?: string
  x: number
  y: number
  vx: number
  vy: number
}

interface Edge {
  id: string
  source: string
  target: string
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

const WIDTH = 720
const HEIGHT = 520

const ROLE_BUCKETS = [
  { match: ['主角'], label: '主角', cls: 'role-protagonist' },
  { match: ['配角', '女主', '男主'], label: '重要角色', cls: 'role-supporting' },
  { match: ['反派', 'BOSS', 'boss', '敌'], label: '反派', cls: 'role-antagonist' }
] as const

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
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

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

  const [layoutSeed, setLayoutSeed] = useState(0)
  const nodes = useMemo<Node[]>(() => {
    const n = characters.length
    if (n === 0) return []
    const cx = WIDTH / 2
    const cy = HEIGHT / 2
    // 用向日葵（phyllotaxis）分布 + 种子抖动，避免初始圆环；
    // 同势力节点尽量相邻（按势力排序后再铺）
    const grouped = new Map<string, Character[]>()
    for (const c of characters) {
      const f = factionOf(c)
      const list = grouped.get(f)
      if (list) list.push(c)
      else grouped.set(f, [c])
    }
    const ordered: Character[] = []
    for (const list of grouped.values()) ordered.push(...list)
    const golden = Math.PI * (3 - Math.sqrt(5))
    const baseR = 16
    // 基于种子的确定性伪随机，保证同 seed 下稳定
    const seedRand = (i: number) => {
      const x = Math.sin(i * 374.761 + layoutSeed * 91.13) * 43758.5453
      return x - Math.floor(x)
    }
    const arr: Node[] = ordered.map((c, i) => {
      const r = baseR * Math.sqrt(i + 1)
      const theta = i * golden
      const jitter = 18 * (seedRand(i) - 0.5)
      return {
        id: c.id,
        name: c.name,
        role: c.role,
        x: cx + Math.cos(theta) * r + jitter,
        y: cy + Math.sin(theta) * r + jitter,
        vx: 0,
        vy: 0
      }
    })
    return arr
  }, [characters, layoutSeed])

  // 用 ref 维护节点位置以驱动物理迭代
  const nodeMapRef = useRef<Map<string, Node>>(new Map())
  useEffect(() => {
    const m = new Map<string, Node>()
    for (const n of nodes) m.set(n.id, { ...n })
    nodeMapRef.current = m
  }, [nodes])

  const edges = useMemo<Edge[]>(
    () =>
      relationships.map((r) => ({
        id: r.id,
        source: r.characterAId,
        target: r.characterBId,
        type: r.relationType,
        description: r.description,
        strength: r.strength
      })),
    [relationships]
  )

  // 简易力导向：排斥 + 弹簧 + 中心牵引
  useEffect(() => {
    if (nodes.length === 0) return
    // 预热：同步跑若干步，让首屏即接近稳定布局（消除初始散点）
    const map0 = nodeMapRef.current
    const arr0 = [...map0.values()]
    const cx0 = WIDTH / 2
    const cy0 = HEIGHT / 2
    const settle = (steps: number) => {
      for (let s = 0; s < steps; s++) {
        const cur = [...map0.values()]
        for (let i = 0; i < cur.length; i++) {
          for (let j = i + 1; j < cur.length; j++) {
            const a = cur[i]
            const b = cur[j]
            const dx = b.x - a.x
            const dy = b.y - a.y
            const d2 = dx * dx + dy * dy + 0.01
            const d = Math.sqrt(d2)
            let force = 1800 / d2
            if (d < 54) force += ((54 - d) / 54) * 60
            const fx = (dx / d) * force
            const fy = (dy / d) * force
            a.vx -= fx * 0.05
            a.vy -= fy * 0.05
            b.vx += fx * 0.05
            b.vy += fy * 0.05
          }
        }
        for (const e of edges) {
          const a = map0.get(e.source)
          const b = map0.get(e.target)
          if (!a || !b) continue
          const dx = b.x - a.x
          const dy = b.y - a.y
          const d = Math.sqrt(dx * dx + dy * dy) + 0.01
          const k = 0.03 * (d - 140)
          const fx = (dx / d) * k
          const fy = (dy / d) * k
          a.vx += fx
          a.vy += fy
          b.vx -= fx
          b.vy -= fy
        }
        for (const n of cur) {
          n.vx += (cx0 - n.x) * 0.004
          n.vy += (cy0 - n.y) * 0.004
          n.vx *= 0.7
          n.vy *= 0.7
          n.x += n.vx
          n.y += n.vy
          n.x = Math.max(40, Math.min(WIDTH - 40, n.x))
          n.y = Math.max(30, Math.min(HEIGHT - 30, n.y))
        }
      }
    }
    if (arr0.length > 0) settle(160)
    setTick((t) => (t + 1) % 1_000_000)

    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min(50, now - last)
      last = now
      const map = nodeMapRef.current
      const arr = [...map.values()]
      const cx = WIDTH / 2
      const cy = HEIGHT / 2
      // 排斥 + 碰撞（节点半径 ~26，小于此距离强力推开避免重叠）
      const MIN_DIST = 54
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i]
          const b = arr[j]
          const dx = b.x - a.x
          const dy = b.y - a.y
          const d2 = dx * dx + dy * dy + 0.01
          const d = Math.sqrt(d2)
          // 远距：温和排斥
          let force = 1800 / d2
          // 近距：碰撞硬排斥
          if (d < MIN_DIST) {
            force += ((MIN_DIST - d) / MIN_DIST) * 60
          }
          const fx = (dx / d) * force
          const fy = (dy / d) * force
          if (dragRef.current?.id !== a.id) {
            a.vx -= fx * 0.02
            a.vy -= fy * 0.02
          }
          if (dragRef.current?.id !== b.id) {
            b.vx += fx * 0.02
            b.vy += fy * 0.02
          }
        }
      }
      // 弹簧
      for (const e of edges) {
        const a = map.get(e.source)
        const b = map.get(e.target)
        if (!a || !b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d = Math.sqrt(dx * dx + dy * dy) + 0.01
        const target = 140
        const k = 0.012 * (d - target)
        const fx = (dx / d) * k
        const fy = (dy / d) * k
        if (dragRef.current?.id !== a.id) {
          a.vx += fx
          a.vy += fy
        }
        if (dragRef.current?.id !== b.id) {
          b.vx -= fx
          b.vy -= fy
        }
      }
      // 中心牵引 + 阻尼
      for (const n of arr) {
        if (dragRef.current?.id === n.id) {
          n.vx = 0
          n.vy = 0
          continue
        }
        n.vx += (cx - n.x) * 0.0015
        n.vy += (cy - n.y) * 0.0015
        n.vx *= 0.85
        n.vy *= 0.85
        n.x += n.vx * (dt / 16)
        n.y += n.vy * (dt / 16)
        // 边界
        n.x = Math.max(40, Math.min(WIDTH - 40, n.x))
        n.y = Math.max(30, Math.min(HEIGHT - 30, n.y))
      }
      setTick((t) => (t + 1) % 1_000_000)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [edges, nodes.length])

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

  const nameOf = (id: string) => characters.find((c) => c.id === id)?.name ?? '（已删除）'
  const charOf = (id: string) => characters.find((c) => c.id === id)

  const selectedChar = selectedNode ? charOf(selectedNode) : null
  const selectedEdgeObj = selectedEdge ? edges.find((e) => e.id === selectedEdge) : null

  const onPointerDown = (e: React.PointerEvent<SVGCircleElement>, id: string) => {
    e.stopPropagation()
    const node = nodeMapRef.current.get(id)
    if (!node || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    dragRef.current = {
      id,
      offsetX: e.clientX - rect.left - node.x,
      offsetY: e.clientY - rect.top - node.y
    }
    setSelectedNode(id)
    setSelectedEdge(null)
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<SVGCircleElement>) => {
    if (!dragRef.current || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const n = nodeMapRef.current.get(dragRef.current.id)
    if (!n) return
    n.x = e.clientX - rect.left - dragRef.current.offsetX
    n.y = e.clientY - rect.top - dragRef.current.offsetY
  }
  const onPointerUp = (e: React.PointerEvent<SVGCircleElement>) => {
    dragRef.current = null
    ;(e.target as Element).releasePointerCapture(e.pointerId)
  }

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
              onClick={() => setLayoutSeed((s) => s + 1)}
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
          <div
            className="relation-graph"
            style={{ height: HEIGHT }}
            onClick={() => {
              setSelectedNode(null)
              setSelectedEdge(null)
            }}
          >
            <svg
              ref={svgRef}
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              preserveAspectRatio="xMidYMid meet"
            >
              {factionList.length > 0 && characters.length > 0
                ? Array.from(
                    new Set(characters.map((c) => factionOf(c)))
                  ).map((f) => {
                    const groupNodes = characters
                      .filter((c) => factionOf(c) === f)
                      .map((c) => nodeMapRef.current.get(c.id))
                      .filter(Boolean) as Node[]
                    if (groupNodes.length === 0) return null
                    const xs = groupNodes.map((n) => n.x)
                    const ys = groupNodes.map((n) => n.y)
                    const minX = Math.min(...xs) - 36
                    const maxX = Math.max(...xs) + 36
                    const minY = Math.min(...ys) - 30
                    const maxY = Math.max(...ys) + 48
                    return (
                      <rect
                        key={f}
                        className="faction-halo"
                        x={minX}
                        y={minY}
                        width={maxX - minX}
                        height={maxY - minY}
                        rx={10}
                      >
                        <title>{f}</title>
                      </rect>
                    )
                  })
                : null}
              {edges.map((e) => {
                const a = nodeMapRef.current.get(e.source)
                const b = nodeMapRef.current.get(e.target)
                if (!a || !b) return null
                const mx = (a.x + b.x) / 2
                const my = (a.y + b.y) / 2
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
                      // 跳转到关系详情（双击等同点击，详情栏已展开）
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
                      rx={4}
                      fill="var(--surface)"
                      stroke="var(--line)"
                    />
                    <text x={mx} y={my + 4} className="rel-edge-label">
                      {e.type}
                    </text>
                  </g>
                )
              })}
              {nodes.map((n) => {
                const live = nodeMapRef.current.get(n.id) ?? n
                const selected = selectedNode === n.id
                return (
                  <g key={n.id}>
                    <circle
                      cx={live.x}
                      cy={live.y}
                      r={22}
                      className={`rel-node-circle ${selected ? 'selected' : ''}`}
                      onPointerDown={(e) => onPointerDown(e, n.id)}
                      onPointerMove={onPointerMove}
                      onPointerUp={onPointerUp}
                      onDoubleClick={(ev) => {
                        ev.stopPropagation()
                        // 双击节点：跳转到人物管理页
                        onOpenCharacters?.()
                      }}
                      style={{ cursor: 'grab' }}
                    >
                      <title>{`拖拽移动 · 单击查看 · 双击进入人物页`}</title>
                    </circle>
                    <text x={live.x} y={live.y + 4} className="rel-node-label">
                      {n.name.slice(0, 2)}
                    </text>
                    <text
                      x={live.x}
                      y={live.y + 38}
                      className="rel-node-label"
                      style={{ fontSize: 11.5, fill: 'var(--ink-2)' }}
                    >
                      {n.name}
                    </text>
                  </g>
                )
              })}
            </svg>
            {characters.length === 0 ? (
              <div className="empty-graph">尚无人物</div>
            ) : null}
            {/* 用隐藏节点触发 tick 重渲染 */}
            <foreignObject x={0} y={0} width={0} height={0}>
              <span>{tick}</span>
            </foreignObject>
          </div>

          <aside className="rel-detail">
            {!selectedChar && !selectedEdgeObj ? (
              <div>
                <h3 className="sub" style={{ marginTop: 0 }}>说明</h3>
                <p className="muted" style={{ fontSize: 13 }}>
                  点击节点查看人物，点击边查看关系详情。节点可拖拽。
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
