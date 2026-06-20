import { useEffect, useState } from 'react'
import type {
  Foreshadowing,
  ForeshadowingStatus,
  CreateForeshadowingInput,
  UpdateForeshadowingInput,
  ChapterMeta
} from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
  onOpenChapter?: (n: number) => void
}

const COLUMNS: { status: ForeshadowingStatus; label: string; chip: string; tone: string }[] = [
  { status: 'pending', label: '待埋', chip: '', tone: 'var(--ink-2)' },
  { status: 'planted', label: '已埋', chip: 'warning', tone: 'var(--warning)' },
  { status: 'collected', label: '已收', chip: 'success', tone: 'var(--success)' },
  { status: 'missed', label: '遗漏', chip: 'danger', tone: 'var(--danger)' }
]

export default function ForeshadowingBoard({ projectId, onOpenChapter }: Props) {
  const [items, setItems] = useState<Foreshadowing[]>([])
  const [chapters, setChapters] = useState<ChapterMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Foreshadowing | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = () => {
    setLoading(true)
    void window.api.listForeshadowings(projectId).then((list) => {
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
  }, [projectId])

  const totalChapters = chapters.length
  const maxChapter = totalChapters

  const remove = async (f: Foreshadowing) => {
    if (!window.confirm('删除该伏笔？')) return
    await window.api.deleteForeshadowing(projectId, f.id)
    refresh()
  }

  const summary = {
    pending: items.filter((f) => f.status === 'pending').length,
    planted: items.filter((f) => f.status === 'planted').length,
    collected: items.filter((f) => f.status === 'collected').length,
    missed: items.filter((f) => f.status === 'missed').length,
    overdue: items.filter(
      (f) =>
        f.status === 'planted' &&
        f.expectedCollect != null &&
        maxChapter > 0 &&
        f.expectedCollect < maxChapter
    ).length
  }

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>伏笔看板</h1>
            <p className="desc">埋设与回收 · 状态追踪</p>
          </div>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            + 新伏笔
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="filters">
          <span className="filter-chip">总计 {items.length}</span>
          <span className="filter-chip">待埋 {summary.pending}</span>
          <span className="filter-chip">已埋 {summary.planted}</span>
          <span className="filter-chip">已收 {summary.collected}</span>
          {summary.overdue > 0 ? (
            <span className="filter-chip active" style={{ color: 'var(--danger)' }}>
              逾期 {summary.overdue}
            </span>
          ) : null}
        </div>
      </div>

      {loading ? (
        <p className="empty">展卷中…</p>
      ) : items.length === 0 ? (
        <div className="placeholder">
          <p style={{ margin: '0 0 12px' }}>尚无伏笔。</p>
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            + 新伏笔
          </button>
        </div>
      ) : (
        <div className="kanban">
          {COLUMNS.map((col) => {
            const list = items.filter((f) => f.status === col.status)
            return (
              <div key={col.status} className="kanban-col">
                <h4 style={{ color: col.tone }}>
                  {col.label}
                  <span className="pill">{list.length}</span>
                </h4>
                <div className="kanban-list">
                  {list.length === 0 ? (
                    <p className="muted" style={{ fontSize: 12, fontStyle: 'italic' }}>—</p>
                  ) : null}
                  {list.map((f) => {
                    const overdue =
                      f.status === 'planted' &&
                      f.expectedCollect != null &&
                      maxChapter > 0 &&
                      f.expectedCollect < maxChapter
                    return (
                      <div key={f.id} className="card kanban-card">
                        <div className="content" title={f.content}>{f.content}</div>
                        <div className="meta-row">
                          {f.plantChapter ? (
                            <span
                              className="ch plant"
                              style={{ cursor: onOpenChapter ? 'pointer' : 'default' }}
                              onClick={() => onOpenChapter?.(f.plantChapter!)}
                            >
                              埋 · 第 {f.plantChapter} 章
                            </span>
                          ) : null}
                          {f.expectedCollect ? (
                            <span
                              className={`ch ${overdue ? 'overdue' : 'collect'}`}
                              style={{ cursor: onOpenChapter ? 'pointer' : 'default' }}
                              onClick={() => onOpenChapter?.(f.expectedCollect!)}
                            >
                              {overdue ? '⚠ 逾期 · 第 ' : '预收 · 第 '}
                              {f.expectedCollect} 章
                            </span>
                          ) : null}
                          {f.actualCollect ? (
                            <span
                              className="ch collect"
                              style={{ cursor: onOpenChapter ? 'pointer' : 'default' }}
                              onClick={() => onOpenChapter?.(f.actualCollect!)}
                            >
                              实收 · 第 {f.actualCollect} 章
                            </span>
                          ) : null}
                        </div>
                        {f.note ? (
                          <div className="muted kanban-card-note" title={f.note}>{f.note}</div>
                        ) : null}
                        <div className="actions">
                          {f.status === 'pending' ? (
                            <button
                              className="btn btn-sm"
                              onClick={() => {
                                const ch = f.plantChapter ?? chapters[0]?.chapterNumber ?? 1
                                void window.api
                                  .plantForeshadowing(projectId, f.id, ch)
                                  .then(refresh)
                              }}
                            >
                              埋设
                            </button>
                          ) : null}
                          {f.status === 'planted' ? (
                            <>
                              <button
                                className="btn btn-sm"
                                onClick={() => {
                                  const ch =
                                    f.expectedCollect ?? f.plantChapter ?? chapters[0]?.chapterNumber ?? 1
                                  void window.api
                                    .collectForeshadowing(projectId, f.id, ch)
                                    .then(refresh)
                                }}
                              >
                                回收
                              </button>
                              <button
                                className="btn btn-sm"
                                onClick={async () => {
                                  if (!window.confirm('标记为遗漏？')) return
                                  await window.api.markForeshadowingMissed(projectId, f.id)
                                  refresh()
                                }}
                              >
                                遗漏
                              </button>
                            </>
                          ) : null}
                          <button
                            className="btn btn-sm"
                            onClick={() => setEditing(f)}
                          >
                            编辑
                          </button>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => remove(f)}
                          >
                            删
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {creating ? (
        <ForeshadowingDialog
          title="新建伏笔"
          chapters={chapters}
          onClose={() => setCreating(false)}
          onSubmit={async (input) => {
            await window.api.createForeshadowing(projectId, input)
            setCreating(false)
            refresh()
          }}
        />
      ) : null}
      {editing ? (
        <ForeshadowingDialog
          title="编辑伏笔"
          chapters={chapters}
          initial={editing}
          onClose={() => setEditing(null)}
          onSubmit={async (input) => {
            const patch: UpdateForeshadowingInput = {
              content: input.content,
              expectedCollect: input.expectedCollect,
              note: input.note
            }
            await window.api.updateForeshadowing(projectId, editing.id, patch)
            setEditing(null)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}

interface DialogProps {
  title: string
  chapters: ChapterMeta[]
  initial?: Foreshadowing
  onClose: () => void
  onSubmit: (input: CreateForeshadowingInput) => Promise<void>
}

function ForeshadowingDialog({ title, chapters, initial, onClose, onSubmit }: DialogProps) {
  const [content, setContent] = useState(initial?.content ?? '')
  const [expectedCollect, setExpectedCollect] = useState<string>(
    initial?.expectedCollect?.toString() ?? ''
  )
  const [note, setNote] = useState(initial?.note ?? '')
  const [saving, setSaving] = useState(false)
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="field">
          <label>伏笔内容 *</label>
          <textarea
            className="textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
            placeholder="例如：主角的师父左眼下有一颗痣"
          />
        </div>
        <div className="field">
          <label>预期回收章节</label>
          <select
            className="select"
            value={expectedCollect}
            onChange={(e) => setExpectedCollect(e.target.value)}
          >
            <option value="">不指定</option>
            {chapters.map((c) => (
              <option key={c.chapterNumber} value={c.chapterNumber}>
                第 {c.chapterNumber} 章 · {c.title}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>备注</label>
          <textarea
            className="textarea"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
          />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={saving || !content.trim()}
            onClick={async () => {
              setSaving(true)
              try {
                await onSubmit({
                  content: content.trim(),
                  expectedCollect: expectedCollect ? Number(expectedCollect) : undefined,
                  note: note.trim() || undefined
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
