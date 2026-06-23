interface Props {
  styleItems: string[]
  characterItems: string[]
  plotItems: string[]
}

/**
 * P28：三栏约束块。把 dos/donts 拆成可复用的写作约束（文风 / 人设 / 剧情），
 * 让作者一眼看清每条归属哪一类，便于复用与维护。查看态用。
 */
export default function StyleProfileConstraintsBlock({
  styleItems,
  characterItems,
  plotItems
}: Props) {
  // P28 兼容：老 styles.json 中的文风卡没有这三个新字段，读取时为 undefined
  const s = styleItems ?? []
  const c = characterItems ?? []
  const p = plotItems ?? []
  const allEmpty = s.length === 0 && c.length === 0 && p.length === 0
  if (allEmpty) {
    return (
      <section style={{ marginTop: 14 }}>
        <strong style={{ fontSize: 13 }}>约束（文风 / 人设 / 剧情）</strong>
        <p className="meta" style={{ marginTop: 6 }}>暂无</p>
      </section>
    )
  }
  return (
    <section style={{ marginTop: 14 }}>
      <strong style={{ fontSize: 13 }}>约束（文风 / 人设 / 剧情）</strong>
      <p className="meta" style={{ marginTop: 6, fontSize: 12 }}>
        应做按归属分类：文风约束（跨题材复用） / 人设约束（与角色绑定） / 剧情约束（与本书设定绑定）。
      </p>
      <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
        <ConstraintColumn
          title="文风约束"
          hint="跨题材复用"
          items={styleItems}
          accent="var(--vermilion)"
        />
        <ConstraintColumn
          title="人设约束"
          hint="与主角/角色绑定"
          items={characterItems}
          accent="#3b82f6"
        />
        <ConstraintColumn
          title="剧情约束"
          hint="与本书题材/设定绑定"
          items={plotItems}
          accent="#10b981"
        />
      </div>
    </section>
  )
}

function ConstraintColumn({
  title,
  hint,
  items,
  accent
}: {
  title: string
  hint: string
  items: string[]
  accent: string
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border, #e5e7eb)',
        borderLeft: `3px solid ${accent}`,
        borderRadius: 6,
        padding: '8px 10px',
        background: 'var(--card-bg, transparent)'
      }}
    >
      <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
        <strong style={{ fontSize: 13 }}>{title}</strong>
        <span className="meta" style={{ fontSize: 11 }}>{hint}</span>
        <span className="meta" style={{ marginLeft: 'auto', fontSize: 11 }}>{items.length} 条</span>
      </div>
      {items.length === 0 ? (
        <p className="meta" style={{ marginTop: 4 }}>暂无</p>
      ) : (
        <ul className="bare" style={{ marginTop: 6, display: 'grid', gap: 4 }}>
          {items.map((item) => (
            <li key={item} style={{ fontSize: 13, lineHeight: 1.55 }}>
              · {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
