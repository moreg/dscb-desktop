import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChapterContent,
  ChapterVersion,
  ChapterSource,
  ChapterStatus,
  Character,
  Foreshadowing,
  MemoryEntity
} from '../../shared/types'
import { analyze, rhythmWarnings, type ChapterStats } from './analyze'
import type { DetailedOutlineItem } from '../../shared/types'

interface Props {
  projectId: string
  chapterNumber: number
  onBack: () => void
  onOpenOutline?: () => void
}

const SOURCE_LABEL: Record<ChapterSource, string> = {
  manual: '手写',
  ai: 'AI',
  reviewed: '润色'
}

interface ReviewSuggestion {
  quote: string
  advice: string
  why: string
}

interface CastSuggestion {
  name: string
  reason: string
  quote: string
  /** 是否已加入登场 */
  applied: boolean
  /** 匹配到的人物 id；undefined 表示未在人物库中 */
  characterId?: string
}

/** 把 LLM 流式输出的"原文 → 建议 → 理由"格式解析成结构化建议 */
function parseSuggestions(text: string): ReviewSuggestion[] {
  // 按空行分段；每段查找 原文/建议/理由 标签
  const blocks = text.split(/\n{2,}/)
  const out: ReviewSuggestion[] = []
  for (const b of blocks) {
    if (!b.trim()) continue
    const find = (label: string) => {
      const re = new RegExp(`[【\\[\\]】]?\\s*${label}\\s*[：:]\\s*([\\s\\S]*?)(?=\\n[【\\[\\]】]?\\s*(?:原文|建议|理由)|$)`)
      const m = b.match(re)
      return m ? m[1].trim() : ''
    }
    const quote = find('原文')
    const advice = find('建议')
    const why = find('理由')
    if (advice || quote) {
      out.push({ quote, advice, why })
    } else {
      // 没标签时整段作为建议
      out.push({ quote: '', advice: b.trim(), why: '' })
    }
  }
  return out
}

