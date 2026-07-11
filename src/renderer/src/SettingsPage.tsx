import { useEffect, useRef, useState } from 'react'
import type {
  UsageSummary,
  ListProvidersResult,
  ProviderSummary,
  ProviderProtocol,
  ProjectUsage,
  ChapterUsage,
  ChapterRuleSectionView,
  DeslopRuleSectionView,
  DeslopLockedSectionView,
  ReviewCheckSectionView,
  ReviewRulesConfig,
  ReviewCheckId,
  AuditCategory
} from '../../shared/types'
import {
  DEFAULT_WRITING_REQUIREMENT_TEMPLATES,
  normalizeWritingRequirementLines,
  type WritingRequirementTemplate
} from '../../shared/writing-requirement-templates'

interface Props {
  onBack?: () => void
}

type ThemeMode = 'light' | 'dark' | 'system'

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}
function fmtCost(n: number): string {
  if (n >= 1) return '¥' + n.toFixed(2)
  if (n >= 0.01) return '¥' + n.toFixed(3)
  return '¥' + n.toFixed(4)
}

function newId(): string {
  // 浏览器 / Electron 渲染层都有 crypto.randomUUID
  return 'p_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

/** 由小节清单 + 覆盖表合成草稿：覆盖优先，否则内置默认（空串=停用会保留） */
function mergeRuleDrafts(
  sections: ChapterRuleSectionView[],
  overrides: Record<string, string>
): Record<string, string> {
  const drafts: Record<string, string> = {}
  for (const s of sections) drafts[s.key] = overrides[s.key] ?? s.defaultText
  return drafts
}

/** 去 AI 味规则：由分节清单 + 覆盖表合成文本草稿（逻辑同 mergeRuleDrafts，类型独立） */
function mergeDeslopDrafts(
  sections: DeslopRuleSectionView[],
  overrides: Record<string, string>
): Record<string, string> {
  const drafts: Record<string, string> = {}
  for (const s of sections) drafts[s.key] = overrides[s.key] ?? s.defaultText
  return drafts
}

/**
 * 把 AI 输出的完整 Markdown 解析回各分节草稿 + 禁用词。
 * 与 main 端 parseDeslopRulesFromMd 逻辑一致（按 ## 二级标题切节），前端独立实现避免类型穿透。
 * 只识别已知的节标题，未知节丢弃。
 */
function parseDeslopRulesMd(
  md: string,
  sections: DeslopRuleSectionView[]
): { overrides: Record<string, string>; bannedWords: string[] } {
  const titleByKey = new Map(sections.map((s) => [s.title, s.key]))
  const overrides: Record<string, string> = {}
  let bannedWords: string[] = []
  const lines = md.split(/\r?\n/)
  let curTitle = ''
  let curBody: string[] = []
  const flush = (): void => {
    if (!curTitle) return
    const body = curBody.join('\n').replace(/\s+$/u, '')
    if (curTitle === '禁用词表（每行一个词）') {
      const seen = new Set<string>()
      const words: string[] = []
      for (const raw of body.split(/\r?\n/)) {
        const w = raw.trim()
        if (!w || seen.has(w)) continue
        seen.add(w)
        words.push(w)
      }
      bannedWords = words
      return
    }
    const key = titleByKey.get(curTitle)
    if (key) overrides[key] = body
  }
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/u.exec(line)
    if (m) {
      flush()
      curTitle = m[1].trim()
      curBody = []
    } else if (curTitle) {
      curBody.push(line)
    }
  }
  flush()
  return { overrides, bannedWords }
}

