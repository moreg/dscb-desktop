import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Foreshadowing,
  ForeshadowingStatus,
  UpdateForeshadowingInput,
  ChapterMeta
} from '../../shared/types'
import {
  buildForeshadowingEditPatch, buildForeshadowingStagePatch, FORESHADOWING_STATUS_LABELS,
  isForeshadowingOverdue, isOpenForeshadowing, latestWrittenChapter,
  validateForeshadowingEventChapter, writtenChapters, type ForeshadowingStageAction
} from './foreshadowingBoardState'

interface Props {
  projectId: string
  onBack: () => void
  onOpenChapter?: (n: number) => void
}

const COLUMNS: { statuses: ForeshadowingStatus[]; label: string; tone: string }[] = [
  { statuses: ['pending'], label: '待埋', tone: 'var(--ink-2)' },
  { statuses: ['planted', 'reinforced', 'partial'], label: '进行中', tone: 'var(--warning)' },
  { statuses: ['collected'], label: '已收', tone: 'var(--success)' },
  { statuses: ['deferred', 'missed'], label: '暂缓与遗漏', tone: 'var(--ink-2)' }
]

export default function ForeshadowingBoard({ projectId, onOpenChapter }: Props) {
  const [items, setItems] = useState<Foreshadowing[]>([])
  const [chapters, setChapters] = useState<ChapterMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Foreshadowing | null>(null)
  const [creating, setCreating] = useState(false)
  const [action, setAction] = useState<{ item: Foreshadowing; kind: ForeshadowingStageAction } | null>(null)
  const [error, setError] = useState('')
  const projectRef = useRef(projectId)
  projectRef.current = projectId
  const refreshId = useRef(0)
  const abandonRefresh = useCallback(() => { ++refreshId.current }, [])

  const refresh = useCallback(async () => {
    const request = ++refreshId.current
    setLoading(true)
    try {
      const [list, chapterList] = await Promise.all([window.api.listForeshadowings(projectId), window.api.listChapters(projectId)])
      if (projectRef.current !== projectId || refreshId.current !== request) return
      setItems(list)
      setChapters(chapterList)
      setError('')
    } catch (err) {
      if (projectRef.current === projectId && refreshId.current === request) setError(`加载失败：${(err as Error).message}`)
    } finally {
      if (projectRef.current === projectId && refreshId.current === request) setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    setEditing(null)
    setCreating(false)
    setAction(null)
    setItems([])
    setChapters([])
    void refresh()
    return abandonRefresh
  }, [refresh, abandonRefresh])

  const maxChapter = latestWrittenChapter(chapters)

  const remove = async (f: Foreshadowing) => {
    if (!window.confirm('删除该伏笔？')) return
    try {
      await window.api.deleteForeshadowing(projectId, f.id)
      await refresh()
    } catch (err) { setError(`删除失败：${(err as Error).message}`) }
  }

  const summary = {
    pending: items.filter((f) => f.status === 'pending').length,
    planted: items.filter(isOpenForeshadowing).length,
    collected: items.filter((f) => f.status === 'collected').length,
    missed: items.filter((f) => f.status === 'missed').length,
    deferred: items.filter((f) => f.status === 'deferred').length,
    overdue: items.filter((f) => isForeshadowingOverdue(f, maxChapter)).length
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
          <span className="filter-chip">进行中 {summary.planted}</span>
          <span className="filter-chip">已收 {summary.collected}</span>
          <span className="filter-chip">暂缓 {summary.deferred}</span>
          {summary.overdue > 0 ? (
            <span className="filter-chip active" style={{ color: 'var(--danger)' }}>
              逾期 {summary.overdue}
            </span>
          ) : null}
        </div>
      </div>

      {error ? <p role="alert" style={{ color: 'var(--danger)' }}>{error} <button className="btn btn-sm" onClick={() => void refresh()}>重试</button></p> : null}

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
            const list = items.filter((f) => col.statuses.includes(f.status))
            return (
              <div key={col.label} className="kanban-col">
                <h4 style={{ color: col.tone }}>
                  {col.label}
                  <span className="pill">{list.length}</span>
                </h4>
                <div className="kanban-list">
                  {list.length === 0 ? (
                    <p className="muted" style={{ fontSize: 12, fontStyle: 'italic' }}>—</p>
                  ) : null}
                  {list.map((f) => {
                    const overdue = isForeshadowingOverdue(f, maxChapter)
                    return (
                      <div key={f.id} className="card kanban-card">
                        <div className="content" title={f.content}>{f.content}</div>
                        <div className="meta-row">
                          <span className="ch">{FORESHADOWING_STATUS_LABELS[f.status]}</span>
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
                          {(f.reinforcementChapters ?? []).map((chapter) => <span key={`reinforce-${chapter}`} className="ch plant"
                            style={{ cursor: onOpenChapter ? 'pointer' : 'default' }} onClick={() => onOpenChapter?.(chapter)}>强化 · 第 {chapter} 章</span>)}
                          {(f.partialCollectChapters ?? []).map((chapter) => <span key={`partial-${chapter}`} className="ch collect"
                            style={{ cursor: onOpenChapter ? 'pointer' : 'default' }} onClick={() => onOpenChapter?.(chapter)}>部分回收 · 第 {chapter} 章</span>)}
                        </div>
                        {f.note ? (
                          <div className="muted kanban-card-note" title={f.note}>{f.note}</div>
                        ) : null}
                        <div className="actions">
                          {f.status === 'pending' || (f.plantChapter == null && (isOpenForeshadowing(f) || f.status === 'deferred')) ? (
                            <button
                              className="btn btn-sm"
                              onClick={() => setAction({ item: f, kind: 'plant' })}
                            >
                              埋设
                            </button>
                          ) : null}
                          {isOpenForeshadowing(f) || f.status === 'deferred' ? (
                            <>
                              <button
                                className="btn btn-sm"
                                onClick={() => setAction({ item: f, kind: 'collect' })}
                              >
                                完整回收
                              </button>
                              <button className="btn btn-sm" onClick={() => setAction({ item: f, kind: 'reinforce' })}>强化</button>
                              <button className="btn btn-sm" onClick={() => setAction({ item: f, kind: 'partial' })}>部分回收</button>
                              <button className="btn btn-sm" onClick={() => setAction({ item: f, kind: 'defer' })}>暂缓</button>
                              <button
                                className="btn btn-sm"
                                onClick={async () => {
                                  if (!window.confirm('标记为遗漏？')) return
                                  try {
                                    await window.api.markForeshadowingMissed(projectId, f.id)
                                    await refresh()
                                  } catch (err) { setError(`标记失败：${(err as Error).message}`) }
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
            await window.api.createForeshadowing(projectId, { content: input.content ?? '', expectedCollect: input.expectedCollect ?? undefined, note: input.note ?? undefined })
            setCreating(false)
            await refresh()
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
            await window.api.updateForeshadowing(projectId, editing.id, input)
            setEditing(null)
            await refresh()
          }}
        />
      ) : null}
      {action ? <ForeshadowingActionDialog action={action.kind} item={action.item} chapters={chapters}
        onClose={() => setAction(null)} onSubmit={async (chapter) => {
          if (action.kind === 'plant') await window.api.plantForeshadowing(projectId, action.item.id, chapter)
          else if (action.kind === 'collect') await window.api.collectForeshadowing(projectId, action.item.id, chapter)
          else await window.api.updateForeshadowing(projectId, action.item.id, buildForeshadowingStagePatch(action.item, action.kind, chapter))
          setAction(null)
          await refresh()
        }} /> : null}
    </div>
  )
}

interface DialogProps {
  title: string
  chapters: ChapterMeta[]
  initial?: Foreshadowing
  onClose: () => void
  onSubmit: (input: UpdateForeshadowingInput) => Promise<void>
}

function ForeshadowingDialog({ title, chapters, initial, onClose, onSubmit }: DialogProps) {
  const [content, setContent] = useState(initial?.content ?? '')
  const [expectedCollect, setExpectedCollect] = useState<string>(
    initial?.expectedCollect?.toString() ?? ''
  )
  const [note, setNote] = useState(initial?.note ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
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
          <input
            type="number" min={1} step={1} list="foreshadowing-planned-chapters"
            className="input" placeholder="不指定"
            value={expectedCollect}
            onChange={(e) => setExpectedCollect(e.target.value)}
          />
          <datalist id="foreshadowing-planned-chapters">
            {chapters.map((c) => (
              <option key={c.chapterNumber} value={c.chapterNumber}>
                第 {c.chapterNumber} 章 · {c.title}
              </option>
            ))}
          </datalist>
        </div>
        {error ? <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p> : null}
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
              setError('')
              try {
                await onSubmit(buildForeshadowingEditPatch(content, expectedCollect, note))
              } catch (err) {
                setError((err as Error).message)
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

function ForeshadowingActionDialog({ action, item, chapters, onClose, onSubmit }: {
  action: ForeshadowingStageAction
  item: Foreshadowing
  chapters: ChapterMeta[]
  onClose: () => void
  onSubmit: (chapter: number) => Promise<void>
}) {
  const [selected, setSelected] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const label = { plant: '埋设', collect: '完整回收', reinforce: '强化', partial: '部分回收', defer: '暂缓' }[action]
  const actualChapters = writtenChapters(chapters).filter((chapter) => action === 'plant' ||
    !item.plantChapter || chapter.chapterNumber >= item.plantChapter)
  return <div className="dialog-overlay" onClick={saving ? undefined : onClose}>
    <div className="dialog" role="dialog" aria-modal="true" aria-label={`记录${label}`} onClick={(event) => event.stopPropagation()}>
      <h3>记录{label}</h3>
      <p className="muted">{item.content}</p>
      <div className="field">
        <label>{action === 'defer' ? '新的计划回收章节' : `实际${label}章节`}</label>
        {action === 'defer' ? <input type="number" min={latestWrittenChapter(chapters) + 1} step={1}
          className="input" value={selected} placeholder="请输入计划章节" onChange={(event) => setSelected(event.target.value)} />
          : <select className="select" value={selected} onChange={(event) => setSelected(event.target.value)}>
            <option value="">请选择实际发生章节</option>
            {actualChapters.map((chapter) => <option key={chapter.chapterNumber} value={chapter.chapterNumber}>
              第 {chapter.chapterNumber} 章 · {chapter.title}
            </option>)}
          </select>}
        {action !== 'defer' && actualChapters.length === 0 ? <p className="muted">暂无可选正文，请先保存对应章节。</p> : null}
        {action === 'partial' ? <p className="muted">只记录已揭示的部分，其余伏笔继续保留。</p> : null}
        {action === 'defer' ? <p className="muted">调整全书当前计划；回看旧章也沿用这项安排。</p> : null}
      </div>
      {error ? <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p> : null}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" disabled={saving} onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={saving || !selected} onClick={async () => {
          setSaving(true)
          setError('')
          try { await onSubmit(validateForeshadowingEventChapter(item, action, selected, chapters)) }
          catch (err) { setError((err as Error).message) }
          finally { setSaving(false) }
        }}>保存记录</button>
      </div>
    </div>
  </div>
}
