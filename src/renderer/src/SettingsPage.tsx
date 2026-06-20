import { useEffect, useState } from 'react'
import type {
  UsageSummary,
  ListProvidersResult,
  ProviderSummary
} from '../../shared/types'

interface Props {
  onBack: () => void
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

export default function SettingsPage({ onBack }: Props) {
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
  const [pricing, setPricing] = useState({ inputRate: 1, outputRate: 3 })
  const [dailyGoal, setDailyGoal] = useState(3000)
  const [pomoFocus, setPomoFocus] = useState(25)
  const [pomoBreak, setPomoBreak] = useState(5)

  const refreshProviders = () => void window.api.listProviders().then(setProviders)
  const refreshRoot = () => void window.api.getProjectsRoot().then(setProjectsRoot)
  const refreshUsage = () => void window.api.getUsageSummary().then(setUsage)

  useEffect(() => {
    refreshProviders()
    refreshRoot()
    refreshUsage()
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
      <button className="btn btn-ghost btn-sm" onClick={onBack}>
        ‹ 返回
      </button>
      <h2 className="section mt">设置</h2>

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

      <div className="card" style={{ maxWidth: 600, marginTop: 16 }}>
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

      {/* 模型 provider 配置区 */}
      <div className="card" style={{ maxWidth: 600, marginTop: 16 }}>
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
          用于大纲生成、细纲生成、章节续写、改稿。所有 provider 走 OpenAI Chat
          Completions 兼容协议（POST <code>{'{baseUrl}'}/chat/completions</code>），适用于绝大多数主流厂商。
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
          <p className="empty" style={{ padding: '12px 0' }}>尚未添加任何 provider</p>
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

      {/* 全局消息提示 */}
      {msg ? (
        <p
          style={{
            color: msg.kind === 'ok' ? 'var(--success)' : 'var(--danger)',
            marginTop: 14,
            fontSize: 13
          }}
        >
          {msg.text}
        </p>
      ) : null}

      {/* Token / 费用仪表盘 */}
      <div className="card" style={{ maxWidth: 600, marginTop: 16 }}>
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
          <p className="empty" style={{ padding: 8 }}>加载中…</p>
        )}
      </div>

      {/* 写作目标 + 番茄钟 */}
      <div className="card" style={{ maxWidth: 600, marginTop: 16 }}>
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
          </div>
          <div className="meta" style={{ marginTop: 6, wordBreak: 'break-all' }}>
            {provider.baseUrl || '(未填 baseUrl)'} · {provider.model || '(未填 model)'}
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
        apiKey: apiKey.trim()
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