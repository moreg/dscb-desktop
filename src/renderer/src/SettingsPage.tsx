import { useEffect, useRef, useState } from 'react'
import type {
  UsageSummary,
  ListProvidersResult,
  ProviderSummary,
  ProviderProtocol,
  ProjectUsage,
  ChapterUsage,
  ChapterRuleSectionView
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
    { id: 'writingRules', label: '续写规则' }
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
  const refreshAiHighFreq = () => void window.api.getAiHighFreqConfig().then(setAiHighFreq)
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
          LLM_AUTH_FAILED: '认证失败，请检查 API Key',
          LLM_RATE_LIMIT: '请求过于频繁',
          LLM_REQUEST_FAILED: '请求失败',
          NETWORK_ERROR: '网络错误'
        }
        setPingResult({ ok: false, text: '✗ ' + (map[r.error ?? ''] ?? r.error ?? '未知错误') })
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
                      const saved = await writingTemplateApi.setWritingRequirementTemplates(
                        normalized
                      )
                      setWritingTemplates(saved)
                      setMsg({ kind: 'ok', text: '写作模板已保存' })
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
  const resetTemp = () => {
    if (tempTimer.current) {
      clearTimeout(tempTimer.current)
      tempTimer.current = null
    }
    setTempDraft(null)
    void window.api.upsertProvider({
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: '',
      protocol: provider.protocol
    })
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
              <span className="chip chip-success" title="已配置 API Key">
                ✓ {provider.keyMasked || 'Key'}
              </span>
            ) : (
              <span className="chip chip-warning">无 Key</span>
            )}
            <span
              className="chip"
              style={{
                background:
                  provider.protocol === 'anthropic' ? 'var(--inkstone-soft)' : 'var(--surface-2)',
                color:
                  provider.protocol === 'anthropic' ? 'var(--inkstone)' : 'var(--ink-3)'
              }}
            >
              {provider.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'}
            </span>
          </div>
          <div className="meta" style={{ marginTop: 6, wordBreak: 'break-all' }}>
            {provider.baseUrl || '(未填 baseUrl)'} · {provider.model || '(未填 model)'}
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

  const submit = async () => {
    setErr(null)
    if (!label.trim()) return setErr('请填写名称')
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
    setSaving(true)
    try {
      await window.api.upsertProvider({
        id: newId(),
        label: label.trim(),
        baseUrl: baseUrlTrim.replace(/\/+$/, ''),
        model: model.trim(),
        apiKey: apiKey.trim(),
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
        <div className="field" style={{ flex: 2, marginBottom: 10 }}>
          <label>Base URL</label>
          <input
            className="input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </div>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <div className="field" style={{ flex: 1, marginBottom: 10 }}>
          <label>模型</label>
          <input
            className="input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="例如 gpt-4o-mini / deepseek-chat"
          />
        </div>
        <div className="field" style={{ flex: 1, marginBottom: 10 }}>
          <label>协议</label>
          <select
            className="select"
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as ProviderProtocol)}
          >
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
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
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button
          className="btn btn-primary btn-sm"
          onClick={submit}
          disabled={saving || !label.trim() || !model.trim()}
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
