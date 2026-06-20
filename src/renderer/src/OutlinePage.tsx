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
                  return (
                    <li key={it.chapterNumber} className="card">
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
                          </div>
                          <div className="outline-detail-fields">
                            {rows.map((row) => (
                              <OutlineDetailField key={row.label} row={row} />
                            ))}
                          </div>
                        </div>
                      </div>
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
