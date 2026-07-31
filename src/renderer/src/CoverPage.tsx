import { useEffect, useState, useCallback, useRef } from 'react'
import type {
  CoverFile,
  CoverGenre,
  CoverImageConfigSummary,
  CoverPlatform,
  CoverComposition,
  GenerateCoverInput
} from '../../shared/types'

const PLATFORM_OPTIONS: { value: CoverPlatform; label: string }[] = [
  { value: 'fanqie', label: '番茄小说（3:4）' },
  { value: 'qidian', label: '起点（2:3）' },
  { value: 'jjwxc', label: '晋江（2:3）' },
  { value: 'zhihu', label: '知乎盐言（2:3）' },
  { value: 'qimao', label: '七猫（2:3）' },
  { value: 'ciweimao', label: '刺猬猫（2:3）' },
  { value: 'other', label: '其他（2:3）' }
]

const GENRE_OPTIONS: { value: CoverGenre; label: string }[] = [
  { value: 'xianxia', label: '玄幻/仙侠' },
  { value: 'urban', label: '都市' },
  { value: 'ancient_romance', label: '古言/宫斗' },
  { value: 'modern_romance', label: '现言/甜宠' },
  { value: 'mystery', label: '悬疑/推理' },
  { value: 'scifi', label: '科幻/末世' },
  { value: 'western_fantasy', label: '西幻' },
  { value: 'historical', label: '历史/军事' },
  { value: 'supernatural', label: '灵异/恐怖' },
  { value: 'light_novel', label: '轻小说' }
]

const COMPOSITION_OPTIONS: { value: CoverComposition; label: string }[] = [
  { value: 'closeup', label: '人物特写（通用）' },
  { value: 'fullbody', label: '全身动态' },
  { value: 'scene', label: '纯场景/氛围' },
  { value: 'duo', label: '双人（言情）' }
]

const GENRE_LABELS: Record<CoverGenre, string> = {
  xianxia: '玄幻/仙侠',
  urban: '都市',
  ancient_romance: '古言',
  modern_romance: '现言',
  mystery: '悬疑',
  scifi: '科幻',
  western_fantasy: '西幻',
  historical: '历史',
  supernatural: '灵异',
  light_novel: '轻小说'
}

/** 把主进程抛回的错误码翻成人话（safeHandle 会带 "Error: " 前缀） */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.includes('COVER_PROMPT_NO_MATERIAL')) {
    return '这本书还没有简介、大纲、人物卡或正文，先写一点再来提炼。'
  }
  if (raw.includes('COVER_PROMPT_PARSE_FAILED')) {
    return '模型没有按要求返回 JSON。重试一次，或在设置里给「辅助提取」换一个更稳的模型。'
  }
  if (raw.includes('LLM_NOT_CONFIGURED')) {
    return '还没有可用的文本模型。到全局设置里配置 API Key，或接入 codex / grok CLI。'
  }
  if (raw.includes('LLM_TIMEOUT')) {
    return '提炼超时。素材较多时可先精简大纲，或换一个更快的模型。'
  }
  return raw.replace(/^Error:\s*/, '')
}

interface Props {
  projectId: string
}

