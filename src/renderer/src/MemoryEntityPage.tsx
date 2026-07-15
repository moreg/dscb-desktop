import { useEffect, useMemo, useState } from 'react'
import MarkdownView, { rawFieldsToMarkdown } from './MarkdownView'
import type {
  MemoryEntity,
  MemoryEntityType,
  CreateMemoryEntityInput,
  ChapterMeta
} from '../../shared/types'

/** 实体展示用 body：地点/道具从 rawFields 重建（含关联事件/角色/状态），世界观直接用 notes */
function displayBody(e: MemoryEntity, type: MemoryEntityType): string {
  if (type === 'location' || type === 'item') return rawFieldsToMarkdown(e.rawFields) || e.notes || ''
  return e.notes || ''
}

interface Props {
  projectId: string
  type: MemoryEntityType
  label: string
  onBack: () => void
  onOpenChapter?: (n: number) => void
}

const EMPTY: CreateMemoryEntityInput = { name: '', category: '', notes: '' }

interface TypeConfig {
  /** 编辑时实际会用到的字段（type-specific 增补） */
  fields: { key: 'name' | 'category' | 'notes' | 'chapter'; label: string; placeholder?: string; multi?: boolean }[]
  /** 列表项额外展示的渲染（拿到 entity + chapterByNumber） */
  renderExtra?: (e: MemoryEntity, ctx: RenderCtx) => React.ReactNode
  emptyHint: string
  presetCategories?: string[]
}

interface RenderCtx {
  chapterTitle: (n: number) => string
  onOpenChapter?: (n: number) => void
}

