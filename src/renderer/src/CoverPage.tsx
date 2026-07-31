import { useEffect, useState, useCallback, useRef } from 'react'
import type {
  CoverFile,
  CoverGenre,
  CoverImageConfigSummary,
  CoverPlatform,
  CoverComposition,
  CoverStylePreset,
  CoverTypographyOptions,
  CoverTitleFontStyle,
  CoverTitlePosition,
  CoverTitleEffect,
  CoverAuthorFontStyle,
  CoverAuthorPosition,
  GenerateCoverInput
} from '../../shared/types'

const PLATFORM_OPTIONS: { value: CoverPlatform; label: string }[] = [
  { value: 'fanqie', label: '番茄小说（默认 9:16）' },
  { value: 'qidian', label: '起点（默认 9:16）' },
  { value: 'jjwxc', label: '晋江（默认 9:16）' },
  { value: 'zhihu', label: '知乎盐言（默认 9:16）' },
  { value: 'qimao', label: '七猫（默认 9:16）' },
  { value: 'ciweimao', label: '刺猬猫（默认 9:16）' },
  { value: 'other', label: '其他（默认 9:16）' }
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

const STYLE_PRESET_OPTIONS: Array<{
  value: CoverStylePreset
  label: string
  description: string
  swatch: string
}> = [
  {
    value: 'auto',
    label: '智能匹配',
    description: '按平台、题材和小说内容自动选择视觉表达',
    swatch: 'linear-gradient(135deg, #24364b, #d7a24a, #f2e7d2)'
  },
  {
    value: 'fanqie_impact',
    label: '高饱和爽文海报',
    description: '强对比、主体醒目、超大标题，适合脑洞与逆袭',
    swatch: 'linear-gradient(135deg, #ff5a2a, #ffc400 52%, #1167d8)'
  },
  {
    value: 'ancient_romance',
    label: '古风人物言情',
    description: '古装人物、红金华服与情绪关系',
    swatch: 'linear-gradient(135deg, #611016, #d13a32 52%, #d9ad58)'
  },
  {
    value: 'ink_minimal',
    label: '国风水墨留白',
    description: '宣纸、水墨山水、花枝与书法标题',
    swatch: 'linear-gradient(135deg, #f3ead6, #c7c1a8 55%, #27302d)'
  },
  {
    value: 'dark_suspense',
    label: '暗黑悬疑电影',
    description: '低照度、强阴影与局部红色警示',
    swatch: 'linear-gradient(135deg, #080b12, #253b51 65%, #a10f1a)'
  },
  {
    value: 'urban_cinematic',
    label: '都市电影感',
    description: '写实人物、城市空间与高级电影光影',
    swatch: 'linear-gradient(135deg, #17293d, #436f8e 55%, #d99b55)'
  },
  {
    value: 'anime_light',
    label: '二次元轻小说',
    description: '角色立绘、明亮配色和图形贴纸感',
    swatch: 'linear-gradient(135deg, #49c8ff, #f47cc2 55%, #8b68e8)'
  },
  {
    value: 'retro_period',
    label: '年代复古宣传画',
    description: '旧海报质感、年代建筑与暖色印刷色',
    swatch: 'linear-gradient(135deg, #a83428, #d1a64b 52%, #52776d)'
  },
  {
    value: 'epic_fantasy',
    label: '玄幻史诗大片',
    description: '宏大世界、英雄主体与克制能量特效',
    swatch: 'linear-gradient(135deg, #111833, #4d3480 52%, #d89d39)'
  },
  {
    value: 'concept_symbol',
    label: '无人物概念符号',
    description: '用关键物、徽记或空间表达故事核心',
    swatch: 'linear-gradient(135deg, #161513, #655542 58%, #dfd0ad)'
  },
  {
    value: 'glamour_romance',
    label: '女频精致人像',
    description: '柔光人像、时尚质感与装饰字，适合现言豪门',
    swatch: 'linear-gradient(135deg, #f5d9d3, #a33d56 55%, #d8b16b)'
  },
  {
    value: 'cute_doodle',
    label: '沙雕简笔脑洞',
    description: '白底手绘、表情包角色与超大手写标题',
    swatch: 'linear-gradient(135deg, #fffdf5, #f05038 62%, #ffd43b)'
  },
  {
    value: 'warm_period_life',
    label: '年代生活群像',
    description: '年代服装、家庭群像与温暖金色日光',
    swatch: 'linear-gradient(135deg, #53664b, #d4a15e 55%, #9e3e31)'
  },
  {
    value: 'rural_healing',
    label: '田园种田治愈',
    description: '乡野、作物、美食和有烟火气的日常生活',
    swatch: 'linear-gradient(135deg, #759447, #e4bd63 58%, #bd5b36)'
  },
  {
    value: 'male_power_type',
    label: '男频强字效爽文',
    description: '英雄主体、强透视和粗黑堆叠标题',
    swatch: 'linear-gradient(135deg, #10151e, #ef6b25 52%, #1b7acb)'
  },
  {
    value: 'folk_horror',
    label: '中式民俗灵异',
    description: '纸扎、棺木、古宅和红黑禁忌物',
    swatch: 'linear-gradient(135deg, #100c0b, #8e1118 58%, #b49154)'
  },
  {
    value: 'war_spy_epic',
    label: '战争谍战纪实',
    description: '战场、列车、密信与孤胆行动人物',
    swatch: 'linear-gradient(135deg, #30352f, #ae6d35 58%, #d4c09b)'
  },
  {
    value: 'game_neon',
    label: '游戏科幻霓虹',
    description: '全身角色、技能光效与蓝橙游戏标题',
    swatch: 'linear-gradient(135deg, #071b37, #087fd3 52%, #ff7832)'
  },
  {
    value: 'western_adventure',
    label: '西幻冒险轻快',
    description: '异世界角色、城镇、工坊与冒险道具',
    swatch: 'linear-gradient(135deg, #e8d5a9, #57a4c8 55%, #a34d36)'
  },
  {
    value: 'minimal_typographic',
    label: '纯字极简概念',
    description: '用书名排版、色块和单一符号完成封面',
    swatch: 'linear-gradient(135deg, #f3eee3 48%, #c42e25 49%, #171717 72%)'
  }
]

const TITLE_FONT_OPTIONS: Array<{ value: CoverTitleFontStyle; label: string }> = [
  { value: 'auto', label: '跟随封面风格' },
  { value: 'impact', label: '粗黑堆叠大字' },
  { value: 'brush', label: '国风毛笔书法' },
  { value: 'elegant', label: '雅致宋体/楷体' },
  { value: 'modern', label: '现代几何黑体' },
  { value: 'suspense', label: '悬疑窄体锐字' },
  { value: 'anime', label: '二次元描边字' },
  { value: 'retro', label: '年代复古印刷字' }
]

const TITLE_POSITION_OPTIONS: Array<{ value: CoverTitlePosition; label: string }> = [
  { value: 'auto', label: '自动布局' },
  { value: 'top', label: '顶部横排' },
  { value: 'center', label: '中央主视觉' },
  { value: 'lower_third', label: '下三分之一横排' },
  { value: 'vertical_left', label: '左侧竖排' },
  { value: 'vertical_right', label: '右侧竖排' }
]

const TITLE_EFFECT_OPTIONS: Array<{ value: CoverTitleEffect; label: string }> = [
  { value: 'auto', label: '跟随封面风格' },
  { value: 'flat', label: '纯色平面' },
  { value: 'outline_shadow', label: '描边立体阴影' },
  { value: 'metallic', label: '金属金/银质感' },
  { value: 'ink', label: '水墨飞白' },
  { value: 'glow', label: '克制发光' },
  { value: 'embossed', label: '浮雕刻字' }
]

const AUTHOR_FONT_OPTIONS: Array<{ value: CoverAuthorFontStyle; label: string }> = [
  { value: 'auto', label: '跟随封面风格' },
  { value: 'sans', label: '简洁现代黑体' },
  { value: 'serif', label: '雅致宋体' },
  { value: 'seal', label: '印章/篆刻感' },
  { value: 'handwritten', label: '自然手写体' },
  { value: 'metallic', label: '纤细金属字' }
]

const AUTHOR_POSITION_OPTIONS: Array<{ value: CoverAuthorPosition; label: string }> = [
  { value: 'auto', label: '自动布局' },
  { value: 'bottom_center', label: '底部居中' },
  { value: 'bottom_right', label: '右下角' },
  { value: 'vertical_side', label: '标题侧边竖排' }
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
  const [stylePreset, setStylePreset] = useState<CoverStylePreset>('fanqie_impact')
  const [typography, setTypography] = useState<CoverTypographyOptions>({
    titleFont: 'auto',
    titlePosition: 'auto',
    titleEffect: 'auto',
    authorFont: 'auto',
    authorPosition: 'auto'
  })
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
      stylePreset,
      typography,
      ...(genreOverride ? { genreOverride } : {}),
      ...overrides
    }),
    [projectId, trimmedBook, trimmedAuthor, platform, composition, stylePreset, typography, genreOverride]
  )

  const selectStylePreset = (next: CoverStylePreset): void => {
    setStylePreset(next)
    if (next === 'concept_symbol') setComposition('scene')
    setSummary('')
    setSources([])
    // 风格卡片就是一次明确的“按当前选择重生成模板提示词”操作。
    setPromptDirty(false)
    setError('')
  }

  const updateTypography = (patch: Partial<CoverTypographyOptions>): void => {
    setTypography((current) => ({ ...current, ...patch }))
    setSummary('')
    setSources([])
    setPromptDirty(false)
    setError('')
  }

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
   * 手改过的提示词里也包含平台风格。之后改平台不会覆盖手改内容，
   * 因此提醒用户重置提示词，避免新平台和旧风格互相冲突。
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
      setError('请先配置图像生成 API（点右上「封面配置」）')
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
        stylePreset,
        typography,
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
              ⚙ 封面配置
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
        <div className="field cover-style-field">
          <label>
            封面风格
            <span className="meta" style={{ marginLeft: 6 }}>
              已分析番茄 23 个题材、138 张榜单封面的共性，不复刻具体作品
            </span>
          </label>
          <div className="cover-style-grid" role="radiogroup" aria-label="封面风格">
            {STYLE_PRESET_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={stylePreset === option.value}
                className={`cover-style-card ${stylePreset === option.value ? 'active' : ''}`}
                onClick={() => selectStylePreset(option.value)}
              >
                <span className="cover-style-swatch" style={{ background: option.swatch }} aria-hidden />
                <span className="cover-style-copy">
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                <span className="cover-style-check" aria-hidden>{stylePreset === option.value ? '✓' : ''}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="cover-typography-panel">
          <div className="cover-typography-head">
            <div>
              <strong>文字设计</strong>
              <span>分别控制小说书名与作者名的字体、位置和效果</span>
            </div>
            <span className="chip chip-muted">文字只出现一次 · 保持安全边距</span>
          </div>
          <div className="cover-typography-grid">
            <div className="field">
              <label htmlFor="cover-title-font">书名字体</label>
              <select
                id="cover-title-font"
                className="select"
                value={typography.titleFont ?? 'auto'}
                onChange={(event) => updateTypography({ titleFont: event.target.value as CoverTitleFontStyle })}
              >
                {TITLE_FONT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cover-title-position">书名位置</label>
              <select
                id="cover-title-position"
                className="select"
                value={typography.titlePosition ?? 'auto'}
                onChange={(event) => updateTypography({ titlePosition: event.target.value as CoverTitlePosition })}
              >
                {TITLE_POSITION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cover-title-effect">书名效果</label>
              <select
                id="cover-title-effect"
                className="select"
                value={typography.titleEffect ?? 'auto'}
                onChange={(event) => updateTypography({ titleEffect: event.target.value as CoverTitleEffect })}
              >
                {TITLE_EFFECT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cover-author-font">作者名字体</label>
              <select
                id="cover-author-font"
                className="select"
                value={typography.authorFont ?? 'auto'}
                onChange={(event) => updateTypography({ authorFont: event.target.value as CoverAuthorFontStyle })}
              >
                {AUTHOR_FONT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cover-author-position">作者名位置</label>
              <select
                id="cover-author-position"
                className="select"
                value={typography.authorPosition ?? 'auto'}
                onChange={(event) => updateTypography({ authorPosition: event.target.value as CoverAuthorPosition })}
              >
                {AUTHOR_POSITION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
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
                  '✦ 从小说内容生成提示词'
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
              但提示词还是上一个平台的风格。点「重置」重新生成，或直接手动调整。
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
          aspectRatio: cover.isUploadSize ? '3 / 4' : '9 / 16',
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
        <h3>封面配置</h3>
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