export default function CoverPage({ projectId }: Props): React.ReactElement {
  const [covers, setCovers] = useState<CoverFile[]>([])
  const [config, setConfig] = useState<CoverImageConfigSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [error, setError] = useState('')

  // 表单
  const [bookName, setBookName] = useState('')
  const [authorName, setAuthorName] = useState('')
  const [platform, setPlatform] = useState<CoverPlatform>('fanqie')
  const [genreOverride, setGenreOverride] = useState<CoverGenre | ''>('')
  const [composition, setComposition] = useState<CoverComposition>('closeup')
  const [extraHint, setExtraHint] = useState('')

  /**
   * 唯一的提示词事实来源：框里是什么，就原样送给图像模型。
   * 未手改时跟随上方表单自动重拼；手改后停止自动覆盖（否则会吞掉用户的编辑）。
   */
  const [prompt, setPrompt] = useState('')
  const [promptDirty, setPromptDirty] = useState(false)
  /** 拼出当前提示词时用的平台，用于提示「改了平台但提示词没跟着变」 */
  const [promptPlatform, setPromptPlatform] = useState<CoverPlatform | null>(null)
  const [summary, setSummary] = useState('')
  const [sources, setSources] = useState<string[]>([])

  // 配置弹窗
  const [showConfig, setShowConfig] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [list, cfg] = await Promise.all([
        window.api.listCovers(projectId),
        window.api.getCoverImageConfig()
      ])
      setCovers(list)
      setConfig(cfg)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 书名默认取项目名，省得每次手打；用户改过就不再覆盖
  const bookNamePrefilled = useRef(false)
  useEffect(() => {
    bookNamePrefilled.current = false
    let active = true
    void window.api
      .getProject(projectId)
      .then((project) => {
        if (!active || bookNamePrefilled.current || !project?.name) return
        bookNamePrefilled.current = true
        setBookName((prev) => (prev.trim() ? prev : project.name))
      })
      .catch(() => {
        /* 项目信息读不到不影响手填 */
      })
    return () => {
      active = false
    }
  }, [projectId])

  const trimmedBook = bookName.trim()
  const trimmedAuthor = authorName.trim()
  const canBuild = Boolean(trimmedBook && trimmedAuthor)

  /** 当前表单折算成出图入参（拼装与生成共用，保证所见即所发） */
  const buildInput = useCallback(
    (overrides?: Partial<GenerateCoverInput>): GenerateCoverInput => ({
      projectId,
      bookName: trimmedBook,
      authorName: trimmedAuthor,
      platform,
      composition,
      ...(genreOverride ? { genreOverride } : {}),
      ...overrides
    }),
    [projectId, trimmedBook, trimmedAuthor, platform, composition, genreOverride]
  )

  // 未手改时跟随表单重拼提示词；手改后不再自动覆盖，改由「重置」显式放弃编辑
  useEffect(() => {
    if (promptDirty || !canBuild) return
    let active = true
    void window.api
      .buildCoverPrompt(buildInput())
      .then((text) => {
        if (active) {
          setPrompt(text)
          setPromptPlatform(platform)
        }
      })
      .catch(() => {
        /* 拼装失败不打断填表 */
      })
    return () => {
      active = false
    }
  }, [promptDirty, canBuild, buildInput, platform])

  /**
   * 手改过的提示词里写死了当时平台的比例（如 "portrait 3:4 ratio"），
   * 之后改平台只会改出图尺寸，提示词里的比例不会跟着变 —— 两者打架会画歪。
   */
  const platformStale = promptDirty && promptPlatform !== null && promptPlatform !== platform

  const handleGenerate = async (): Promise<void> => {
    if (!canBuild) {
      setError('书名和作者名必填')
      return
    }
    if (!prompt.trim()) {
      setError('提示词不能为空')
      return
    }
    if (!config?.hasKey) {
      setError('请先配置图像生成 API（点右上「图像配置」）')
      return
    }
    setGenerating(true)
    setError('')
    try {
      // 框里是什么就发什么
      await window.api.generateCover(buildInput({ promptOverride: prompt }))
      await refresh()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setGenerating(false)
    }
  }

  /**
   * 读项目的大纲 / 人物卡 / 正文提炼画面要素，拼成整段提示词填进框里。
   * 只调文本模型（走 auxiliary 路由），没配图像 Key 也能先把提示词调好。
   */
  const handleExtractPrompt = async (): Promise<void> => {
    if (!canBuild) {
      setError('书名和作者名必填')
      return
    }
    setExtracting(true)
    setError('')
    try {
      const hasLlm = await window.api.hasLlmKey()
      if (!hasLlm) {
        throw new Error('请先在全局设置中配置文本模型（API Key 或 codex / grok CLI 均可）')
      }
      const draft = await window.api.extractCoverPrompt({
        projectId,
        bookName: trimmedBook,
        authorName: trimmedAuthor,
        platform,
        ...(genreOverride ? { genreOverride } : {}),
        ...(extraHint.trim() ? { extraHint: extraHint.trim() } : {})
      })
      setPrompt(draft.prompt)
      // 提炼结果视同手改：后续改平台/题材不该把它冲掉
      setPromptDirty(true)
      setPromptPlatform(platform)
      setSummary(draft.summary)
      setSources(draft.sources)
      setComposition(draft.composition)
      if (!genreOverride) setGenreOverride(draft.genre)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setExtracting(false)
    }
  }

  /** 丢弃提炼与手改，回到当前平台/题材/构图的模板提示词 */
  const handleResetPrompt = async (): Promise<void> => {
    setError('')
    setSummary('')
    setSources([])
    setPromptDirty(false)
    if (!canBuild) {
      setPrompt('')
      setPromptPlatform(null)
      return
    }
    try {
      setPrompt(await window.api.buildCoverPrompt(buildInput()))
      setPromptPlatform(platform)
    } catch (err) {
      setError(describeError(err))
    }
  }

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>封面设计</h1>
            <p className="desc">一眼传达题材与氛围 · 调用图像模型生成含书名署名的专业封面</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => setShowConfig(true)}>
              ⚙ 图像配置
              {config?.hasKey ? (
                <span style={{ marginLeft: 6, color: 'var(--success)' }}>●已配置</span>
              ) : (
                <span style={{ marginLeft: 6, color: 'var(--danger)' }}>●未配置</span>
              )}
            </button>
          </div>
        </div>
      </div>

      {config && !config.hasKey ? (
        <div className="placeholder" style={{ marginTop: 16 }}>
          <p style={{ margin: '0 0 6px', fontSize: 14, color: 'var(--danger)' }}>
            图像生成 API 未配置。出图需要 OpenAI Images API 或兼容代理的 Key（gpt-image-2）。
          </p>
          <p className="meta" style={{ margin: '0 0 12px' }}>
            codex / grok 这类 CLI 只能生成文本，不能出图；下方「提炼画面要素」可以先用它们把提示词调好。
          </p>
          <button className="btn btn-primary" onClick={() => setShowConfig(true)}>
            前往配置
          </button>
        </div>
      ) : null}

      {/* 生成表单 */}
      <div className="dialog" style={{ maxWidth: 'none', margin: '12px 0', boxShadow: 'none' }}>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: '2 1 200px' }}>
            <label htmlFor="cover-book-name">书名 *</label>
            <input
              id="cover-book-name"
              className="input"
              value={bookName}
              onChange={(e) => setBookName(e.target.value)}
              placeholder="《剑道独尊》"
            />
          </div>
          <div className="field" style={{ flex: '1 1 120px' }}>
            <label htmlFor="cover-author">作者名（笔名）*</label>
            <input
              id="cover-author"
              className="input"
              value={authorName}
              onChange={(e) => setAuthorName(e.target.value)}
              placeholder="青椒炒肉"
            />
          </div>
        </div>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: '1 1 140px' }}>
            <label htmlFor="cover-platform">目标平台</label>
            <select id="cover-platform" className="input" value={platform} onChange={(e) => setPlatform(e.target.value as CoverPlatform)}>
              {PLATFORM_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 140px' }}>
            <label htmlFor="cover-genre">题材（留空自动推断）</label>
            <select
              id="cover-genre"
              className="input"
              value={genreOverride}
              onChange={(e) => setGenreOverride(e.target.value as CoverGenre | '')}
            >
              <option value="">自动推断</option>
              {GENRE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 140px' }}>
            <label htmlFor="cover-composition">构图</label>
            <select
              id="cover-composition"
              className="input"
              value={composition}
              onChange={(e) => setComposition(e.target.value as CoverComposition)}
            >
              {COMPOSITION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {/* 唯一的提示词事实来源：框里是什么，就原样送给图像模型 */}
        <div className="field" style={{ marginBottom: 4 }}>
          <label
            htmlFor="cover-prompt"
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}
          >
            <span>
              封面提示词
              <span className="meta" style={{ marginLeft: 6 }}>
                {promptDirty ? '已手改，出图按此原文' : '按平台/题材自动拼装，可直接编辑'}
              </span>
            </span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn"
                style={{
                  fontSize: 12,
                  padding: '2px 10px',
                  height: 24,
                  borderRadius: 12,
                  background: 'var(--accent-soft)',
                  color: 'var(--accent)',
                  border: '1px solid var(--line-strong)',
                  cursor: extracting ? 'wait' : 'pointer',
                  opacity: extracting ? 0.7 : 1
                }}
                onClick={() => void handleExtractPrompt()}
                disabled={extracting || !canBuild}
                title="读本书的简介、大纲、人物卡与开篇正文，提炼出专属画面后重写整段提示词（只调文本模型，不消耗图像额度）"
              >
                {extracting ? (
                  <>
                    <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span>{' '}
                    提炼中…
                  </>
                ) : (
                  '✦ 从小说内容提炼'
                )}
              </button>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: '2px 10px', height: 24 }}
                onClick={() => void handleResetPrompt()}
                disabled={extracting}
                title="丢弃提炼与手改，回到当前平台/题材/构图的模板提示词"
              >
                ↺ 重置
              </button>
            </span>
          </label>
          <textarea
            id="cover-prompt"
            className="input"
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value)
              setPromptDirty(true)
            }}
            placeholder={canBuild ? '' : '填写书名与作者名后自动生成'}
            spellCheck={false}
            style={{
              resize: 'vertical',
              minHeight: 200,
              padding: '10px 12px',
              lineHeight: 1.6,
              fontSize: 12,
              fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)'
            }}
            rows={10}
          />
          {platformStale ? (
            <p className="meta" style={{ margin: '6px 0 0', color: 'var(--danger)' }}>
              平台已改为「{PLATFORM_OPTIONS.find((o) => o.value === platform)?.label}」，
              但提示词里的比例还是改平台之前的。点「重置」重拼，或手动改掉里面的 ratio。
            </p>
          ) : null}
          {summary ? (
            <p style={{ margin: '6px 0 0', fontSize: 13 }}>{summary}</p>
          ) : null}
          {sources.length > 0 ? (
            <p className="meta" style={{ margin: '2px 0 0' }}>
              素材来源：{sources.join(' · ')}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="cover-extra-hint" style={{ fontSize: 12 }}>
            提炼方向（可选，只影响「从小说内容提炼」）
          </label>
          <input
            id="cover-extra-hint"
            className="input"
            value={extraHint}
            onChange={(e) => setExtraHint(e.target.value)}
            placeholder="如：主角画女性视角 / 不要人物只要场景 / 突出第三卷的决战"
          />
        </div>

        {error ? <p className="diag-msg" style={{ color: 'var(--danger)' }}>{error}</p> : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button
            className="btn btn-primary"
            onClick={() => void handleGenerate()}
            disabled={generating || !canBuild || !prompt.trim()}
          >
            {generating ? '生成中…（约 30-90 秒）' : '✦ 生成封面'}
          </button>
        </div>
      </div>

      {/* 封面历史 */}
      <h3 style={{ fontSize: 14, margin: '20px 0 12px' }}>封面版本</h3>
      {loading ? (
        <p className="empty">加载中…</p>
      ) : covers.length === 0 ? (
        <div className="placeholder">
          <p style={{ margin: 0, fontSize: 14 }}>还没有封面。填写上方信息生成第一个。</p>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 16
          }}
        >
          {covers.map((c) => (
            <CoverThumb key={c.relPath} cover={c} projectId={projectId} />
          ))}
        </div>
      )}

      {showConfig && config ? (
        <CoverConfigDialog
          config={config}
          onClose={() => setShowConfig(false)}
          onSaved={async () => {
            const cfg = await window.api.getCoverImageConfig()
            setConfig(cfg)
            setShowConfig(false)
          }}
        />
      ) : null}
    </div>
  )
}

