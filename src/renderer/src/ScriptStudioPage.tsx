import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  AdaptStrength,
  BasedOn,
  GateIssue,
  GenerateStudioScriptResult,
  GenerateStudioStoryboardResult,
  GenerationRun,
  PaceTier,
  PromptPackage,
  QualityReport,
  ScriptFormat,
  ScriptProject,
  ScriptProjectSummary,
  ScriptSettings,
  ShotField,
  SourceKind,
  SourceRange,
  SourceSelectionHint,
  StoryboardUnit
} from '../../shared/script-studio'
// 按值导入纯校验器：该模块不含 zod / Node 依赖，不会污染前端 bundle。
import { storyboardHardIssues } from '../../shared/script-studio-gate'
import { PACE_LABELS, rhythmProfile } from '../../shared/script-studio-planning'
import { isWebClient } from './web-download'
import ScriptStoryboardWorkspace from './ScriptStoryboardWorkspace'
import './script-studio.css'

// 渲染层只 import type 共享契约；以下常量是共享常量的本地镜像（顺序一致性由纯测试保证），
// 避免把 zod / 校验逻辑打进前端 bundle。
const SHOT_FIELDS: readonly ShotField[] = [
  'focalLength', 'aperture', 'depthOfFieldAndFocusLock', 'cameraPosition', 'composition',
  'cameraMovement', 'subjectActionExpression', 'dialogueAndTone', 'lighting', 'constraints',
  'nextTransition'
]
const SHOT_LABELS: Record<ShotField, string> = {
  focalLength: '焦段',
  aperture: '光圈',
  depthOfFieldAndFocusLock: '景深与焦点锁定',
  cameraPosition: '机位',
  composition: '构图',
  cameraMovement: '运镜',
  subjectActionExpression: '主体动作与表情',
  dialogueAndTone: '台词与语气',
  lighting: '光影',
  constraints: '限制',
  nextTransition: '衔接'
}
const SOURCE_MAX_CHARS = 24_000
const PROMPT_HARD_LIMIT = 2000
const MAX_LONG_CHAPTERS = 5

