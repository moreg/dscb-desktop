import { useEffect, useState, useCallback } from 'react'
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

interface Props {
  projectId: string
}

export default function CoverPage({ projectId }: Props): React.ReactElement {
  const [covers, setCovers] = useState<CoverFile[]>([])
  const [config, setConfig] = useState<CoverImageConfigSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [generatingPrompt, setGeneratingPrompt] = useState(false)
  const [error, setError] = useState('')

  // 表单
  const [bookName, setBookName] = useState('')
  const [authorName, setAuthorName] = useState('')
  const [platform, setPlatform] = useState<CoverPlatform>('fanqie')
  const [genreOverride, setGenreOverride] = useState<CoverGenre | ''>('')
  const [composition, setComposition] = useState<CoverComposition>('closeup')
  const [styleHint, setStyleHint] = useState('')

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

  const handleGenerate = async (): Promise<void> => {
    if (!bookName.trim() || !authorName.trim()) {
      setError('书名和作者名必填')
      return
    }
    if (!config?.hasKey) {
      setError('请先配置图像生成 API（点右上「图像配置」）')
      return
    }
    setGenerating(true)
    setError('')
    try {
      const input: GenerateCoverInput = {
        projectId,
        bookName: bookName.trim(),
        authorName: authorName.trim(),
        platform,
        composition,
        styleHint: styleHint.trim() || undefined,
        ...(genreOverride ? { genreOverride } : {})
      }
      await window.api.generateCover(input)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setGenerating(false)
    }
  }

  const handleGenerateStyleHint = async (): Promise<void> => {
    setGeneratingPrompt(true)
    setError('')
    try {
      const hasLlm = await window.api.hasLlmKey()
      if (!hasLlm) {
        throw new Error('请先在全局设置中配置文本模型 API Key')
      }

      const project = await window.api.getProject(projectId)
      const outline = await window.api.getMainOutline(projectId)
      
      const prompt = `请根据以下小说的书名、简介和大纲，提取小说的核心视觉元素，并生成一段用于 AI 绘画的封面提示词（风格补充）。
要求：
1. 重点突出小说的氛围、主角特征、核心场景、色调等视觉元素。
2. 语言简练，直接输出提示词，不需要解释，不需要多余的话，尽量用短语或短句。
3. 示例："偏暗黑系，赛博朋克风格，霓虹灯光，主角黑衣单刀，背景高楼大厦，冷色调"

小说书名：${project.name}
小说简介：${project.description || '无'}
小说大纲：${outline?.synopsis || '无'}`

      let generated = ''
      setStyleHint('')
      const res = await window.api.generateStream(prompt, (token) => {
        generated += token
        setStyleHint(generated)
      })

      if (!res.ok) {
        throw new Error(res.error || '生成失败')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setGeneratingPrompt(false)
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
                <span style={{ marginLeft: 6, color: '#16a34a' }}>●已配置</span>
              ) : (
                <span style={{ marginLeft: 6, color: '#dc2626' }}>●未配置</span>
              )}
            </button>
          </div>
        </div>
      </div>

      {config && !config.hasKey ? (
        <div className="placeholder" style={{ marginTop: 16 }}>
          <p style={{ margin: '0 0 12px', fontSize: 14, color: '#dc2626' }}>
            图像生成 API 未配置。封面生成需要 OpenAI Images API 或兼容代理的 Key（gpt-image-2）。
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
        <div className="field">
          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>风格补充（可选）</span>
            <button
              className="btn"
              style={{
                fontSize: 12,
                padding: '2px 10px',
                height: 24,
                borderRadius: 12,
                background: 'linear-gradient(135deg, #f3e8ff 0%, #e0e7ff 100%)',
                color: '#6d28d9',
                border: '1px solid #c4b5fd',
                cursor: generatingPrompt ? 'wait' : 'pointer',
                opacity: generatingPrompt ? 0.7 : 1,
                display: 'flex',
                alignItems: 'center',
                gap: 4
              }}
              onClick={() => void handleGenerateStyleHint()}
              disabled={generatingPrompt}
            >
              {generatingPrompt ? (
                <>
                  <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span> 生成中...
                </>
              ) : (
                '✦ 智能生成'
              )}
            </button>
          </label>
          <textarea
            className="input"
            value={styleHint}
            onChange={(e) => setStyleHint(e.target.value)}
            placeholder="如：偏暗黑系，赛博朋克风格，霓虹灯光，主角黑衣单刀，背景高楼大厦，冷色调"
            style={{ resize: 'vertical', minHeight: '60px', padding: '8px 12px', lineHeight: 1.5 }}
            rows={2}
          />
        </div>
        {error ? <p className="diag-msg" style={{ color: '#dc2626' }}>{error}</p> : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button
            className="btn btn-primary"
            onClick={() => void handleGenerate()}
            disabled={generating || !bookName.trim() || !authorName.trim()}
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
          background: '#f0f0f0',
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
        {error ? <p className="diag-msg" style={{ color: '#dc2626' }}>{error}</p> : null}
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
