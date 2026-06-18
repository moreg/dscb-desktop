import type { MemoryEntityType } from '../../shared/types'

interface Props {
  onBack: () => void
  onOpenCharacters: () => void
  onOpenEntity: (type: MemoryEntityType) => void
}

const ENTITIES: { type: MemoryEntityType; label: string; desc: string }[] = [
  { type: 'location', label: '地点', desc: '城市、山脉、门派、场所' },
  { type: 'worldview', label: '世界观', desc: '体系、势力、规则、设定' },
  { type: 'timeline', label: '时间线', desc: '按章节的关键事件' },
  { type: 'plot_point', label: '剧情点', desc: '故事弧、转折点' }
]

export default function MemoryCenterPage({ onBack, onOpenCharacters, onOpenEntity }: Props) {
  return (
    <div>
      <button onClick={onBack}>← 返回章节列表</button>
      <h2>记忆中心</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <Card label="人物" desc="角色档案、性格、能力" onClick={onOpenCharacters} />
        {ENTITIES.map((e) => (
          <Card key={e.type} label={e.label} desc={e.desc} onClick={() => onOpenEntity(e.type)} />
        ))}
      </div>
    </div>
  )
}

function Card({ label, desc, onClick }: { label: string; desc: string; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: 16,
        border: '1px solid #e2e8f0',
        borderRadius: 10,
        cursor: 'pointer'
      }}
    >
      <strong style={{ fontSize: 16 }}>{label}</strong>
      <div style={{ color: '#64748b', fontSize: 13, marginTop: 4 }}>{desc}</div>
    </div>
  )
}