export default function SettingsPage(_: Props) {
  const [activeTab, setActiveTab] = useState('appearance')
  const writingTemplateApi = window.api as typeof window.api & {
    getWritingRequirementTemplates?: () => Promise<WritingRequirementTemplate[]>
    setWritingRequirementTemplates?: (
      templates: WritingRequirementTemplate[]
    ) => Promise<WritingRequirementTemplate[]>
  }

  const TABS = [
    { id: 'appearance', label: '外观' },
    { id: 'storage', label: '保存位置' },
    { id: 'model', label: '模型服务' },
    { id: 'usage', label: '用量与费用' },
    { id: 'aiwords', label: 'AI 高频词' },
    { id: 'writing', label: '写作节奏' },
    { id: 'writingReq', label: '写作要求' },
    { id: 'writingRules', label: '续写规则' },
    { id: 'deslopRules', label: '去AI味规则' },
    { id: 'reviewRules', label: '审稿规则' }
  ] as const

  // list 接口返回的是脱敏的 ProviderSummary（没有 apiKey）
  const [providers, setProviders] = useState<ListProvidersResult>({
    activeId: '',
    providers: []
  })
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [projectsRoot, setProjectsRoot] = useState('')
  const [changingPath, setChangingPath] = useState(false)
  const [pinging, setPinging] = useState(false)
  const [pingResult, setPingResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [theme, setTheme] = useState<ThemeMode>('system')
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  // P13-C + P14-C：用量预警配置
  const [costAlert, setCostAlert] = useState<{
    enabled: boolean
    warning: number
    exceeded: number
    blockOnExceeded: boolean
  }>({
    enabled: true,
    warning: 10,
    exceeded: 30,
    blockOnExceeded: false
  })
  const [pricing, setPricing] = useState({ inputRate: 1, outputRate: 3 })
  const [dailyGoal, setDailyGoal] = useState(3000)

  // 番茄钟默认值
  const DEFAULT_POMODORO_FOCUS_MINUTES = 25
  const DEFAULT_POMODORO_BREAK_MINUTES = 5

  const [pomoFocus, setPomoFocus] = useState(DEFAULT_POMODORO_FOCUS_MINUTES)
  const [pomoBreak, setPomoBreak] = useState(DEFAULT_POMODORO_BREAK_MINUTES)

  /** AI 高频词配置状态 */
  const [aiHighFreq, setAiHighFreq] = useState<{
    enabled: boolean
    words: { word: string; example?: string }[]
  }>({ enabled: true, words: [] })
  const [writingTemplates, setWritingTemplates] = useState<WritingRequirementTemplate[]>(
    DEFAULT_WRITING_REQUIREMENT_TEMPLATES
  )
  const [expandedTemplateId, setExpandedTemplateId] = useState<string | null>(
    DEFAULT_WRITING_REQUIREMENT_TEMPLATES[0]?.id ?? null
  )
  // 续写规则分节编辑：内置小节清单 + 本地草稿（预填生效正文）
  const [ruleSections, setRuleSections] = useState<ChapterRuleSectionView[]>([])
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, string>>({})

  // 去 AI 味规则：可编辑分节草稿 + 只读锁定区 + 禁用词草稿 + AI 改写相关
  const [deslopSections, setDeslopSections] = useState<DeslopRuleSectionView[]>([])
  const [deslopLockedSections, setDeslopLockedSections] = useState<DeslopLockedSectionView[]>([])
  const [deslopDrafts, setDeslopDrafts] = useState<Record<string, string>>({})
  const [deslopBannedDraft, setDeslopBannedDraft] = useState('')
  const [deslopEditInstruction, setDeslopEditInstruction] = useState('')
  const [deslopEditing, setDeslopEditing] = useState(false)
  const [deslopEditPreview, setDeslopEditPreview] = useState('')
  const deslopEditGenRef = useRef(0)
  const refreshAiHighFreq = () => void window.api.getAiHighFreqConfig().then(setAiHighFreq)
  // 审稿规则：检查项清单（含默认信息）+ 当前配置（开关/阈值/词表本地草稿）
  const [reviewSections, setReviewSections] = useState<ReviewCheckSectionView[]>([])
  const [reviewCfg, setReviewCfg] = useState<ReviewRulesConfig | null>(null)
  // 阈值/词表本地草稿：用户编辑时不立即落盘，点「保存」才写
  const [reviewThresholdDraft, setReviewThresholdDraft] = useState({
    minWords: 2300,
    maxWords: 3500,
    maxParagraphLen: 300,
    dashDensityPer100: 2,
    repetitionLen: 8,
    maxSentenceLen: 80
  })
  const [reviewMetaDraft, setReviewMetaDraft] = useState('')
  const [reviewSensitiveDraft, setReviewSensitiveDraft] = useState('')
  // 检查项 CRUD：编辑中的 checkId / 编辑草稿 / 待二次确认删除 / 已隐藏项
  const [hiddenSections, setHiddenSections] = useState<{ checkId: string; label: string }[]>([])
  const [editingCheckId, setEditingCheckId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<{ label: string; hint: string; severity: 'error' | 'warn' | 'info' }>({
    label: '', hint: '', severity: 'warn'
  })
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  // 新增自定义检查项表单
  const [showAddForm, setShowAddForm] = useState(false)
  const [addDraft, setAddDraft] = useState<{
    label: string
    hint: string
    severity: 'error' | 'warn' | 'info'
    type: 'keyword' | 'regex' | 'llm'
    group: string
    keywords: string
    pattern: string
    prompt: string
  }>({
    label: '', hint: '', severity: 'warn', type: 'keyword',
    group: 'toxic', keywords: '', pattern: '', prompt: ''
  })
  const [regexValid, setRegexValid] = useState<{ ok: boolean; err?: string }>({ ok: true })
  const refreshWritingTemplates = () => {
    if (typeof writingTemplateApi.getWritingRequirementTemplates !== 'function') {
      setWritingTemplates(DEFAULT_WRITING_REQUIREMENT_TEMPLATES)
      return
    }
    void writingTemplateApi.getWritingRequirementTemplates().then(setWritingTemplates)
  }
  const refreshChapterRules = () => {
    void window.api.getChapterRules().then((bundle) => {
      setRuleSections(bundle.sections)
      setRuleDrafts(mergeRuleDrafts(bundle.sections, bundle.overrides))
    })
  }
  const refreshDeslopRules = () => {
    void window.api.getDeslopRules().then((bundle) => {
      setDeslopSections(bundle.sections)
      setDeslopLockedSections(bundle.lockedSections)
      setDeslopDrafts(mergeDeslopDrafts(bundle.sections, bundle.overrides))
      setDeslopBannedDraft(bundle.bannedWords.join('\n'))
    })
  }
  const refreshReviewRules = () => {
    void window.api.getReviewRules().then((bundle) => {
      setReviewSections(bundle.sections)
      setHiddenSections(bundle.hiddenSections ?? [])
      setReviewCfg(bundle.config)
      setReviewThresholdDraft({ ...bundle.config.thresholds })
      setReviewMetaDraft(bundle.config.wordLists.metaBreak.join('\n'))
      setReviewSensitiveDraft(bundle.config.wordLists.sensitive.join('\n'))
    })
  }

  useEffect(() => {
    setExpandedTemplateId((cur) =>
      writingTemplates.some((t) => t.id === cur) ? cur : (writingTemplates[0]?.id ?? null)
    )
  }, [writingTemplates])

  const refreshProviders = () => void window.api.listProviders().then(setProviders)
  const refreshRoot = () => void window.api.getProjectsRoot().then(setProjectsRoot)
  const refreshUsage = () => void window.api.getUsageSummary().then(setUsage)
  const refreshCostAlert = () => void window.api.getCostAlertConfig().then(setCostAlert)
  // P17-A：按项目 / 按章节聚合
  const [byProject, setByProject] = useState<ProjectUsage[]>([])
  const [byChapter, setByChapter] = useState<ChapterUsage[]>([])
  const refreshByProject = () => void window.api.getUsageByProject().then(setByProject)
  const refreshByChapter = () => void window.api.getUsageByChapter().then(setByChapter)

  useEffect(() => {
    refreshProviders()
    refreshRoot()
    refreshUsage()
    refreshCostAlert()
    refreshAiHighFreq()
    refreshWritingTemplates()
    refreshChapterRules()
    refreshDeslopRules()
    refreshReviewRules()
    refreshByProject()
    refreshByChapter()
    void window.api.getTheme().then(setTheme)
    void window.api.getPricing().then(setPricing)
    void window.api.getDailyWordGoal().then(setDailyGoal)
    void window.api.getPomodoroConfig().then((cfg) => {
      setPomoFocus(cfg.focus)
      setPomoBreak(cfg.brk)
    })
  }, [])

  const applyTheme = (t: ThemeMode) => {
    const root = document.documentElement
    const resolve = (): 'light' | 'dark' =>
      t === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : t
    if (resolve() === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
  }

  const onThemeChange = (t: ThemeMode) => {
    setTheme(t)
    applyTheme(t)
    void window.api.setTheme(t)
  }

  const ping = async () => {
    setPinging(true)
    setPingResult(null)
    try {
      const r = await window.api.pingLlm()
      if (r.ok) {
        setPingResult({
          ok: true,
          text: `✓ 连通 · ${r.providerLabel ?? ''} · 模型 ${r.model ?? 'unknown'}`
        })
      } else {
        const map: Record<string, string> = {
          NO_KEY: '尚未配置 API Key',
          LLM_NOT_CONFIGURED: '尚未配置 provider',
          LLM_AUTH_FAILED: '认证失败，请检查 API Key 或 CLI 登录状态',
          LLM_RATE_LIMIT: '请求过于频繁',
          LLM_TIMEOUT: '连通测试超时',
          LLM_REQUEST_FAILED: '请求失败',
          NETWORK_ERROR: '网络错误',
          AGY_NOT_FOUND: '未检测到 agy CLI，请先安装并运行 agy 登录',
          AGY_SPAWN_FAILED: 'agy CLI 启动失败',
          CODEX_NOT_FOUND: '未检测到 codex CLI，请先安装并运行 codex login',
          CODEX_MODEL_ERROR: 'codex 模型配置有误'
        }
        const err = r.error ?? ''
        // 精确匹配优先，再尝试前缀匹配（AGY_ERROR: xxx / CODEX_ERROR: xxx）
        let msg = map[err]
        if (!msg) {
          if (err.startsWith('AGY_ERROR: ')) msg = `agy 出错：${err.slice(11).slice(0, 80)}`
          else if (err.startsWith('CODEX_ERROR: ')) msg = `codex 出错：${err.slice(13).slice(0, 80)}`
          else msg = err || '未知错误'
        }
        setPingResult({ ok: false, text: '✗ ' + msg })
      }
    } catch {
      setPingResult({ ok: false, text: '✗ 测试失败' })
    } finally {
      setPinging(false)
    }
  }

  const selectSavePath = async () => {
    setChangingPath(true)
    try {
      const selected = await window.api.selectDirectory()
      if (selected) {
        await window.api.setProjectsRoot(selected)
        setProjectsRoot(selected)
        setMsg({ kind: 'ok', text: '保存位置已更新' })
      }
    } finally {
      setChangingPath(false)
    }
  }

  const activeProvider = providers.providers.find((p) => p.id === providers.activeId) ?? null

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>设置</h1>
            <p className="desc">外观、保存位置、模型服务、用量与写作节奏</p>
          </div>
        </div>
      </div>

      <div className="settings-layout">
        <nav className="settings-tabs">
          {TABS.map(tab => (
            <button
              key={tab.id}
              className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {/* 全局消息提示 */}
          {msg ? (
            <p
              style={{
                color: msg.kind === 'ok' ? 'var(--success)' : 'var(--danger)',
                marginBottom: 14,
                fontSize: 13
              }}
            >
              {msg.text}
            </p>
          ) : null}

          {activeTab === 'appearance' && (
            <div className="card" style={{ maxWidth: 600 }}>
              <h3 className="sub">外观</h3>
              <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>
                切换浅色/深色主题，或跟随系统设置。
              </p>
              <div className="theme-toggle" style={{ marginTop: 8 }}>
                <button
                  className={theme === 'light' ? 'active' : ''}
                  onClick={() => onThemeChange('light')}
                >
                  ☀ 浅色
                </button>
                <button
                  className={theme === 'dark' ? 'active' : ''}
                  onClick={() => onThemeChange('dark')}
                >
                  ☾ 深色
                </button>
                <button
                  className={theme === 'system' ? 'active' : ''}
                  onClick={() => onThemeChange('system')}
                >
                  ◐ 跟随系统
                </button>
              </div>
            </div>
          )}

          {activeTab === 'storage' && (
            <div className="card" style={{ maxWidth: 600 }}>
              <div className="row" style={{ marginBottom: 4 }}>
                <h3 className="sub" style={{ margin: 0 }}>书籍保存位置</h3>
              </div>
              <p
                className="muted"
                style={{ wordBreak: 'break-all', marginBottom: 10, fontSize: 13 }}
              >
                {projectsRoot || '加载中…'}
              </p>
              <button className="btn btn-ghost" onClick={selectSavePath} disabled={changingPath}>
                {changingPath ? '选择中…' : '更改保存位置'}
              </button>
              <p className="meta" style={{ marginTop: 10 }}>
                新建项目将保存到此位置。已有项目不受影响。
              </p>
            </div>
          )}

          {activeTab === 'model' && (
            <div className="card" style={{ maxWidth: 600 }}>
              <div className="row" style={{ marginBottom: 4 }}>
                <h3 className="sub" style={{ margin: 0 }}>模型服务</h3>
                {activeProvider ? (
                  <span className="chip chip-success" style={{ marginLeft: 8 }}>
                    ✓ {activeProvider.label}
                  </span>
                ) : (
                  <span className="chip chip-warning" style={{ marginLeft: 8 }}>
                    未配置
                  </span>
                )}
              </div>
              <p className="muted" style={{ marginTop: 6, fontSize: 13 }}>
                用于大纲生成、细纲生成、章节续写、改稿。支持 OpenAI Chat
                Completions 兼容协议（POST <code>{'{baseUrl}'}/chat/completions</code>）和
                Anthropic Messages API（POST <code>{'{baseUrl}'}/v1/messages</code>）。
              </p>

              {/* provider 列表 */}
              {providers.providers.length > 0 ? (
                <ul className="bare" style={{ marginTop: 12 }}>
                  {providers.providers.map((p) => (
                    <ProviderRow
                      key={p.id}
                      provider={p}
                      active={p.id === providers.activeId}
                      onActivate={async () => {
                        await window.api.setActiveProvider(p.id)
                        setMsg({ kind: 'ok', text: `已切换到「${p.label}」` })
                        refreshProviders()
                      }}
                      onDelete={async () => {
                        if (!window.confirm(`删除 provider「${p.label}」？`)) return
                        await window.api.deleteProvider(p.id)
                        refreshProviders()
                      }}
                    />
                  ))}
                </ul>
              ) : (
                <div className="placeholder" style={{ padding: 16 }}>
                  尚未添加任何 provider，请在下方填写表单添加。
                </div>
              )}

              {/* 联通测试 */}
              <div className="row" style={{ gap: 8, marginTop: 14 }}>
                <button className="btn" onClick={ping} disabled={pinging || !activeProvider?.hasKey}>
                  {pinging ? '测试中…' : '测试当前连通'}
                </button>
              </div>
              {pingResult ? (
                <p
                  style={{
                    color: pingResult.ok ? 'var(--success)' : 'var(--danger)',
                    marginTop: 10,
                    fontSize: 13,
                    fontFamily: 'ui-monospace, Consolas, monospace'
                  }}
                >
                  {pingResult.text}
                </p>
              ) : null}

              {/* 新增 / 编辑 provider 表单 */}
              <hr className="soft" />
              <h3 className="sub" style={{ fontSize: 14 }}>添加 provider</h3>
              <NewProviderForm
                onCreated={() => {
                  refreshProviders()
                  setMsg({ kind: 'ok', text: '已保存' })
                }}
              />

              <p className="meta" style={{ marginTop: 16 }}>
                Key 经 Electron safeStorage（Windows DPAPI / macOS Keychain）加密后存于本地{' '}
                <code>config/providers.enc</code>，源码不含任何密钥。
              </p>
            </div>
          )}

          {activeTab === 'usage' && (
            <div className="card" style={{ maxWidth: 600 }}>
              <div className="row" style={{ marginBottom: 4 }}>
                <h3 className="sub" style={{ margin: 0 }}>用量与费用</h3>
                <button className="btn btn-ghost btn-sm" onClick={refreshUsage}>
                  刷新
                </button>
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                统计本地记录的所有 AI 调用，费用按下方价格估算。
              </p>
              {usage ? (
                <>
                  <div className="usage-grid">
                    <div className="usage-cell">
                      <div className="label">今日</div>
                      <div className="tokens">{fmtTokens(usage.today.total)}</div>
                      <div className="cost">{fmtCost(usage.today.cost)}</div>
                    </div>
                    <div className="usage-cell">
                      <div className="label">本月</div>
                      <div className="tokens">{fmtTokens(usage.month.total)}</div>
                      <div className="cost">{fmtCost(usage.month.cost)}</div>
                    </div>
                    <div className="usage-cell">
                      <div className="label">累计</div>
                      <div className="tokens">{fmtTokens(usage.allTime.total)}</div>
                      <div className="cost">{fmtCost(usage.allTime.cost)}</div>
                    </div>
                  </div>
                  {usage.byFeature.length > 0 ? (
                    <div style={{ marginTop: 12 }}>
                      <strong style={{ fontSize: 12.5 }}>按功能分布</strong>
                      {(() => {
                        const max = Math.max(...usage.byFeature.map((f) => f.total), 1)
                        return usage.byFeature.map((f) => (
                          <div key={f.feature} className="usage-feature-row">
                            <span style={{ minWidth: 72 }}>{f.feature}</span>
                            <div className="bar-wrap">
                              <div
                                className="bar-fill"
                                style={{ width: `${(f.total / max) * 100}%` }}
                              />
                            </div>
                            <span className="meta" style={{ minWidth: 90, textAlign: 'right' }}>
                              {fmtTokens(f.total)} · {fmtCost(f.cost)} · {f.calls}次
                            </span>
                          </div>
                        ))
                      })()}
                    </div>
                  ) : null}
                  <div className="row" style={{ marginTop: 12 }}>
                    <span className="meta">价格（元 / 百万 token，仅用于估算）</span>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        if (!window.confirm('清空所有用量记录？此操作不可撤销。')) return
                        await window.api.clearUsage()
                        refreshUsage()
                        refreshByProject()
                        refreshByChapter()
                      }}
                    >
                      清空记录
                    </button>
                  </div>
                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    <label className="field" style={{ flex: 1, margin: 0 }}>
                      <span className="meta">输入</span>
                      <input
                        className="input"
                        type="number"
                        step="0.1"
                        value={pricing.inputRate}
                        onChange={(e) => setPricing({ ...pricing, inputRate: Number(e.target.value) })}
                      />
                    </label>
                    <label className="field" style={{ flex: 1, margin: 0 }}>
                      <span className="meta">输出</span>
                      <input
                        className="input"
                        type="number"
                        step="0.1"
                        value={pricing.outputRate}
                        onChange={(e) => setPricing({ ...pricing, outputRate: Number(e.target.value) })}
                      />
                    </label>
                    <button
                      className="btn btn-sm"
                      style={{ alignSelf: 'flex-end' }}
                      onClick={async () => {
                        const next = await window.api.setPricing(pricing)
                        setPricing(next)
                        refreshUsage()
                        setMsg({ kind: 'ok', text: '价格已更新' })
                      }}
                    >
                      保存价格
                    </button>
                  </div>
                </>
              ) : (
                <div className="placeholder" style={{ padding: 12 }}>加载中…</div>
              )}

              {/* P13-C：用量预警阈值配置 */}
              <div className="cost-alert-config" style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
                <h4 style={{ margin: '0 0 6px', fontSize: 12.5 }}>用量预警阈值</h4>
                <p className="muted" style={{ fontSize: 11.5, margin: '0 0 8px' }}>
                  当月 AI 费用达到阈值时弹 toast 提醒。warning 是温和提醒，exceeded 是强警告。
                </p>
                <div className="row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
                    <input
                      type="checkbox"
                      checked={costAlert.enabled}
                      onChange={(e) => setCostAlert({ ...costAlert, enabled: e.target.checked })}
                    />
                    启用预警
                  </label>
                  <label className="row" style={{ gap: 4, fontSize: 12.5 }}>
                    warning ¥
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={costAlert.warning}
                      onChange={(e) => setCostAlert({ ...costAlert, warning: Number(e.target.value) || 0 })}
                      style={{ width: 60 }}
                      disabled={!costAlert.enabled}
                    />
                  </label>
                  <label className="row" style={{ gap: 4, fontSize: 12.5 }}>
                    exceeded ¥
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={costAlert.exceeded}
                      onChange={(e) => setCostAlert({ ...costAlert, exceeded: Number(e.target.value) || 0 })}
                      style={{ width: 60 }}
                      disabled={!costAlert.enabled}
                    />
                  </label>
                  <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
                    <input
                      type="checkbox"
                      checked={costAlert.blockOnExceeded}
                      onChange={(e) => setCostAlert({ ...costAlert, blockOnExceeded: e.target.checked })}
                      disabled={!costAlert.enabled}
                    />
                    exceeded 时弹确认（用户可取消）
                  </label>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={async () => {
                      if (costAlert.warning >= costAlert.exceeded) {
                        setMsg({ kind: 'err', text: 'warning 必须小于 exceeded' })
                        return
                      }
                      setMsg(null)
                      const next = await window.api.setCostAlertConfig(costAlert)
                      setCostAlert(next)
                      setMsg({ kind: 'ok', text: '预警配置已保存' })
                      setTimeout(() => setMsg(null), 2000)
                    }}
                  >
                    保存阈值
                  </button>
                  {msg && msg.kind === 'ok' ? <span className="muted" style={{ fontSize: 12 }}>{msg.text}</span> : null}
                  {msg && msg.kind === 'err' && msg.text.includes('warning') ? (
                    <span style={{ color: 'var(--danger)', fontSize: 12 }}>{msg.text}</span>
                  ) : null}
                </div>
              </div>

              {/* P17-A：按项目 / 按章节 用量统计 */}
              <div
                className="by-project-stats"
                style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}
              >
                <h4 style={{ margin: '0 0 6px', fontSize: 12.5 }}>按项目统计</h4>
                {byProject.length === 0 ? (
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    还没有项目用量记录（开始续写后会自动汇总）
                  </div>
                ) : (
                  <ul className="by-project-list">
                    {byProject.map((p) => (
                      <li key={p.projectId} className="by-project-row">
                        <span className="project-id" title={p.projectId}>
                          {p.projectId.length > 20 ? p.projectId.slice(0, 20) + '…' : p.projectId}
                        </span>
                        <span className="meta">
                          {(p.total / 1000).toFixed(1)}k ·{' '}
                          {p.cost < 1 ? `¥${p.cost.toFixed(3)}` : `¥${p.cost.toFixed(2)}`} · {p.calls}次
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <h4 style={{ margin: '12px 0 6px', fontSize: 12.5 }}>按章节统计</h4>
                {byChapter.length === 0 ? (
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    还没有章节用量记录
                  </div>
                ) : (
                  <ul className="by-project-list">
                    {byChapter.slice(0, 10).map((c) => (
                      <li key={`${c.projectId}-${c.chapterNumber}`} className="by-project-row">
                        <span className="project-id" title={c.projectId}>
                          {c.projectId.length > 14 ? c.projectId.slice(0, 14) + '…' : c.projectId}
                        </span>
                        <span className="chapter-tag">第 {c.chapterNumber} 章</span>
                        <span className="meta">
                          {(c.total / 1000).toFixed(1)}k ·{' '}
                          {c.cost < 1 ? `¥${c.cost.toFixed(3)}` : `¥${c.cost.toFixed(2)}`} · {c.calls}次
                        </span>
                      </li>
                    ))}
                    {byChapter.length > 10 && (
                      <li className="muted" style={{ fontSize: 11, padding: '4px 0' }}>
                        …还有 {byChapter.length - 10} 章未展示
                      </li>
                    )}
                  </ul>
                )}
              </div>
            </div>
          )}

          {activeTab === 'aiwords' && (
            <div className="card" style={{ maxWidth: 600 }}>
              <div className="row" style={{ alignItems: 'center', marginBottom: 4 }}>
                <h3 className="sub" style={{ margin: 0 }}>AI 高频词</h3>
                <label
                  className="row"
                  style={{ gap: 6, fontSize: 12.5, marginLeft: 'auto', alignItems: 'center' }}
                >
                  <input
                    type="checkbox"
                    checked={aiHighFreq.enabled}
                    onChange={(e) => {
                      const next = { ...aiHighFreq, enabled: e.target.checked }
                      setAiHighFreq(next)
                      void window.api.setAiHighFreqConfig({ enabled: e.target.checked })
                    }}
                  />
                  启用高亮
                </label>
              </div>
              <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                配置 AI 常见高频词（如"微微一笑"、"眉头一皱"），正文会高亮匹配；并为每个词附一句改写范例便于润色。
              </p>
              <AiHighFreqEditor
                words={aiHighFreq.words}
                disabled={!aiHighFreq.enabled}
                onChange={(words) => {
                  const next = { ...aiHighFreq, words }
                  setAiHighFreq(next)
                }}
                onSave={async (words) => {
                  const saved = await window.api.setAiHighFreqConfig({ words })
                  setAiHighFreq(saved)
                  setMsg({ kind: 'ok', text: 'AI 高频词已保存' })
                }}
              />
            </div>
          )}

          {activeTab === 'writing' && (
            <div className="card" style={{ maxWidth: 600 }}>
              <h3 className="sub">写作节奏</h3>
              <div className="field" style={{ marginTop: 8 }}>
                <label>每日字数目标</label>
                <div className="row" style={{ gap: 8 }}>
                  <input
                    className="input"
                    type="number"
                    step="100"
                    value={dailyGoal}
                    onChange={(e) => setDailyGoal(Number(e.target.value))}
                    style={{ flex: 1 }}
                  />
                  <button
                    className="btn btn-sm"
                    onClick={async () => {
                      await window.api.setDailyWordGoal(dailyGoal)
                      setMsg({ kind: 'ok', text: '目标已保存' })
                    }}
                  >
                    保存
                  </button>
                </div>
              </div>
              <div className="row" style={{ gap: 12 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label>专注分钟</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={pomoFocus}
                    onChange={(e) => setPomoFocus(Number(e.target.value))}
                  />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>休息分钟</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={pomoBreak}
                    onChange={(e) => setPomoBreak(Number(e.target.value))}
                  />
                </div>
              </div>
              <button
                className="btn btn-sm"
                onClick={async () => {
                  const next = await window.api.setPomodoroConfig({
                    focus: pomoFocus,
                    brk: pomoBreak
                  })
                  setPomoFocus(next.focus)
                  setPomoBreak(next.brk)
                  setMsg({ kind: 'ok', text: '番茄钟已保存' })
                }}
              >
                保存番茄钟
              </button>
            </div>
          )}

          {activeTab === 'writingReq' && (
            <div className="card" style={{ maxWidth: 600 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h3 className="sub" style={{ margin: 0, fontSize: 15 }}>长期写作要求模板</h3>
                  <p className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>
                    这里维护的是全局模板。章节页里的“长期写作要求”会读取这里的模板列表。
                  </p>
                </div>
                <div className="btn-group">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      const id = newId()
                      setWritingTemplates((prev) => [
                        ...prev,
                        {
                          id,
                          name: '新模板',
                          description: '',
                          requirements: ['']
                        }
                      ])
                      setExpandedTemplateId(id)
                    }}
                  >
                    新增模板
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={async () => {
                      const normalized = writingTemplates
                        .map((item) => ({
                          ...item,
                          id: item.id.trim() || newId(),
                          name: item.name.trim(),
                          description: item.description.trim(),
                          requirements: normalizeWritingRequirementLines(
                            item.requirements.join('\n')
                          )
                        }))
                      const invalidTemplate = normalized.find(
                        (item) => !item.name || item.requirements.length === 0
                      )
                      if (invalidTemplate) {
                        setMsg({
                          kind: 'err',
                          text: '请先补全每个模板的名称和要求列表，再保存模板。'
                        })
                        return
                      }
                      if (typeof writingTemplateApi.setWritingRequirementTemplates !== 'function') {
                        setMsg({
                          kind: 'err',
                          text: '当前应用还没加载到新的模板设置接口，请重启桌面应用后再试。'
                        })
                        return
                      }
                      try {
                        const saved = await writingTemplateApi.setWritingRequirementTemplates(
                          normalized
                        )
                        setWritingTemplates(saved)
                        setMsg({ kind: 'ok', text: '写作模板已保存' })
                      } catch (err) {
                        setMsg({
                          kind: 'err',
                          text: `写作模板保存失败：${err instanceof Error ? err.message : String(err)}`
                        })
                      }
                    }}
                  >
                    保存模板
                  </button>
                </div>
              </div>

              <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
                {writingTemplates.map((template, index) => {
                  const isOpen = expandedTemplateId === template.id
                  const summary =
                    template.description.trim() ||
                    template.requirements.find((r) => r.trim()) ||
                    '暂无要求'
                  return (
                    <div
                      key={template.id}
                      className="card"
                      style={{
                        padding: 0,
                        overflow: 'hidden',
                        background: 'var(--surface)',
                        border: '1px solid var(--line)'
                      }}
                    >
                      <div
                        className="row"
                        style={{
                          padding: '10px 12px',
                          alignItems: 'center',
                          gap: 8,
                          cursor: 'pointer',
                          userSelect: 'none'
                        }}
                        onClick={() => setExpandedTemplateId(isOpen ? null : template.id)}
                      >
                        <span
                          style={{
                            width: 14,
                            textAlign: 'center',
                            color: 'var(--ink-3)',
                            fontSize: 12
                          }}
                        >
                          {isOpen ? '▼' : '▸'}
                        </span>
                        <strong
                          style={{
                            fontSize: 13.5,
                            flex: '0 1 auto',
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {template.name.trim() || `未命名模板 ${index + 1}`}
                        </strong>
                        <span
                          className="meta"
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {summary}
                        </span>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            setWritingTemplates((prev) =>
                              prev.filter((item) => item.id !== template.id)
                            )
                          }}
                          disabled={writingTemplates.length <= 1}
                        >
                          删除
                        </button>
                      </div>

                      {isOpen ? (
                        <div
                          style={{
                            padding: '0 12px 12px',
                            borderTop: '1px solid var(--line-soft)'
                          }}
                        >
                          <div className="field" style={{ marginTop: 10 }}>
                            <label>模板名称</label>
                            <input
                              className="input"
                              value={template.name}
                              onChange={(e) =>
                                setWritingTemplates((prev) =>
                                  prev.map((item) =>
                                    item.id === template.id
                                      ? { ...item, name: e.target.value }
                                      : item
                                  )
                                )
                              }
                            />
                          </div>

                          <div className="field">
                            <label>模板说明</label>
                            <input
                              className="input"
                              value={template.description}
                              onChange={(e) =>
                                setWritingTemplates((prev) =>
                                  prev.map((item) =>
                                    item.id === template.id
                                      ? { ...item, description: e.target.value }
                                      : item
                                  )
                                )
                              }
                            />
                          </div>

                          <div className="field">
                            <label>要求列表</label>
                            <textarea
                              className="textarea"
                              style={{ minHeight: 120 }}
                              value={template.requirements.join('\n')}
                              onChange={(e) =>
                                setWritingTemplates((prev) =>
                                  prev.map((item) =>
                                    item.id === template.id
                                      ? {
                                          ...item,
                                          requirements: e.target.value.split(/\r?\n/)
                                        }
                                      : item
                                  )
                                )
                              }
                              placeholder="每行一条要求，例如：\n开头三段内抛出冲突\n结尾必须留钩子"
                            />
                            <p className="meta" style={{ marginTop: 6 }}>
                              每行一条，保存时会自动去掉序号、空行和重复项。
                            </p>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {activeTab === 'writingRules' && (
            <div className="card" style={{ maxWidth: 760 }}>
              <div
                className="row"
                style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}
              >
                <div>
                  <h3 className="sub" style={{ margin: 0, fontSize: 15 }}>
                    续写规则（分节可编辑）
                  </h3>
                  <p className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>
                    这些规则会拼进每次续写的系统提示词。改完点「保存规则」生效。与内置默认完全相同的小节不会存储、仍随内置升级；把某节清空等于停用该规则。「题材定位」与「禁用高频词」是系统目录，不在此编辑。
                  </p>
                </div>
                <button
                  className="btn btn-primary btn-sm"
                  style={{ flexShrink: 0 }}
                  disabled={ruleSections.length === 0}
                  onClick={async () => {
                    // 只保存与默认不同的 key（含清空=停用）；与默认相同的剔除，回到内置
                    const pruned: Record<string, string> = {}
                    for (const s of ruleSections) {
                      const cur = ruleDrafts[s.key] ?? ''
                      if (cur !== s.defaultText) pruned[s.key] = cur
                    }
                    try {
                      const saved = await window.api.setChapterRules(pruned)
                      setRuleDrafts(mergeRuleDrafts(ruleSections, saved))
                      setMsg({ kind: 'ok', text: '续写规则已保存' })
                    } catch {
                      setMsg({ kind: 'err', text: '保存失败，请重试' })
                    }
                  }}
                >
                  保存规则
                </button>
              </div>

              <div style={{ display: 'grid', gap: 16, marginTop: 14 }}>
                {ruleSections.map((s) => {
                  const cur = ruleDrafts[s.key] ?? ''
                  const customized = cur !== s.defaultText
                  return (
                    <div key={s.key} className="field" style={{ marginBottom: 0 }}>
                      <div className="row" style={{ marginBottom: 6 }}>
                        <label style={{ margin: 0 }}>
                          {s.title}{' '}
                          <span
                            className="meta"
                            style={{
                              marginLeft: 6,
                              color: customized ? 'var(--vermilion)' : 'var(--ink-3)'
                            }}
                          >
                            {customized ? '已自定义' : '默认'}
                          </span>
                        </label>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() =>
                            setRuleDrafts((prev) => ({ ...prev, [s.key]: s.defaultText }))
                          }
                          disabled={!customized}
                        >
                          恢复默认
                        </button>
                      </div>
                      <textarea
                        className="textarea"
                        style={{ minHeight: 200 }}
                        value={cur}
                        onChange={(e) =>
                          setRuleDrafts((prev) => ({ ...prev, [s.key]: e.target.value }))
                        }
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {activeTab === 'deslopRules' && (
            <div className="card" style={{ maxWidth: 760 }}>
              <div
                className="row"
                style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}
              >
                <div>
                  <h3 className="sub" style={{ margin: 0, fontSize: 15 }}>
                    去 AI 味规则（分节可编辑）
                  </h3>
                  <p className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>
                    这些规则会注入「去 AI 味」的扫描与改写。改完点「保存规则」生效——保存后影响正文润色、开书去 AI 等所有 deslop 流程。
                    与内置默认完全相同的小节不会存储、仍随内置升级；清空某节等于停用该规则。最毒句式正则、排比正则、心理词是确定性扫描的内核，锁定只读，避免写错正则让扫描崩溃。
                  </p>
                </div>
                <button
                  className="btn btn-primary btn-sm"
                  style={{ flexShrink: 0 }}
                  disabled={deslopSections.length === 0}
                  onClick={async () => {
                    // 只保存与默认不同的 key（含清空=停用）；与默认相同的剔除，回到内置
                    const pruned: Record<string, string> = {}
                    for (const s of deslopSections) {
                      const cur = deslopDrafts[s.key] ?? ''
                      if (cur !== s.defaultText) pruned[s.key] = cur
                    }
                    // 禁用词表：按行 split、去空、去重；与默认等价时后端会自动 prune（不存储）
                    const seen = new Set<string>()
                    const bannedWords: string[] = []
                    for (const raw of deslopBannedDraft.split(/\r?\n/)) {
                      const w = raw.trim()
                      if (!w || seen.has(w)) continue
                      seen.add(w)
                      bannedWords.push(w)
                    }
                    try {
                      const saved = await window.api.setDeslopRules({
                        textOverrides: pruned,
                        bannedWords
                      })
                      setDeslopDrafts(mergeDeslopDrafts(saved.sections, saved.overrides))
                      setDeslopBannedDraft(saved.bannedWords.join('\n'))
                      setMsg({ kind: 'ok', text: '去 AI 味规则已保存' })
                    } catch {
                      setMsg({ kind: 'err', text: '保存失败，请重试' })
                    }
                  }}
                >
                  保存规则
                </button>
              </div>

              {/* 可编辑分节：系统铁律 + Gate A-G */}
              <div style={{ display: 'grid', gap: 16, marginTop: 14 }}>
                {deslopSections.map((s) => {
                  const cur = deslopDrafts[s.key] ?? ''
                  const customized = cur !== s.defaultText
                  return (
                    <div key={s.key} className="field" style={{ marginBottom: 0 }}>
                      <div className="row" style={{ marginBottom: 6 }}>
                        <label style={{ margin: 0 }}>
                          {s.title}{' '}
                          <span
                            className="meta"
                            style={{
                              marginLeft: 6,
                              color: customized ? 'var(--vermilion)' : 'var(--ink-3)'
                            }}
                          >
                            {customized ? '已自定义' : '默认'}
                          </span>
                        </label>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() =>
                            setDeslopDrafts((prev) => ({ ...prev, [s.key]: s.defaultText }))
                          }
                          disabled={!customized}
                        >
                          恢复默认
                        </button>
                      </div>
                      <textarea
                        className="textarea"
                        style={{ minHeight: 160, fontFamily: 'inherit', fontSize: 12.5 }}
                        value={cur}
                        onChange={(e) =>
                          setDeslopDrafts((prev) => ({ ...prev, [s.key]: e.target.value }))
                        }
                      />
                    </div>
                  )
                })}
              </div>

              {/* 禁用词表（每行一个词） */}
              <div className="field" style={{ marginBottom: 0, marginTop: 16 }}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <label style={{ margin: 0 }}>禁用词表（每行一个词，扫描器与改写都会用到）</label>
                </div>
                <textarea
                  className="textarea"
                  style={{ minHeight: 120, fontFamily: 'inherit', fontSize: 12.5 }}
                  placeholder="仿佛&#10;缓缓&#10;眼中闪过"
                  value={deslopBannedDraft}
                  onChange={(e) => setDeslopBannedDraft(e.target.value)}
                />
              </div>

              {/* AI 自然语言改写区 */}
              <div
                className="field"
                style={{
                  marginTop: 16,
                  padding: 12,
                  border: '1px solid var(--border)',
                  borderRadius: 6
                }}
              >
                <label className="sub" style={{ margin: 0, fontSize: 13 }}>
                  AI 改写规则（自然语言）
                </label>
                <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                  用一句话描述想怎么改，例如「禁用词里加上『眼眸』和『凝视』，Gate B 增加对『与其说不如说』的处理」。
                  AI 会流式输出改写后的完整规则，完成后自动填回各分节，可继续微调，最后点「保存规则」落盘。
                </p>
                <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'flex-end' }}>
                  <textarea
                    className="textarea"
                    style={{ minHeight: 60, flex: 1, fontSize: 12.5 }}
                    placeholder="描述你想怎么改去 AI 味规则……"
                    value={deslopEditInstruction}
                    onChange={(e) => setDeslopEditInstruction(e.target.value)}
                    disabled={deslopEditing}
                  />
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={deslopEditing || !deslopEditInstruction.trim() || deslopSections.length === 0}
                    onClick={async () => {
                      const myGen = ++deslopEditGenRef.current
                      setDeslopEditing(true)
                      setDeslopEditPreview('')
                      let accumulated = ''
                      try {
                        await window.api.editDeslopRulesStream(
                          deslopEditInstruction.trim(),
                          (token, done) => {
                            if (deslopEditGenRef.current !== myGen) return
                            if (token) {
                              accumulated += token
                              setDeslopEditPreview(accumulated)
                            }
                            if (done) setDeslopEditing(false)
                          }
                        )
                        // 防竞态：若被新请求取代则不应用
                        if (deslopEditGenRef.current !== myGen) return
                        // 解析 AI 输出，拆分填回各分节 + 禁用词；保留 preview 供用户核对 AI 全貌
                        const parsed = parseDeslopRulesMd(accumulated, deslopSections)
                        setDeslopDrafts(mergeDeslopDrafts(deslopSections, parsed.overrides))
                        setDeslopBannedDraft(parsed.bannedWords.join('\n'))
                        setDeslopEditInstruction('')
                        setMsg({ kind: 'ok', text: 'AI 已改写规则并填回，请检查后点「保存规则」' })
                      } catch {
                        if (deslopEditGenRef.current === myGen) {
                          setDeslopEditPreview('') // 失败时清空，避免残留半截输出误导用户
                          setMsg({ kind: 'err', text: 'AI 改写失败，请重试' })
                        }
                      } finally {
                        if (deslopEditGenRef.current === myGen) setDeslopEditing(false)
                      }
                    }}
                  >
                    {deslopEditing ? '改写中…' : 'AI 改写'}
                  </button>
                </div>
                {deslopEditPreview ? (
                  <div style={{ marginTop: 8 }}>
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="muted" style={{ fontSize: 11.5 }}>
                        {deslopEditing ? 'AI 输出中…' : 'AI 完整输出（已自动填回上方各分节）'}
                      </span>
                      {!deslopEditing ? (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setDeslopEditPreview('')}
                        >
                          收起预览
                        </button>
                      ) : null}
                    </div>
                    <pre
                      style={{
                        marginTop: 4,
                        maxHeight: 320,
                        overflow: 'auto',
                        padding: 10,
                        background: 'var(--bg-2, #f7f7f5)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        fontSize: 12,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word'
                      }}
                    >
                      {deslopEditPreview}
                    </pre>
                  </div>
                ) : null}
              </div>

              {/* 锁定只读区：最毒句式正则 / 排比正则 / 心理词 */}
              {deslopLockedSections.length > 0 ? (
                <div style={{ marginTop: 16 }}>
                  <h4 className="sub" style={{ margin: '0 0 8px', fontSize: 13 }}>
                    锁定规则（只读，确定性扫描内核）
                  </h4>
                  <div style={{ display: 'grid', gap: 10 }}>
                    {deslopLockedSections.map((s) => (
                      <div
                        key={s.key}
                        className="field"
                        style={{
                          marginBottom: 0,
                          padding: 10,
                          background: 'var(--bg-2, #f7f7f5)',
                          border: '1px solid var(--border)',
                          borderRadius: 4
                        }}
                      >
                        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                          {s.title}
                        </div>
                        <pre
                          style={{
                            margin: 0,
                            fontSize: 11.5,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word'
                          }}
                        >
                          {s.content}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {activeTab === 'reviewRules' && reviewCfg && (
            <div className="card" style={{ maxWidth: 760 }}>
              <div className="row" style={{ alignItems: 'center', marginBottom: 4 }}>
                <h3 className="sub" style={{ margin: 0 }}>审稿规则</h3>
                <label
                  className="row"
                  style={{ gap: 6, fontSize: 12.5, marginLeft: 'auto', alignItems: 'center' }}
                >
                  <input
                    type="checkbox"
                    checked={reviewCfg.enabled}
                    onChange={async (e) => {
                      const next = await window.api.setReviewRules({ enabled: e.target.checked })
                      setReviewCfg(next)
                    }}
                  />
                  启用审稿
                </label>
              </div>
              <p className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>
                按「正文审核」技能集成。算法类检查（毒点/引文/成文质量等）实时跑、不调 LLM；LLM
                类（角色崩坏/逻辑漏洞等）需点「AI 深度审稿」按需触发，避免每次续写烧 token。关闭某项 =
                该项不再报告。
              </p>

              {/* 总开关：自动深度审稿 */}
              <div
                className="field"
                style={{
                  marginTop: 12,
                  padding: 10,
                  border: '1px solid var(--border)',
                  borderRadius: 6
                }}
              >
                <label className="row" style={{ gap: 6, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={reviewCfg.autoDeepReview}
                    disabled={!reviewCfg.enabled}
                    onChange={async (e) => {
                      const next = await window.api.setReviewRules({
                        autoDeepReview: e.target.checked
                      })
                      setReviewCfg(next)
                    }}
                  />
                  <span>续写完自动跑 LLM 深度审稿</span>
                  <span className="meta" style={{ color: 'var(--ink-3)' }}>
                    （默认关：手动点按钮触发，省 token）
                  </span>
                </label>
              </div>

              {/* 检查项清单：算法 / LLM 分组 */}
              <h4 className="sub" style={{ marginTop: 18, fontSize: 13.5 }}>
                检查项
              </h4>
              <div style={{ display: 'grid', gap: 12, marginTop: 10 }}>
                {(['algorithm', 'llm'] as const).map((kind) => {
                  const list = reviewSections.filter((s) => s.kind === kind)
                  if (list.length === 0) return null
                  return (
                    <div
                      key={kind}
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        padding: 10
                      }}
                    >
                      <div className="meta" style={{ marginBottom: 8, fontSize: 12 }}>
                        {kind === 'algorithm' ? '算法检查（实时，不调 LLM）' : 'LLM 深度审稿（按需）'}
                      </div>
                      <div style={{ display: 'grid', gap: 8 }}>
                        {list.map((s) => {
                          const on = reviewCfg.checks[s.checkId] !== false
                          const pill =
                            s.defaultSeverity === 'error'
                              ? '🚨'
                              : s.defaultSeverity === 'warn'
                                ? '⚠'
                                : '💡'
                          const isEditing = editingCheckId === s.checkId
                          return (
                            <div key={s.checkId} style={{ borderBottom: '1px dashed var(--line-soft)', paddingBottom: 6 }}>
                              <label
                                className="row"
                                style={{ gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}
                              >
                                <input
                                  type="checkbox"
                                  checked={on && reviewCfg.enabled}
                                  disabled={!reviewCfg.enabled}
                                  style={{ marginTop: 2 }}
                                  onChange={async (e) => {
                                    const next = await window.api.setReviewRules({
                                      checks: { [s.checkId]: e.target.checked }
                                    })
                                    setReviewCfg(next)
                                  }}
                                />
                                <span style={{ flex: 1 }}>
                                  {pill} <strong>{s.label}</strong>
                                  {s.isCustom && (
                                    <span className="meta" style={{ marginLeft: 6, fontSize: 11 }}>
                                      [{s.customType}]
                                    </span>
                                  )}
                                  <span className="meta" style={{ marginLeft: 6 }}>
                                    {s.hint}
                                  </span>
                                </span>
                              </label>
                              {/* 编辑/删除按钮 */}
                              {!isEditing && (
                                <div className="row" style={{ gap: 6, marginTop: 4, marginLeft: 24 }}>
                                  <button
                                    className="btn btn-ghost btn-sm"
                                    style={{ padding: '1px 6px', fontSize: 11 }}
                                    onClick={() => {
                                      setEditingCheckId(s.checkId)
                                      setEditDraft({
                                        label: s.label,
                                        hint: s.hint,
                                        severity: s.defaultSeverity
                                      })
                                    }}
                                  >
                                    ✎ 编辑
                                  </button>
                                  {s.isCustom ? (
                                    <button
                                      className="btn btn-ghost btn-sm"
                                      style={{ padding: '1px 6px', fontSize: 11, color: 'var(--vermilion)' }}
                                      onClick={async () => {
                                        if (pendingDeleteId === s.checkId) {
                                          // 二次确认 → 硬删
                                          const next = (reviewCfg.customChecks ?? []).filter(
                                            (c) => c.id !== s.checkId
                                          )
                                          await window.api.setReviewRules({ customChecks: next })
                                          refreshReviewRules()
                                          setPendingDeleteId(null)
                                        } else {
                                          setPendingDeleteId(s.checkId)
                                        }
                                      }}
                                    >
                                      {pendingDeleteId === s.checkId ? '⚠ 确认删除？' : '🗑 删除'}
                                    </button>
                                  ) : (
                                    <button
                                      className="btn btn-ghost btn-sm"
                                      style={{ padding: '1px 6px', fontSize: 11 }}
                                      title="隐藏此项（可在下方「已隐藏」区恢复）"
                                      onClick={async () => {
                                        const next = [...(reviewCfg.hiddenBuiltin ?? []), s.checkId as ReviewCheckId]
                                        await window.api.setReviewRules({ hiddenBuiltin: next })
                                        refreshReviewRules()
                                      }}
                                    >
                                      🗑 隐藏
                                    </button>
                                  )}
                                </div>
                              )}
                              {/* 编辑表单 */}
                              {isEditing && (
                                <div style={{ marginTop: 6, marginLeft: 24, padding: 8, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--surface-2)' }}>
                                  <div className="field" style={{ marginBottom: 6 }}>
                                    <label style={{ fontSize: 11.5 }}>名称</label>
                                    <input
                                      className="input"
                                      value={editDraft.label}
                                      onChange={(e) => setEditDraft((d) => ({ ...d, label: e.target.value }))}
                                    />
                                  </div>
                                  <div className="field" style={{ marginBottom: 6 }}>
                                    <label style={{ fontSize: 11.5 }}>说明</label>
                                    <input
                                      className="input"
                                      value={editDraft.hint}
                                      onChange={(e) => setEditDraft((d) => ({ ...d, hint: e.target.value }))}
                                    />
                                  </div>
                                  <div className="field" style={{ marginBottom: 8 }}>
                                    <label style={{ fontSize: 11.5 }}>严重度</label>
                                    <select
                                      className="input"
                                      value={editDraft.severity}
                                      onChange={(e) => setEditDraft((d) => ({ ...d, severity: e.target.value as 'error' | 'warn' | 'info' }))}
                                    >
                                      <option value="error">🚨 错误（error）</option>
                                      <option value="warn">⚠ 提醒（warn）</option>
                                      <option value="info">💡 建议（info）</option>
                                    </select>
                                  </div>
                                  <div className="row" style={{ gap: 6 }}>
                                    <button
                                      className="btn btn-sm"
                                      onClick={async () => {
                                        // 内置项 → builtinMeta 覆盖；自定义项 → 改 customChecks
                                        if (s.isCustom) {
                                          const next = (reviewCfg.customChecks ?? []).map((c) =>
                                            c.id === s.checkId
                                              ? { ...c, label: editDraft.label, hint: editDraft.hint, severity: editDraft.severity }
                                              : c
                                          )
                                          await window.api.setReviewRules({ customChecks: next })
                                        } else {
                                          await window.api.setReviewRules({
                                            builtinMeta: { [s.checkId]: { label: editDraft.label, hint: editDraft.hint, severity: editDraft.severity } }
                                          })
                                        }
                                        refreshReviewRules()
                                        setEditingCheckId(null)
                                      }}
                                    >
                                      保存
                                    </button>
                                    <button className="btn btn-ghost btn-sm" onClick={() => setEditingCheckId(null)}>
                                      取消
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* 已隐藏的内置项（可恢复） */}
              {hiddenSections.length > 0 && (
                <div style={{ marginTop: 10, padding: 10, border: '1px dashed var(--border)', borderRadius: 6 }}>
                  <div className="meta" style={{ fontSize: 12, marginBottom: 6 }}>已隐藏（点恢复）</div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {hiddenSections.map((h) => (
                      <button
                        key={h.checkId}
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 11 }}
                        onClick={async () => {
                          const next = (reviewCfg.hiddenBuiltin ?? []).filter((x) => x !== h.checkId)
                          await window.api.setReviewRules({ hiddenBuiltin: next })
                          refreshReviewRules()
                        }}
                      >
                        ↩ 恢复「{h.label}」
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 新增自定义检查项 */}
              <div className="row" style={{ marginTop: 12, gap: 8 }}>
                <button
                  className="btn btn-sm"
                  disabled={!reviewCfg.enabled}
                  onClick={() => {
                    setShowAddForm((v) => !v)
                    setAddDraft({
                      label: '', hint: '', severity: 'warn', type: 'keyword',
                      group: 'toxic', keywords: '', pattern: '', prompt: ''
                    })
                    setRegexValid({ ok: true })
                  }}
                >
                  {showAddForm ? '取消新增' : '＋ 新增检查项'}
                </button>
              </div>

              {showAddForm && (
                <div style={{ marginTop: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface-2)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 12.5 }}>名称</label>
                      <input
                        className="input"
                        value={addDraft.label}
                        onChange={(e) => setAddDraft((d) => ({ ...d, label: e.target.value }))}
                        placeholder="如：我的专属禁用词"
                      />
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 12.5 }}>严重度</label>
                      <select
                        className="input"
                        value={addDraft.severity}
                        onChange={(e) => setAddDraft((d) => ({ ...d, severity: e.target.value as 'error' | 'warn' | 'info' }))}
                      >
                        <option value="error">🚨 错误</option>
                        <option value="warn">⚠ 提醒</option>
                        <option value="info">💡 建议</option>
                      </select>
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 12.5 }}>检测类型</label>
                      <select
                        className="input"
                        value={addDraft.type}
                        onChange={(e) => setAddDraft((d) => ({ ...d, type: e.target.value as 'keyword' | 'regex' | 'llm' }))}
                      >
                        <option value="keyword">关键词命中（词表，实时）</option>
                        <option value="regex">正则匹配（实时）</option>
                        <option value="llm">LLM 语义（按需调 AI）</option>
                      </select>
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 12.5 }}>分类（结果分组）</label>
                      <select
                        className="input"
                        value={addDraft.group}
                        onChange={(e) => setAddDraft((d) => ({ ...d, group: e.target.value }))}
                      >
                        <option value="toxic">毒点</option>
                        <option value="quality">成文质量</option>
                        <option value="quote">引文一致性</option>
                        <option value="paragraph">段落长度</option>
                        <option value="dialogue">对话标签</option>
                        <option value="sensitive">敏感词</option>
                        <option value="llm_review">深度审稿</option>
                      </select>
                    </div>
                  </div>
                  <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
                    <label style={{ fontSize: 12.5 }}>说明（命中时显示）</label>
                    <input
                      className="input"
                      value={addDraft.hint}
                      onChange={(e) => setAddDraft((d) => ({ ...d, hint: e.target.value }))}
                      placeholder="一句话说明这条查什么"
                    />
                  </div>
                  {addDraft.type === 'keyword' && (
                    <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
                      <label style={{ fontSize: 12.5 }}>触发词（每行一个）</label>
                      <textarea
                        className="textarea"
                        style={{ minHeight: 80 }}
                        value={addDraft.keywords}
                        onChange={(e) => setAddDraft((d) => ({ ...d, keywords: e.target.value }))}
                        placeholder={'居然\n竟然\n忍不住'}
                      />
                    </div>
                  )}
                  {addDraft.type === 'regex' && (
                    <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
                      <label style={{ fontSize: 12.5 }}>正则表达式（如 ——[一-龥]——）</label>
                      <input
                        className="input"
                        value={addDraft.pattern}
                        style={{ borderColor: regexValid.ok ? undefined : 'var(--vermilion)' }}
                        onChange={(e) => {
                          const pat = e.target.value
                          setAddDraft((d) => ({ ...d, pattern: pat }))
                          if (!pat) { setRegexValid({ ok: true }); return }
                          try {
                            new RegExp(pat)
                            setRegexValid({ ok: true })
                          } catch (err) {
                            setRegexValid({ ok: false, err: (err as Error).message })
                          }
                        }}
                        placeholder="——[一-龥]——"
                      />
                      {!regexValid.ok && (
                        <span style={{ color: 'var(--vermilion)', fontSize: 11 }}>⚠ 非法正则：{regexValid.err}</span>
                      )}
                    </div>
                  )}
                  {addDraft.type === 'llm' && (
                    <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
                      <label style={{ fontSize: 12.5 }}>检查指令（告诉 AI 这项查什么）</label>
                      <textarea
                        className="textarea"
                        style={{ minHeight: 80 }}
                        value={addDraft.prompt}
                        onChange={(e) => setAddDraft((d) => ({ ...d, prompt: e.target.value }))}
                        placeholder={'检查是否有过度堆砌形容词，列出明显段落'}
                      />
                    </div>
                  )}
                  <div className="row" style={{ marginTop: 10, gap: 8 }}>
                    <button
                      className="btn btn-sm"
                      disabled={
                        !addDraft.label.trim() ||
                        (addDraft.type === 'keyword' && !addDraft.keywords.trim()) ||
                        (addDraft.type === 'regex' && (!addDraft.pattern.trim() || !regexValid.ok)) ||
                        (addDraft.type === 'llm' && !addDraft.prompt.trim())
                      }
                      onClick={async () => {
                        // 生成唯一 id：custom_ + slug + 短随机
                        const slug =
                          addDraft.label
                            .replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '')
                            .slice(0, 12)
                            .toLowerCase() || 'rule'
                        const id = `custom_${slug}_${Math.random().toString(36).slice(2, 6)}`
                        const newCheck = {
                          id,
                          label: addDraft.label.trim(),
                          hint: addDraft.hint.trim(),
                          severity: addDraft.severity,
                          type: addDraft.type,
                          group: addDraft.group as AuditCategory,
                          enabled: true,
                          keywords: addDraft.type === 'keyword' ? addDraft.keywords.split('\n') : undefined,
                          pattern: addDraft.type === 'regex' ? addDraft.pattern : undefined,
                          prompt: addDraft.type === 'llm' ? addDraft.prompt : undefined
                        }
                        const next = [...(reviewCfg.customChecks ?? []), newCheck]
                        await window.api.setReviewRules({ customChecks: next })
                        refreshReviewRules()
                        setShowAddForm(false)
                        setMsg({ kind: 'ok', text: `已新增「${newCheck.label}」` })
                      }}
                    >
                      创建
                    </button>
                  </div>
                </div>
              )}

              {/* 阈值区 */}
              <h4 className="sub" style={{ marginTop: 18, fontSize: 13.5 }}>
                阈值
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 10 }}>
                {(
                  [
                    ['minWords', '字数下限', 1, 100000],
                    ['maxWords', '字数上限', 1, 100000],
                    ['maxParagraphLen', '段落长度上限', 1, 10000],
                    ['maxSentenceLen', '句子长度上限', 1, 10000],
                    ['repetitionLen', '重复判定长度', 1, 1000],
                    ['dashDensityPer100', '破折号密度(/100字)', 0, 100]
                  ] as const
                ).map(([key, label, min, max]) => (
                  <div key={key} className="field" style={{ marginBottom: 0 }}>
                    <label style={{ fontSize: 12.5 }}>{label}</label>
                    <input
                      className="input"
                      type="number"
                      step={key === 'dashDensityPer100' ? 0.5 : 1}
                      min={min}
                      max={max}
                      value={reviewThresholdDraft[key]}
                      onChange={(e) =>
                        setReviewThresholdDraft((prev) => ({
                          ...prev,
                          [key]: Number(e.target.value)
                        }))
                      }
                    />
                  </div>
                ))}
              </div>
              <div className="row" style={{ marginTop: 10, gap: 8 }}>
                <button
                  className="btn btn-sm"
                  disabled={!reviewCfg.enabled}
                  onClick={async () => {
                    try {
                      const next = await window.api.setReviewRules({
                        thresholds: reviewThresholdDraft
                      })
                      setReviewCfg(next)
                      setReviewThresholdDraft({ ...next.thresholds })
                      setMsg({ kind: 'ok', text: '阈值已保存' })
                    } catch {
                      setMsg({ kind: 'err', text: '保存失败，请重试' })
                    }
                  }}
                >
                  保存阈值
                </button>
              </div>

              {/* 自定义词表区 */}
              <h4 className="sub" style={{ marginTop: 18, fontSize: 13.5 }}>
                自定义词表
              </h4>
              <div style={{ display: 'grid', gap: 12, marginTop: 10 }}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: 12.5 }}>打破第四面墙触发词（每行一个）</label>
                  <textarea
                    className="textarea"
                    style={{ minHeight: 100 }}
                    value={reviewMetaDraft}
                    onChange={(e) => setReviewMetaDraft(e.target.value)}
                    placeholder="第X卷、弹幕、读者、主角、剧情……"
                  />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: 12.5 }}>敏感词（每行一个；仅提醒，不强制修改）</label>
                  <textarea
                    className="textarea"
                    style={{ minHeight: 100 }}
                    value={reviewSensitiveDraft}
                    onChange={(e) => setReviewSensitiveDraft(e.target.value)}
                    placeholder="敏感词每行一个……"
                  />
                </div>
              </div>
              <div className="row" style={{ marginTop: 10, gap: 8 }}>
                <button
                  className="btn btn-sm"
                  disabled={!reviewCfg.enabled}
                  onClick={async () => {
                    try {
                      const next = await window.api.setReviewRules({
                        wordLists: {
                          metaBreak: reviewMetaDraft.split('\n'),
                          sensitive: reviewSensitiveDraft.split('\n')
                        }
                      })
                      setReviewCfg(next)
                      setReviewMetaDraft(next.wordLists.metaBreak.join('\n'))
                      setReviewSensitiveDraft(next.wordLists.sensitive.join('\n'))
                      setMsg({ kind: 'ok', text: '词表已保存' })
                    } catch {
                      setMsg({ kind: 'err', text: '保存失败，请重试' })
                    }
                  }}
                >
                  保存词表
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={async () => {
                    // 恢复默认 = 传空词表，repo 层会兜底为内置默认
                    try {
                      const next = await window.api.setReviewRules({
                        wordLists: { metaBreak: [], sensitive: [] }
                      })
                      setReviewCfg(next)
                      setReviewMetaDraft(next.wordLists.metaBreak.join('\n'))
                      setReviewSensitiveDraft(next.wordLists.sensitive.join('\n'))
                      setMsg({ kind: 'ok', text: '词表已恢复默认' })
                    } catch {
                      setMsg({ kind: 'err', text: '恢复失败，请重试' })
                    }
                  }}
                >
                  恢复默认词表
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ---------- Provider 行 ---------- */
function ProviderRow({
  provider,
  active,
  onActivate,
  onDelete
}: {
  provider: ProviderSummary
  active: boolean
  onActivate: () => void
  onDelete: () => void
}) {
  const [tempDraft, setTempDraft] = useState<number | null>(
    typeof provider.temperature === 'number' ? provider.temperature : null
  )
  // 防抖定时器：拖动/键盘连续调节时，停止输入 400ms 后才写盘，避免狂发请求
  const tempTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // provider 切换后同步草稿（例如重新拉取列表）
  useEffect(() => {
    setTempDraft(typeof provider.temperature === 'number' ? provider.temperature : null)
  }, [provider.id, provider.temperature])
  // 卸载时清掉待写的定时器，避免内存泄漏与卸载后写盘
  useEffect(() => {
    return () => {
      if (tempTimer.current) clearTimeout(tempTimer.current)
    }
  }, [])

  const persistTemp = (v: number | null) => {
    setTempDraft(v)
    if (tempTimer.current) clearTimeout(tempTimer.current)
    tempTimer.current = setTimeout(async () => {
      tempTimer.current = null
      try {
        // apiKey 传空 → main 端保留旧 key；只更新 temperature
        await window.api.upsertProvider({
          id: provider.id,
          label: provider.label,
          baseUrl: provider.baseUrl,
          model: provider.model,
          apiKey: '',
          protocol: provider.protocol,
          ...(v === null ? {} : { temperature: v })
        })
      } catch {
        // 失败回滚到 props 当前值，避免滑块与存储不一致
        setTempDraft(
          typeof provider.temperature === 'number' ? provider.temperature : null
        )
      }
    }, 400)
  }

  /** 「默认」按钮：清除自定义温度。瞬时操作，立即写盘并取消挂起的防抖 */
  const resetTemp = async () => {
    if (tempTimer.current) {
      clearTimeout(tempTimer.current)
      tempTimer.current = null
    }
    setTempDraft(null)
    try {
      await window.api.upsertProvider({
        id: provider.id,
        label: provider.label,
        baseUrl: provider.baseUrl,
        model: provider.model,
        apiKey: '',
        protocol: provider.protocol
      })
    } catch {
      // 与 persistTemp 一致：写盘失败回滚到 props 当前值，避免 UI 显示"默认"但存储仍是旧温度
      setTempDraft(
        typeof provider.temperature === 'number' ? provider.temperature : null
      )
    }
  }

  return (
    <li
      className="card"
      style={{
        padding: '14px 16px',
        marginBottom: 10,
        borderColor: active ? 'var(--vermilion)' : undefined
      }}
    >
      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <strong style={{ fontFamily: 'var(--font-display)', fontSize: 15 }}>
              {provider.label || '(未命名)'}
            </strong>
            {active ? <span className="chip-seal">当前</span> : null}
            {provider.hasKey ? (
              <span className="chip chip-success" title="已配置">
                ✓ {provider.keyMasked || 'Key'}
              </span>
            ) : (
              <span className="chip chip-warning">无 Key</span>
            )}
            <span
              className="chip"
              style={{
                background:
                  provider.protocol === 'anthropic'
                    ? 'var(--inkstone-soft)'
                    : provider.protocol === 'antigravity'
                      ? 'var(--vermilion-soft, rgba(229,57,53,0.12))'
                      : provider.protocol === 'codex'
                        ? 'rgba(16,163,127,0.12)'
                        : 'var(--surface-2)',
                color:
                  provider.protocol === 'anthropic'
                    ? 'var(--inkstone)'
                    : provider.protocol === 'antigravity'
                      ? 'var(--vermilion, #e53935)'
                      : provider.protocol === 'codex'
                        ? '#10a37f'
                        : 'var(--ink-3)'
              }}
            >
              {provider.protocol === 'anthropic'
                ? 'Anthropic'
                : provider.protocol === 'antigravity'
                  ? 'Antigravity (agy)'
                  : provider.protocol === 'codex'
                    ? 'Codex CLI'
                    : 'OpenAI'}
            </span>
          </div>
          <div className="meta" style={{ marginTop: 6, wordBreak: 'break-all' }}>
            {provider.protocol === 'antigravity'
              ? `本机 agy CLI · ${provider.model && provider.model !== 'default' ? provider.model : 'agy 默认模型'}`
              : provider.protocol === 'codex'
                ? `本机 codex CLI · ${provider.model && provider.model !== 'default' ? provider.model : 'codex 默认模型'}`
                : `${provider.baseUrl || '(未填 baseUrl)'} · ${provider.model || '(未填 model)'}`}
          </div>
          {/* 模型强度（采样温度）：拖动/键盘/点击统一走防抖 onChange，400ms 后写盘 */}
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>模型强度</span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={tempDraft ?? 1}
              onChange={(e) => persistTemp(Number(e.target.value))}
              aria-label="模型强度（采样温度）"
              style={{ width: 160 }}
            />
            <span style={{ fontSize: 13, minWidth: 92, fontFamily: 'var(--font-mono)' }}>
              {tempDraft === null ? '模型默认' : `温度 ${tempDraft.toFixed(1)}`}
            </span>
            <button
              className="btn btn-sm"
              style={{ padding: '2px 8px', fontSize: 12 }}
              onClick={resetTemp}
              disabled={tempDraft === null}
              title="清除自定义温度，使用模型默认值"
            >
              默认
            </button>
            <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              {tempDraft === null
                ? ''
                : tempDraft <= 0.5
                  ? '稳定（适合改写/审阅）'
                  : tempDraft <= 1.0
                    ? '均衡（适合续写）'
                    : '发散（更有惊喜，易跑偏）'}
            </span>
          </div>
        </div>
        <div className="btn-group">
          {!active ? (
            <button className="btn btn-sm" onClick={onActivate}>启用</button>
          ) : null}
          <button className="btn btn-sm btn-danger" onClick={onDelete}>删除</button>
        </div>
      </div>
    </li>
  )
}

/* ---------- 新增 provider 表单 ---------- */
function NewProviderForm({ onCreated }: { onCreated: () => void }) {
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [protocol, setProtocol] = useState<ProviderProtocol>('openai')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // CLI 协议的模型列表（切到对应协议时懒加载）
  const [agyModels, setAgyModels] = useState<string[]>([])
  const [agyModelsLoading, setAgyModelsLoading] = useState(false)
  const [codexModels, setCodexModels] = useState<string[]>([])
  const [codexModelsLoading, setCodexModelsLoading] = useState(false)

  const isAg = protocol === 'antigravity'
  const isCodex = protocol === 'codex'
  const isCli = isAg || isCodex

  // 切到 antigravity 时拉取 agy 可用模型列表
  // 注意：loading 状态不能放进依赖数组，否则 setAgyModelsLoading(true) 触发重渲染时
  // 会 cleanup 当前 effect（cancelled=true），导致 IPC 结果被丢弃、列表永远为空。
  useEffect(() => {
    if (!isAg || agyModels.length > 0) return
    let cancelled = false
    setAgyModelsLoading(true)
    window.api
      .listAntigravityModels()
      .then((list) => {
        if (!cancelled) setAgyModels(list)
      })
      .catch(() => {
        // 拉取失败不阻塞，回退为文本输入
      })
      .finally(() => {
        if (!cancelled) setAgyModelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isAg, agyModels.length])

  // 切到 codex 时拉取 codex 可用模型（读 config.toml 默认模型）
  useEffect(() => {
    if (!isCodex || codexModels.length > 0) return
    let cancelled = false
    setCodexModelsLoading(true)
    window.api
      .listCodexModels()
      .then((list) => {
        if (!cancelled) setCodexModels(list)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setCodexModelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isCodex, codexModels.length])

  const submit = async () => {
    setErr(null)
    if (!label.trim()) return setErr('请填写名称')
    // CLI 协议（antigravity/codex）：无需 baseUrl/apiKey，model 可空（走默认）
    if (!isCli) {
      // 严格 URL 校验：必须能 new URL() 解析且协议是 http(s)
      const baseUrlTrim = baseUrl.trim()
      let parsed: URL
      try {
        parsed = new URL(baseUrlTrim)
      } catch {
        return setErr('baseUrl 不是合法 URL（需含协议与域名，如 https://api.example.com/v1）')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return setErr('baseUrl 仅支持 http / https 协议')
      }
      if (!model.trim()) return setErr('请填写模型名')
    }
    setSaving(true)
    try {
      await window.api.upsertProvider({
        id: newId(),
        label: label.trim(),
        baseUrl: isAg ? '' : baseUrl.trim().replace(/\/+$/, ''),
        model: isAg ? (model.trim() || 'default') : model.trim(),
        apiKey: isAg ? '' : apiKey.trim(),
        protocol
      })
      setLabel('')
      setApiKey('')
      onCreated()
    } catch (e) {
      setErr((e as Error).message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ marginTop: 6 }}>
      <div className="row" style={{ gap: 8 }}>
        <div className="field" style={{ flex: 1, marginBottom: 10 }}>
          <label>名称</label>
          <input
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="主力 / 备用 / DeepSeek"
          />
        </div>
        {isCli ? (
          <div className="field" style={{ flex: 2, marginBottom: 10 }}>
            <label>
              模型
              {isAg && agyModels.length > 0 ? `（${agyModels.length} 个可选）`
                : isCodex && codexModels.length > 0 ? `（默认 ${codexModels[0]}）`
                : '（可选）'}
            </label>
            {isAg && agyModels.length > 0 ? (
              <select
                className="select"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">agy 默认模型</option>
                {agyModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : isCodex ? (
              <input
                className="input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={
                  codexModels.length > 0
                    ? `留空用 ${codexModels[0]}，或填其他模型名`
                    : '留空用 codex 默认，或填模型名'
                }
              />
            ) : (isAg && agyModelsLoading) || (isCodex && codexModelsLoading) ? (
              <input className="input" disabled placeholder="加载模型列表…" />
            ) : (
              <input
                className="input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="无法拉取列表，请手动填模型显示名"
              />
            )}
          </div>
        ) : (
          <div className="field" style={{ flex: 2, marginBottom: 10 }}>
            <label>Base URL</label>
            <input
              className="input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </div>
        )}
      </div>
      <div className="row" style={{ gap: 8 }}>
        {isCli ? null : (
          <div className="field" style={{ flex: 1, marginBottom: 10 }}>
            <label>模型</label>
            <input
              className="input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="例如 gpt-4o-mini / deepseek-chat"
            />
          </div>
        )}
        <div className="field" style={{ flex: 1, marginBottom: 10 }}>
          <label>协议</label>
          <select
            className="select"
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as ProviderProtocol)}
          >
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
            <option value="antigravity">Antigravity (agy CLI)</option>
            <option value="codex">Codex (codex CLI)</option>
          </select>
        </div>
        {isCli ? (
          <div className="field" style={{ flex: 3, marginBottom: 10 }}>
            <label>认证方式</label>
            <div
              className="meta"
              style={{
                padding: '8px 10px',
                background: 'var(--surface-2)',
                borderRadius: 6,
                fontSize: 12
              }}
            >
              {isAg
                ? <>使用本机 agy 登录态，无需 API Key / Base URL。首次使用请先在终端运行 <code>agy</code> 完成 Google 登录。</>
                : <>使用本机 codex 登录态，无需 API Key / Base URL。首次使用请先在终端运行 <code>codex login</code> 完成 ChatGPT 登录。</>
              }
            </div>
          </div>
        ) : (
          <div className="field" style={{ flex: 2, marginBottom: 10 }}>
            <label>API Key</label>
            <input
              className="input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
            />
          </div>
        )}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button
          className="btn btn-primary btn-sm"
          onClick={submit}
          disabled={saving || !label.trim() || (!isCli && !model.trim())}
        >
          {saving ? '保存中…' : '保存并设为默认'}
        </button>
        {err ? (
          <span style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</span>
        ) : null}
      </div>
    </div>
  )
}

/* ---------- AI 高频词编辑 ---------- */
function AiHighFreqEditor({
  words,
  disabled,
  onChange,
  onSave
}: {
  words: { word: string; example?: string }[]
  disabled: boolean
  onChange: (words: { word: string; example?: string }[]) => void
  onSave: (words: { word: string; example?: string }[]) => Promise<void>
}) {
  const [draftWord, setDraftWord] = useState('')
  const [draftExample, setDraftExample] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const add = () => {
    const w = draftWord.trim()
    if (!w) {
      setErr('请输入词条')
      return
    }
    if (words.some((x) => x.word === w)) {
      setErr('已存在该词条')
      return
    }
    const next = [...words, { word: w, example: draftExample.trim() || undefined }]
    onChange(next)
    setDraftWord('')
    setDraftExample('')
    setErr(null)
  }

  const remove = (idx: number) => {
    onChange(words.filter((_, i) => i !== idx))
  }

  const save = async () => {
    setSaving(true)
    setErr(null)
    try {
      await onSave(words)
    } catch (e) {
      setErr((e as Error).message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ marginTop: 10 }}>
      {words.length > 0 ? (
        <ul className="bare" style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
          {words.map((w, i) => (
            <li
              key={`${w.word}-${i}`}
              className="row"
              style={{
                alignItems: 'center',
                gap: 8,
                border: '1px solid var(--line-soft)',
                borderRadius: 4,
                padding: 8
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ fontSize: 13 }}>{w.word}</strong>
                {w.example ? (
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                    改写示例：{w.example}
                  </div>
                ) : null}
              </div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => remove(i)}
                disabled={disabled || saving}
                title="删除该词条"
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          暂无词条。在下方添加后保存即可生效。
        </p>
      )}

      <div
        className="row"
        style={{ gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}
      >
        <div className="field" style={{ flex: '1 1 140px', margin: 0 }}>
          <label style={{ fontSize: 11.5 }}>词或短语</label>
          <input
            className="input"
            value={draftWord}
            onChange={(e) => setDraftWord(e.target.value)}
            placeholder="如：微微一笑"
            disabled={disabled}
          />
        </div>
        <div className="field" style={{ flex: '2 1 220px', margin: 0 }}>
          <label style={{ fontSize: 11.5 }}>改写示例（可选）</label>
          <input
            className="input"
            value={draftExample}
            onChange={(e) => setDraftExample(e.target.value)}
            placeholder="如：嘴角微微上扬，没有说话"
            disabled={disabled}
          />
        </div>
        <button
          className="btn btn-sm"
          onClick={add}
          disabled={disabled || !draftWord.trim()}
        >
          添加
        </button>
      </div>
      {err ? (
        <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>{err}</p>
      ) : null}
      <div className="row" style={{ marginTop: 10 }}>
        <button
          className="btn btn-primary btn-sm"
          onClick={save}
          disabled={disabled || saving}
        >
          {saving ? '保存中…' : '保存词条'}
        </button>
      </div>
    </div>
  )
}
