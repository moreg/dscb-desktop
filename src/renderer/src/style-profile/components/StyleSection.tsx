interface Props {
  title: string
  items: string[]
}

/**
 * 文风画像的单个段（标题 + chip 列表）。纯展示组件。
 */
export default function StyleSection({ title, items }: Props) {
  return (
    <section style={{ marginTop: 14 }}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      {items.length === 0 ? (
        <p className="meta" style={{ marginTop: 6 }}>暂无</p>
      ) : (
        <ul className="bare" style={{ marginTop: 8, display: 'grid', gap: 6 }}>
          {items.map((item) => (
            <li key={item} className="chip" style={{ width: 'fit-content', maxWidth: '100%' }}>
              {item}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
