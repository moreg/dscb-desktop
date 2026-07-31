import { useEffect, useMemo, useRef, useState } from 'react'
import type { DetailedOutlineItem, MainOutline, ProjectData, ProjectMeta } from '../../shared/types'
import { buildProjectInspirationPrompt, parseProjectInspiration } from './project-inspiration'

interface DrawResult {
  id: number
  name: string
  description: string
  seed: string
}

const TITLE_ANGLES = ['强悬念', '身份反差', '核心能力', '命运倒计时', '宏大意象', '人物关系', '终极目标']
const COPY_TONES = ['热血燃感', '冷峻克制', '诡谲神秘', '轻松爽快', '史诗厚重', '现实锋利', '浪漫宿命']
const HOOK_FOCUS = ['突出开局钩子', '突出主角困境', '突出独特设定', '突出升级爽点', '突出终局悬念', '突出情感冲突']

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

function nextSeed(previous?: string): string {
  let seed = ''
  for (let i = 0; i < 8; i++) {
    seed = `${pick(TITLE_ANGLES)} × ${pick(COPY_TONES)} × ${pick(HOOK_FOCUS)}`
    if (seed !== previous) break
  }
  return seed
}

function detailedPlotContext(items: DetailedOutlineItem[]): string {
  return items
    .filter((item) => item.plotSummary?.trim())
    .slice(0, 16)
    .map((item) => `第${item.chapterNumber}章：${item.plotSummary!.trim()}`)
    .join('\n')
    .slice(0, 5000)
}

