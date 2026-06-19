import type { MemoryEntityType } from '../../shared/types'

interface Props {
  onBack: () => void
  onOpenCharacters: () => void
  onOpenEntity: (type: MemoryEntityType) => void
  onOpenForeshadowings: () => void
  onOpenRelationships: () => void
}

const ENTITIES: { type: MemoryEntityType; label: string; desc: string }[] = [
  { type: 'location', label: '地点', desc: '城池 · 山川 · 门派 · 场所' },
  { type: 'worldview', label: '世界观', desc: '体系 · 势力 · 规则 · 设定' },
  { type: 'timeline', label: '时间线', desc: '按章铺陈的关键事件' },
  { type: 'plot_point', label: '剧情点', desc: '故事弧 · 转折 · 高潮' }
]

export default function MemoryCenterPage({
  onBack,
  onOpenCharacters,
  onOpenEntity,
  onOpenForeshadowings,
  onOpenRelationships
}: Props) {
  return (
    <div>
      <button className="btn btn-ghost btn-sm" onClick={onBack}>
        ‹ 章节
      </button>
      <h2 className="section mt">记忆中心</h2>
      <div className="card-grid">
        <div className="card card-hover" onClick={onOpenCharacters}>
          <strong style={{ fontSize: 16 }}>人物</strong>
          <div className="muted">角色档案 · 性格 · 能力</div>
        </div>
        <div className="card card-hover" onClick={onOpenForeshadowings}>
          <strong style={{ fontSize: 16 }}>伏笔</strong>
          <div className="muted">埋设与回收 · 状态看板</div>
        </div>
        <div className="card card-hover" onClick={onOpenRelationships}>
          <strong style={{ fontSize: 16 }}>人物关系</strong>
          <div className="muted">师徒 · 敌我 · 情缘</div>
        </div>
        {ENTITIES.map((e) => (
          <div key={e.type} className="card card-hover" onClick={() => onOpenEntity(e.type)}>
            <strong style={{ fontSize: 16 }}>{e.label}</strong>
            <div className="muted">{e.desc}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
