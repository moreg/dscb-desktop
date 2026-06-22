import { useEffect, useMemo, useState } from 'react'
import MarkdownView from './MarkdownView'
import type { ChapterMeta, DetailedOutlineItem, MainOutline } from '../../shared/types'
import { getOutlineDetailRows, type OutlineDetailRow } from './outlineDetailFields'

const DETAILED_PAGE_SIZE = 10

interface Props {
  projectId: string
  onBack?: () => void
  onOpenChapter?: (n: number) => void
}

interface DetailedVolumeGroup {
  key: string
  label: string
  items: DetailedOutlineItem[]
}

export default function OutlinePage({ projectId, onOpenChapter }: Props) {
  const [tab, setTab] = useState<'main' | 'detailed'>('main')
  const [main, setMain] = useState<MainOutline | null>(null)
  const [items, setItems] = useState<DetailedOutlineItem[]>([])
  const [sections, setSections] = useState<{ title: string; body: string }[]>([])
  const [chapters, setChapters] = useState<ChapterMeta[]>([])
  const [loadingMain, setLoadingMain] = useState(false)

  const [editingMain, setEditingMain] = useState(false)
  const [mainDraft, setMainDraft] = useState('')
  const [themeDraft, setThemeDraft] = useState('')
  const [mainLineDraft, setMainLineDraft] = useState('')
  const [savingMain, setSavingMain] = useState(false)

  const [activeDetailedVolume, setActiveDetailedVolume] = useState('all')
  const [detailedPage, setDetailedPage] = useState(1)

  // 细纲编辑状态
  const [editingChapter, setEditingChapter] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<Partial<DetailedOutlineItem>>({})
  const [savingEdit, setSavingEdit] = useState(false)

  const refresh = () => {
    void window.api.getMainOutline(projectId).then(setMain)
    void window.api.listDetailedOutline(projectId).then(setItems)
    void window.api.getOutlineSections(projectId).then((res) => setSections(res.sections))
    void window.api.listChapters(projectId).then(setChapters)
  }

  useEffect(refresh, [projectId])

  const chapterTitleOf = (n: number) =>
    chapters.find((c) => c.chapterNumber === n)?.title ?? `第 ${n} 章`

  const totalChapters = chapters.length
  const detailedCount = items.length
  const coverage = totalChapters === 0 ? 0 : Math.round((detailedCount / totalChapters) * 100)

  const genMain = async () => {
    setLoadingMain(true)
    try {
      setMain(await window.api.generateMainOutline(projectId))
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setLoadingMain(false)
    }
  }

  const startEditMain = () => {
    if (!main) return
    setMainDraft(main.synopsis)
    setThemeDraft(main.theme ?? '')
    setMainLineDraft(main.mainLine ?? '')
    setEditingMain(true)
  }

  const saveMain = async () => {
    setSavingMain(true)
    try {
      const next = await window.api.updateMainOutline(projectId, {
        synopsis: mainDraft.trim() || main?.synopsis || '',
        theme: themeDraft.trim() || undefined,
        mainLine: mainLineDraft.trim() || undefined
      })
      setMain(next)
      setEditingMain(false)
      void window.api.getOutlineSections(projectId).then((res) => setSections(res.sections))
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setSavingMain(false)
    }
  }

  // 细纲编辑函数
  const startEditDetailed = (item: DetailedOutlineItem) => {
    setEditingChapter(item.chapterNumber)
    setEditDraft({
      title: item.title,
      plotSummary: item.plotSummary,
      coolPoint: item.coolPoint,
      hook: item.hook,
      charactersAppearing: item.charactersAppearing ?? [],
      foreshadowings: item.foreshadowings ?? [],
      wordEstimate: item.wordEstimate,
      goldenLine: item.goldenLine,
      emotion: item.emotion,
      climax: item.climax
    })
  }

  const cancelEditDetailed = () => {
    setEditingChapter(null)
    setEditDraft({})
  }

  const saveEditDetailed = async () => {
    if (editingChapter === null) return
    setSavingEdit(true)
    try {
      await window.api.updateDetailedOutline(projectId, editingChapter, editDraft)
      // 刷新列表
      void window.api.listDetailedOutline(projectId).then(setItems)
      setEditingChapter(null)
      setEditDraft({})
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setSavingEdit(false)
    }
  }

  const sortedItems = useMemo(
    () => [...items].sort((a, b) => a.chapterNumber - b.chapterNumber),
    [items]
  )

  const detailedVolumes = useMemo<DetailedVolumeGroup[]>(() => {
    const grouped = new Map<number | 'none', DetailedOutlineItem[]>()

    for (const item of sortedItems) {
      const key = item.volume ?? 'none'
      const list = grouped.get(key) ?? []
      list.push(item)
      grouped.set(key, list)
    }

    const tabs = [...grouped.entries()]
      .sort(([a], [b]) => {
        if (a === 'none') return 1
        if (b === 'none') return -1
        return a - b
      })
      .map(([volume, volumeItems]) => ({
        key: volume === 'none' ? 'none' : `volume-${volume}`,
        label: volume === 'none' ? '未分卷' : `第 ${volume} 卷`,
        items: volumeItems
      }))

    return [{ key: 'all', label: '全部', items: sortedItems }, ...tabs]
  }, [sortedItems])

  const activeDetailedGroup =
    detailedVolumes.find((group) => group.key === activeDetailedVolume) ?? detailedVolumes[0]

  const totalDetailedPages = Math.max(
    1,
    Math.ceil((activeDetailedGroup?.items.length ?? 0) / DETAILED_PAGE_SIZE)
  )

  const pagedDetailedItems = useMemo(() => {
    if (!activeDetailedGroup) return []
    const start = (detailedPage - 1) * DETAILED_PAGE_SIZE
    return activeDetailedGroup.items.slice(start, start + DETAILED_PAGE_SIZE)
  }, [activeDetailedGroup, detailedPage])

  useEffect(() => {
    if (!detailedVolumes.some((group) => group.key === activeDetailedVolume)) {
      setActiveDetailedVolume(detailedVolumes[0]?.key ?? 'all')
    }
  }, [activeDetailedVolume, detailedVolumes])

  useEffect(() => {
    setDetailedPage(1)
  }, [activeDetailedVolume, projectId])

  useEffect(() => {
    if (detailedPage > totalDetailedPages) {
      setDetailedPage(totalDetailedPages)
    }
  }, [detailedPage, totalDetailedPages])

  const renderDetailedPager = () => {
    if (!activeDetailedGroup || activeDetailedGroup.items.length <= DETAILED_PAGE_SIZE) return null

    return (
      <div className="outline-pager">
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setDetailedPage((page) => Math.max(1, page - 1))}
          disabled={detailedPage === 1}
        >
          上一页
        </button>
        <div className="outline-pager-pages">
          {Array.from({ length: totalDetailedPages }, (_, index) => {
            const page = index + 1
            return (
              <button
                key={page}
                className={`outline-pager-page ${page === detailedPage ? 'active' : ''}`}
                onClick={() => setDetailedPage(page)}
              >
                {page}
              </button>
            )
          })}
        </div>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setDetailedPage((page) => Math.min(totalDetailedPages, page + 1))}
          disabled={detailedPage === totalDetailedPages}
        >
          下一页
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>大纲</h1>
            <p className="desc">
              细纲覆盖 {detailedCount} / {totalChapters} 章（{coverage}%）
            </p>
          </div>
        </div>
      </div>

      <div className="tab-bar">
        <button
          className={`tab-btn ${tab === 'main' ? 'active' : ''}`}
          onClick={() => setTab('main')}
        >
          总纲
        </button>
        <button
          className={`tab-btn ${tab === 'detailed' ? 'active' : ''}`}
          onClick={() => setTab('detailed')}
        >
          细纲 · {detailedCount}
        </button>
      </div>

      {tab === 'main' ? (
        <div className="outline-single">
          {editingMain && main ? (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <strong style={{ fontSize: 15 }}>编辑概要</strong>
              </div>
              <div className="field">
                <label>核心主题</label>
                <input
                  className="input"
                  value={themeDraft}
                  onChange={(e) => setThemeDraft(e.target.value)}
                  placeholder="复仇 / 救赎 / 成长"
                />
              </div>
              <div className="field">
                <label>故事主线</label>
                <input
                  className="input"
                  value={mainLineDraft}
                  onChange={(e) => setMainLineDraft(e.target.value)}
                  placeholder="一句话概括"
                />
              </div>
              <div className="field">
                <label>主线概要</label>
                <textarea
                  className="textarea"
                  value={mainDraft}
                  onChange={(e) => setMainDraft(e.target.value)}
                  rows={6}
                />
              </div>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setEditingMain(false)}
                  disabled={savingMain}
                >
                  取消
                </button>
                <button className="btn btn-primary btn-sm" onClick={saveMain} disabled={savingMain}>
                  {savingMain ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          ) : null}

          <div className="card">
            <div className="row" style={{ marginBottom: 12, alignItems: 'center' }}>
              <strong style={{ fontSize: 16 }}>总纲全文</strong>
              <span className="meta" style={{ marginLeft: 'auto' }}>
                {sections.length} 节
              </span>
              {main && !editingMain ? (
                <button className="btn btn-sm btn-ghost" onClick={startEditMain}>
                  编辑概要
                </button>
              ) : null}
            </div>
            {sections.length === 0 ? (
              <div className="placeholder" style={{ padding: 16 }}>
                <p style={{ margin: '0 0 10px' }}>暂无总纲内容</p>
                <button className="btn btn-primary btn-sm" onClick={genMain} disabled={loadingMain}>
                  {loadingMain ? '生成中…' : 'AI 生成总纲'}
                </button>
              </div>
            ) : (
              <MarkdownView sections={sections} skipTitles={['逐章节奏标注']} />
            )}
          </div>
        </div>
      ) : (
        <div className="outline-single">
          {totalChapters === 0 ? (
            <div className="placeholder">
              <p>先在“章节”页创建章节，再为每章生成细纲。</p>
            </div>
          ) : sortedItems.length === 0 ? (
            <div className="placeholder">
              <p>暂无细纲。生成细纲文件后，这里会自动展示。</p>
            </div>
          ) : (
            <>
              <div className="outline-volume-tabs">
                {detailedVolumes.map((group) => (
                  <button
                    key={group.key}
                    className={`outline-volume-tab ${group.key === activeDetailedVolume ? 'active' : ''}`}
                    onClick={() => setActiveDetailedVolume(group.key)}
                  >
                    <span>{group.label}</span>
                    <span>{group.items.length}</span>
                  </button>
                ))}
              </div>

              <div className="outline-toolbar">
                <span className="meta">
                  当前显示 {activeDetailedGroup?.label ?? '全部'} · 第 {detailedPage} / {totalDetailedPages} 页
                </span>
                <span className="meta">
                  每页 {DETAILED_PAGE_SIZE} 章 · 本组共 {activeDetailedGroup?.items.length ?? 0} 章
                </span>
              </div>

              {renderDetailedPager()}

              <ul className="bare">
                {pagedDetailedItems.map((it) => {
                  const title = chapterTitleOf(it.chapterNumber)
                  const rows = getOutlineDetailRows(it)
                  const isEditing = editingChapter === it.chapterNumber
                  return (
                    <li key={it.chapterNumber} className="card">
                      {isEditing ? (
                        // 编辑模式
                        <div style={{ padding: '12px 0' }}>
                          <div className="row" style={{ marginBottom: 12, alignItems: 'center' }}>
                            <strong style={{ fontSize: 15 }}>
                              第 {it.chapterNumber} 章 · 编辑细纲
                            </strong>
                          </div>
                          <div className="field">
                            <label>章节标题</label>
                            <input
                              className="input"
                              value={editDraft.title ?? ''}
                              onChange={(e) => setEditDraft({ ...editDraft, title: e.target.value })}
                              placeholder="章节标题"
                            />
                          </div>
                          <div className="field">
                            <label>核心事件</label>
                            <textarea
                              className="textarea"
                              value={editDraft.plotSummary ?? ''}
                              onChange={(e) => setEditDraft({ ...editDraft, plotSummary: e.target.value })}
                              rows={2}
                              placeholder="本章核心事件描述"
                            />
                          </div>
                          <div className="field">
                            <label>爽点/打脸</label>
                            <textarea
                              className="textarea"
                              value={editDraft.coolPoint ?? ''}
                              onChange={(e) => setEditDraft({ ...editDraft, coolPoint: e.target.value })}
                              rows={2}
                              placeholder="爽点或打脸情节"
                            />
                          </div>
                          <div className="field">
                            <label>角色出场（逗号分隔）</label>
                            <input
                              className="input"
                              value={(editDraft.charactersAppearing ?? []).join('，')}
                              onChange={(e) =>
                                setEditDraft({
                                  ...editDraft,
                                  charactersAppearing: e.target.value
                                    .split(/[,，]/)
                                    .map((s) => s.trim())
                                    .filter((s) => s)
                                })
                              }
                              placeholder="林凡，老王，..."
                            />
                          </div>
                          <div className="field">
                            <label>伏笔铺设（逗号分隔）</label>
                            <input
                              className="input"
                              value={(editDraft.foreshadowings ?? []).join('，')}
                              onChange={(e) =>
                                setEditDraft({
                                  ...editDraft,
                                  foreshadowings: e.target.value
                                    .split(/[,，]/)
                                    .map((s) => s.trim())
                                    .filter((s) => s)
                                })
                              }
                              placeholder="神秘盒子，符文，..."
                            />
                          </div>
                          <div className="field">
                            <label>章末钩子</label>
                            <textarea
                              className="textarea"
                              value={editDraft.hook ?? ''}
                              onChange={(e) => setEditDraft({ ...editDraft, hook: e.target.value })}
                              rows={2}
                              placeholder="章节结尾的悬念"
                            />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                            <div className="field">
                              <label>字数预估</label>
                              <input
                                className="input"
                                value={editDraft.wordEstimate ?? ''}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, wordEstimate: e.target.value })
                                }
                                placeholder="2500"
                              />
                            </div>
                            <div className="field">
                              <label>情绪值（1-10）</label>
                              <input
                                className="input"
                                type="number"
                                min={1}
                                max={10}
                                value={editDraft.emotion ?? ''}
                                onChange={(e) =>
                                  setEditDraft({
                                    ...editDraft,
                                    emotion: e.target.value ? Number(e.target.value) : undefined
                                  })
                                }
                                placeholder="5"
                              />
                            </div>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                            <div className="field">
                              <label>爽点类型</label>
                              <select
                                className="input"
                                value={editDraft.climax ?? ''}
                                onChange={(e) =>
                                  setEditDraft({
                                    ...editDraft,
                                    climax: e.target.value ? Number(e.target.value) : undefined
                                  })
                                }
                              >
                                <option value="">未设置</option>
                                <option value="0">0 - 无爽点</option>
                                <option value="1">1 - 小打脸</option>
                                <option value="2">2 - 中打脸</option>
                                <option value="3">3 - 大高潮</option>
                                <option value="3.5">3.5 - 卷中决战</option>
                                <option value="4">4 - 卷终决战</option>
                              </select>
                            </div>
                            <div className="field">
                              <label>金句</label>
                              <input
                                className="input"
                                value={editDraft.goldenLine ?? ''}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, goldenLine: e.target.value })
                                }
                                placeholder="本章金句"
                              />
                            </div>
                          </div>
                          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={cancelEditDetailed}
                              disabled={savingEdit}
                            >
                              取消
                            </button>
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={saveEditDetailed}
                              disabled={savingEdit}
                            >
                              {savingEdit ? '保存中…' : '保存'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        // 查看模式
                        <div className="outline-item">
                          <div className="num">{String(it.chapterNumber).padStart(3, '0')}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="row" style={{ marginBottom: 6, alignItems: 'baseline' }}>
                              <strong
                                style={{
                                  fontSize: 15,
                                  cursor: onOpenChapter ? 'pointer' : 'default',
                                  color: onOpenChapter ? 'var(--accent)' : 'var(--ink)'
                                }}
                                onClick={() => onOpenChapter?.(it.chapterNumber)}
                              >
                                {title}
                              </strong>
                              {it.volume ? (
                                <span className="outline-tag" style={{ marginLeft: 4 }}>
                                  第 {it.volume} 卷
                                </span>
                              ) : null}
                              <button
                                className="btn btn-ghost btn-sm"
                                style={{ marginLeft: 'auto', padding: '2px 8px' }}
                                onClick={() => startEditDetailed(it)}
                              >
                                编辑
                              </button>
                            </div>
                            <div className="outline-detail-fields">
                              {rows.map((row) => (
                                <OutlineDetailField key={row.label} row={row} />
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>

              {renderDetailedPager()}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function OutlineDetailField({ row }: { row: OutlineDetailRow }) {
  return (
    <section className="outline-detail-field">
      <div className="outline-detail-label">{row.label}</div>
      {row.value ? <div className="outline-detail-value">{row.value}</div> : null}
      {row.items && row.items.length > 0 ? (
        <ul className="outline-detail-list">
          {row.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