/** 合并「当前 units 实时硬阻断」与后端完整质量报告，按问题标识去重。 */
function mergeHardIssues(live: GateIssue[], generated: GateIssue[]): GateIssue[] {
  const seen = new Set<string>()
  return [...live, ...generated].filter(item => {
    const key = `${item.code}|${item.unitId ?? ''}|${item.field ?? ''}|${item.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const DEFAULT_SETTINGS: ScriptSettings = {
  format: 'short',
  platform: '抖音',
  aspectRatio: '9:16',
  targetDurationSec: 90,
  visualStyle: '暂定',
  adaptStrength: 'medium',
  paceTier: 'short-high',
  paceMode: 'auto',
  promptMode: 'auto',
  resolution: '1080p',
  extraRequirements: ''
}

type RunPhase = 'ready' | 'generating' | 'stopping' | 'failed' | 'interrupted' | 'done'
type ActiveHandle = { requestId: string; abort: () => Promise<{ ok: boolean }> }

interface RunState {
  phase: RunPhase
  kind: 'script' | 'storyboard' | null
  error: string
  retainedText: string
  activeUnitId?: string
}

interface SourceDraft {
  kind: SourceKind
  text: string
  ranges: SourceRange[]
  outlineHint: string
  truncated: boolean
  title: string
}

const INITIAL_DRAFT: SourceDraft = {
  kind: 'pasteNovel', text: '', ranges: [], outlineHint: '', truncated: false, title: ''
}
const INITIAL_RUN: RunState = { phase: 'ready', kind: null, error: '', retainedText: '' }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function uuid4(): string {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 仅用于 UI 显示的短码，不是安全指纹。 */
function shortCode(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  return hash.toString(16).padStart(8, '0').slice(0, 8)
}

function codePoints(text: string): number {
  return Array.from(text).length
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}

function downloadText(text: string, fileName: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function issueList(issues: GateIssue[], emptyText: string): ReactElement {
  if (!issues.length) return <p className="ss-muted">{emptyText}</p>
  return (
    <ul className="ss-issues">
      {issues.map((item, index) => (
        <li key={`${item.code}-${index}`} className={`ss-issue ss-issue-${item.severity}`}>
          <strong>{item.severity === 'error' ? '阻断' : '提醒'}</strong>
          <span>{item.message}</span>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// 1) 四步页签
// ---------------------------------------------------------------------------

interface StepNavProps {
  step: number
  onChange: (step: number) => void
  stale: boolean
}

function StepNav({ step, onChange, stale }: StepNavProps): ReactElement {
  const labels = ['选材与设置', '剧本', '视频分镜', '提示词导出']
  return (
    <nav className="ss-steps" aria-label="剧本创作步骤">
      {labels.map((label, index) => (
        <button
          key={label}
          type="button"
          className={`ss-step ${step === index + 1 ? 'ss-step-active' : ''}`}
          aria-current={step === index + 1 ? 'step' : undefined}
          onClick={() => onChange(index + 1)}
        >
          <span className="ss-step-num">{index + 1}</span>
          {label}
        </button>
      ))}
      {stale ? <span className="ss-stale-chip">已过期（基于旧版本）</span> : null}
    </nav>
  )
}

// ---------------------------------------------------------------------------
// 2) 状态条
// ---------------------------------------------------------------------------

interface StatusBarProps {
  run: RunState
  streamText: string
  onStop: () => void
  onRetry: () => void
  onRecover: () => void
}

const PHASE_LABEL: Record<RunPhase, string> = {
  ready: '准备就绪', generating: '生成中', stopping: '正在停止',
  failed: '生成失败', interrupted: '已中断（不会后台续跑）', done: '已完成'
}

function StatusBar({ run, streamText, onStop, onRetry, onRecover }: StatusBarProps): ReactElement {
  const running = run.phase === 'generating' || run.phase === 'stopping'
  return (
    <div className={`ss-status ss-status-${run.phase}`} role="status">
      <div className="ss-status-head">
        <strong>{PHASE_LABEL[run.phase]}</strong>
        <span className="ss-muted">{run.kind ? (run.kind === 'script' ? '小说 → 剧本' : '剧本 → 分镜') : '本地工作台'}</span>
        <div className="ss-status-actions">
          {running ? <button type="button" className="btn btn-danger btn-sm" onClick={onStop} disabled={run.phase === 'stopping'}>停止生成</button> : null}
          {run.phase === 'failed' ? <button type="button" className="btn btn-sm" onClick={onRetry}>按单元重试</button> : null}
          {run.retainedText || streamText ? <button type="button" className="btn btn-ghost btn-sm" onClick={onRecover}>恢复已收到文本</button> : null}
        </div>
      </div>
      {run.error ? <p className="ss-error-text">失败原因：{run.error}</p> : null}
      {run.phase === 'interrupted' ? <p className="ss-muted">本次请求已停止；离开页面不会后台续跑，已收到文本可恢复。</p> : null}
      {streamText && running ? <pre className="ss-stream">{streamText.slice(-1200)}</pre> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 3) 选材（4 类来源）
// ---------------------------------------------------------------------------

interface SourcePickerProps {
  draft: SourceDraft
  setDraft: (draft: SourceDraft) => void
  onMessage: (message: string) => void
}

function SourcePicker({ draft, setDraft, onMessage }: SourcePickerProps): ReactElement {
  const [longProjects, setLongProjects] = useState<Array<{ id: string; name: string }>>([])
  const [shortStories, setShortStories] = useState<Array<{ id: string; title: string }>>([])
  const [longProjectId, setLongProjectId] = useState('')
  const [chapters, setChapters] = useState<Array<{ chapterNumber: number; title: string }>>([])
  const [selectedChapters, setSelectedChapters] = useState<number[]>([])
  const [shortStoryId, setShortStoryId] = useState('')
  const [shortScope, setShortScope] = useState<'all' | number>('all')
  const [sections, setSections] = useState<Array<{ number: number; title: string; content: string }>>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const [longList, shortList] = await Promise.all([
          window.api.listProjects(),
          window.api.listShortStories()
        ])
        setLongProjects(longList.map(item => ({ id: item.id, name: item.name })))
        setShortStories(shortList.map(item => ({ id: item.id, title: item.title })))
      } catch (err) {
        onMessage(`读取来源列表失败：${errorText(err)}`)
      }
    })()
  }, [onMessage])

  const pickLongProject = async (id: string): Promise<void> => {
    setLongProjectId(id)
    setSelectedChapters([])
    if (!id) { setChapters([]); return }
    try {
      const list = await window.api.listChapters(id)
      setChapters(list.map(item => ({ chapterNumber: item.chapterNumber, title: item.title })))
    } catch (err) {
      onMessage(`读取章节失败：${errorText(err)}`)
    }
  }

  const applyChapters = async (numbers: number[]): Promise<void> => {
    setSelectedChapters(numbers)
    if (!longProjectId || !numbers.length) { setDraft({ ...draft, kind: 'long', text: '', ranges: [] }); return }
    if (numbers.length > MAX_LONG_CHAPTERS) {
      onMessage(`长篇最多选择 ${MAX_LONG_CHAPTERS} 章，请缩小范围`)
      return
    }
    setLoading(true)
    try {
      const parts: string[] = []
      const ranges: SourceRange[] = []
      for (const number of numbers) {
        const chapter = await window.api.getChapter(longProjectId, number)
        parts.push(`## 第 ${number} 章 ${chapter.meta.title}\n\n${chapter.content}`)
        ranges.push({ kind: 'longChapter', label: `第 ${number} 章 ${chapter.meta.title}`, projectId: longProjectId, chapterNumber: number })
      }
      const text = parts.join('\n\n')
      const name = longProjects.find(item => item.id === longProjectId)?.name ?? '长篇选材'
      setDraft({
        ...draft,
        kind: 'long',
        text,
        ranges,
        title: draft.title || `${name} · ${numbers.join('、')} 章`,
        truncated: codePoints(text) > SOURCE_MAX_CHARS
      })
      if (codePoints(text) > SOURCE_MAX_CHARS) onMessage(`选材共 ${codePoints(text)} 字，超过 ${SOURCE_MAX_CHARS} 字上限，请减少章节或改用粘贴节选`)
    } catch (err) {
      onMessage(`读取章节正文失败：${errorText(err)}`)
    } finally {
      setLoading(false)
    }
  }

  const pickShortStory = async (id: string): Promise<void> => {
    setShortStoryId(id)
    setShortScope('all')
    if (!id) { setSections([]); setDraft({ ...draft, kind: 'short', text: '', ranges: [] }); return }
    try {
      const story = await window.api.getShortStory(id)
      const list = story.sections.map(section => ({
        number: section.number, title: section.title, content: section.content
      }))
      setSections(list)
      const text = list.map(item => `## 第 ${item.number} 节${item.title ? `：${item.title}` : ''}\n\n${item.content}`).join('\n\n')
      const ranges: SourceRange[] = list.map(item => ({
        kind: 'shortStorySection', label: `第 ${item.number} 节${item.title ? `：${item.title}` : ''}`,
        storyId: id, sectionNumber: item.number
      }))
      setDraft({
        ...draft, kind: 'short', text, ranges,
        title: draft.title || story.title,
        truncated: codePoints(text) > SOURCE_MAX_CHARS
      })
    } catch (err) {
      onMessage(`读取中短篇失败：${errorText(err)}`)
    }
  }

  const applyShortScope = (scope: 'all' | number): void => {
    setShortScope(scope)
    const chosen = scope === 'all' ? sections : sections.filter(item => item.number === scope)
    const text = chosen.map(item => `## 第 ${item.number} 节${item.title ? `：${item.title}` : ''}\n\n${item.content}`).join('\n\n')
    const ranges: SourceRange[] = chosen.map(item => ({
      kind: 'shortStorySection', label: `第 ${item.number} 节${item.title ? `：${item.title}` : ''}`,
      storyId: shortStoryId, sectionNumber: item.number
    }))
    setDraft({ ...draft, kind: 'short', text, ranges, truncated: codePoints(text) > SOURCE_MAX_CHARS })
  }

  const count = codePoints(draft.text)
  return (
    <div className="ss-card">
      <h2>选材</h2>
      <p className="ss-muted">小说正文是唯一事实来源；大纲只是计划。选材会复制为快照，不会写回小说正文／大纲／记忆。</p>
      <div className="ss-field">
        <label htmlFor="ss-source-kind">来源类型</label>
        <select
          id="ss-source-kind"
          className="select"
          value={draft.kind}
          onChange={event => {
            const kind = event.target.value as SourceKind
            setDraft({ ...draft, kind, text: kind === draft.kind ? draft.text : '', ranges: kind === draft.kind ? draft.ranges : [] })
          }}
        >
          <option value="long">长篇章节（最多 5 章）</option>
          <option value="short">中短篇作品（分节 / 全文）</option>
          <option value="pasteNovel">粘贴小说片段</option>
          <option value="pasteScript">粘贴已有剧本（直接进分镜）</option>
        </select>
      </div>

      {draft.kind === 'long' ? (
        <div className="ss-source-block">
          <div className="ss-field-row">
            <div className="ss-field">
              <label htmlFor="ss-long-project">长篇项目</label>
              <select id="ss-long-project" className="select" value={longProjectId} onChange={event => void pickLongProject(event.target.value)}>
                <option value="">请选择项目</option>
                {longProjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>
          </div>
          <div className="ss-chapter-picker">
            {chapters.map(item => (
              <label key={item.chapterNumber} className="ss-check">
                <input
                  type="checkbox"
                  checked={selectedChapters.includes(item.chapterNumber)}
                  onChange={event => {
                    const next = event.target.checked
                      ? [...selectedChapters, item.chapterNumber].sort((a, b) => a - b)
                      : selectedChapters.filter(number => number !== item.chapterNumber)
                    void applyChapters(next)
                  }}
                />
                第 {item.chapterNumber} 章 {item.title}
              </label>
            ))}
            {!chapters.length ? <span className="ss-muted">选择项目后显示章节，最多勾选 {MAX_LONG_CHAPTERS} 章。</span> : null}
          </div>
        </div>
      ) : null}

      {draft.kind === 'short' ? (
        <div className="ss-source-block">
          <div className="ss-field-row">
            <div className="ss-field">
              <label htmlFor="ss-short-story">中短篇作品</label>
              <select id="ss-short-story" className="select" value={shortStoryId} onChange={event => void pickShortStory(event.target.value)}>
                <option value="">请选择作品</option>
                {shortStories.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </div>
            <div className="ss-field">
              <label htmlFor="ss-short-scope">范围</label>
              <select id="ss-short-scope" className="select" value={String(shortScope)} onChange={event => applyShortScope(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
                <option value="all">全文</option>
                {sections.map(item => <option key={item.number} value={item.number}>第 {item.number} 节{item.title ? ` · ${item.title}` : ''}</option>)}
              </select>
            </div>
          </div>
        </div>
      ) : null}

      {draft.kind === 'pasteNovel' || draft.kind === 'pasteScript' ? (
        <div className="ss-field">
          <label htmlFor="ss-paste">{draft.kind === 'pasteScript' ? '已有剧本正文（将自动创建正式稿版本）' : '小说片段正文'}</label>
          <textarea
            id="ss-paste"
            className="textarea ss-paste"
            rows={10}
            value={draft.text}
            placeholder={draft.kind === 'pasteScript' ? '粘贴完整的影视剧本（场景号、动作行、角色名、对白）…' : '粘贴要改编的小说正文…'}
            onChange={event => setDraft({
              ...draft,
              text: event.target.value,
              ranges: event.target.value.trim() ? [{ kind: 'paste', label: '粘贴文本' }] : [],
              truncated: codePoints(event.target.value) > SOURCE_MAX_CHARS
            })}
          />
        </div>
      ) : null}

      <div className="ss-field">
        <label htmlFor="ss-outline">大纲提示（仅计划，不是事实；可选）</label>
        <textarea
          id="ss-outline"
          className="textarea"
          rows={3}
          value={draft.outlineHint}
          onChange={event => setDraft({ ...draft, outlineHint: event.target.value })}
        />
      </div>
      <div className="ss-source-meta">
        <span>范围：{draft.ranges.length ? draft.ranges.map(item => item.label).join('、') : '未选择'}</span>
        <span>字符：{count.toLocaleString()} / {SOURCE_MAX_CHARS.toLocaleString()}</span>
        <span>指纹短码：{draft.text ? shortCode(draft.text + JSON.stringify(draft.ranges)) : '—'}</span>
      </div>
      {draft.truncated || count > SOURCE_MAX_CHARS ? (
        <p className="ss-warn-text">⚠ 选材超过 {SOURCE_MAX_CHARS.toLocaleString()} 字上限，请缩小范围；服务端只在创建时兜底截断并显式标注 truncated，不会静默截断。</p>
      ) : null}
      {loading ? <p className="ss-muted">正在读取正文…</p> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 4) 设置
// ---------------------------------------------------------------------------

interface SettingsBarProps {
  settings: ScriptSettings
  setSettings: (settings: ScriptSettings) => void
}

function SettingsBar({ settings, setSettings }: SettingsBarProps): ReactElement {
  const profile = rhythmProfile(settings)
  const update = <K extends keyof ScriptSettings>(key: K, value: ScriptSettings[K]): void => setSettings({ ...settings, [key]: value })
  return <div className="ss-card ss-settings">
    <h2>改编设置</h2>
    <p className="ss-muted">先确定形态、平台和时长，其余设置可按需要展开。</p>
    <div className="ss-settings-grid">
      <label className="ss-field" htmlFor="ss-format">剧本形态<select id="ss-format" className="select" value={settings.format} onChange={event => update('format', event.target.value as ScriptFormat)}>
        <option value="short">短剧</option><option value="comic">漫剧</option>
      </select></label>
      <label className="ss-field" htmlFor="ss-platform">目标平台<select id="ss-platform" className="select" value={settings.platform} onChange={event => update('platform', event.target.value)}>
        {['抖音', '快手', '红果', 'B 站', '视频号', '自定义'].map(item => <option key={item} value={item}>{item}</option>)}
      </select></label>
      <label className="ss-field" htmlFor="ss-duration">单集目标时长（秒）<input id="ss-duration" className="input" type="number" min={1} max={3600}
        value={settings.targetDurationSec} onChange={event => update('targetDurationSec', Number(event.target.value) || 90)} /></label>
      <label className="ss-field" htmlFor="ss-style">视觉风格<input id="ss-style" className="input" value={settings.visualStyle} onChange={event => update('visualStyle', event.target.value)} /></label>
    </div>
    <details className="ss-details"><summary>受众与改编要求</summary><div className="ss-detail-content">
      <div className="ss-settings-grid">
        <label className="ss-field" htmlFor="ss-audience">目标受众<input id="ss-audience" className="input" value={settings.targetAudience ?? ''} placeholder="该题材的短剧／漫剧观众" onChange={event => update('targetAudience', event.target.value)} /></label>
        <label className="ss-field" htmlFor="ss-adapt">改编幅度<select id="ss-adapt" className="select" value={settings.adaptStrength} onChange={event => update('adaptStrength', event.target.value as AdaptStrength)}>
          <option value="low">低 · 尽量贴近原文</option><option value="medium">中 · 重组戏剧单元</option><option value="high">高 · 大幅压缩重构</option>
        </select></label>
      </div>
      <label className="ss-field" htmlFor="ss-extra">补充要求<textarea id="ss-extra" className="textarea" rows={3} value={settings.extraRequirements} onChange={event => update('extraRequirements', event.target.value)} /></label>
    </div></details>
    <details className="ss-details"><summary>节奏档位与平台节奏档案</summary><div className="ss-detail-content">
      <div className="ss-settings-grid">
        <label className="ss-field" htmlFor="ss-pace-mode">节奏判定<select id="ss-pace-mode" className="select" value={settings.paceMode ?? 'manual'} onChange={event => update('paceMode', event.target.value as 'auto' | 'manual')}>
          <option value="auto">按剧情逐段自动判定</option><option value="manual">使用指定档位</option>
        </select></label>
        <label className="ss-field" htmlFor="ss-pace">默认节奏档位<select id="ss-pace" className="select" value={settings.paceTier} onChange={event => update('paceTier', event.target.value as PaceTier)}>
          {(Object.keys(PACE_LABELS) as PaceTier[]).map(item => <option key={item} value={item}>{PACE_LABELS[item]}</option>)}
        </select></label>
      </div>
      <div className="ss-settings-grid">{(Object.keys(profile) as Array<keyof typeof profile>).map(key => <label className="ss-field" key={key} htmlFor={`ss-rhythm-${key}`}>
        {{ first3: '前3秒任务', first15: '前15秒任务', first30: '前30秒任务', breathing: '呼吸感许可', avoidDragging: '禁止拖慢点', completionGoal: '完播与互动目标' }[key]}
        <textarea id={`ss-rhythm-${key}`} className="textarea" rows={3} value={profile[key]} onChange={event => update('rhythmProfile', { ...profile, [key]: event.target.value })} />
      </label>)}</div>
    </div></details>
    <details className="ss-details"><summary>画幅与清晰度</summary><div className="ss-detail-content ss-settings-grid">
      <label className="ss-field" htmlFor="ss-aspect">画幅<select id="ss-aspect" className="select" value={settings.aspectRatio} onChange={event => update('aspectRatio', event.target.value)}>
        {['9:16', '16:9', '1:1', '4:3'].map(item => <option key={item} value={item}>{item}</option>)}
      </select></label>
      <label className="ss-field" htmlFor="ss-resolution">分辨率<select id="ss-resolution" className="select" value={settings.resolution} onChange={event => update('resolution', event.target.value)}>
        {['1080p', '720p', '4K', '暂定'].map(item => <option key={item} value={item}>{item}</option>)}
      </select></label>
    </div></details>
  </div>
}

// ---------------------------------------------------------------------------
// 5) 剧本步骤
// ---------------------------------------------------------------------------

interface ScriptStepProps {
  project: ScriptProject | null
  candidateText: string
  setCandidateText: (text: string) => void
  versionDraft: string
  setVersionDraft: (text: string) => void
  versionNote: string
  setVersionNote: (text: string) => void
  onGenerate: () => void
  onAdopt: () => void
  onSaveVersion: () => void
  onCopy: (text: string) => void
  busy: boolean
  stale: boolean
}

function ScriptStep(props: ScriptStepProps): ReactElement {
  const [view, setView] = useState<'compare' | 'candidate' | 'version'>('compare')
  const {
    project, candidateText, setCandidateText, versionDraft, setVersionDraft, versionNote, setVersionNote,
    onGenerate, onAdopt, onSaveVersion, onCopy, busy, stale
  } = props
  const candidate = project?.candidate ?? null
  const candidateStale = !!candidate && candidate.sourceFingerprint !== (project?.source.sourceFingerprint ?? '')
  const versions = project?.scriptVersions ?? []
  const active = versions.find(item => item.id === project?.activeVersionId) ?? null
  return (
    <div className="ss-stack">
      <div className="ss-workbar ss-script-toolbar">
        <div><h2>剧本编辑</h2><p className="ss-muted">对照候选与正式稿，采用或修订后再制作分镜。</p></div>
        <div className="ss-view-switch" role="group" aria-label="剧本编辑视图">
          {([['compare', '并排对照'], ['candidate', '专注候选'], ['version', '专注正式稿']] as const).map(([value, label]) =>
            <button key={value} type="button" aria-pressed={view === value} className={view === value ? 'ss-view-active' : ''} onClick={() => setView(value)}>{label}</button>)}
        </div>
        {view !== 'candidate' ? <button type="button" className="btn btn-primary btn-sm" disabled={busy || !project || !active || !versionDraft.trim()}
          title={!active ? '先采用候选为正式稿。' : '将当前正式稿编辑保存为新版本。'} onClick={onSaveVersion}>保存为新版本</button> : null}
      </div>
      <div className={`ss-script-compare ${view !== 'compare' ? 'ss-script-focus' : ''}`}>

      <section className="ss-card ss-script-pane" hidden={view === 'version'}>
        <div className="ss-card-head">
          <h2>剧本候选</h2>
          <div className="ss-actions">
            <button type="button" className="btn btn-sm" disabled={!candidateText.trim()} onClick={() => onCopy(candidateText)}>复制</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !project} onClick={onGenerate}>
              {candidate ? '重新生成' : '生成剧本候选'}
            </button>
          </div>
        </div>
        <p className="ss-muted">候选可自由编辑，确认后采用为正式稿。</p>
        {candidateStale ? <p className="ss-warn-text">⚠ 该候选基于旧来源，已过期，禁止采用，请重新生成。</p> : null}
        <textarea
          id="ss-candidate-edit" aria-label="候选剧本" disabled={busy}
          className="textarea ss-script-body"
          rows={24}
          value={candidateText}
          placeholder="生成后在这里编辑候选剧本；采用前可自由修改。"
          onChange={event => setCandidateText(event.target.value)}
        />
        {candidate ? (
          <details className="ss-details"><summary>改编说明、风险与创作笔记</summary><div className="ss-candidate-meta">
            <div><strong>改编说明</strong><p>{candidate.adaptationNote || '—'}</p></div>
            <div><strong>暂定项</strong><p>{candidate.tentative.length ? candidate.tentative.join('；') : '—'}</p></div>
            <div><strong>新增内容</strong><p>{candidate.additions.length ? candidate.additions.join('；') : '—'}</p></div>
            <div><strong>角色 / 场景 / 道具</strong><p>{candidate.characters.join('、') || '—'} ｜ {candidate.scenes.join('、') || '—'} ｜ {candidate.props.join('、') || '—'}</p></div>
            <div><strong>创作笔记</strong><p>{candidate.creativeNotes || '—'}</p></div>
            <div><strong>改编风险</strong><p>{candidate.risks.length ? candidate.risks.join('；') : '—'}</p></div>
            {candidate.comicExtras ? (
              <div><strong>漫剧附加</strong><p>关键画面 {candidate.comicExtras.keyFrames.length} 条 · 旁白 {candidate.comicExtras.narration.length} 条 · 视觉风格：{candidate.comicExtras.visualStyle} · 切换 {candidate.comicExtras.transitions.length} 条</p></div>
            ) : null}
            {candidate.parseFallback ? <p className="ss-warn-text">本候选为 JSON 解析失败后的 Markdown 降级结果，请人工复核集首推进与结尾落点。</p> : null}
          </div></details>
        ) : null}
        <div className="ss-pane-footer">
          <span className="ss-save-state">{candidateText !== (candidate?.body ?? '') ? '候选有未保存编辑，采用时一并保存' : candidate ? '候选已保存' : '等待生成候选'}</span>
          <button type="button" className="btn btn-primary" disabled={busy || !candidate || candidateStale || !candidateText.trim()} onClick={onAdopt}>采用为正式稿</button>
        </div>
        {stale ? <p className="ss-warn-text">⚠ 正式稿已修改，原有分镜与提示词包已过期（基于旧版本），请重新生成。</p> : null}
      </section>

      <section className="ss-card ss-script-pane" hidden={view === 'candidate'}>
        <div className="ss-card-head"><h2>正式稿{active ? ` · v${active.number}` : ''}</h2>
          <span className={`ss-save-state ${versionDraft !== (active?.body ?? '') ? 'ss-save-state-dirty' : ''}`}>{versionDraft !== (active?.body ?? '') ? '有未保存修改' : active ? '已保存' : '等待采用'}</span>
        </div>
        {!versions.length ? <p className="ss-muted">还没有正式稿。采用候选，或在选材页粘贴已有剧本后创建项目。</p> : (
          <details className="ss-details"><summary>版本记录 · {versions.length} 版</summary><ul className="ss-version-list">
            {versions.map(version => (
              <li key={version.id} className={version.id === project?.activeVersionId ? 'ss-version-active' : ''}>
                v{version.number} · {version.note || '无备注'} · {new Date(version.createdAt).toLocaleString('zh-CN')}
                {version.id === project?.activeVersionId ? <span className="ss-chip">当前</span> : null}
              </li>
            ))}
          </ul></details>
        )}
        <div className="ss-field">
          <label htmlFor="ss-version-edit">编辑当前正式稿（保存后生成新版本）</label>
          <textarea id="ss-version-edit" className="textarea ss-script-body" rows={24} disabled={busy} value={versionDraft}
            onChange={event => setVersionDraft(event.target.value)} />
        </div>
        <div className="ss-field-row">
          <div className="ss-field ss-field-grow">
            <label htmlFor="ss-version-note">版本备注</label>
            <input id="ss-version-note" className="input" value={versionNote} onChange={event => setVersionNote(event.target.value)} />
          </div>
        </div>
      </section>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 6) 分镜步骤
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 7) 提示词导出步骤
// ---------------------------------------------------------------------------

interface PromptStepProps {
  packages: PromptPackage[]
  outputMode: NonNullable<ScriptSettings['promptMode']>
  onModeChange: (mode: NonNullable<ScriptSettings['promptMode']>) => void
  buildBlockedReason: string
  onBuild: () => void
  onCopy: (text: string) => void
  onExport: () => void
  busy: boolean
  exportBlocked: boolean
  blockReasons: string[]
}

function PromptStep({ packages, outputMode, onModeChange, buildBlockedReason, onBuild, onCopy, onExport, busy, exportBlocked, blockReasons }: PromptStepProps): ReactElement {
  const [selectedId, setSelectedId] = useState('')
  const pkg = packages.find(item => item.unitId === selectedId) ?? packages[0]
  const index = pkg ? packages.indexOf(pkg) : 0
  return <div className="ss-stack">
    <div className="ss-workbar">
      <div><h2>视频提示词包</h2><p className="ss-muted">{packages.length ? `共 ${packages.length} 段 · ${packages.reduce((sum, item) => sum + item.durationSec, 0)} 秒` : '从已保存的分镜构建正文，选择模板即可预览。'}</p></div>
      <div className="ss-actions">
        <button type="button" className="btn btn-sm" disabled={busy || !!buildBlockedReason} title={buildBlockedReason || '使用当前模板构建'} onClick={onBuild}>构建 / 刷新提示词包</button>
        <button type="button" className="btn btn-sm" disabled={!packages.length} onClick={() => onCopy(packages.map(item => item.body).join('\n\n---\n\n'))}>复制整包正文</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || exportBlocked || !packages.length} onClick={onExport}>导出 Markdown</button>
      </div>
      {buildBlockedReason ? <p className="ss-inline-warning">{buildBlockedReason}</p> : null}
    </div>
    <div className="ss-card ss-output-settings">
      <label className="ss-field" htmlFor="ss-prompt-mode">本次提示词模板<select id="ss-prompt-mode" className="select" disabled={busy} value={outputMode}
        onChange={event => onModeChange(event.target.value as NonNullable<ScriptSettings['promptMode']>)}>
        <option value="auto">自动推荐 · 普通段 C / 复杂段 B</option><option value="C">C · 导演轨纯净版</option>
        <option value="A">A · 标准字段化详细版</option><option value="B">B · 导演执行增强版</option>
      </select></label>
      <p className="ss-muted">模板仅影响本次构建，无需重新生成分镜；时长、画幅等参数与正文分开展示。</p>
    </div>
    {exportBlocked ? <div className="ss-gate ss-gate-error"><strong>导出已禁用</strong>
      <ul className="ss-issues">{blockReasons.map((reason, at) => <li key={at} className="ss-issue ss-issue-error">{reason}</li>)}</ul>
    </div> : null}
    {!pkg ? <div className="ss-empty"><h3>提示词正文将在这里预览</h3><p>先保存分镜，再点击“构建 / 刷新提示词包”。</p></div> : <div className="ss-prompt-workspace">
      <nav className="ss-unit-nav ss-card" aria-label="提示词分段目录"><div className="ss-panel-heading"><h3>分段目录</h3><span>{packages.length} 段</span></div>
        <div className="ss-unit-nav-list">{packages.map((item, at) => <button key={item.unitId} type="button" className={`ss-unit-link ${item === pkg ? 'ss-unit-link-active' : ''}`}
          aria-current={item === pkg ? 'true' : undefined} onClick={() => setSelectedId(item.unitId)}>
          <span className="ss-unit-link-top"><strong>第 {at + 1} 段</strong><span>{item.durationSec} 秒</span></span>
          <span className="ss-unit-link-bottom">{item.charCount} 字 · {item.quality.ok ? '可导出' : '有阻断'}{item.meta.splitFromUnitId ? ' · 拆分段' : ''}</span>
        </button>)}</div>
      </nav>
      <section className="ss-card ss-package">
        <div className="ss-card-head"><div><p className="ss-eyebrow">第 {index + 1} 段 / 共 {packages.length} 段</p><h3>提示词正文</h3></div>
          <button type="button" className="btn btn-sm" onClick={() => onCopy(pkg.body)}>仅复制本段正文</button>
        </div>
        <div className="ss-prompt-summary"><span>{pkg.durationSec} 秒</span><span>{pkg.meta.aspectRatio}</span><span>{pkg.meta.resolution}</span>
          <span>模板 {pkg.meta.mode}</span><span className={pkg.charCount > PROMPT_HARD_LIMIT ? 'ss-inline-warning' : ''}>{pkg.charCount} / {PROMPT_HARD_LIMIT} 字</span>
          <strong className={pkg.quality.ok ? 'ss-save-state' : 'ss-inline-warning'}>{pkg.quality.ok ? '校验通过' : '导出阻断'}</strong>
        </div>
        {pkg.meta.stale ? <p className="ss-warn-text">已过期（基于旧版本）：{pkg.meta.staleReason || '基于旧版本'}。导出文件将标注旧版本状态。</p> : null}
        {pkg.meta.splitNotice ? <p className="ss-warn-text">{pkg.meta.splitNotice}</p> : null}
        {pkg.quality.errors.length ? <div className="ss-gate ss-gate-error">{issueList(pkg.quality.errors, '')}</div> : null}
        <div className="ss-field"><label htmlFor={`ss-body-${pkg.unitId}`}>纯净正文 · 可直接复制</label>
          <textarea id={`ss-body-${pkg.unitId}`} className="textarea ss-body" rows={24} value={pkg.body} readOnly />
        </div>
        <details className="ss-details"><summary>质量提醒 · {pkg.quality.warnings.length} 项{pkg.quality.compressed ? ' · 已压缩一轮' : ''}</summary>
          <div className="ss-detail-content">{issueList(pkg.quality.warnings, '没有额外提醒。')}</div>
        </details>
        <details className="ss-details"><summary>生成参数、节奏与版本依据</summary><div className="ss-detail-content ss-meta-grid">
          <span>任务类型：{pkg.meta.taskType}</span><span>推荐模板：{pkg.meta.recommendedMode ?? pkg.meta.mode}；{pkg.meta.modeReason}</span>
          <span>节奏：{pkg.meta.paceTier ? PACE_LABELS[pkg.meta.paceTier] : '旧版未记录'}；{pkg.meta.paceReason}</span>
          <span>节奏执行：{pkg.meta.paceExecution}</span><span>边界交接：{pkg.meta.boundaryPlan}</span>
          <span>按需增强：{pkg.meta.enhancementAdvice?.join('；') || '无额外建议'}</span><span>视觉风格：{pkg.meta.visualStyle || '暂定'}</span>
          <span>平台：{pkg.meta.platform}</span><span>版本：v{pkg.meta.versionNumber}</span><span>分段标识：{pkg.unitId}</span>
          <span>分镜指纹：<code>{pkg.meta.storyboardFingerprint.slice(0, 8)}</code></span><span>状态：{pkg.meta.stale ? '已过期' : '最新'}</span>
        </div></details>
      </section>
    </div>}
  </div>
}

// ---------------------------------------------------------------------------
// 8) 主组件
// ---------------------------------------------------------------------------

export default function ScriptStudioPage({ initialSource }: { initialSource?: SourceSelectionHint }): ReactElement {
  const [projects, setProjects] = useState<ScriptProjectSummary[]>([])
  const [project, setProject] = useState<ScriptProject | null>(null)
  const [step, setStep] = useState(1)
  const [draft, setDraft] = useState<SourceDraft>(INITIAL_DRAFT)
  const [settings, setSettings] = useState<ScriptSettings>(DEFAULT_SETTINGS)
  const [outputMode, setOutputMode] = useState<NonNullable<ScriptSettings['promptMode']>>('auto')
  const [candidateText, setCandidateText] = useState('')
  const [versionDraft, setVersionDraft] = useState('')
  const [versionNote, setVersionNote] = useState('')
  const [units, setUnits] = useState<StoryboardUnit[]>([])
  const [storyboardBasedOn, setStoryboardBasedOn] = useState<BasedOn | null>(null)
  const [storyboardQuality, setStoryboardQuality] = useState<QualityReport | null>(null)
  /** 当前 units 的硬阻断；由共享纯函数重算，绝不因手工编辑而清空。 */
  const [hardIssues, setHardIssues] = useState<GateIssue[]>([])
  const [packages, setPackages] = useState<PromptPackage[]>([])
  const [run, setRun] = useState<RunState>(INITIAL_RUN)
  const [streamText, setStreamText] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<GenerationRun[]>([])
  const [recoveredText, setRecoveredText] = useState('')
  const handleRef = useRef<ActiveHandle | null>(null)
  const pageEpoch = useRef(0)
  const stoppedRef = useRef(false)
  const hintLoaded = useRef(false)

  useEffect(() => {
    const lifetime = pageEpoch
    void window.api.listScriptProjects().then(setProjects).catch(err => setMessage(`读取项目列表失败：${errorText(err)}`))
    return () => {
      lifetime.current++
      const handle = handleRef.current
      if (handle) void handle.abort().catch(() => undefined)
      handleRef.current = null
    }
  }, [])

  const hydrate = useCallback((next: ScriptProject): void => {
    pageEpoch.current++
    setProject(next)
    setSettings(next.settings)
    setOutputMode(next.settings.promptMode ?? 'C')
    setDraft({
      kind: next.source.kind,
      text: next.source.text,
      ranges: next.source.ranges,
      outlineHint: next.source.outlineHint,
      truncated: next.source.truncated,
      title: next.title
    })
    setCandidateText(next.candidate?.body ?? '')
    const active = next.scriptVersions.find(item => item.id === next.activeVersionId)
    setVersionDraft(active?.body ?? '')
    const loadedUnits = next.storyboard?.units ?? []
    setUnits(loadedUnits)
    setStoryboardBasedOn(next.storyboard?.basedOn ?? null)
    setHardIssues(storyboardHardIssues(loadedUnits))
    setStoryboardQuality(null)
    setPackages([])
    setHistory([])
    setRecoveredText('')
    setRun(INITIAL_RUN)
    setStreamText('')
  }, [])

  /** 从章节列表 / 中短篇页带来源跳转时，自动把选材装进工作台。 */
  useEffect(() => {
    if (!initialSource || hintLoaded.current) return
    hintLoaded.current = true
    void (async () => {
      try {
        if (initialSource.kind === 'long' && initialSource.projectId) {
          const numbers = (initialSource.chapterNumbers ??
            (initialSource.chapterNumber ? [initialSource.chapterNumber] : [])).slice(0, MAX_LONG_CHAPTERS)
          const parts: string[] = []
          const ranges: SourceRange[] = []
          for (const number of numbers) {
            const chapter = await window.api.getChapter(initialSource.projectId, number)
            parts.push(`## 第 ${number} 章 ${chapter.meta.title}\n\n${chapter.content}`)
            ranges.push({ kind: 'longChapter', label: `第 ${number} 章 ${chapter.meta.title}`, projectId: initialSource.projectId, chapterNumber: number })
          }
          const text = parts.join('\n\n')
          setDraft({
            kind: 'long', text, ranges, outlineHint: '',
            truncated: codePoints(text) > SOURCE_MAX_CHARS,
            title: initialSource.title || `${numbers.join('、')} 章改编`
          })
          if (codePoints(text) > SOURCE_MAX_CHARS) setMessage(`来源共 ${codePoints(text)} 字，超过 ${SOURCE_MAX_CHARS} 字，请缩小范围`)
        } else if (initialSource.kind === 'short' && initialSource.storyId) {
          const story = await window.api.getShortStory(initialSource.storyId)
          const text = story.sections.map(item => `## 第 ${item.number} 节${item.title ? `：${item.title}` : ''}\n\n${item.content}`).join('\n\n')
          const ranges: SourceRange[] = story.sections.map(item => ({
            kind: 'shortStorySection', label: `第 ${item.number} 节${item.title ? `：${item.title}` : ''}`,
            storyId: initialSource.storyId, sectionNumber: item.number
          }))
          setDraft({
            kind: 'short', text, ranges, outlineHint: '',
            truncated: codePoints(text) > SOURCE_MAX_CHARS,
            title: initialSource.title || story.title
          })
        } else {
          setDraft(current => ({ ...current, kind: initialSource.kind }))
        }
      } catch (err) {
        setMessage(`自动载入来源失败：${errorText(err)}；可手动在下方选材。`)
      }
    })()
  }, [initialSource])

  const refreshProjects = useCallback(async (): Promise<void> => {
    setProjects(await window.api.listScriptProjects())
  }, [])

  /** 恢复完成后再展示记录；项目切换后的旧响应不能污染当前项目。 */
  const projectId = project?.id
  const projectRevision = project?.revision
  useEffect(() => {
    if (!projectId || run.phase === 'generating' || run.phase === 'stopping') return
    let canceled = false
    const epoch = pageEpoch.current
    void window.api.recoverStudioRuns({ projectId })
      .then(result => {
        if (!canceled && pageEpoch.current === epoch) setHistory(result.runs.filter(item =>
          item.projectId === projectId && ['interrupted', 'aborted', 'failed'].includes(item.status) &&
          (item.retainedText || item.partialText)))
      })
      .catch(() => undefined)
    return () => { canceled = true }
  }, [projectId, projectRevision, run.phase])

  const createProject = useCallback(async (): Promise<void> => {
    if (!draft.text.trim()) { setMessage('请先选择或粘贴来源内容'); return }
    if (codePoints(draft.text) > SOURCE_MAX_CHARS) {
      setMessage(`来源共 ${codePoints(draft.text)} 字，超过 ${SOURCE_MAX_CHARS} 字上限，请缩小范围后再创建（不静默截断）`)
      return
    }
    setBusy(true)
    try {
      const created = await window.api.createScriptProject({
        title: draft.title.trim() || `剧本创作 · ${new Date().toLocaleDateString('zh-CN')}`,
        settings,
        sourceText: draft.text,
        sourceRanges: draft.ranges,
        outlineHint: draft.outlineHint,
        sourceKind: draft.kind,
        truncated: draft.truncated
      })
      hydrate(created)
      await refreshProjects()
      setMessage(draft.kind === 'pasteScript' ? '已粘贴剧本并自动创建正式稿版本，可直接进入视频分镜。' : '项目已创建，来源快照已保存。')
      setStep(draft.kind === 'pasteScript' ? 3 : 2)
    } catch (err) {
      setMessage(`创建失败：${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }, [draft, settings, hydrate, refreshProjects])

  const openProject = useCallback(async (id: string): Promise<void> => {
    if (busy || handleRef.current) return
    const epoch = ++pageEpoch.current
    setBusy(true)
    try {
      const loaded = await window.api.getScriptProject(id)
      if (pageEpoch.current !== epoch) return
      hydrate(loaded)
      setMessage('已打开项目。')
    } catch (err) {
      setMessage(`打开失败：${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }, [busy, hydrate])

  const runStream = useCallback(async <T extends { ok: boolean; error?: string; retainedText?: string }>(
    kind: 'script' | 'storyboard',
    start: (onToken: (token: string, done: boolean) => void) => ActiveHandle & Promise<T>,
    onSuccess: (result: T) => void,
    onFailure: (result: T) => void,
    activeUnitId?: string
  ): Promise<void> => {
    if (handleRef.current) return
    const epoch = pageEpoch.current
    stoppedRef.current = false
    setStreamText('')
    const unitTag = activeUnitId ? { activeUnitId } : {}
    setRun({ phase: 'generating', kind, error: '', retainedText: '', ...unitTag })
    const handle = start((token, done) => {
      if (done || pageEpoch.current !== epoch) return
      setStreamText(previous => previous + token)
    })
    handleRef.current = handle
    try {
      const result = await handle
      if (pageEpoch.current !== epoch) return
      if (stoppedRef.current) {
        setRun({
          phase: 'interrupted', kind, error: '',
          retainedText: result.retainedText ?? '', ...unitTag
        })
        return
      }
      if (result.ok) {
        onSuccess(result)
        setRun({ phase: 'done', kind, error: '', retainedText: '', ...unitTag })
      } else {
        onFailure(result)
        setRun({
          phase: 'failed', kind,
          error: result.error || '生成失败',
          retainedText: result.retainedText ?? '', ...unitTag
        })
      }
    } catch (err) {
      if (pageEpoch.current === epoch) setRun({ phase: 'failed', kind, error: errorText(err), retainedText: '', ...unitTag })
    } finally {
      if (handleRef.current === handle) handleRef.current = null
    }
  }, [])

  const generateScript = useCallback(async (): Promise<void> => {
    if (handleRef.current) return
    if (!project) { setMessage('请先创建项目'); return }
    setBusy(true)
    await runStream<GenerateStudioScriptResult>(
      'script',
      onToken => window.api.generateStudioScript({ projectId: project.id, expectedRevision: project.revision }, onToken),
      result => {
        if (!result.ok) return
        setProject(result.project)
        setCandidateText(result.candidate.body)
        setMessage('剧本候选已生成并写回项目（未自动采用）。')
        setStep(2)
      },
      result => {
        setMessage(`生成失败：${result.error ?? '未知错误'}`)
        if (result.retainedText) setCandidateText(result.retainedText)
      }
    )
    setBusy(false)
  }, [project, runStream])

  const generateStoryboard = useCallback(async (unitId?: string): Promise<void> => {
    if (handleRef.current) return
    if (!project) { setMessage('请先创建项目'); return }
    if (unitId && (!storyboardBasedOn || storyboardBasedOn.projectId !== project.id ||
      storyboardBasedOn.versionId !== project.activeVersionId ||
      storyboardBasedOn.scriptFingerprint !== project.scriptFingerprint ||
      storyboardBasedOn.sourceFingerprint !== project.source.sourceFingerprint)) {
      setMessage('分镜基于旧稿，请重新生成全部分镜后再按段修改。')
      return
    }
    setBusy(true)
    await runStream<GenerateStudioStoryboardResult>(
      'storyboard',
      onToken => window.api.generateStudioStoryboard({
        projectId: project.id, expectedRevision: project.revision, ...(unitId ? { unitId } : {})
      }, onToken),
      result => {
        if (result.quality) setStoryboardQuality(result.quality)
        const generated = result.units
        if (generated?.length) {
          setStoryboardBasedOn(unitId ? storyboardBasedOn : result.basedOn ?? null)
          const replacement = generated[0]
          const next = unitId
            ? units.map(item => item.id === unitId ? replacement : item)
            : generated
          setUnits(next)
          setHardIssues(mergeHardIssues(storyboardHardIssues(next), result.quality?.errors ?? []))
          setMessage(unitId ? '该段已重生成，请确认后显式保存。' : '分镜已生成，请确认 11 字段后显式保存。')
        } else if (result.quality) {
          setHardIssues(result.quality.errors)
        }
        setStep(3)
      },
      result => {
        if (result.quality) setStoryboardQuality(result.quality)
        const generated = result.units
        if (generated?.length) {
          setStoryboardBasedOn(unitId ? storyboardBasedOn : result.basedOn ?? null)
          const replacement = generated[0]
          const next = unitId
            ? units.map(item => item.id === unitId ? replacement : item)
            : generated
          setUnits(next)
          setHardIssues(mergeHardIssues(storyboardHardIssues(next), result.quality?.errors ?? []))
        } else if (result.quality) {
          setHardIssues(result.quality.errors)
        }
        setMessage(`分镜生成失败：${result.error ?? '未知错误'}${result.retainedText ? '（已保留原始文本，可恢复）' : ''}`)
      },
      unitId
    )
    setBusy(false)
  }, [project, runStream, units, storyboardBasedOn])

  const stop = useCallback(async (): Promise<void> => {
    stoppedRef.current = true
    setRun(previous => ({ ...previous, phase: 'stopping' }))
    try {
      await handleRef.current?.abort()
    } catch (err) {
      setMessage(`停止失败：${errorText(err)}`)
    }
    setRun(previous => ({ ...previous, phase: 'interrupted', error: '', retainedText: previous.retainedText || streamText }))
  }, [streamText])

  const adoptCandidate = useCallback(async (): Promise<void> => {
    if (!project?.candidate) return
    setBusy(true)
    try {
      const result = await window.api.adoptScriptCandidate({
        projectId: project.id,
        candidateId: project.candidate.id,
        expectedRevision: project.revision,
        body: candidateText,
        note: '采用剧本候选'
      })
      if (result.ok) {
        hydrate(result.project)
        const version = result.project.scriptVersions.find(item => item.id === result.project.activeVersionId)
        setVersionDraft(version?.body ?? candidateText)
        setMessage('已采用为正式稿；旧分镜与提示词包已标记过期。')
        setStep(2)
      } else {
        setMessage(`采用失败：${result.message}`)
        if (result.current) hydrate(result.current)
      }
    } catch (err) {
      setMessage(`采用失败：${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }, [project, candidateText, hydrate])

  const saveVersion = useCallback(async (): Promise<void> => {
    if (!project) return
    const versionId = uuid4()
    const version = {
      id: versionId,
      number: project.scriptVersions.length + 1,
      body: versionDraft,
      note: versionNote.trim() || '手工修订',
      sourceFingerprint: project.source.sourceFingerprint,
      createdAt: new Date().toISOString()
    }
    setBusy(true)
    try {
      const result = await window.api.saveScriptProject({
        project: {
          ...project,
          scriptVersions: [...project.scriptVersions, version],
          activeVersionId: versionId
        }
      })
      if (result.ok) {
        hydrate(result.project)
        setVersionDraft(versionDraft)
        setVersionNote('')
        setMessage('已保存为新版本；旧分镜与提示词包已标记过期。')
      } else {
        setMessage(`保存冲突：${result.message}；已载入当前版本，未覆盖。`)
        hydrate(result.current)
      }
    } catch (err) {
      setMessage(`保存失败：${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }, [project, versionDraft, versionNote, hydrate])

  const onFieldChange = useCallback((unitId: string, shotIndex: number, field: ShotField, value: string): void => {
    const next = units.map(unit => unit.id !== unitId ? unit : {
      ...unit,
      shots: unit.shots.map((shot, index) => index !== shotIndex ? shot : { ...shot, [field]: value })
    })
    setUnits(next)
    setPackages([])
    // 手工编辑后必须重算硬阻断，绝不能只清空质量状态，否则非法 units 仍可保存。
    setHardIssues(storyboardHardIssues(next))
  }, [units])

  const onUnitChange = useCallback((unitId: string, patch: Partial<StoryboardUnit>): void => {
    const next = units.map(unit => unit.id === unitId ? { ...unit, ...patch,
      ...(patch.paceTier ? { paceExecution: '', paceReason: '用户指定本段节奏档位' } : {}) } : unit)
    setUnits(next)
    setPackages([])
    setHardIssues(storyboardHardIssues(next))
  }, [units])

  const saveSettings = useCallback(async (): Promise<void> => {
    if (!project || busy || handleRef.current) return
    setBusy(true)
    try {
      const result = await window.api.saveScriptProject({ project: { ...project, settings } })
      if (result.ok) {
        hydrate(result.project)
        setMessage('设置和节奏档案已保存；已有分镜需按新设置重新生成。')
      } else setMessage(`保存设置失败：${result.message}；当前设置草稿仍保留。`)
    } catch (error) { setMessage(`保存设置失败：${errorText(error)}`) }
    finally { setBusy(false) }
  }, [project, settings, busy, hydrate])

  const saveStoryboard = useCallback(async (): Promise<void> => {
    if (!project || !units.length) return
    if (!storyboardBasedOn || storyboardBasedOn.projectId !== project.id ||
      storyboardBasedOn.versionId !== project.activeVersionId ||
      storyboardBasedOn.scriptFingerprint !== project.scriptFingerprint ||
      storyboardBasedOn.sourceFingerprint !== project.source.sourceFingerprint) {
      setMessage('分镜缺少当前剧本的生成依据或已过期，请重新生成全部分镜。')
      return
    }
    // 同步护栏：即便按钮因竞态可点，也绝不把非法 units 发给主进程。
    const blocking = storyboardHardIssues(units)
    if (blocking.length > 0) {
      setHardIssues(blocking)
      setMessage(`分镜存在硬阻断，未保存：${blocking.slice(0, 3).map(item => item.message).join('；')}`)
      return
    }
    setBusy(true)
    try {
      const result = await window.api.saveScriptStoryboard({
        projectId: project.id,
        units,
        expectedRevision: project.revision,
        expectedVersionId: storyboardBasedOn.versionId,
        expectedScriptFingerprint: storyboardBasedOn.scriptFingerprint,
        expectedSourceFingerprint: storyboardBasedOn.sourceFingerprint
      })
      if (result.ok) {
        setProject(result.project)
        setStoryboardBasedOn(result.project.storyboard?.basedOn ?? null)
        setPackages([])
        setMessage('分镜已显式保存。旧提示词包已失效，请重新构建。')
        await refreshProjects()
      } else {
        const detail = result.issues?.length
          ? `（${result.issues.slice(0, 3).map(item => item.message).join('；')}）`
          : ''
        if (result.issues?.length) setHardIssues(result.issues)
        setMessage(`保存分镜失败：${result.message}${detail}；未覆盖已保存分镜。`)
        if (result.current) hydrate(result.current)
      }
    } catch (err) {
      setMessage(`保存分镜失败：${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }, [project, units, storyboardBasedOn, hydrate, refreshProjects])

  const buildPackages = useCallback(async (): Promise<void> => {
    if (!project) { setMessage('请先创建项目。'); return }
    if (JSON.stringify(units) !== JSON.stringify(project.storyboard?.units ?? [])) {
      setMessage('分镜有未保存修改，请先保存分镜再构建提示词包。'); return
    }
    setBusy(true)
    try {
      const result = await window.api.buildStudioPromptPackage({
        projectId: project.id,
        promptMode: outputMode,
        ...(packages.length ? { expectedBasedOn: basedOnFromPackage(packages[0]) } : {})
      })
      if (result.ok) {
        setPackages(result.packages)
        setMessage(`已构建 ${result.packages.length} 个提示词包（本地纯函数，无模型调用）。`)
        setStep(4)
      } else {
        setMessage(`构建失败：${result.message}`)
        setPackages([])
      }
    } catch (err) {
      setMessage(`构建失败：${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }, [project, packages, units, outputMode])

  const exportMarkdown = useCallback(async (): Promise<void> => {
    if (!project || !packages.length) return
    setBusy(true)
    try {
      const result = await window.api.exportStudioMarkdown({
        projectId: project.id,
        packages,
        preferText: isWebClient(),
        allowStale: packages.some(pkg => pkg.meta.stale)
      })
      if (!result.ok) {
        setMessage(`导出被阻断：${result.message}${result.issues.length ? `（${result.issues.map(item => item.message).slice(0, 3).join('；')}）` : ''}`)
        return
      }
      if (!('mode' in result)) { setMessage('已取消导出。'); return }
      if (result.mode === 'text') {
        downloadText(result.text, result.fileName)
        setMessage('Web 版已生成 Markdown 文本并下载。')
      } else {
        setMessage(`已导出：${result.path}`)
      }
    } catch (err) {
      setMessage(`导出失败：${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }, [project, packages])

  const stale = useMemo((): boolean => {
    if (!project?.storyboard) return false
    const basedOn = project.storyboard.basedOn
    // 与 store.isStale 的五项比对保持一致，避免 UI 把已过期产物显示为最新。
    return basedOn.versionId !== project.activeVersionId ||
      basedOn.scriptFingerprint !== project.scriptFingerprint ||
      basedOn.sourceFingerprint !== project.source.sourceFingerprint ||
      basedOn.contentFingerprint !== project.contentFingerprint ||
      basedOn.storyboardFingerprint !== project.storyboard.storyboardFingerprint
  }, [project])

  const exportBlockReasons = useMemo((): string[] => {
    const reasons: string[] = []
    for (const pkg of packages) {
      if (pkg.charCount > PROMPT_HARD_LIMIT) reasons.push(`${pkg.unitId}：单镜或当前模板仍超过 ${PROMPT_HARD_LIMIT} 字，请精简非台词描述或调整模板`)
      for (const item of pkg.quality.errors) reasons.push(`${pkg.unitId}：${item.message}`)
    }
    return reasons
  }, [packages])

  const retry = useCallback((): void => {
    if (run.kind === 'script') void generateScript()
    else void generateStoryboard(run.activeUnitId)
  }, [run, generateScript, generateStoryboard])

  const recoverText = useCallback((kind: 'script' | 'storyboard' | null, text: string): void => {
    if (!text) return
    setRecoveredText(text)
    if (kind === 'storyboard') setMessage(`已恢复 ${codePoints(text)} 字原始分镜文本，可在下方查看与复制。`)
    else {
      setCandidateText(text)
      setMessage(`已恢复 ${codePoints(text)} 字文本到剧本候选编辑框，请人工复核。`)
    }
  }, [])

  const recover = useCallback((): void => {
    recoverText(run.kind, run.retainedText || streamText)
  }, [run, streamText, recoverText])

  return (
    <div className="ss-page">
      <div className="page-head page-head-row">
        <div>
          <h1>剧本创作</h1>
          <p className="desc">小说选材、剧本写作、分镜制作与视频提示词导出。</p>
        </div>
        <div className="ss-actions">
          <select aria-label="已有剧本项目" className="select" disabled={busy} value={project?.id ?? ''} onChange={event => { if (event.target.value) void openProject(event.target.value) }}>
            <option value="">已有项目（{projects.length}）</option>
            {projects.map(item => <option key={item.id} value={item.id}>{item.title} · v{item.revision}</option>)}
          </select>
          {step !== 1 ? <button type="button" className="btn" disabled={busy} onClick={() => setStep(1)}>选材与项目设置</button> : null}
        </div>
      </div>

      <StepNav step={step} onChange={setStep} stale={stale} />
      <StatusBar
        run={run}
        streamText={streamText}
        onStop={() => void stop()}
        onRetry={retry}
        onRecover={recover}
      />
      {message ? <div className="ss-message" role="status">{message}</div> : null}
      {history.length ? (
        <div className="ss-card">
          <h2>可恢复的生成记录</h2>
          <p className="ss-muted">以下记录已停止，不会后台续跑。</p>
          {history.map(item => (
            <div key={item.runId} className="ss-actions">
              <span>{item.kind === 'script' ? '剧本' : '分镜'} · {new Date(item.updatedAt).toLocaleString('zh-CN')}</span>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => recoverText(item.kind, item.retainedText || item.partialText)}>恢复此记录文本</button>
            </div>
          ))}
        </div>
      ) : null}
      {recoveredText ? (
        <div className="ss-card">
          <label htmlFor="ss-recovered-text">已恢复的原始文本</label>
          <textarea id="ss-recovered-text" className="textarea" rows={10} value={recoveredText} readOnly />
          <button type="button" className="btn btn-sm" onClick={() => void copyText(recoveredText)}>复制恢复文本</button>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="ss-stack">
          <SourcePicker draft={draft} setDraft={setDraft} onMessage={setMessage} />
          <SettingsBar settings={settings} setSettings={setSettings} />
          <div className="ss-workbar ss-actions ss-actions-end">
            {project && JSON.stringify(settings) !== JSON.stringify(project.settings) ? <span className="ss-save-state ss-save-state-dirty">设置有未保存修改</span> : null}
            <button type="button" className={project ? 'btn' : 'btn btn-primary'} disabled={busy || !draft.text.trim()} onClick={() => void createProject()}>{project ? '创建副本并进入剧本' : '创建并进入剧本'}</button>
            {project ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void saveSettings()}>保存当前项目设置</button> : null}
            {project ? <button type="button" className="btn" onClick={() => setStep(2)}>回到当前项目剧本</button> : null}
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <ScriptStep
          project={project}
          candidateText={candidateText}
          setCandidateText={setCandidateText}
          versionDraft={versionDraft}
          setVersionDraft={setVersionDraft}
          versionNote={versionNote}
          setVersionNote={setVersionNote}
          onGenerate={() => void generateScript()}
          onAdopt={() => void adoptCandidate()}
          onSaveVersion={() => void saveVersion()}
          onCopy={text => void copyText(text)}
          busy={busy}
          stale={stale}
        />
      ) : null}

      {step === 3 ? (
        <ScriptStoryboardWorkspace
          key={project?.id ?? 'new'}
          fields={SHOT_FIELDS}
          labels={SHOT_LABELS}
          dirty={JSON.stringify(units) !== JSON.stringify(project?.storyboard?.units ?? [])}
          project={project}
          units={units}
          quality={storyboardQuality}
          hardIssues={hardIssues}
          onFieldChange={onFieldChange}
          onUnitChange={onUnitChange}
          saveBlocked={!project || !storyboardBasedOn || storyboardBasedOn.projectId !== project.id ||
            storyboardBasedOn.versionId !== project.activeVersionId || storyboardBasedOn.scriptFingerprint !== project.scriptFingerprint ||
            storyboardBasedOn.sourceFingerprint !== project.source.sourceFingerprint}
          onRegenerate={unitId => void generateStoryboard(unitId)}
          onGenerateAll={() => void generateStoryboard()}
          onSave={() => void saveStoryboard()}
          busy={busy}
          stale={stale}
        />
      ) : null}

      {step === 4 ? (
        <PromptStep
          key={project?.id ?? 'new'}
          packages={packages}
          outputMode={outputMode}
          onModeChange={mode => { setOutputMode(mode); setPackages([]) }}
          buildBlockedReason={!project?.storyboard ? '请先生成并保存分镜。' :
            JSON.stringify(units) !== JSON.stringify(project.storyboard.units) ? '分镜有未保存修改，请先保存分镜再构建提示词包。' :
              stale ? '已保存分镜基于旧版本，请重新生成并保存分镜。' : ''}
          onBuild={() => void buildPackages()}
          onCopy={text => void copyText(text)}
          onExport={() => void exportMarkdown()}
          busy={busy}
          exportBlocked={exportBlockReasons.length > 0}
          blockReasons={exportBlockReasons}
        />
      ) : null}
    </div>
  )
}

/** 从已构建包的元信息还原 basedOn，供「构建新提示词包」时做过期硬拒。 */
function basedOnFromPackage(pkg: PromptPackage): BasedOn {
  return {
    projectId: pkg.meta.projectId,
    projectName: pkg.meta.projectName,
    versionId: pkg.meta.versionId,
    versionNumber: pkg.meta.versionNumber,
    contentFingerprint: pkg.meta.contentFingerprint,
    scriptFingerprint: pkg.meta.scriptFingerprint,
    storyboardFingerprint: pkg.meta.storyboardFingerprint,
    sourceFingerprint: pkg.meta.sourceFingerprint,
    scriptRevision: pkg.meta.scriptRevision,
    unitId: pkg.meta.unitId,
    stale: pkg.meta.stale,
    ...(pkg.meta.staleReason ? { staleReason: pkg.meta.staleReason } : {}),
    generatedAt: pkg.meta.generatedAt
  }
}