export default function ProjectInspirationPage() {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [projectId, setProjectId] = useState('')
  const [project, setProject] = useState<ProjectData | null>(null)
  const [outline, setOutline] = useState<MainOutline | null>(null)
  const [plots, setPlots] = useState('')
  const [proseExcerpt, setProseExcerpt] = useState('')
  const [extraDirection, setExtraDirection] = useState('')
  const [loadingProject, setLoadingProject] = useState(true)
  const [drawing, setDrawing] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<DrawResult[]>([])
  const [copyId, setCopyId] = useState<number | null>(null)
  const [savingResultId, setSavingResultId] = useState<number | null>(null)
  const [savedResultId, setSavedResultId] = useState<number | null>(null)
  const generationRef = useRef(0)
  const handleRef = useRef<{ abort: () => Promise<unknown> } | null>(null)

  useEffect(() => {
    void window.api
      .listProjects()
      .then((list) => {
        setProjects(list)
        setProjectId((current) => current || list[0]?.id || '')
      })
      .finally(() => setLoadingProject(false))
  }, [])

  useEffect(() => {
    if (!projectId) {
      setProject(null)
      setOutline(null)
      setPlots('')
      setProseExcerpt('')
      return
    }
    let cancelled = false
    setLoadingProject(true)
    setError('')
    void Promise.all([
      window.api.getProject(projectId),
      window.api.getMainOutline(projectId).catch(() => null),
      window.api.listDetailedOutline(projectId).catch(() => []),
      window.api.listChapters(projectId).catch(() => [])
    ])
      .then(async ([nextProject, nextOutline, details, chapters]) => {
        const sampleNumbers = [...new Set([
          chapters[0]?.chapterNumber,
          chapters.at(-1)?.chapterNumber
        ].filter((value): value is number => typeof value === 'number'))]
        const samples = await Promise.all(
          sampleNumbers.map((chapterNumber) =>
            window.api.getChapter(projectId, chapterNumber).catch(() => null)
          )
        )
        if (cancelled) return
        setProject(nextProject)
        setOutline(nextOutline)
        setPlots(detailedPlotContext(details))
        setProseExcerpt(
          samples
            .filter((chapter): chapter is NonNullable<typeof chapter> => chapter !== null)
            .map((chapter) => `第${chapter.meta.chapterNumber}章 ${chapter.meta.title}\n${chapter.content.slice(0, 2200)}`)
            .join('\n\n')
            .slice(0, 5000)
        )
        setResults([])
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoadingProject(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  useEffect(() => {
    return () => {
      generationRef.current += 1
      void handleRef.current?.abort().catch(() => undefined)
    }
  }, [])

  const stopDrawing = () => {
    generationRef.current += 1
    const handle = handleRef.current
    handleRef.current = null
    void handle?.abort().catch(() => undefined)
    setDrawing(false)
  }

  const draw = async () => {
    if (drawing) {
      stopDrawing()
      return
    }
    if (!project) {
      setError('请先选择一本书')
      return
    }

    const generation = ++generationRef.current
    const seed = nextSeed(results[0]?.seed)
    setDrawing(true)
    setError('')
    try {
      if (!(await window.api.hasLlmKey())) {
        throw new Error('请先在“设置 → 模型服务”中配置 AI 模型')
      }
      if (generationRef.current !== generation) return

      let raw = ''
      const handle = window.api.generateStream(
        buildProjectInspirationPrompt({
          projectName: project.name,
          genre: project.genre,
          description: project.description,
          synopsis: outline?.synopsis,
          theme: outline?.theme,
          mainLine: outline?.mainLine,
          detailedPlots: plots,
          proseExcerpt,
          extraDirection,
          variationSeed: seed,
          excludedNames: results.map((item) => item.name)
        }),
        (token) => {
          if (generationRef.current === generation && token) raw += token
        }
      )
      handleRef.current = handle
      const response = await handle
      if (generationRef.current !== generation) return
      if (!response.ok) throw new Error(response.error || '生成失败，请重试')

      const generated = parseProjectInspiration(raw)
      setResults((current) => [
        { id: Date.now(), ...generated, seed },
        ...current
      ].slice(0, 12))
    } catch (err) {
      if (generationRef.current !== generation) return
      const message = err instanceof Error ? err.message : String(err)
      if (!message.includes('LLM_ABORTED')) setError(message)
    } finally {
      if (generationRef.current === generation) {
        handleRef.current = null
        setDrawing(false)
      }
    }
  }

  const copyResult = async (result: DrawResult) => {
    try {
      await navigator.clipboard.writeText(`《${result.name}》\n\n${result.description}`)
      setCopyId(result.id)
      window.setTimeout(() => setCopyId((current) => current === result.id ? null : current), 1500)
    } catch {
      setError('复制失败，请手动选择文字复制')
    }
  }

  const saveResultToProject = async (result: DrawResult) => {
    if (!projectId) return
    setSavingResultId(result.id)
    setSavedResultId(null)
    setError('')
    try {
      const updated = await window.api.updateProjectInfo(projectId, {
        name: result.name,
        description: result.description
      })
      setProject(updated)
      setProjects((current) =>
        current.map((item) =>
          item.id === projectId
            ? { ...item, name: updated.name, description: updated.description }
            : item
        )
      )
      setSavedResultId(result.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingResultId(null)
    }
  }

  const latest = results[0]
  const sourceSummary = useMemo(() => {
    if (!project) return '尚未选择书籍'
    const sources = [project.description, outline?.synopsis, outline?.mainLine, plots, proseExcerpt].filter(Boolean)
    return sources.length >= 4 ? '简介、大纲、细纲与正文' : sources.length > 0 ? '已有项目信息' : '仅题材和当前书名'
  }, [outline, plots, project, proseExcerpt])

  return (
    <div className="inspiration-page">
      <div className="page-head">
        <h1>灵感抽签</h1>
        <p className="desc">从书里的真实内容出发，每次抽一个不同的书名与简介包装方案。</p>
      </div>

      <div className="inspiration-layout">
        <section className="inspiration-controls">
          <div className="field">
            <label>选择书籍</label>
            <select
              className="select"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              disabled={loadingProject || drawing}
            >
              {projects.length === 0 ? <option value="">暂无项目</option> : null}
              {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <div className="inspiration-source-note">
            <span>取材范围</span>
            <strong>{loadingProject ? '正在读取…' : sourceSummary}</strong>
          </div>
          <div className="field">
            <label>额外方向（可选）</label>
            <textarea
              className="textarea"
              rows={4}
              value={extraDirection}
              onChange={(event) => setExtraDirection(event.target.value)}
              placeholder="例如：书名更短、突出悬疑感、简介偏番茄风格……"
              disabled={drawing}
            />
          </div>
          <button
            type="button"
            className={`btn inspiration-draw-btn ${drawing ? 'btn-ghost' : 'btn-primary'}`}
            onClick={() => void draw()}
            disabled={loadingProject || !projectId}
          >
            {drawing ? '■ 停止抽取' : results.length ? '🎲 再抽一个' : '🎲 抽一个方案'}
          </button>
          <p className="meta">连续抽取会更换包装角度，并避开已经抽到的书名。</p>
          {error ? <div className="inspiration-error" role="alert">{error}</div> : null}
        </section>

        <section className={`inspiration-stage ${drawing ? 'is-drawing' : ''}`}>
          {latest ? (
            <article className="inspiration-result-card">
              <div className="inspiration-result-topline">
                <span>第 {results.length} 签</span>
                <span>{latest.seed}</span>
              </div>
              <h2>《{latest.name}》</h2>
              <p>{latest.description}</p>
              <div className="inspiration-result-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => void copyResult(latest)}>
                  {copyId === latest.id ? '✓ 已复制' : '复制书名与简介'}
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => void saveResultToProject(latest)}
                  disabled={savingResultId !== null}
                >
                  {savingResultId === latest.id
                    ? '保存中…'
                    : savedResultId === latest.id
                      ? '✓ 已保存到项目'
                      : '保存为项目书名与简介'}
                </button>
              </div>
            </article>
          ) : (
            <div className="inspiration-empty">
              <div className="inspiration-lottery" aria-hidden>签</div>
              <h2>{drawing ? '正在摇签…' : '签筒还空着'}</h2>
              <p>{drawing ? 'AI 正在从大纲中寻找新的包装角度' : '选好书后，抽取第一组书名与简介'}</p>
            </div>
          )}
        </section>
      </div>

      {results.length > 1 ? (
        <section className="inspiration-history">
          <h2>本次抽签记录</h2>
          <div className="inspiration-history-grid">
            {results.slice(1).map((item, index) => (
              <article key={item.id} className="inspiration-history-card">
                <span>第 {results.length - index - 1} 签 · {item.seed}</span>
                <h3>《{item.name}》</h3>
                <p>{item.description}</p>
                <div className="inspiration-result-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => void copyResult(item)}>
                    {copyId === item.id ? '✓ 已复制' : '复制'}
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void saveResultToProject(item)}
                    disabled={savingResultId !== null}
                  >
                    {savingResultId === item.id
                      ? '保存中…'
                      : savedResultId === item.id
                        ? '✓ 已保存'
                        : '保存到项目'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