export default function ChapterEditor({ projectId, chapterNumber, onBack, onOpenOutline }: Props) {
  const [data, setData] = useState<ChapterContent | null>(null)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [versions, setVersions] = useState<ChapterVersion[]>([])
  const [showVersions, setShowVersions] = useState(false)
  const [savingVersion, setSavingVersion] = useState(false)
  const [viewing, setViewing] = useState<ChapterVersion | null>(null)
  const [generating, setGenerating] = useState(false)
  const [characters, setCharacters] = useState<Character[]>([])
  const [showCast, setShowCast] = useState(false)
  const [savingCast, setSavingCast] = useState(false)
  const [showVersionDialog, setShowVersionDialog] = useState(false)
  const [foreshadowings, setForeshadowings] = useState<Foreshadowing[]>([])
  const [locations, setLocations] = useState<MemoryEntity[]>([])
  const [showPreview, setShowPreview] = useState(false)
  const [chapterOutline, setChapterOutline] = useState<DetailedOutlineItem | null>(null)
  const [showChapterOutline, setShowChapterOutline] = useState(false)
  const [generatingOutline, setGeneratingOutline] = useState(false)
  const [pomoFocus, setPomoFocus] = useState(25)
  const [pomoBreak, setPomoBreak] = useState(5)
  const [pomoMode, setPomoMode] = useState<'focus' | 'break'>('focus')
  const [pomoSecs, setPomoSecs] = useState(25 * 60)
  const [pomoRunning, setPomoRunning] = useState(false)
  const [pomoSessions, setPomoSessions] = useState(0)
  const [dailyGoal, setDailyGoal] = useState(3000)
  const [sessionStartWords, setSessionStartWords] = useState(0)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [reviewText, setReviewText] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [castSuggestions, setCastSuggestions] = useState<CastSuggestion[]>([])
  const [castApplied, setCastApplied] = useState(false)
  const [showCastPanel, setShowCastPanel] = useState(false)
  const reviewRef = useRef(0)
  const castRef = useRef(0)
  const genRef = useRef(0)

function parseCastJson(text: string): Omit<CastSuggestion, 'applied' | 'characterId'>[] {
  // LLM 可能输出 ```json ... ``` 或多余文本；尝试提取首个 JSON 数组
  const m = text.match(/\[\s*[\s\S]*?\]\s*(?=$|[^\]]*$)/)
  const candidate = m ? m[0] : text
  try {
    const arr = JSON.parse(candidate)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((x) => x && typeof x === 'object' && typeof x.name === 'string')
      .map((x) => ({
        name: String(x.name).trim(),
        reason: typeof x.reason === 'string' ? x.reason.trim() : '',
        quote: typeof x.quote === 'string' ? x.quote.trim() : ''
      }))
      .filter((x) => x.name)
  } catch {
    return []
  }
}

  const refreshVersions = () => {
    void window.api.listChapterVersions(projectId, chapterNumber).then(setVersions)
  }
  const refreshCharacters = () => {
    void window.api.listCharacters(projectId).then(setCharacters)
  }
  const refreshMemory = () => {
    void window.api.listForeshadowings(projectId).then(setForeshadowings)
    void window.api.listMemoryEntities(projectId, 'location').then(setLocations)
  }

  const refreshChapterOutline = () => {
    void window.api.listDetailedOutline(projectId).then((items) => {
      setChapterOutline(items.find((it) => it.chapterNumber === chapterNumber) ?? null)
    })
  }

  useEffect(() => {
    ++genRef.current
    setGenerating(false)
    void window.api.getChapter(projectId, chapterNumber).then((c) => {
      setData(c)
      setDraft(c.content)
      setDirty(false)
      setSessionStartWords(c.meta.wordCount)
    })
    refreshVersions()
    refreshCharacters()
    refreshMemory()
    refreshChapterOutline()
  }, [projectId, chapterNumber])

  // 加载番茄钟配置 + 每日目标
  useEffect(() => {
    void window.api.getPomodoroConfig().then((cfg) => {
      setPomoFocus(cfg.focus)
      setPomoBreak(cfg.brk)
      setPomoSecs(cfg.focus * 60)
    })
    void window.api.getDailyWordGoal().then(setDailyGoal)
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const meta = await window.api.updateChapterContent(projectId, chapterNumber, draft)
      setData({ meta, content: draft })
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const saveAsVersion = async () => setShowVersionDialog(true)

  const submitVersion = async (source: ChapterSource, note: string) => {
    setSavingVersion(true)
    setShowVersionDialog(false)
    try {
      await window.api.createChapterVersion(projectId, chapterNumber, {
        source,
        content: draft,
        note: note.trim() || undefined
      })
      refreshVersions()
    } finally {
      setSavingVersion(false)
    }
  }

  const aiGenerate = async () => {
    if (!(await window.api.hasLlmKey())) {
      window.alert('请先在「⚙ 设置 → 模型服务」中配置 provider')
      return
    }
    setGenerating(true)
    setDraft('')
    const myGen = ++genRef.current
    try {
      const result = await window.api.generateChapterStream(
        projectId,
        chapterNumber,
        (token, done) => {
          if (genRef.current !== myGen) return
          if (token) setDraft((d) => d + token)
          if (done) setGenerating(false)
        }
      )
      if (genRef.current !== myGen) return
      if (!result.ok) {
        setGenerating(false)
        const msg =
          result.error === 'LLM_AUTH_FAILED'
            ? '认证失败，请检查 API Key'
            : result.error === 'LLM_RATE_LIMIT'
              ? '请求过于频繁，请稍后再试'
              : '生成失败，请重试'
        window.alert(msg)
        return
      }
      setDirty(true)
    } catch {
      if (genRef.current === myGen) setGenerating(false)
    }
  }

  const startReview = async () => {
    if (!(await window.api.hasLlmKey())) {
      window.alert('请先在「⚙ 设置 → 模型服务」中配置 provider')
      return
    }
    setReviewOpen(true)
    setReviewing(true)
    setReviewText('')
    const myReview = ++reviewRef.current
    try {
      const result = await window.api.reviewChapterStream(
        projectId,
        chapterNumber,
        (token, done) => {
          if (reviewRef.current !== myReview) return
          if (token) setReviewText((t) => t + token)
          if (done) setReviewing(false)
        }
      )
      if (reviewRef.current !== myReview) return
      if (!result.ok) {
        setReviewing(false)
        setReviewText(
          (t) =>
            t +
            (result.error === 'LLM_AUTH_FAILED'
              ? '\n\n⚠ 认证失败，请检查 API Key'
              : '\n\n⚠ 生成失败：' + (result.error ?? '未知错误'))
        )
      }
    } catch {
      if (reviewRef.current === myReview) setReviewing(false)
    }
  }

  const startDetectCast = async () => {
    if (!(await window.api.hasLlmKey())) {
      window.alert('请先在「⚙ 设置 → 模型服务」中配置 provider')
      return
    }
    setShowCastPanel(true)
    setDetecting(true)
    setCastSuggestions([])
    setCastApplied(false)
    const myCast = ++castRef.current
    let buffer = ''
    try {
      const result = await window.api.detectCastStream(
        projectId,
        chapterNumber,
        (token, done) => {
          if (castRef.current !== myCast) return
          if (token) buffer += token
          if (done) setDetecting(false)
        }
      )
      if (castRef.current !== myCast) return
      if (!result.ok) {
        setDetecting(false)
        window.alert('识别失败：' + (result.error ?? '未知错误'))
        return
      }
      const parsed = parseCastJson(buffer)
      // 匹配人物库
      const merged: CastSuggestion[] = parsed.map((p) => {
        const found = characters.find((c) => c.name === p.name)
        return { ...p, applied: false, characterId: found?.id }
      })
      setCastSuggestions(merged)
    } catch {
      if (castRef.current === myCast) setDetecting(false)
    }
  }

  const applyCastSuggestions = async () => {
    if (!data) return
    const matched = castSuggestions.filter((s) => s.characterId && !s.applied)
    if (matched.length === 0) return
    const ids = new Set(appearing)
    matched.forEach((s) => s.characterId && ids.add(s.characterId))
    setSavingCast(true)
    try {
      const meta = await window.api.updateChapterMeta(projectId, chapterNumber, {
        appearingCharacters: [...ids]
      })
      setData({ ...data, meta })
      setCastSuggestions((arr) =>
        arr.map((s) => (matched.find((m) => m.name === s.name) ? { ...s, applied: true } : s))
      )
      setCastApplied(true)
    } finally {
      setSavingCast(false)
    }
  }

  const rollback = async (v: ChapterVersion) => {
    if (!window.confirm(`回滚到版本 ${v.versionNumber}（${SOURCE_LABEL[v.source]}）？当前正文将被覆盖。`))
      return
    const meta = await window.api.rollbackChapter(projectId, chapterNumber, v.versionNumber)
    setDraft(v.content)
    setData({ meta, content: v.content })
    setDirty(false)
    setViewing(null)
  }

  const removeVersion = async (v: ChapterVersion) => {
    if (!window.confirm(`删除版本 ${v.versionNumber}？`)) return
    await window.api.deleteChapterVersion(projectId, chapterNumber, v.versionNumber)
    refreshVersions()
  }

  const appearing = data?.meta.appearingCharacters ?? []
  const appearingSet = useMemo(() => new Set(appearing), [appearing])

  const toggleCast = async (id: string) => {
    if (!data) return
    const next = appearingSet.has(id)
      ? appearing.filter((x) => x !== id)
      : [...appearing, id]
    setSavingCast(true)
    try {
      const meta = await window.api.updateChapterMeta(projectId, chapterNumber, {
        appearingCharacters: next
      })
      setData({ ...data, meta })
    } finally {
      setSavingCast(false)
    }
  }

  const cycleStatus = async () => {
    if (!data) return
    const order: ChapterStatus[] = ['outline', 'draft', 'reviewed', 'published']
    const idx = order.indexOf(data.meta.status)
    const next = order[(idx + 1) % order.length]
    const meta = await window.api.updateChapterMeta(projectId, chapterNumber, { status: next })
    setData({ ...data, meta })
  }

  // 番茄钟计时
  useEffect(() => {
    if (!pomoRunning) return
    const id = setInterval(() => {
      setPomoSecs((s) => {
        if (s > 1) return s - 1
        // 倒计时结束
        setPomoRunning(false)
        if (pomoMode === 'focus') {
          setPomoSessions((n) => n + 1)
          setPomoMode('break')
          return pomoBreak * 60
        } else {
          setPomoMode('focus')
          return pomoFocus * 60
        }
      })
    }, 1000)
    return () => clearInterval(id)
  }, [pomoRunning, pomoMode, pomoFocus, pomoBreak])

  const pomoToggle = () => setPomoRunning((r) => !r)
  const pomoReset = () => {
    setPomoRunning(false)
    setPomoMode('focus')
    setPomoSecs(pomoFocus * 60)
  }

  const generateThisChapterOutline = async () => {
    if (!(await window.api.hasLlmKey())) {
      window.alert('请先在「⚙ 设置 → 模型服务」中配置 provider')
      return
    }
    setGeneratingOutline(true)
    try {
      await window.api.generateDetailedOutline(projectId, chapterNumber)
      refreshChapterOutline()
    } finally {
      setGeneratingOutline(false)
    }
  }

  // 会话字数：当前字数 - 进入时字数
  const sessionWords = useMemo(() => {
    const cur = (draft.match(/\S/g) ?? []).length
    return Math.max(0, cur - sessionStartWords)
  }, [draft, sessionStartWords])

  // 联动高亮：构建 (text, kind) 序列
  const previewSegments = useMemo(() => {
    if (!showPreview) return null
    type Hit = { start: number; end: number; kind: 'char' | 'foreshadow' | 'location'; label: string }
    const hits: Hit[] = []
    const pushHits = (terms: string[], kind: Hit['kind'], label: string) => {
      for (const t of terms) {
        if (!t) continue
        let idx = 0
        while ((idx = draft.indexOf(t, idx)) >= 0) {
          hits.push({ start: idx, end: idx + t.length, kind, label })
          idx += t.length
        }
      }
    }
    pushHits(
      characters.map((c) => c.name),
      'char',
      '人物'
    )
    pushHints()
    function pushHints() {
      for (const f of foreshadowings) {
        if (f.content) {
          let idx = 0
          while ((idx = draft.indexOf(f.content, idx)) >= 0) {
            hits.push({ start: idx, end: idx + f.content.length, kind: 'foreshadow', label: '伏笔' })
            idx += f.content.length
          }
        }
      }
      for (const l of locations) {
        if (l.name) {
          let idx = 0
          while ((idx = draft.indexOf(l.name, idx)) >= 0) {
            hits.push({ start: idx, end: idx + l.name.length, kind: 'location', label: '地点' })
            idx += l.name.length
          }
        }
      }
    }
    // 合并重叠区间，保留 kind 优先级 char > foreshadow > location
    if (hits.length === 0) return []
    hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
    const merged: Hit[] = []
    for (const h of hits) {
      const last = merged[merged.length - 1]
      if (last && h.start < last.end) {
        // 重叠：跳过，避免嵌套
        continue
      }
      merged.push(h)
    }
    const out: { text: string; hl?: Hit }[] = []
    let cursor = 0
    for (const h of merged) {
      if (h.start > cursor) out.push({ text: draft.slice(cursor, h.start) })
      out.push({ text: draft.slice(h.start, h.end), hl: h })
      cursor = h.end
    }
    if (cursor < draft.length) out.push({ text: draft.slice(cursor) })
    return out
  }, [showPreview, draft, characters, foreshadowings, locations])

  const onPreviewClick = (kind: string, text: string) => {
    if (kind === 'char') {
      const c = characters.find((x) => x.name === text)
      if (c) window.alert(`人物 · ${c.name}\n身份：${c.identity ?? '—'}\n性格：${c.personality ?? '—'}`)
    } else if (kind === 'foreshadow') {
      const f = foreshadowings.find((x) => x.content === text)
      if (f) window.alert(`伏笔 · ${f.content}\n状态：${f.status}`)
    } else if (kind === 'location') {
      const l = locations.find((x) => x.name === text)
      if (l) window.alert(`地点 · ${l.name}\n分类：${l.category ?? '—'}`)
    }
  }

  const suggestions = useMemo(() => (reviewText ? parseSuggestions(reviewText) : []), [reviewText])

  if (!data) return <p className="empty">展卷中…</p>

  return (
    <div style={{ paddingRight: reviewOpen ? 396 : 0, transition: 'padding 0.2s' }}>
      <div className="row">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          ‹ 返回
        </button>
        <span className="meta">
          第 {data.meta.chapterNumber} 章 · {data.meta.title} · {data.meta.wordCount} 字 ·{' '}
          {versions.length} 版
        </span>
        <div className="btn-group">
          <span
            className={`chip ${
              data.meta.status === 'published'
                ? 'chip-success'
                : data.meta.status === 'reviewed'
                  ? 'chip-accent'
                  : ''
            }`}
            style={{ cursor: 'pointer' }}
            onClick={cycleStatus}
            title="点击切换状态"
          >
            {data.meta.status === 'outline'
              ? '纲'
              : data.meta.status === 'draft'
                ? '稿'
                : data.meta.status === 'reviewed'
                  ? '润'
                  : '定'}
            {' '}↻
          </span>
          <button className="btn btn-sm" onClick={save} disabled={!dirty || saving}>
            {saving ? '保存中…' : dirty ? '保存 ·' : '已存'}
          </button>
          <button className="btn btn-sm" onClick={saveAsVersion} disabled={savingVersion}>
            存版本
          </button>
          <button className="btn btn-sm" onClick={() => setShowVersions((s) => !s)}>
            {showVersions ? '收起' : '版本'}
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setShowPreview((s) => !s)}
            title="按人物/伏笔/地点高亮正文"
          >
            {showPreview ? '收起预览' : '👁 预览'}
          </button>
          <button className="btn btn-sm" onClick={startReview} disabled={reviewing}>
            {reviewing ? '审稿中…' : '✎ AI 改稿'}
          </button>
          <button className="btn btn-primary btn-sm" onClick={aiGenerate} disabled={generating}>
            {generating ? '落墨中…' : '✦ 续写'}
          </button>
        </div>
      </div>

      {/* 番茄钟 + 写作进度 */}
      <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
        <div className={`pomodoro ${pomoMode === 'break' ? 'break' : ''}`}>
          <span
            className={`dot ${pomoRunning ? 'running' : ''}`}
            title={pomoMode === 'focus' ? '专注中' : '休息中'}
          />
          <span className="muted" style={{ fontSize: 11 }}>
            {pomoMode === 'focus' ? '专注' : '休息'}
          </span>
          <span className="time">
            {String(Math.floor(pomoSecs / 60)).padStart(2, '0')}:
            {String(pomoSecs % 60).padStart(2, '0')}
          </span>
          <button onClick={pomoToggle} title={pomoRunning ? '暂停' : '开始'}>
            {pomoRunning ? '⏸' : '▶'}
          </button>
          <button onClick={pomoReset} title="重置">
            ↺
          </button>
          <span className="muted" style={{ fontSize: 11 }}>
            今日 {pomoSessions} 番
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div className="goal-row">
            <span>本次会话</span>
            <span className="num">+{sessionWords}</span>
            <span>字 · 每日目标</span>
            <span className="num">{dailyGoal.toLocaleString()}</span>
            <span>字</span>
          </div>
          <div className="goal-bar">
            <div
              className={`fill ${sessionWords >= dailyGoal ? 'done' : ''}`}
              style={{ width: `${Math.min(100, (sessionWords / Math.max(1, dailyGoal)) * 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* 本章细纲 */}
      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setShowChapterOutline((s) => !s)}
        >
          {showChapterOutline ? '收起本章细纲' : '📜 本章细纲'}
        </button>
        {onOpenOutline ? (
          <button className="btn btn-sm btn-ghost" onClick={onOpenOutline}>
            大纲页 →
          </button>
        ) : null}
      </div>
      {showChapterOutline ? (
        <div className="chapter-outline-panel">
          <div className="row" style={{ alignItems: 'baseline' }}>
            <strong style={{ fontSize: 13.5 }}>
              第 {chapterNumber} 章细纲
            </strong>
            <button
              className="btn btn-sm"
              onClick={generateThisChapterOutline}
              disabled={generatingOutline}
              style={{ marginLeft: 'auto' }}
            >
              {generatingOutline
                ? '运笔中…'
                : chapterOutline
                  ? '重新生成'
                  : '✦ 生成细纲'}
            </button>
          </div>
          {chapterOutline ? (
            <>
              <p className="body-text">{chapterOutline.plotSummary}</p>
              {(chapterOutline.emotionPoint ||
                chapterOutline.coolPoint ||
                chapterOutline.hook) ? (
                <div className="outline-tags" style={{ marginTop: 8 }}>
                  {chapterOutline.emotionPoint ? (
                    <span className="outline-tag emotion">情绪 · {chapterOutline.emotionPoint}</span>
                  ) : null}
                  {chapterOutline.coolPoint ? (
                    <span className="outline-tag cool">爽点 · {chapterOutline.coolPoint}</span>
                  ) : null}
                  {chapterOutline.hook ? (
                    <span className="outline-tag hook">钩子 · {chapterOutline.hook}</span>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <p className="missing">本章暂无细纲，点「生成细纲」让 AI 据总纲铺陈。</p>
          )}
        </div>
      ) : null}

      <textarea
        className="editor-text"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setDirty(true)
        }}
        placeholder="此处落笔，或点「续写」让 AI 接续成文……"
        style={{ marginTop: 16 }}
      />

      {showPreview ? (
        <>
          <div className="row" style={{ marginTop: 16, marginBottom: 4 }}>
            <strong style={{ fontSize: 13.5 }}>联动预览</strong>
            <div className="row" style={{ gap: 12, fontSize: 12, color: 'var(--ink-3)' }}>
              <span><span className="hl char" style={{ padding: '1px 4px' }}>人物</span></span>
              <span><span className="hl foreshadow" style={{ padding: '1px 4px' }}>伏笔</span></span>
              <span><span className="hl location" style={{ padding: '1px 4px' }}>地点</span></span>
            </div>
          </div>
          <div className="editor-preview">
            {previewSegments && previewSegments.length > 0 ? (
              previewSegments.map((seg, i) =>
                seg.hl ? (
                  <span
                    key={i}
                    className={`hl ${seg.hl.kind}`}
                    title={`${seg.hl.label} · ${seg.text}`}
                    onClick={() => onPreviewClick(seg.hl!.kind, seg.text)}
                  >
                    {seg.text}
                  </span>
                ) : (
                  <span key={i}>{seg.text}</span>
                )
              )
            ) : (
              <span className="muted">暂无可联动高亮的内容。</span>
            )}
          </div>
        </>
      ) : null}

      <div className="card" style={{ marginTop: 14, padding: 12 }}>
        <div className="row">
          <div>
            <strong style={{ fontSize: 13.5 }}>本章登场人物</strong>
            <span className="meta" style={{ marginLeft: 8 }}>
              {appearing.length} 位
              {savingCast ? ' · 保存中…' : ''}
            </span>
          </div>
          <div className="btn-group">
            <button
              className="btn btn-sm"
              onClick={startDetectCast}
              disabled={detecting}
              title="让 AI 扫描本章，自动列出出场人物"
            >
              {detecting ? '识别中…' : '🤖 AI 识别'}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => setShowCast((s) => !s)}
              disabled={characters.length === 0}
            >
              {showCast ? '收起' : '编辑登场'}
            </button>
          </div>
        </div>
        {appearing.length > 0 ? (
          <div className="outline-tags" style={{ marginTop: 8 }}>
            {appearing.map((id) => {
              const c = characters.find((x) => x.id === id)
              return (
                <span key={id} className="outline-tag emotion">
                  {c?.name ?? '（已删除）'}
                </span>
              )
            })}
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            暂未标记。点「编辑登场」勾选本章出场的人物。
          </p>
        )}
        {showCast ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              gap: 6,
              marginTop: 10
            }}
          >
            {characters.length === 0 ? (
              <p className="empty" style={{ padding: 4 }}>
                尚无人物
              </p>
            ) : (
              characters.map((c) => {
                const on = appearingSet.has(c.id)
                return (
                  <span
                    key={c.id}
                    className={`filter-chip ${on ? 'active' : ''}`}
                    onClick={() => toggleCast(c.id)}
                  >
                    {on ? '✓ ' : ''}
                    {c.name}
                    {c.role ? ` · ${c.role}` : ''}
                  </span>
                )
              })
            )}
          </div>
        ) : null}
      </div>

      {showCastPanel ? (
        <CastSuggestionPanel
          suggestions={castSuggestions}
          characters={characters}
          detecting={detecting}
          applied={castApplied}
          onApply={applyCastSuggestions}
          onClose={() => setShowCastPanel(false)}
        />
      ) : null}

      <AnalysisPanel text={draft} />

      {showVersions ? (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 className="sub">版本历史（{versions.length}）</h3>
          {versions.length === 0 ? (
            <p className="empty">尚无版本，点「存版本」留存。</p>
          ) : (
            <ul className="bare">
              {[...versions].reverse().map((v) => (
                <li
                  key={v.versionNumber}
                  className="row"
                  style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}
                >
                  <div>
                    <strong>#{v.versionNumber}</strong>{' '}
                    <span className={`chip chip-${sourceChip(v.source)}`}>
                      {SOURCE_LABEL[v.source]}
                    </span>{' '}
                    <span className="meta">
                      {v.wordCount} 字 · {v.createdAt.replace('T', ' ').slice(0, 16)}
                    </span>
                    {v.note ? <div className="muted">{v.note}</div> : null}
                  </div>
                  <div className="btn-group">
                    <button className="btn btn-sm" onClick={() => setViewing(v)}>
                      看
                    </button>
                    <button className="btn btn-sm" onClick={() => rollback(v)}>
                      回滚
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => removeVersion(v)}>
                      删
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {viewing ? (
        <div className="dialog-overlay" onClick={() => setViewing(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>
              版本 #{viewing.versionNumber} · {SOURCE_LABEL[viewing.source]} · {viewing.wordCount} 字
            </h3>
            <pre className="body">{viewing.content}</pre>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-ghost" onClick={() => setViewing(null)}>
                关闭
              </button>
              <button className="btn btn-primary" onClick={() => rollback(viewing)}>
                回滚到此版
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showVersionDialog ? (
        <VersionDialog
          onClose={() => setShowVersionDialog(false)}
          onSubmit={submitVersion}
        />
      ) : null}

      {reviewOpen ? (
        <ReviewPanel
          text={reviewText}
          streaming={reviewing}
          suggestions={suggestions}
          onClose={() => setReviewOpen(false)}
          onCopy={async () => {
            await navigator.clipboard.writeText(reviewText)
          }}
        />
      ) : null}
    </div>
  )
}

function ReviewPanel({
  text,
  streaming,
  suggestions,
  onClose,
  onCopy
}: {
  text: string
  streaming: boolean
  suggestions: ReviewSuggestion[]
  onClose: () => void
  onCopy: () => void | Promise<void>
}) {
  return (
    <aside className="review-panel">
      <header>
        <h3>AI 改稿建议</h3>
        <div className="btn-group">
          <button className="btn btn-sm" onClick={onCopy} disabled={!text}>
            复制
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            关闭
          </button>
        </div>
      </header>
      <div className="body-area">
        {suggestions.length === 0 && !streaming ? (
          <div className="review-empty">
            点击「✎ AI 改稿」后，建议会出现在这里。
          </div>
        ) : suggestions.length === 0 ? (
          <div className="review-empty review-streaming">审稿中…</div>
        ) : (
          <>
            {suggestions.map((s, i) => (
              <div key={i} className="review-suggestion">
                {s.quote ? <div className="quote">「{s.quote}」</div> : null}
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  建议 · {s.advice}
                </div>
                {s.why ? <div className="why">理由 · {s.why}</div> : null}
              </div>
            ))}
            {streaming ? (
              <div className="review-streaming muted" style={{ fontSize: 12 }}>
                ▍ 还在收尾…
              </div>
            ) : null}
          </>
        )}
      </div>
    </aside>
  )
}

function CastSuggestionPanel({
  suggestions,
  characters,
  detecting,
  applied,
  onApply,
  onClose
}: {
  suggestions: CastSuggestion[]
  characters: Character[]
  detecting: boolean
  applied: boolean
  onApply: () => void | Promise<void>
  onClose: () => void
}) {
  const matched = suggestions.filter((s) => s.characterId)
  const unmatched = suggestions.filter((s) => !s.characterId)
  const charById = new Map<string, Character>(characters.map((c) => [c.id, c]))
  return (
    <div className="card" style={{ marginTop: 14, padding: 14 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <strong style={{ fontSize: 14 }}>🤖 AI 识别结果</strong>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          关闭
        </button>
      </div>
      {detecting ? (
        <p className="muted" style={{ fontSize: 13 }}>
          正在让 AI 扫描本章出场人物…
        </p>
      ) : suggestions.length === 0 ? (
        <p className="empty" style={{ padding: 8 }}>
          AI 未识别到出场人物。
        </p>
      ) : (
        <>
          {unmatched.length > 0 ? (
            <div
              style={{
                background: 'var(--paper-soft)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--r-sm)',
                padding: 8,
                marginBottom: 10
              }}
            >
              <strong style={{ fontSize: 12.5, color: 'var(--warning)' }}>
                ⚠ {unmatched.length} 位未在人物库中
              </strong>
              <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                建议先到「人物」页补建：
                {unmatched.map((s) => s.name).join('、')}
              </p>
            </div>
          ) : null}
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="meta">
              共 {suggestions.length} 人 · {matched.length} 可一键应用
              {applied ? ' · 已应用' : ''}
            </span>
            <button
              className="btn btn-primary btn-sm"
              onClick={onApply}
              disabled={matched.length === 0 || matched.every((m) => m.applied)}
            >
              {matched.every((m) => m.applied) ? '已应用' : `应用 ${matched.length} 个到登场`}
            </button>
          </div>
          {suggestions.map((s, i) => (
            <div
              key={i}
              className={`cast-suggestion ${s.characterId ? 'known' : 'unknown'} ${
                s.applied ? 'applied' : ''
              }`}
            >
              <div className="row" style={{ alignItems: 'baseline' }}>
                <span className="name">
                  {s.name}
                  {s.applied ? <span className="chip chip-success" style={{ marginLeft: 8 }}>已加入</span> : null}
                </span>
                <span
                  className="meta"
                  style={{ marginLeft: 'auto', fontSize: 11.5 }}
                >
                  {s.characterId
                    ? charById.get(s.characterId)?.role ?? '人物库'
                    : '未在人物库'}
                </span>
              </div>
              {s.reason ? <div className="reason">{s.reason}</div> : null}
              {s.quote ? <div className="quote">「{s.quote}」</div> : null}
            </div>
          ))}
        </>
      )}
    </div>
  )
}

function AnalysisPanel({ text }: { text: string }) {
  const stats: ChapterStats = useMemo(() => analyze(text, 12), [text])
  const warnings = useMemo(() => rhythmWarnings(stats), [stats])
  return (
    <div className="card" style={{ marginTop: 14, padding: 14 }}>
      <div className="row" style={{ marginBottom: 4 }}>
        <strong style={{ fontSize: 14 }}>📊 章节分析</strong>
        <span className="meta">实时</span>
      </div>
      <div className="stats-grid">
        <div className="stat-cell">
          <div className="label">字数</div>
          <div className="val">{stats.wordCount.toLocaleString()}</div>
        </div>
        <div className="stat-cell">
          <div className="label">段落</div>
          <div className="val">{stats.paragraphCount}</div>
        </div>
        <div className="stat-cell">
          <div className="label">句数</div>
          <div className="val">{stats.sentenceCount}</div>
        </div>
        <div className="stat-cell">
          <div className="label">平均句长</div>
          <div className="val">{stats.avgSentenceLen}</div>
          <div className="sub">字/句</div>
        </div>
        <div className="stat-cell">
          <div className="label">对话占比</div>
          <div className="val">{Math.round(stats.dialogueRatio * 100)}%</div>
          <div className="sub">「」/"" 字符</div>
        </div>
        <div className="stat-cell">
          <div className="label">虚词占比</div>
          <div className="val">{Math.round(stats.fillerRatio * 100)}%</div>
          <div className="sub">的/了/着…</div>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <div className="row" style={{ marginBottom: 4 }}>
          <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>情绪曲线</span>
          <span className="meta" style={{ fontSize: 11 }}>
            消极 ← 积极
          </span>
        </div>
        <div className="emotion-curve" title="按章分段估算的极性">
          {stats.emotionCurve.map((v, i) => {
            const maxAbs = 100
            const halfH = 32 // 上下各 32px
            const intensity = Math.min(1, Math.abs(v) / maxAbs)
            const h = Math.max(2, intensity * halfH)
            const positive = v >= 0
            return (
              <div
                key={i}
                className={`emotion-bar ${v > 5 ? 'positive' : v < -5 ? 'negative' : 'neutral'}`}
                style={{
                  height: positive ? `${h}px` : `${h}px`,
                  marginTop: positive ? `${halfH - h}px` : '32px',
                  alignSelf: positive ? 'flex-end' : 'flex-start'
                }}
              />
            )
          })}
        </div>
        <div className="emotion-axis">
          <span>开头</span>
          <span>中段</span>
          <span>结尾</span>
        </div>
      </div>
      {warnings.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          {warnings.map((w, i) => (
            <span key={i} className={`warning-pill level-${w.level}`}>
              {w.level === 2 ? '⚠ ' : '· '}
              {w.msg}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function VersionDialog({
  onClose,
  onSubmit
}: {
  onClose: () => void
  onSubmit: (source: ChapterSource, note: string) => Promise<void>
}) {
  const [source, setSource] = useState<ChapterSource>('manual')
  const [note, setNote] = useState('')
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>保存为版本</h3>
        <div className="field">
          <label>来源</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['manual', 'ai', 'reviewed'] as ChapterSource[]).map((s) => (
              <span
                key={s}
                className={`filter-chip ${source === s ? 'active' : ''}`}
                onClick={() => setSource(s)}
              >
                {SOURCE_LABEL[s]}
              </span>
            ))}
          </div>
        </div>
        <div className="field">
          <label>备注（可留空）</label>
          <textarea
            className="textarea"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="如：第一稿 / 重大修订 / AI 续写后润色"
          />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => onSubmit(source, note)}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

function sourceChip(s: ChapterSource): string {
  if (s === 'ai') return 'accent'
  if (s === 'reviewed') return 'success'
  return ''
}
