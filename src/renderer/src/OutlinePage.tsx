import { useEffect, useMemo, useState } from 'react'
import MarkdownView from './MarkdownView'
import type { MainOutline, DetailedOutlineItem, ChapterMeta } from '../../shared/types'

interface Props {
  projectId: string
  onBack?: () => void
  onOpenChapter?: (n: number) => void
}

const CLIMAX_LABEL = ['无爽点', '小打脸', '中打脸', '大高潮', '卷中决战', '卷终决战']
function climaxIdx(c: number | undefined): number {
  if (c == null) return 0
  if (c >= 4) return 5
  if (c >= 3.25) return 4
  if (c >= 3) return 3
  if (c >= 2) return 2
  if (c >= 1) return 1
  return 0
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

      {/* Tab 切换 */}
      <div className="tab-bar">
        <button
          className={`tab-btn ${tab === 'main' ? 'active' : ''}`}
          onClick={() => setTab('main')}
        >
          大纲总纲
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
          {/* 概要编辑（折叠） */}
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
                  placeholder="复仇 / 救赎 / 成长…"
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
                <label>主线概要（写入大纲.md 主线剧情走向 引言段）</label>
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
                <button
                  className="btn btn-primary btn-sm"
                  onClick={saveMain}
                  disabled={savingMain}
                >
                  {savingMain ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          ) : null}

          {/* 大纲全文（结构化渲染） */}
          <div className="card">
            <div className="row" style={{ marginBottom: 12, alignItems: 'center' }}>
              <strong style={{ fontSize: 16 }}>大纲全文</strong>
              <span className="meta" style={{ marginLeft: 'auto' }}>
                {sections.length} 节 · 逐章节奏标注见「节奏图谱」
              </span>
              {main && !editingMain ? (
                <button className="btn btn-sm btn-ghost" onClick={startEditMain}>
                  ✎ 编辑概要
                </button>
              ) : null}
            </div>
            {sections.length === 0 ? (
              <div className="placeholder" style={{ padding: 16 }}>
                <p style={{ margin: '0 0 10px' }}>尚无大纲内容</p>
                <button className="btn btn-primary btn-sm" onClick={genMain} disabled={loadingMain}>
                  {loadingMain ? '运笔中…' : '✦ AI 生成总纲'}
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
              <p>先在「章节」页创建章节，再为每章生成细纲。</p>
            </div>
          ) : sortedItems.length === 0 ? (
            <div className="placeholder">
              <p>尚无细纲。用「小说立项」技能生成 细纲/第NN卷.md 后此处自动展示。</p>
            </div>
          ) : (
            <ul className="bare">
              {sortedItems.map((it) => {
                const title = chapterTitleOf(it.chapterNumber)
                const cIdx = climaxIdx(it.climax)
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
                        {it.plotSummary ? (
                          <pre className="body" style={{ whiteSpace: 'pre-wrap' }}>
                            {it.plotSummary}
                          </pre>
                        ) : null}
                        {it.coolPoint ? (
                          <p className="meta" style={{ marginTop: 6 }}>
                            <span className="label">爽点</span> · {it.coolPoint}
                          </p>
                        ) : null}

                        {(it.emotion != null || it.climax != null) ? (
                          <div className="outline-tags" style={{ marginTop: 8 }}>
                            {it.emotion != null ? (
                              <span className="outline-tag emotion">情绪 · {it.emotion}</span>
                            ) : null}
                            {it.climax != null ? (
                              <span className="outline-tag cool">
                                {CLIMAX_LABEL[cIdx]} · {it.climax}
                              </span>
                            ) : null}
                            {it.hook ? (
                              <span className="outline-tag hook">钩子 · {it.hook}</span>
                            ) : null}
                          </div>
                        ) : (it.emotionPoint || it.coolPoint || it.hook) ? (
                          <div className="outline-tags" style={{ marginTop: 8 }}>
                            {it.emotionPoint ? (
                              <span className="outline-tag emotion">情绪 · {it.emotionPoint}</span>
                            ) : null}
                            {it.coolPoint ? (
                              <span className="outline-tag cool">爽点 · {it.coolPoint}</span>
                            ) : null}
                            {it.hook ? (
                              <span className="outline-tag hook">钩子 · {it.hook}</span>
                            ) : null}
                          </div>
                        ) : null}

                        {it.charactersAppearing && it.charactersAppearing.length > 0 ? (
                          <div className="outline-tags" style={{ marginTop: 8 }}>
                            <span className="outline-tag">角色出场</span>
                            {it.charactersAppearing.map((ca, i) => (
                              <span key={i} className="outline-tag">
                                {ca}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {it.foreshadowings && it.foreshadowings.length > 0 ? (
                          <div className="outline-tags" style={{ marginTop: 6 }}>
                            <span className="outline-tag">伏笔</span>
                            {it.foreshadowings.map((fz, i) => (
                              <span key={i} className="outline-tag">
                                {fz}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {it.goldenLine ? (
                          <p
                            className="meta"
                            style={{
                              marginTop: 8,
                              fontStyle: 'italic',
                              color: 'var(--accent)',
                              borderLeft: '3px solid var(--accent)',
                              paddingLeft: 10
                            }}
                          >
                            {it.goldenLine}
                          </p>
                        ) : null}
                        {it.wordEstimate ? (
                          <p className="meta" style={{ marginTop: 6 }}>
                            字数 · {it.wordEstimate}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
