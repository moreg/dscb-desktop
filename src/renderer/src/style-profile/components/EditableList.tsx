import { useState } from 'react'

interface Props {
  title: string
  hint?: string
  accent?: string
  items: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}

/**
 * 可增删改的字符串列表。每行一个条目；底部一个「+ 添加」输入框。
 * 编辑态通用：用于画像字段（句式特征 / 词汇偏好…）和三栏约束。
 */
export default function EditableList({
  title,
  hint,
  accent,
  items,
  onChange,
  placeholder
}: Props) {
  const updateAt = (idx: number, value: string) => {
    const next = items.slice()
    next[idx] = value
    onChange(next)
  }
  const removeAt = (idx: number) => {
    onChange(items.filter((_, i) => i !== idx))
  }
  const append = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    onChange([...items, trimmed])
  }
  const moveUp = (idx: number) => {
    if (idx <= 0) return
    const next = items.slice()
    ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
    onChange(next)
  }
  const moveDown = (idx: number) => {
    if (idx >= items.length - 1) return
    const next = items.slice()
    ;[next[idx + 1], next[idx]] = [next[idx], next[idx + 1]]
    onChange(next)
  }
  return (
    <section
      style={{
        marginTop: 12,
        ...(accent
          ? {
              borderLeft: `3px solid ${accent}`,
              paddingLeft: 10
            }
          : {})
      }}
    >
      <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
        <strong style={{ fontSize: 13 }}>{title}</strong>
        {hint ? (
          <span className="meta" style={{ fontSize: 11 }}>{hint}</span>
        ) : null}
        <span className="meta" style={{ marginLeft: 'auto', fontSize: 11 }}>{items.length} 条</span>
      </div>
      <ul className="bare" style={{ marginTop: 6, display: 'grid', gap: 4 }}>
        {items.map((item, idx) => (
          <li key={`${idx}-${item}`} className="row" style={{ gap: 4, alignItems: 'center' }}>
            <input
              className="input"
              value={item}
              onChange={(e) => updateAt(idx, e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
            />
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => moveUp(idx)}
              disabled={idx === 0}
              title="上移"
            >
              ↑
            </button>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => moveDown(idx)}
              disabled={idx === items.length - 1}
              title="下移"
            >
              ↓
            </button>
            <button
              className="btn btn-danger btn-sm"
              type="button"
              onClick={() => removeAt(idx)}
              title="删除"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <AddRow placeholder={placeholder} onAdd={append} />
    </section>
  )
}

function AddRow({
  placeholder,
  onAdd
}: {
  placeholder?: string
  onAdd: (value: string) => void
}) {
  const [text, setText] = useState('')
  return (
    <form
      className="row"
      style={{ gap: 4, marginTop: 6 }}
      onSubmit={(e) => {
        e.preventDefault()
        onAdd(text)
        setText('')
      }}
    >
      <input
        className="input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder ?? '添加一条...'}
        style={{ flex: 1, minWidth: 0 }}
      />
      <button className="btn btn-ghost btn-sm" type="submit" disabled={!text.trim()}>
        + 添加
      </button>
    </form>
  )
}