const CONFIG: Record<MemoryEntityType, TypeConfig> = {
  location: {
    fields: [
      { key: 'name', label: '名称 *' },
      { key: 'category', label: '所属势力 / 区域', placeholder: '天玄宗 · 北域' },
      { key: 'notes', label: '描述', multi: true }
    ],
    emptyHint: '尚无地点。'
  },
  worldview: {
    fields: [
      { key: 'name', label: '名称 *' },
      { key: 'category', label: '体系 / 类别', placeholder: '修炼体系 / 势力' },
      { key: 'notes', label: '规则与细节', multi: true }
    ],
    emptyHint: '尚无世界观。'
  },
  timeline: {
    fields: [
      { key: 'name', label: '事件名 *' },
      { key: 'category', label: '阶段', placeholder: '开场 / 转折 / 高潮' },
      { key: 'chapter', label: '发生章节（可选）' },
      { key: 'notes', label: '细节', multi: true }
    ],
    emptyHint: '尚无时间线事件。',
    renderExtra: (e, ctx) => {
      // 解析 notes 中的"第N章"作为提示；category 中已扩展可能含数字
      const m = (e.notes ?? '').match(/第\s*(\d+)\s*章/)
      if (m) {
        const n = Number(m[1])
        return (
          <span
            className="outline-tag emotion"
            style={{ cursor: 'pointer' }}
            onClick={() => ctx.onOpenChapter?.(n)}
          >
            第 {n} 章 · {ctx.chapterTitle(n)}
          </span>
        )
      }
      return null
    }
  },
  plot_point: {
    fields: [
      { key: 'name', label: '剧情点名 *' },
      { key: 'category', label: '类型', placeholder: '伏笔 / 转折 / 高潮 / 揭秘' },
      { key: 'notes', label: '详情', multi: true }
    ],
    emptyHint: '尚无剧情点。',
    renderExtra: (e, ctx) => {
      const notes = e.notes ?? ''
      const personHits = [...notes.matchAll(/@(\S+)/g)].map((m) => m[1])
      const fTagHits = [...notes.matchAll(/#伏笔\s*[:：]?\s*(\S+)/g)].map((m) => m[1])
      if (personHits.length === 0 && fTagHits.length === 0) return null
      return (
        <div className="outline-tags" style={{ marginLeft: 8 }}>
          {personHits.slice(0, 4).map((p, i) => (
            <span key={`p${i}`} className="outline-tag emotion">
              👤 {p}
            </span>
          ))}
          {fTagHits.slice(0, 2).map((t, i) => (
            <span key={`f${i}`} className="outline-tag cool">
              📌 {t}
            </span>
          ))}
        </div>
      )
    }
  },
  item: {
    fields: [
      { key: 'name', label: '名称 *' },
      { key: 'category', label: '类型', placeholder: '法宝 / 兵器 / 灵物 / 信物' },
      { key: 'notes', label: '描述', multi: true }
    ],
    emptyHint: '尚无道具。'
  }
}

export default function MemoryEntityPage({ projectId, type, label, onOpenChapter }: Props) {
  const [items, setItems] = useState<MemoryEntity[]>([])
  const [chapters, setChapters] = useState<ChapterMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ id: string; input: CreateMemoryEntityInput; chapter?: string } | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = () => {
    setLoading(true)
    void window.api.listMemoryEntities(projectId, type).then((list) => {
      setItems(list)
      setLoading(false)
    })
  }
  const refreshChapters = () => {
    void window.api.listChapters(projectId).then(setChapters)
  }

  useEffect(() => {
    refresh()
    refreshChapters()
  }, [projectId, type])

  const remove = async (e: MemoryEntity) => {
    if (!window.confirm(`删除「${e.name}」？`)) return
    await window.api.deleteMemoryEntity(projectId, type, e.id)
    refresh()
  }

  const config = CONFIG[type]
  const chapterByNumber = useMemo(() => {
    const m = new Map<number, ChapterMeta>()
    for (const c of chapters) m.set(c.chapterNumber, c)
    return m
  }, [chapters])
  const chapterTitle = (n: number) => chapterByNumber.get(n)?.title ?? `第 ${n} 章`
  const useMarkdown = type === 'location' || type === 'worldview' || type === 'item'
  const ctx = { chapterTitle, onOpenChapter: onOpenChapter ?? (() => {}) }

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>{label}</h1>
            <p className="desc">{items.length} 条记录</p>
          </div>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            + 新建
          </button>
        </div>
      </div>

      {loading ? (
        <p className="empty">展卷中…</p>
      ) : items.length === 0 ? (
        <div className="placeholder">
          <p style={{ margin: '0 0 12px' }}>{config.emptyHint}</p>
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            + 新建
          </button>
        </div>
      ) : (
        <ul className="bare">
          {items.map((e) => {
            const extra = config.renderExtra?.(e, ctx)
            return (
              <li key={e.id} className="card">
                <div className="row" style={{ alignItems: 'baseline' }}>
                  <strong style={{ fontSize: 15 }}>{e.name}</strong>
                  {e.category ? (
                    <span className="chip chip-accent" style={{ marginLeft: 6 }}>
                      {e.category}
                    </span>
                  ) : null}
                  {extra}
                  <div style={{ marginLeft: 'auto' }} className="btn-group">
                    {e.sources && e.sources[0] ? (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() =>
                          window.api.openMemorySource(projectId, e.sources![0].path)
                        }
                        title={`在系统资源管理器中打开 ${e.sources[0].path}`}
                      >
                        📂 源文件
                      </button>
                    ) : null}
                    <button
                      className="btn btn-sm"
                      onClick={() =>
                        setEditing({
                          id: e.id,
                          input: {
                            name: e.name,
                            category: e.category ?? '',
                            notes: e.notes ?? ''
                          }
                        })
                      }
                    >
                      编辑
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => remove(e)}>
                      删除
                    </button>
                  </div>
                </div>
                {(() => {
                  const body = displayBody(e, type)
                  if (!body) return null
                  if (useMarkdown) {
                    return <MarkdownView sections={[{ title: '', body }]} />
                  }
                  return <pre className="body">{body}</pre>
                })()}
              </li>
            )
          })}
        </ul>
      )}

      {creating ? (
        <EntityDialog
          title={`新建${label}`}
          initial={EMPTY}
          config={config}
          chapters={chapters}
          onClose={() => setCreating(false)}
          onSubmit={async (input) => {
            await window.api.createMemoryEntity(projectId, type, trim(input))
            setCreating(false)
            refresh()
          }}
        />
      ) : null}
      {editing ? (
        <EntityDialog
          title={`编辑${label}`}
          initial={editing.input}
          config={config}
          chapters={chapters}
          onClose={() => setEditing(null)}
          onSubmit={async (input) => {
            await window.api.updateMemoryEntity(projectId, type, editing.id, trim(input))
            setEditing(null)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function trim(input: CreateMemoryEntityInput): CreateMemoryEntityInput {
  return {
    name: input.name.trim(),
    category: input.category?.trim() || undefined,
    notes: input.notes?.trim() || undefined
  }
}

function EntityDialog({
  title,
  initial,
  config,
  chapters,
  onClose,
  onSubmit
}: {
  title: string
  initial: CreateMemoryEntityInput
  config: TypeConfig
  chapters: ChapterMeta[]
  onClose: () => void
  onSubmit: (input: CreateMemoryEntityInput) => Promise<void>
}) {
  const [name, setName] = useState(initial.name)
  const [category, setCategory] = useState(initial.category ?? '')
  const [notes, setNotes] = useState(initial.notes ?? '')
  const [chapterRaw, setChapterRaw] = useState<string>(() => {
    if (initial.notes) {
      const m = initial.notes.match(/第\s*(\d+)\s*章/)
      if (m) return m[1]
    }
    return ''
  })
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    let finalNotes = notes.trim()
    if (chapterRaw.trim()) {
      const tag = `第 ${chapterRaw.trim()} 章`
      if (!finalNotes.includes(tag)) {
        finalNotes = finalNotes ? `${finalNotes}\n[${tag}]` : `[${tag}]`
      }
    }
    setSaving(true)
    try {
      await onSubmit({
        name: name.trim(),
        category: category.trim() || undefined,
        notes: finalNotes || undefined
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="field">
          <label>名称 *</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>分类</label>
          <input
            className="input"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder={config.fields.find((f) => f.key === 'category')?.placeholder}
          />
        </div>
        {config.fields.some((f) => f.key === 'chapter') ? (
          <div className="field">
            <label>发生章节</label>
            <select
              className="select"
              value={chapterRaw}
              onChange={(e) => setChapterRaw(e.target.value)}
            >
              <option value="">不指定</option>
              {chapters.map((c) => (
                <option key={c.chapterNumber} value={c.chapterNumber}>
                  第 {c.chapterNumber} 章 · {c.title}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="field">
          <label>详情</label>
          <textarea
            className="textarea"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={5}
            placeholder={config.fields.find((f) => f.key === 'notes')?.placeholder}
          />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={saving || !name.trim()}
            onClick={submit}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