function CoverThumb({ cover, projectId }: { cover: CoverFile; projectId: string }): React.ReactElement {
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.api.readCover(projectId, cover.fileName).then((url) => {
      if (active) setDataUrl(url)
    })
    return () => {
      active = false
    }
  }, [projectId, cover.fileName])

  return (
    <div className="project-card" style={{ padding: 8, cursor: 'default' }}>
      <div
        style={{
          width: '100%',
          aspectRatio: '3 / 4',
          background: 'var(--surface-2)',
          borderRadius: 6,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 8
        }}
      >
        {dataUrl ? (
          <img src={dataUrl} alt={cover.fileName} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span className="meta">加载中…</span>
        )}
      </div>
      <div style={{ fontSize: 12 }}>
        <div style={{ fontWeight: 600 }}>
          v{cover.version}
          {cover.isUploadSize ? ' · 上传版' : ''}
        </div>
        <div className="meta">
          {GENRE_LABELS[cover.genre]} · {(cover.size / 1024).toFixed(0)} KB
        </div>
      </div>
    </div>
  )
}

function CoverConfigDialog({
  config,
  onClose,
  onSaved
}: {
  config: CoverImageConfigSummary
  onClose: () => void
  onSaved: () => void
}): React.ReactElement {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(config.baseUrl)
  const [model, setModel] = useState(config.model)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      await window.api.setCoverImageConfig({
        apiKey: apiKey || undefined,
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim() || undefined
      })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <h3>图像生成 API 配置</h3>
        <p className="meta" style={{ marginTop: 4 }}>
          封面生成调用 OpenAI Images API（gpt-image-2）或兼容代理。独立于文本 LLM provider。
        </p>
        <div className="field">
          <label>API Key {config.hasKey ? `（当前 ${config.keyMasked}，留空保留）` : '*'}</label>
          <input
            className="input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config.hasKey ? '留空保留当前 key' : 'sk-...'}
          />
        </div>
        <div className="field">
          <label>Base URL</label>
          <input
            className="input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </div>
        <div className="field">
          <label>模型</label>
          <input
            className="input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-image-2"
          />
        </div>
        {error ? <p className="diag-msg" style={{ color: 'var(--danger)' }}>{error}</p> : null}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
