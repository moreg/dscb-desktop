import { useEffect, useState } from 'react'
import type { MemoryEntityType, Character, Foreshadowing, Relationship } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
  onOpenCharacters: () => void
  onOpenEntity: (type: MemoryEntityType) => void
  onOpenForeshadowings: () => void
  onOpenRelationships: () => void
}

interface EntityMeta {
  type: MemoryEntityType
  label: string
  desc: string
  icon: string
  hint: string
}

const ENTITIES: EntityMeta[] = [
  { type: 'location', label: '地点', desc: '城池 · 山川 · 门派 · 场所', icon: '🏯', hint: '标注所属势力与首次登场' },
  { type: 'worldview', label: '世界观', desc: '体系 · 势力 · 规则 · 设定', icon: '☯', hint: '功法体系 / 修炼境界' },
  { type: 'timeline', label: '时间线', desc: '按章铺陈的关键事件', icon: '⌛', hint: '关联到具体章节号' },
  { type: 'plot_point', label: '剧情点', desc: '故事弧 · 转折 · 高潮', icon: '✦', hint: '与人物/伏笔联动' }
]

export default function MemoryCenterPage({
  projectId,
  onOpenCharacters,
  onOpenEntity,
  onOpenForeshadowings,
  onOpenRelationships
}: Props) {
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [characterCount, setCharacterCount] = useState(0)
  const [foreshadowingCount, setForeshadowingCount] = useState(0)
  const [pendingForeshadowing, setPendingForeshadowing] = useState(0)
  const [relationshipCount, setRelationshipCount] = useState(0)

  useEffect(() => {
    void window.api.listCharacters(projectId).then((c: Character[]) => setCharacterCount(c.length))
    void window.api.listForeshadowings(projectId).then((f: Foreshadowing[]) => {
      setForeshadowingCount(f.length)
      setPendingForeshadowing(f.filter((x) => x.status !== 'collected' && x.status !== 'missed').length)
    })
    void window.api.listRelationships(projectId).then((r: Relationship[]) => setRelationshipCount(r.length))
    void Promise.all(
      ENTITIES.map((e) =>
        window.api.listMemoryEntities(projectId, e.type).then((list) => [e.type, list.length] as const)
      )
    ).then((entries) => {
      setCounts(Object.fromEntries(entries))
    })
  }, [projectId])

  return (
    <div>
      <div className="page-head">
        <h1>记忆中心</h1>
        <p className="desc">人物 · 伏笔 · 关系 · 世界设定一览</p>
      </div>

      <div className="card-grid">
        <div className="card card-hover" onClick={onOpenCharacters}>
          <div className="memory-card">
            <div className="memory-icon">🧑</div>
            <div>
              <strong style={{ fontSize: 16 }}>人物</strong>
              <div className="muted">角色档案 · 性格 · 出场章节</div>
              <div className="memory-stats">
                <span><span className="num">{characterCount}</span>个人物</span>
              </div>
            </div>
          </div>
        </div>

        <div className="card card-hover" onClick={onOpenForeshadowings}>
          <div className="memory-card">
            <div className="memory-icon">📌</div>
            <div>
              <strong style={{ fontSize: 16 }}>伏笔</strong>
              <div className="muted">埋设与回收 · 状态看板</div>
              <div className="memory-stats">
                <span><span className="num">{foreshadowingCount}</span>条</span>
                {pendingForeshadowing > 0 ? (
                  <span style={{ color: 'var(--warning)' }}>
                    待处理 {pendingForeshadowing}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="card card-hover" onClick={onOpenRelationships}>
          <div className="memory-card">
            <div className="memory-icon">🔗</div>
            <div>
              <strong style={{ fontSize: 16 }}>人物关系</strong>
              <div className="muted">师徒 · 敌我 · 情缘</div>
              <div className="memory-stats">
                <span><span className="num">{relationshipCount}</span>条关系</span>
              </div>
            </div>
          </div>
        </div>

        {ENTITIES.map((e) => (
          <div
            key={e.type}
            className="card card-hover"
            onClick={() => onOpenEntity(e.type)}
          >
            <div className="memory-card">
              <div className="memory-icon">{e.icon}</div>
              <div>
                <strong style={{ fontSize: 16 }}>{e.label}</strong>
                <div className="muted">{e.desc}</div>
                <div className="memory-stats">
                  <span><span className="num">{counts[e.type] ?? 0}</span>条</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
