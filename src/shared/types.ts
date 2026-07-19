import type { WritingRequirementTemplate } from './writing-requirement-templates'

export interface ProjectMeta {
  id: string
  name: string
  path: string
  genre?: string
  createdAt: string
  lastOpenedAt: string
}

export interface Library {
  schemaVersion: number
  projects: ProjectMeta[]
}

export interface CreateProjectInput {
  id?: string
  name: string
  path: string
  genre?: string
}

export type ChapterStatus = 'outline' | 'draft' | 'reviewed' | 'published'

/** 单个 LLM provider 配置。统一走 OpenAI Chat Completions 兼容协议。 */
export type ProviderProtocol = 'openai' | 'anthropic' | 'antigravity' | 'codex' | 'grok'

/**
 * 连通测试统一返回结构：
 * - ok=true 时 model / providerLabel 可选填充
 * - ok=false 时 error 为机器可读错误码（NO_KEY / LLM_AUTH_FAILED / AGY_NOT_FOUND 等）
 */
export interface PingResult {
  ok: boolean
  error?: string
  model?: string
  providerLabel?: string
}

export interface ProviderConfig {
  id: string
  /** 展示名（用户可改），例如「主力 / 备用 / DeepSeek」 */
  label: string
  /** 厂商主页，仅展示用 */
  homepage?: string
  /** 形如 https://api.example.com/v1；请求时会拼上协议对应路径 */
  baseUrl: string
  /** 模型名，传给请求体里的 model 字段 */
  model: string
  /** API Key；空字符串表示未配置（保留旧值时由 main 端处理） */
  apiKey: string
  /**
   * 请求协议：
   * - 'openai'（默认）：POST {baseUrl}/chat/completions，Authorization: Bearer
   * - 'anthropic'：POST {baseUrl}/v1/messages，x-api-key + anthropic-version
   * - 'antigravity'：调用本机 agy CLI（`agy -p` 子进程），用 Google 登录态，不走 HTTP。
   *   此时 baseUrl 可空（占位符即可）、apiKey 可空（靠本机 OAuth 登录）、
   *   model 为 agy 模型显示名（可空，走 agy 默认）。
   * - 'codex'：调用本机 codex CLI（`codex exec` 子进程），用 ChatGPT 登录态，不走 HTTP。
   *   此时 baseUrl 可空、apiKey 可空、model 为 codex 模型名（可空，走 config.toml 默认）。
   * - 'grok'：调用本机 grok CLI（`grok --prompt-file` headless），用 `grok login` 登录态，不走 HTTP。
   *   此时 baseUrl 可空、apiKey 可空、model 为 grok 模型 ID（可空，走 CLI/config 默认）。
   */
  protocol?: ProviderProtocol
  /**
   * 采样温度（模型强度/创造性）。
   * - 范围 0~2，缺省/未设置时不传该参数（走模型默认）
   * - 续写正文建议 0.7~0.9，改写/审阅建议 0.3~0.5
   * main 端写入前会 clamp 到 [0,2]
   */
  temperature?: number
}

/** 列表接口返回的脱敏 provider —— 永不返回明文 apiKey */
export type ProviderSummary = Omit<ProviderConfig, 'apiKey'> & {
  hasKey: boolean
  keyMasked: string
}

/** 功能大类：用于按任务类型路由到不同 provider/模型 */
export type FeatureCategory = 'chapter' | 'review' | 'humanize' | 'opening' | 'auxiliary' | 'ask'

/** 单个功能大类的路由配置：指向某个 provider，可选覆盖模型名 */
export interface FeatureRoutingEntry {
  /** 目标 provider id（必须存在于 providers 中，否则回退 activeId） */
  providerId: string
  /** 覆盖 provider.model；空/缺省则用 provider 自带模型 */
  model?: string
}

export interface ProvidersConfig {
  /** 当前选中的 provider id（未配置路由的功能大类走此 provider） */
  activeId: string
  providers: ProviderConfig[]
  /** 功能大类 -> provider 路由；未列出的类别回退 activeId */
  featureRouting?: Partial<Record<FeatureCategory, FeatureRoutingEntry>>
}

/** 列表接口的返回结构（脱敏） */
export interface ListProvidersResult {
  activeId: string
  providers: ProviderSummary[]
  featureRouting?: Partial<Record<FeatureCategory, FeatureRoutingEntry>>
}

export interface ProjectData {
  schemaVersion: number
  updatedAt: string
  id: string
  name: string
  genre?: string
  defaultStyleProfileId?: string
  description?: string
  targetChapters?: number
  chapterWordCount?: number
  status?: string
  createdAt: string
  /**
   * 对标书名列表（拆文库中的书名）。写作时按回退链
   * （项目 对标/{书名}/ → 全局 teardown-library/{书名}/）召回方法论产物。
   * 对齐 oh-story-claudecode 的对标/拆文库分离设计。
   */
  benchmarkBooks?: string[]
}

export interface ChapterMeta {
  schemaVersion: number
  updatedAt: string
  chapterNumber: number
  title: string
  wordCount: number
  status: ChapterStatus
  synopsis?: string
  hook?: string
  /** 在本章登场的人物 id 列表（用于人物卡 ↔ 章节联动） */
  appearingCharacters?: string[]
  /** 所属卷号（1-based，来自节奏图谱 volume 字段） */
  volume?: number
  /** 情绪值（1-10，来自节奏图谱） */
  emotion?: number
  /** 爽点类型（0/1/2/3/3.5/4，来自节奏图谱） */
  climax?: number
}

export interface ChapterContent {
  meta: ChapterMeta
  content: string
}

export interface CreateProjectDataInput {
  name: string
  genre?: string
  description?: string
  targetChapters?: number
  chapterWordCount?: number
  customPath?: string
}

export type StyleSourceType = 'sampleText'

export interface SelectedTextFile {
  content: string
  fileName: string
}

export interface StyleAnalysisResult {
  identifiedStyle: string
  sentencePatterns: string[]
  vocabularyPreferences: string[]
  punctuationAndRhythm: string[]
  narrativePerspective: string[]
  tone: string[]
  narrativeTemplates: string[]
  /**
   * 文风约束：跨题材、跨角色都能复用的写作手法层。
   * 例：保持现实质感、情感克制优先用动作/细节/环境/简短对话传递、对话口语化、
   * 注重生活场景与物件的细节描写、节奏做到"紧张-缓和"交替。
   */
  styleConstraints: string[]
  /**
   * 人设约束：与主角/角色性格、行为模式绑定的写作准则。换主角/换题材需重写。
   * 例：保持主角冷静与逻辑性、避免冗长内心独白、避免情绪失控大喊大叫。
   */
  characterConstraints: string[]
  /**
   * 剧情约束：与本作品题材/设定绑定的剧情手法。换书需重写。
   * 例：穿插对过去（重生前）的闪回、避免完全脱离现实逻辑的"金手指"或巧合、
   * 避免温情场景过度煽情、避免上帝视角随意评价。
   */
  plotConstraints: string[]
  /**
   * @deprecated 自 P28 起拆分为 styleConstraints / characterConstraints / plotConstraints。
   * 解析时仍兜底读取，渲染时不再使用。保留字段以兼容旧 styles.json。
   */
  dos: string[]
  /** @deprecated 同上。 */
  donts: string[]
  stylePrompt: string
}

export interface StyleProfile extends StyleAnalysisResult {
  id: string
  name: string
  sourceType: StyleSourceType
  sampleText: string
  createdAt: string
  updatedAt: string
}

export interface CreateStyleProfileInput {
  name: string
  sourceType: StyleSourceType
  sampleText: string
  identifiedStyle: string
  sentencePatterns: string[]
  vocabularyPreferences: string[]
  punctuationAndRhythm: string[]
  narrativePerspective: string[]
  tone: string[]
  narrativeTemplates: string[]
  styleConstraints: string[]
  characterConstraints: string[]
  plotConstraints: string[]
  dos?: string[]
  donts?: string[]
  stylePrompt: string
}

export interface UpdateStyleProfileInput {
  name?: string
  identifiedStyle?: string
  sentencePatterns?: string[]
  vocabularyPreferences?: string[]
  punctuationAndRhythm?: string[]
  narrativePerspective?: string[]
  tone?: string[]
  narrativeTemplates?: string[]
  styleConstraints?: string[]
  characterConstraints?: string[]
  plotConstraints?: string[]
  stylePrompt?: string
}

export interface WriteStyleSelection {
  mode: 'projectDefault' | 'custom'
  styleProfileId: string | null
}

export interface CreateChapterInput {
  title: string
}

export interface UpdateChapterMetaInput {
  title?: string
  status?: ChapterStatus
  synopsis?: string
  hook?: string
  appearingCharacters?: string[]
}

/** ChapterEditor 正文区 AI 章名命名入参 */
export interface SuggestChapterNameInput {
  projectId: string
  chapterNumber: number
  currentTitle: string
  /** 当前未保存的草稿正文（编辑器里 dirty=true 的那份） */
  draft: string
  /** 项目体裁，可选（影响 system prompt 语感） */
  genre?: string
}

/** ChapterEditor 正文区 AI 章名命名结果。ok=false 时 error 含机器可读错误码 */
export interface SuggestChapterNameResult {
  ok: boolean
  /** 净化后的候选章名（ok=true 时有效，12-50 字） */
  title: string
  /** LLM 给出的简短理由（可能为空字符串） */
  reason: string
  /** ok=false 时含错误码（如 LLM_NOT_CONFIGURED / PARSE_FAILED / SERVICE_UNAVAILABLE） */
  error?: string
}

/** 一条可编辑的续写规则小节（renderer 视图：标题 + 内置默认正文） */
export interface ChapterRuleSectionView {
  key: string
  title: string
  defaultText: string
}

/** getChapterRules 返回：可编辑小节清单 + 当前用户覆盖 */
export interface ChapterRulesBundle {
  sections: ChapterRuleSectionView[]
  overrides: Record<string, string>
}

/** 一条可编辑的去 AI 味规则小节（renderer 视图：标题 + 内置默认正文） */
export interface DeslopRuleSectionView {
  key: string
  title: string
  defaultText: string
}

/** 一条只读展示的去 AI 味规则（正则类，锁定不可编辑，避免写错正则让扫描崩溃） */
export interface DeslopLockedSectionView {
  key: string
  title: string
  /** 多行展示内容（每条规则一行） */
  content: string
}

/** getDeslopRules 返回：可编辑分节 + 只读锁定区 + 当前覆盖 + 禁用词表 */
export interface DeslopRulesBundle {
  /** 可编辑分节（系统铁律 + Gate A-G） */
  sections: DeslopRuleSectionView[]
  /** 锁定只读区（最毒句式正则、排比正则、心理词） */
  lockedSections: DeslopLockedSectionView[]
  /** 当前文本覆盖（key→正文） */
  overrides: Record<string, string>
  /** 当前禁用词表（未配置时 = 内置默认） */
  bannedWords: string[]
}

/** 去 AI 味规则配置（settings.deslopRules，可被用户编辑后真正生效） */
export interface DeslopRulesConfig {
  /** 文本规则覆盖：systemPrompt / gateA-G。缺 key = 用内置默认；空串 = 该节停用 */
  textOverrides?: Record<string, string>
  /** 禁用词表（注入确定性扫描器 + LLM 改写 prompt）；缺省 = 用内置默认 */
  bannedWords?: string[]
}

/** 自定义检查项的检测类型（用户在 UI 选）。 */
export type CustomCheckType = 'keyword' | 'regex' | 'llm'

/**
 * 用户自定义检查项（CRUD 的"新增"产物）。
 * id 用 custom_ 前缀，与内置 ReviewCheckId 永不冲突。
 */
export interface CustomReviewCheck {
  /** 'custom_xxx'，UI 生成，全局唯一 */
  id: string
  label: string
  hint: string
  severity: AuditSeverity
  type: CustomCheckType
  /** UI 分组 + 违例 category，限定为 AuditCategory 之一（复用现有分类） */
  group: AuditCategory
  keywords?: string[]
  pattern?: string
  prompt?: string
  enabled: boolean
}

/** 内置检查项的元数据覆盖（用户编辑内置项名称/说明/严重度时写入）。 */
export interface BuiltinCheckMeta {
  label?: string
  hint?: string
  severity?: AuditSeverity
}

/** 一条审稿检查项（renderer 视图：分类 + 标签 + 默认严重度 + 说明） */
export interface ReviewCheckSectionView {
  /** 内置项用 ReviewCheckId；自定义项用 custom_ 前缀 id */
  checkId: string
  /** 检查类别（用于分组：算法 / LLM） */
  kind: 'algorithm' | 'llm'
  /** 所属技能检查分组（toxic/quote/quality/paragraph/dialogue/sensitive/llm_review） */
  group: string
  label: string
  defaultSeverity: AuditSeverity
  hint: string
  /** true = 用户自定义项（UI 据此显示删除/全字段编辑） */
  isCustom?: boolean
  /** 自定义项的检测类型；内置项无此字段 */
  customType?: CustomCheckType
  /** 自定义项配置（按 type 取用），供 UI 编辑表单初始化 */
  keywords?: string[]
  pattern?: string
  prompt?: string
}

/** getReviewRules 返回：检查项清单（含默认信息）+ 当前配置 */
export interface ReviewRulesBundle {
  sections: ReviewCheckSectionView[]
  /** 被软删除（隐藏）的内置项，供前端「已隐藏」恢复区渲染 */
  hiddenSections: { checkId: string; label: string }[]
  config: ReviewRulesConfig
}

export type FileChangeKind = 'outline' | 'rhythm' | 'progress' | 'characters' | 'prose'

export interface RendererApi {
  listProjects: () => Promise<ProjectMeta[]>
  /** 扫描 projectsRoot，将含 大纲/大纲.md 的子目录登记进 library.json */
  scanProjects: () => Promise<ProjectMeta[]>
  createProject: (input: CreateProjectDataInput) => Promise<ProjectMeta>
  getProject: (projectId: string) => Promise<ProjectData>
  /** 设置项目的对标书列表（拆文库中的书名，写作时召回方法论） */
  setBenchmarkBooks: (projectId: string, books: string[]) => Promise<string[]>
  /** 进入项目视图时启动文件监听（主进程 fs.watch 项目目录） */
  watchProject: (projectId: string) => Promise<boolean>
  /** 离开项目视图时停止文件监听 */
  stopWatchProject: () => Promise<boolean>
  /** 订阅项目文件变更事件（外部编辑器改源文件时推送）。返回取消订阅函数。 */
  onProjectFilesChanged: (cb: (e: { projectId: string; kind: FileChangeKind }) => void) => () => void
  listStyleProfiles: (projectId: string) => Promise<StyleProfile[]>
  createStyleProfile: (projectId: string, input: CreateStyleProfileInput) => Promise<StyleProfile>
  updateStyleProfile: (
    projectId: string,
    styleProfileId: string,
    patch: UpdateStyleProfileInput
  ) => Promise<StyleProfile>
  deleteStyleProfile: (projectId: string, styleProfileId: string) => Promise<void>
  extractStyleProfile: (
    projectId: string,
    sampleText: string,
    name?: string
  ) => Promise<StyleAnalysisResult>
  setProjectDefaultStyleProfile: (
    projectId: string,
    styleProfileId: string | null
  ) => Promise<ProjectData>
  /** 选择本地文本文件用于文风提取，返回文件内容和文件名 */
  selectTextFile: () => Promise<SelectedTextFile[] | null>
  listChapters: (projectId: string) => Promise<ChapterMeta[]>
  getChapter: (projectId: string, n: number) => Promise<ChapterContent>
  createChapter: (projectId: string, input: CreateChapterInput) => Promise<ChapterMeta>
  updateChapterContent: (projectId: string, n: number, content: string) => Promise<ChapterMeta>
  /** P19-A：自动保存草稿（写 / 读 / 清空） */
  saveDraft: (projectId: string, chapterNumber: number, content: string) => Promise<{ at: number }>
  readDraft: (
    projectId: string,
    chapterNumber: number
  ) => Promise<{ content: string; at: number; different: boolean } | null>
  discardDraft: (projectId: string, chapterNumber: number) => Promise<boolean>
  /** P19-E：字数汇总（节奏图谱 + 章节进度笔记） */
  getChapterWordSummary: (projectId: string) => Promise<{
    chapters: Array<{
      chapterNumber: number
      title: string
      emotion: number
      wordCount: number
      status: 'unknown' | 'outline' | 'drafted' | 'finished'
    }>
    totalWords: number
    estimatedTotal: number
    progress: number
    byStatus: Record<'unknown' | 'outline' | 'drafted' | 'finished', number>
  } | null>
  updateChapterMeta: (projectId: string, n: number, patch: UpdateChapterMetaInput) => Promise<ChapterMeta>
  /** ChapterEditor 正文区 AI 章名命名（基于当前未保存草稿；候选需确认才落盘） */
  suggestChapterName: (
    projectId: string,
    chapterNumber: number,
    currentTitle: string,
    draft: string,
    genre?: string
  ) => Promise<SuggestChapterNameResult>
  deleteChapter: (projectId: string, n: number) => Promise<void>
  listCharacters: (projectId: string) => Promise<Character[]>
  getCharacter: (projectId: string, id: string) => Promise<Character | null>
  createCharacter: (projectId: string, input: CreateCharacterInput) => Promise<Character>
  updateCharacter: (projectId: string, id: string, patch: UpdateCharacterInput) => Promise<Character>
  deleteCharacter: (projectId: string, id: string) => Promise<void>
  listHistory: (projectId: string) => Promise<HistoryEntry[]>
  listChapterVersions: (projectId: string, n: number) => Promise<ChapterVersion[]>
  getChapterVersion: (projectId: string, n: number, vn: number) => Promise<ChapterVersion>
  createChapterVersion: (
    projectId: string,
    n: number,
    input: CreateChapterVersionInput
  ) => Promise<ChapterVersion>
  deleteChapterVersion: (projectId: string, n: number, vn: number) => Promise<void>
  rollbackChapter: (projectId: string, n: number, vn: number) => Promise<ChapterMeta>
  listMemoryEntities: (projectId: string, type: MemoryEntityType) => Promise<MemoryEntity[]>
  createMemoryEntity: (
    projectId: string,
    type: MemoryEntityType,
    input: CreateMemoryEntityInput
  ) => Promise<MemoryEntity>
  updateMemoryEntity: (
    projectId: string,
    type: MemoryEntityType,
    id: string,
    patch: UpdateMemoryEntityInput
  ) => Promise<MemoryEntity>
  deleteMemoryEntity: (projectId: string, type: MemoryEntityType, id: string) => Promise<void>
  listForeshadowings: (projectId: string) => Promise<Foreshadowing[]>
  createForeshadowing: (
    projectId: string,
    input: CreateForeshadowingInput
  ) => Promise<Foreshadowing>
  updateForeshadowing: (
    projectId: string,
    id: string,
    patch: UpdateForeshadowingInput
  ) => Promise<Foreshadowing>
  deleteForeshadowing: (projectId: string, id: string) => Promise<void>
  plantForeshadowing: (projectId: string, id: string, chapterNumber: number) => Promise<Foreshadowing>
  collectForeshadowing: (projectId: string, id: string, chapterNumber: number) => Promise<Foreshadowing>
  markForeshadowingMissed: (projectId: string, id: string) => Promise<Foreshadowing>
  listRelationships: (projectId: string) => Promise<Relationship[]>
  createRelationship: (projectId: string, input: CreateRelationshipInput) => Promise<Relationship>
  updateRelationship: (
    projectId: string,
    id: string,
    patch: UpdateRelationshipInput
  ) => Promise<Relationship>
  deleteRelationship: (projectId: string, id: string) => Promise<void>
  /** v4：增量同步 设定/ + 追踪/ + 细纲/ → 记忆/ */
  syncMemoryIndex: (projectId: string) => Promise<{
    added: number
    updated: number
    removed: number
    conflicts: number
    errors: Array<{ source: string; message: string }>
    startedAt: string
    finishedAt: string
  }>
  /** 读取 追踪/ 目录的聚合展示数据（角色状态/时间线/进度/问题/伏笔统计） */
  readTracking: (projectId: string) => Promise<TrackingView | null>
  /** v4：获取实体完整 Markdown（用于详情面板） */
  getMemoryDetail: (
    projectId: string,
    type: string,
    id: string
  ) => Promise<{ markdown: string; sources: Array<{ path: string }> } | null>
  /** v4：在系统资源管理器中打开源文件 */
  openMemorySource: (projectId: string, relativePath: string) => Promise<{ ok: boolean }>
  /** v4：老项目 v3 → v4 一次性迁移（dryRun=true 只预览） */
  migrateV3ToV4: (
    projectId: string,
    options?: { dryRun?: boolean }
  ) => Promise<{
    dryRun: boolean
    skipped: boolean
    wouldConvert: number
    converted: number
    removedDirs: string[]
    errors: Array<{ file: string; message: string }>
  }>
  configureLlm: (apiKey: string) => Promise<boolean>
  hasLlmKey: () => Promise<boolean>
  /**
   * ping 通道统一返回结构：
   * - ok=true 时 model / providerLabel 可选填充
   * - ok=false 时 error 为机器可读错误码（NO_KEY / LLM_AUTH_FAILED / AGY_NOT_FOUND 等）
   */
  pingLlm: () => Promise<PingResult>
  /** 指定 providerId 的连通测试，用于卡片级独立验证 */
  pingProvider: (id: string) => Promise<PingResult>
  /** 列出 agy CLI 可用模型（供 antigravity provider 的模型下拉选择） */
  listAntigravityModels: () => Promise<string[]>
  /** 列出 codex CLI 可用模型（读 config.toml，供 codex provider 的模型选择） */
  listCodexModels: () => Promise<string[]>
  /** 列出 grok CLI 可用模型（`grok models`，供 grok provider 的模型选择） */
  listGrokModels: () => Promise<string[]>
  listProviders: () => Promise<ListProvidersResult>
  upsertProvider: (p: ProviderConfig) => Promise<ProviderConfig>
  deleteProvider: (id: string) => Promise<void>
  setActiveProvider: (id: string) => Promise<string>
  setFeatureRouting: (
    routing: Partial<Record<FeatureCategory, FeatureRoutingEntry>>
  ) => Promise<Partial<Record<FeatureCategory, FeatureRoutingEntry>> | undefined>
  generateStream: (
    prompt: string,
    onToken: (token: string, done: boolean) => void
  ) => Promise<{ ok: boolean; error?: string }>
  getMainOutline: (projectId: string) => Promise<MainOutline | null>
  updateMainOutline: (projectId: string, patch: Partial<MainOutline>) => Promise<MainOutline>
  generateMainOutline: (projectId: string) => Promise<MainOutline>
  listDetailedOutline: (projectId: string) => Promise<DetailedOutlineItem[]>
  updateDetailedOutline: (
    projectId: string,
    chapterNumber: number,
    patch: Partial<DetailedOutlineItem>
  ) => Promise<DetailedOutlineItem>
  generateDetailedOutline: (projectId: string, chapterNumber: number) => Promise<DetailedOutlineItem>
  generateDetailedOutlineRange: (
    projectId: string,
    fromChapter: number,
    count: number
  ) => Promise<DetailedOutlineItem[]>
  getRhythm: (projectId: string) => Promise<RhythmEntry[]>
  getVolumes: (projectId: string) => Promise<Volume[]>
  getOutlineSections: (projectId: string) => Promise<{ h1Title: string; sections: { title: string; body: string }[] }>
  getVolumeOutlines: (projectId: string) => Promise<VolumeOutline[]>
  getDiagnostics: (projectId: string) => Promise<Diagnostic[]>
  listFigures: (projectId: string) => Promise<FigureSummary[]>
  readFigure: (projectId: string, fileName: string) => Promise<ChapterFigure | null>
  openFigure: (projectId: string, fileName: string) => Promise<void>
  generateChapterStream: (
    projectId: string,
    chapterNumber: number,
    styleProfileId: string | null | undefined,
    tempContext: string | undefined,
    existingText: string | undefined,
    onToken: (token: string, done: boolean) => void
  ) => Promise<{ ok: boolean; error?: string }>
  adjustChapterStream: (
    projectId: string,
    chapterNumber: number,
    content: string,
    instruction: string,
    styleProfileId: string | null | undefined,
    onToken: (token: string, done: boolean) => void
  ) => Promise<{ ok: boolean; error?: string }>
  getProjectsRoot: () => Promise<string>
  setProjectsRoot: (path: string) => Promise<string>
  getTheme: () => Promise<'light' | 'dark' | 'system'>
  setTheme: (mode: 'light' | 'dark' | 'system') => Promise<'light' | 'dark' | 'system'>
  selectDirectory: () => Promise<string | null>
  reviewChapterStream: (
    projectId: string,
    chapterNumber: number,
    content: string | undefined,
    onToken: (token: string, done: boolean) => void
  ) => Promise<{ ok: boolean; error?: string }>
  answerChapterQuestionStream: (
    projectId: string,
    chapterNumber: number,
    content: string,
    question: string,
    history: { role: 'user' | 'assistant'; text: string }[],
    onToken: (token: string, done: boolean) => void
  ) => Promise<{ ok: boolean; error?: string }>
  detectCastStream: (
    projectId: string,
    chapterNumber: number,
    onToken: (token: string, done: boolean) => void
  ) => Promise<{ ok: boolean; error?: string }>
  detectRelationshipsStream: (
    projectId: string,
    onToken: (token: string, done: boolean) => void
  ) => Promise<{ ok: boolean; error?: string }>
  checkOutlineStream: (
    projectId: string,
    chapterNumber: number,
    outline: string,
    content: string,
    onToken: (token: string, done: boolean) => void
  ) => Promise<{ ok: boolean; error?: string }>
  /** 记忆提取（流式）：从正文提取新增角色/地点/情节/伏笔/状态变化 */
  extractMemoryStream: (
    projectId: string,
    chapterNumber: number,
    onToken: (token: string, done: boolean) => void
  ) => Promise<{ ok: boolean; error?: string }>
  /** 记忆应用（自动部分）：状态变化 + 情节追加 + 伏笔回收 */
  applyMemory: (projectId: string, extraction: MemoryExtraction) => Promise<MemoryApplyResult>
  /**
   * 续写完成后自动同步：extract → applyMemory → applySettingsPatches(onlyAuto)。
   * autoMemorySync=false 时返回 null；失败不抛（errors 在结果内）。
   * opts.force=true 时忽略关闭开关（用户手动「重新同步 / 补跑」）。
   */
  syncChapterAfterWrite: (
    projectId: string,
    chapterNumber: number,
    content: string,
    opts?: { force?: boolean }
  ) => Promise<{
    memory: MemoryApplyResult
    settings: SettingsApplyResult
    extraction: MemoryExtraction
  } | null>
  /**
   * 撤销一次写后同步的自动写入（best-effort）。
   * 需传入上次 sync 返回的 extraction + memory/settings 结果。
   */
  undoChapterSync: (
    projectId: string,
    payload: {
      extraction: MemoryExtraction
      memory: MemoryApplyResult
      settings: SettingsApplyResult
    }
  ) => Promise<ChapterSyncUndoResult>
  /** 记忆自动部分应用前的 diff 预览 */
  previewMemoryApply: (
    projectId: string,
    extraction: MemoryExtraction
  ) => Promise<MemoryApplyPreview>
  /** 设定补丁预览 */
  previewSettingsApply: (
    projectId: string,
    extraction: MemoryExtraction
  ) => Promise<SettingsApplyPreview>
  /** 应用设定补丁；onlyAuto 默认跟随设置 settingsEvolution */
  applySettingsPatches: (
    projectId: string,
    extraction: MemoryExtraction,
    onlyAuto?: boolean
  ) => Promise<SettingsApplyResult>
  /** 用户确认后：应用新增角色 */
  applyNewCharacters: (
    projectId: string,
    chars: MemoryExtraction['newCharacters']
  ) => Promise<number>
  /** 用户确认后：应用新增地点 */
  applyNewLocations: (
    projectId: string,
    locs: MemoryExtraction['newLocations'],
    chapterNumber?: number
  ) => Promise<number>
  /** 用户确认后：应用新增道具 */
  applyNewItems: (
    projectId: string,
    items: MemoryExtraction['newItems']
  ) => Promise<number>
  /** 用户确认后：应用新增伏笔 */
  applyNewForeshadowings: (
    projectId: string,
    fs: MemoryExtraction['newForeshadowings']
  ) => Promise<number>
  /** 应用 LLM 在正文末尾写下的【本章伏笔回执】到伏笔库 */
  applyForeshadowReceipt: (
    projectId: string,
    chapterNumber: number,
    receipt: { planted?: string[]; collected?: string[] }
  ) => Promise<{ planted: number; collected: number; skipped: string[] }>
  /** 节奏评估（流式）：LLM 评估实际情绪值 */
  evaluateRhythmStream: (
    projectId: string,
    chapterNumber: number,
    onToken: (token: string, done: boolean) => void
  ) => Promise<{ ok: boolean; error?: string }>
  /** 节奏回填：把评估值写回节奏图谱.html */
  applyRhythmEvaluation: (
    projectId: string,
    evaluation: RhythmEvaluation
  ) => Promise<RhythmApplyResult>
  /** 图解生成（流式）：LLM 判断关键转折点并生成 Mermaid */
  generateFigureStream: (
    projectId: string,
    chapterNumber: number,
    onToken: (token: string, done: boolean) => void
  ) => Promise<{ ok: boolean; error?: string }>
  /** 保存图解 HTML 到 图解/ 目录 */
  saveFigure: (
    projectId: string,
    fileName: string,
    html: string
  ) => Promise<string>
  /** 批量续写：从 fromChapter 到 toChapter 逐章生成，每章完成后暂停等用户确认 */
  generateBatch: (
    projectId: string,
    fromChapter: number,
    toChapter: number,
    styleProfileId: string | null | undefined,
    onChapterComplete: (chapter: number, result: ChapterFlowResult) => void,
    onToken?: (token: string, done: boolean) => void
  ) => Promise<{ ok: boolean; progress?: BatchProgress; error?: string }>
  /** 继续批量续写：从 fromChapter+1 开始继续 */
  resumeBatch: (
    projectId: string,
    fromChapter: number,
    toChapter: number,
    styleProfileId: string | null | undefined,
    onChapterComplete: (chapter: number, result: ChapterFlowResult) => void,
    onToken?: (token: string, done: boolean) => void
  ) => Promise<{ ok: boolean; progress?: BatchProgress; error?: string }>
  getUsageSummary: () => Promise<UsageSummary>
  /** P16-C：按日期获取 LLM 调用详情（点击趋势图某天柱状图） */
  getUsageDayDetail: (date: string) => Promise<UsageRecord[]>
  /** P17-A：按项目聚合（所有项目） */
  getUsageByProject: () => Promise<ProjectUsage[]>
  /** P17-A：按项目+章节聚合（所有项目的所有章节） */
  getUsageByChapter: () => Promise<ChapterUsage[]>
  /** P17-A：单章 LLM 调用详情 */
  getUsageChapterDetail: (projectId: string, chapterNumber: number) => Promise<UsageRecord[]>
  clearUsage: () => Promise<boolean>
  getPricing: () => Promise<{ inputRate: number; outputRate: number }>
  setPricing: (patch: { inputRate?: number; outputRate?: number }) => Promise<{ inputRate: number; outputRate: number }>
  getDailyWordGoal: () => Promise<number>
  setDailyWordGoal: (goal: number) => Promise<number>
  getPomodoroConfig: () => Promise<{ focus: number; brk: number }>
  setPomodoroConfig: (cfg: { focus: number; brk: number }) => Promise<{ focus: number; brk: number }>
  /** 续写质检（PR2）：对正文文本跑章末/禁用词/字数三项检查 */
  auditChapter: (projectId: string, content: string) => Promise<AuditReport>
  /** AI 改写命中段：按 humanizer 技能 prompt 改写一段文本 */
  humanizeSegment: (
    projectId: string,
    snippet: string,
    violationType: string,
    chapterNumber?: number
  ) => Promise<{ rewritten: string; reason: string }>
  /** LLM 深度审稿：跑角色崩坏/逻辑漏洞等语义检查，返回 findings 列表 */
  runDeepReview: (
    projectId: string,
    content: string,
    chapterNumber: number
  ) => Promise<AuditViolation[]>
  /** 结构化审核报告（对齐正文审核技能第 6 步）：聚合算法 + LLM 检查为 10 节报告 */
  generateReviewReport: (
    projectId: string,
    content: string,
    chapterNumber: number
  ) => Promise<ChapterReviewReport>
  getWriteAuditConfig: () => Promise<WriteAuditConfig>
  setWriteAuditConfig: (cfg: Partial<WriteAuditConfig>) => Promise<WriteAuditConfig>
  /** 设定随书进化：off | confirm_all | auto_high */
  getSettingsEvolution: () => Promise<SettingsEvolutionMode>
  setSettingsEvolution: (mode: SettingsEvolutionMode) => Promise<SettingsEvolutionMode>
  /** 续写完成后自动同步记忆与设定（默认 true；派生自 autoPostWritePipeline !== off） */
  getAutoMemorySync: () => Promise<boolean>
  setAutoMemorySync: (enabled: boolean) => Promise<boolean>
  /**
   * 续写成功后自动后处理：
   * off | memory_only（默认）| full（记忆 + 细纲/节奏/图解，记忆不重复 extract）
   */
  getAutoPostWritePipeline: () => Promise<'off' | 'memory_only' | 'full'>
  setAutoPostWritePipeline: (
    mode: 'off' | 'memory_only' | 'full'
  ) => Promise<'off' | 'memory_only' | 'full'>
  /** P13-C：用量预警配置（当月 AI 费用阈值） */
  getCostAlertConfig: () => Promise<CostAlertConfig>
  setCostAlertConfig: (cfg: Partial<CostAlertConfig>) => Promise<CostAlertConfig>
  /** AI 高频词配置：开关 + 词条 + 改写示例 */
  getAiHighFreqConfig: () => Promise<AiHighFreqConfig>
  setAiHighFreqConfig: (cfg: Partial<AiHighFreqConfig>) => Promise<AiHighFreqConfig>
  getWritingRequirementTemplates: () => Promise<WritingRequirementTemplate[]>
  setWritingRequirementTemplates: (
    templates: WritingRequirementTemplate[]
  ) => Promise<WritingRequirementTemplate[]>
  /** 续写规则分节：读取内置小节（标题 + 默认正文）与当前用户覆盖 */
  getChapterRules: () => Promise<ChapterRulesBundle>
  /** 整体保存续写规则覆盖（仅白名单 key 生效；与默认相等的 key 由前端剔除） */
  setChapterRules: (overrides: Record<string, string>) => Promise<Record<string, string>>
  /** 审稿规则：读取检查项清单 + 当前配置 */
  getReviewRules: () => Promise<ReviewRulesBundle>
  /** 保存审稿规则配置（开关/阈值/词表） */
  setReviewRules: (cfg: Partial<ReviewRulesConfig>) => Promise<ReviewRulesConfig>
  /* ---- 拆文库（长/短篇拆文）---- */
  /** 列出全部拆文库条目 */
  listTeardowns: () => Promise<TeardownEntry[]>
  /** 启动拆文：落盘原文 + 字数路由，返回篇幅判定（灰区需前端确认） */
  startTeardown: (input: StartTeardownInput) => Promise<TeardownRouteResult>
  /** 运行拆文管道（流式返回进度文本）。lengthKind 由 startTeardown 路由后传入 */
  runTeardown: (
    bookName: string,
    lengthKind: TeardownLengthKind,
    onToken: (token: string, done: boolean) => void
  ) => Promise<{ ok: true }>
  /** 长篇 Stage 1 停靠后继续（从 Stage 2 续跑） */
  continueTeardown: (
    bookName: string,
    onToken: (token: string, done: boolean) => void
  ) => Promise<{ ok: true }>
  /** 轮询拆文进度 */
  getTeardownProgress: (bookName: string) => Promise<TeardownProgressInfo>
  /** 列出某书拆文库产物文件树 */
  getTeardownFiles: (bookName: string) => Promise<TeardownFileNode[]>
  /** 读取单个拆文产物文件内容 */
  readTeardownFile: (bookName: string, path: string) => Promise<TeardownFileContent | null>
  /** 删除整本书的拆文库 */
  deleteTeardown: (bookName: string) => Promise<void>
  /* ---- 去 AI 味润色（story-deslop）---- */
  /** 扫描正文（确定性，不调 LLM），返回检测报告 */
  deslopScan: (projectId: string, text: string) => Promise<DeslopScanReport>
  /** 润色正文（流式），返回润色结果。applyToChapter 传章节号时写回正文，否则仅返回文本 */
  deslopStream: (
    projectId: string,
    text: string,
    levelOverride: DeslopLevel | undefined,
    onToken: (token: string, done: boolean) => void
  ) => Promise<DeslopResult>
  /** 读取项目级去 AI 味白名单 */
  getDeslopWhitelist: (projectId: string) => Promise<string[]>
  /** 写入项目级去 AI 味白名单 */
  setDeslopWhitelist: (projectId: string, words: string[]) => Promise<string[]>
  /** 读取去 AI 味规则（可编辑分节 + 只读锁定区 + 当前覆盖 + 禁用词表） */
  getDeslopRules: () => Promise<DeslopRulesBundle>
  /** 保存去 AI 味规则（文本覆盖 + 禁用词表），保存后真正生效 */
  setDeslopRules: (cfg: {
    textOverrides: Record<string, string>
    bannedWords: string[]
  }) => Promise<DeslopRulesBundle>
  /** 用自然语言让 AI 改写去 AI 味规则（流式输出完整 Markdown，完成后前端解析拆分） */
  editDeslopRulesStream: (
    instruction: string,
    onToken: (token: string, done: boolean) => void
  ) => Promise<string>
  /* ---- 封面生成（story-cover）---- */
  /** 生成封面（调图像 API），返回封面文件信息 */
  generateCover: (input: GenerateCoverInput) => Promise<CoverFile>
  /** 列出项目内已有封面 */
  listCovers: (projectId: string) => Promise<CoverFile[]>
  /** 读取封面为 base64 data URL（前端预览用） */
  readCover: (projectId: string, fileName: string) => Promise<string | null>
  /** 读取图像生成 API 配置（脱敏，不含 apiKey 明文） */
  getCoverImageConfig: () => Promise<CoverImageConfigSummary>
  /** 保存图像生成 API 配置 */
  setCoverImageConfig: (cfg: Partial<CoverImageConfigInput>) => Promise<CoverImageConfigSummary>
  /* ---- 扫榜（story-long-scan / story-short-scan）---- */
  /** 采集某平台榜单（确定性，不调 LLM），返回榜单 markdown + 结构化条目 */
  scanRank: (input: ScanRankInput) => Promise<ScanResult>
  /** 列出历史扫榜报告 */
  listScanReports: () => Promise<ScanReportSummary[]>
  /** 读取单份扫榜报告内容 */
  readScanReport: (fileName: string) => Promise<string | null>
  /** LLM 分析榜单 + 产出选题决策（流式） */
  analyzeRankStream: (
    report: string,
    platform: string,
    onToken: (token: string, done: boolean) => void
  ) => Promise<{ ok: true }>
  /** 删除扫榜报告 */
  deleteScanReport: (fileName: string) => Promise<void>
}

export interface Character {
  id: string
  name: string
  role?: string
  identity?: string
  personality?: string
  abilities?: string
  tags?: string[]
  synopsis?: string
  /**
   * 角色卡.md 中解析出的全部原始字段（超出上述映射的，如 行为习惯/觉醒路线/成长目标/专属标签/当前状态 等）。
   * 值为 string 或 string[]（多行子列表）。
   */
  rawFields?: Record<string, string | string[]>
  /** v4：用户自定义键值对（自由扩展，UI 始终渲染，与 first-class 合并显示，不再互斥）。 */
  customFields?: Record<string, string | string[]>
  /** v4：源文件路径 + mtime，用于同步决策与"源已更新未同步"徽章。 */
  sources?: Array<{ path: string; mtime: string }>
  createdAt: string
  updatedAt: string
}

export interface CreateCharacterInput {
  name: string
  role?: string
  identity?: string
  personality?: string
  abilities?: string
  tags?: string[]
  synopsis?: string
}

export interface UpdateCharacterInput {
  name?: string
  role?: string
  identity?: string
  personality?: string
  abilities?: string
  tags?: string[]
  synopsis?: string
  /** v4：自定义字段补丁（与现有 customFields 浅合并，未列出的 key 保留原值） */
  customFields?: Record<string, string | string[]>
}

export type MemoryAction = 'create' | 'update' | 'delete'

export interface HistoryEntry {
  at: string
  type: string
  action: MemoryAction
  entityId?: string
  summary?: string
}

export type ChapterSource = 'ai' | 'manual' | 'reviewed'

export interface ChapterVersion {
  versionNumber: number
  source: ChapterSource
  content: string
  wordCount: number
  note?: string
  createdAt: string
}

export interface CreateChapterVersionInput {
  source: ChapterSource
  content: string
  note?: string
}

export type MemoryEntityType = 'location' | 'worldview' | 'timeline' | 'plot_point' | 'item'

/**
 * 追踪视图（来自 `追踪/` 目录的聚合展示数据）。
 * 对应后端 TrackingMdRepo.read() 的结果 + 伏笔统计，供 TrackingPage 渲染。
 */
export interface TrackingView {
  /** 角色状态快照（来自 追踪/角色状态.md 的「当前状态」表） */
  characterStates: TrackingCharacterState[]
  /** 状态变更记录（来自「状态变更记录」表，全部，不按章号过滤） */
  stateChanges: TrackingStateChange[]
  /** 时间线表格原文（来自 追踪/时间线.md，保留表格行供前端解析展示） */
  timeline: string
  /** 日更进度（来自 追踪/上下文.md，全量返回供追踪页展示） */
  recentProgress: TrackingProgressEntry[]
  /** 待处理问题（来自 追踪/问题记录.md，只含未关闭的） */
  openIssues: TrackingIssue[]
  /** 全部问题（含已修正，用于问题记录展示） */
  allIssues: TrackingIssue[]
  /** 伏笔统计 */
  foreshadowingSummary: {
    total: number
    pending: number
    planted: number
    collected: number
    missed: number
  }
}

export interface TrackingCharacterState {
  name: string
  power: string
  stance: string
  goal: string
  items: string
  relations: string
  updateChapter: number
}

export interface TrackingStateChange {
  chapter: number
  name: string
  change: string
}

export interface TrackingProgressEntry {
  date: string
  chapter: string
  summary: string
  nextGoal: string
  blocker: string
}

export interface TrackingIssue {
  date: string
  problem: string
  analysis: string
  fix: string
  status: string
}

export interface MemoryEntity {
  id: string
  type?: MemoryEntityType
  name: string
  category?: string
  notes?: string
  /** 原始 .md 解析出的全部字段（超出 name/category/notes 的，如 关联事件/关联角色/当前状态 等） */
  rawFields?: Record<string, string | string[]>
  /** v4：用户自定义键值对（自由扩展，UI 始终渲染） */
  customFields?: Record<string, string | string[]>
  /** v4：源文件路径 + mtime */
  sources?: Array<{ path: string; mtime: string }>
  createdAt: string
  updatedAt: string
}

export interface CreateMemoryEntityInput {
  name: string
  category?: string
  notes?: string
}

export interface UpdateMemoryEntityInput {
  name?: string
  category?: string
  notes?: string
}

export type ForeshadowingStatus = 'pending' | 'planted' | 'collected' | 'missed'

export interface Foreshadowing {
  id: string
  content: string
  status: ForeshadowingStatus
  plantChapter?: number
  expectedCollect?: number
  actualCollect?: number
  note?: string
  createdAt: string
  updatedAt: string
}

export interface CreateForeshadowingInput {
  content: string
  expectedCollect?: number
  note?: string
}

export interface UpdateForeshadowingInput {
  content?: string
  expectedCollect?: number
  note?: string
}

export interface Relationship {
  id: string
  characterAId: string
  characterBId: string
  relationType: string
  description?: string
  strength?: number
  /** v4：源文件路径 + mtime */
  sources?: Array<{ path: string; mtime: string }>
  createdAt: string
  updatedAt: string
}

export interface CreateRelationshipInput {
  characterAId: string
  characterBId: string
  /** v4 友好字段：可直接传名字，由 repo 哈希成 id（与 aId/bId 二选一） */
  characterAName?: string
  characterBName?: string
  relationType: string
  description?: string
  strength?: number
}

export interface UpdateRelationshipInput {
  relationType?: string
  description?: string
  strength?: number
}

export interface MainOutline {
  schemaVersion: number
  updatedAt: string
  synopsis: string
  theme?: string
  mainLine?: string
}

export interface DetailedOutlineItem {
  chapterNumber: number
  /** 章节标题（来自细纲 H2「## 第N章：标题」） */
  title?: string
  plotSummary?: string
  emotionPoint?: string
  coolPoint?: string
  hook?: string
  /** 角色出场（来自细纲每章「角色出场」） */
  charactersAppearing?: string[]
  /** 伏笔铺设（来自细纲每章「伏笔铺设」） */
  foreshadowings?: string[]
  /** 字数预估（来自细纲每章「字数预估」，原文如「约 2500 字」） */
  wordEstimate?: string
  /** 金句（来自细纲每章「金句」） */
  goldenLine?: string
  /** 所属卷号 */
  volume?: number
  /** 情绪值（1-10） */
  emotion?: number
  /** 爽点类型（0/1/2/3/3.5/4） */
  climax?: number
  /** 本章写作要求 */
  writingRequirements?: string
  /** 长期写作要求模板 ID */
  writingRequirementTemplateId?: string
  /** 基于模板之外的自定义补充要求 */
  writingRequirementCustomText?: string
}

export interface DetailedOutline {
  schemaVersion: number
  updatedAt: string
  items: DetailedOutlineItem[]
}

/** 节奏图谱 html 中 rhythmData 数组的一项（逐章节奏，机器可读） */
export interface RhythmEntry {
  /** 章号 */
  chapter: number
  /** 章节标题 */
  title: string
  /** 情绪值 1-10 */
  emotion: number
  /** 爽点类型：0=无爽点 1=小打脸 2=中打脸 3=大高潮 3.5=卷中决战 4=卷终决战 */
  climax: number
  /** 所属卷号 */
  volume: number
  /** 是否已回填实际值（细纲生成时 false；正文写完后 true） */
  actualized: boolean
}

/** 卷结构（从大纲.md 主线剧情走向的 H3 + 节奏图谱推导） */
export interface Volume {
  number: number
  /** 卷名，不含「第N卷：」前缀 */
  name: string
  /** 起始章号（含） */
  chapterStart: number
  /** 结束章号（含） */
  chapterEnd: number
}

/** 卷纲文件内容（大纲/第N卷_卷名.md 的结构化读取） */
export interface VolumeOutline {
  /** 卷号 */
  number: number
  /** 卷名 */
  name: string
  /** H1 标题原文 */
  h1Title: string
  /** 文件名 */
  fileName: string
  /** H2 节列表（卷核心/情绪弧线/爽点节奏/伏笔/反转/各章核心事件/卷末钩子 等） */
  sections: { title: string; body: string }[]
}

/** 细纲每章的完整细节（来自 细纲/第NN卷.md 每章块） */
export interface ChapterDetail {
  chapterNumber: number
  title: string
  volume?: number
  emotion?: number
  climax?: number
  /** 核心事件 */
  plotSummary?: string
  /** 爽点/打脸 */
  coolPoint?: string
  /** 角色出场 */
  charactersAppearing?: string[]
  /** 伏笔铺设 */
  foreshadowings?: string[]
  /** 章末钩子 */
  hook?: string
  /** 字数预估 */
  wordEstimate?: string
  /** 金句 */
  goldenLine?: string
  /** 卷终反转 / 关键设定 等特殊标记 */
  climaxTag?: string
  /** 本章写作要求 */
  writingRequirements?: string
  /** 长期写作要求模板 ID */
  writingRequirementTemplateId?: string
  /** 基于模板之外的自定义补充要求 */
  writingRequirementCustomText?: string
  /** 全部原始字段（兜底） */
  rawFields?: Record<string, string | string[]>
}

/** 格式体检结果项（解析健康检查） */
export interface Diagnostic {
  severity: 'warn' | 'info'
  file: string
  message: string
  hint?: string
}

/** 关键情节图解（图解/第N章-*.html）的结构化解析 */
export interface FigureSummary {
  fileName: string
  chapterNumber: number | null
  title: string
}

export type FigureSectionKind = 'list' | 'table' | 'mermaid' | 'prose'

export interface FigureSection {
  name: string
  kind: FigureSectionKind
  items?: string[]
  rows?: string[][]
  mermaid?: string
  text?: string
}

export interface ChapterFigure {
  fileName: string
  chapterNumber: number | null
  title: string
  sections: FigureSection[]
}

/* ==========================================================
   续写质检（PR2）
   ========================================================== */

export type AuditSeverity = 'error' | 'warn' | 'info'

/**
 * 质检类别。与「正文写作」技能的章末/禁用词/字数 + zh-humanizer 1-16 规则 + 题材例外检查项对应，
 * 加上「正文审核」技能集成的审稿检查项。
 * - ending: 章末形式（对话/事件 vs 说教/AI 抒怀）
 * - forbidden_word: 12 类禁用高频词命中（含正则模式）
 * - word_count: 字数偏离区间
 * - rule: zh-humanizer 识别规则 1-16（破折号/三段式/Emoji/聊天语残留/空洞结尾等算法可检测项）
 * - toxic: 毒点（打破第四面墙🚨/视角混乱/水字数重复）—— 正文审核技能 3.1
 * - quote: 引文一致性（字数描述🚨）—— 正文审核技能 3.2
 * - quality: 成文质量（破折号碎片化🚨/超长句/逗号堆叠/省略号滥用）—— 正文审核技能 3.3
 * - paragraph: 段落长度（过长）—— 正文审核技能 3.8
 * - dialogue: 对话标签单一 —— 正文审核技能 3.7
 * - sensitive: 敏感词提醒（仅提醒）—— 正文审核技能 3.9
 * - llm_review: LLM 深度审稿（角色崩坏/逻辑漏洞等语义项，由 review-flow-service 产出）
 */
export type AuditCategory =
  | 'ending'
  | 'forbidden_word'
  | 'word_count'
  | 'rule'
  | 'toxic'
  | 'quote'
  | 'quality'
  | 'paragraph'
  | 'dialogue'
  | 'sensitive'
  | 'llm_review'

export interface AuditViolation {
  category: AuditCategory
  severity: AuditSeverity
  /** 用户可读的简短描述（如"章末未以对话或事件结尾"） */
  message: string
  /** 命中的原文片段（章末/禁用词上下文） */
  snippet?: string
  /** 在正文中的字符偏移（用于跳转高亮） */
  offset?: number
  /** 禁用词的类别名（如"心理描写模板"），仅 forbidden_word 用 */
  wordCategory?: string
  /** 命中的词条本身，仅 forbidden_word 用 */
  word?: string
  /** 规则 id（zh-humanizer 1-16），仅 rule 用 */
  ruleId?: string
  /** 替换建议 */
  suggestion?: string
}

export interface AuditReport {
  schemaVersion: 1
  /** 正文中文字数 */
  wordCount: number
  /** 三大类是否分别通过（无 error 级违规） */
  passed: { ending: boolean; forbiddenWords: boolean; wordCount: boolean }
  /** 各 severity 计数（错误数即等于阻断 strict 模式所需修复数） */
  counts: { error: number; warn: number; info: number }
  violations: AuditViolation[]
}

/**
 * 结构化审核报告（对齐「正文审核」技能第 6 步报告模板）。
 * 10 个 section 聚合所有算法 + LLM 检查结果。
 */
export interface ChapterReviewReport {
  /** 章号 */
  chapterNumber: number
  /** 生成时间 ISO */
  generatedAt: string
  /** 1. 记忆文件一致性（追踪/设定文件是否读取到） */
  memoryConsistency: {
    read: boolean
    missingFiles: string[]
  }
  /** 2. 大纲/细纲一致性 */
  outlineConsistency: {
    hasOutline: boolean
    rhythmMatchPercent: number | null
    notes: string[]
  }
  /** 3. 毒点检测（toxic 类违规） */
  toxicPoints: AuditViolation[]
  /** 4. 引文一致性（quote 类违规） */
  quoteConsistency: AuditViolation[]
  /** 5. 成文质量（quality 类违规） */
  manuscriptQuality: {
    violations: AuditViolation[]
    verdict: '✅' | '⚠️' | '🚨'
  }
  /** 6. 内容连贯性 */
  continuity: {
    plotTransition: string | null
    timeline: string | null
    spatialTransition: string | null
    notes: string[]
  }
  /** 7. 章节结构（钩子/对话标签/段落长度） */
  structure: {
    hookStrength: AuditViolation[]
    dialogueTags: AuditViolation[]
    paragraphLength: AuditViolation[]
  }
  /** 8. 敏感词检测 */
  sensitiveWords: AuditViolation[]
  /** 9. 爽点分析（爽文题材） */
  coolPointAnalysis: {
    applicable: boolean
    violations: AuditViolation[]
    notes: string[]
  }
  /** 10. 字数统计（仅展示当前字数，不再判定达标/不足） */
  wordCount: {
    current: number
  }
  /** 11. 文风匹配 */
  styleMatch: {
    genre: string | null
    matchPercent: number | null
    violations: AuditViolation[]
  }
  /** 12. 去 AI 味建议（forbidden_word + rule 类违规） */
  deAiSuggestions: AuditViolation[]
  /** 总体评价 */
  overall: {
    score: number // 0-10
    mainIssues: string[]
    fixPriority: string[]
  }
}

export type WriteAuditMode = 'soft' | 'strict'

export interface WriteAuditConfig {
  /** 续写完成后是否自动跑质检 */
  enabled: boolean
  /** soft：违规标红仍可保存；strict：error 必须修复才能保存 */
  mode: WriteAuditMode
}

/* ==========================================================
   审稿规则配置（按「正文审核」技能集成）
   ========================================================== */

/**
 * 审稿检查项 id。对应「正文审核」技能第 3 步检查项。
 * 分两类：算法可检测（同步纯函数）+ LLM 语义判定（流式）。
 */
export type ReviewCheckId =
  // 算法类（chapter-audit.ts 纯函数检测）
  | 'meta_break' // 🚨 打破第四面墙（第X卷/弹幕/读者/主角/剧情）
  | 'pov_mix' // 视角混乱（第一/第三人称同段混用）
  | 'repetition' // 水字数/剧情重复（N-gram 重复片段）
  | 'quote_count' // 🚨 引文字数描述与实际不符
  | 'dash_fragment' // 🚨 破折号碎片化（单字碎片/密度超阈值）
  | 'long_sentence' // 超长句（无句号）
  | 'comma_stack' // 逗号堆叠
  | 'ellipsis_abuse' // 省略号滥用
  | 'long_paragraph' // 段落过长（手机阅读不友好）
  | 'dialogue_tag' // 对话标签单一（"道/说"占比过高）
  | 'sensitive' // 敏感词提醒（仅提醒，不强制）
  | 'hook_strength' // 章末钩子强度检测（算法：末段悬念/冲突/反转关键词）
  // LLM 类（review-flow-service.ts 流式判定）
  | 'character_breakdown' // 角色崩坏人设
  | 'logic_hole' // 逻辑漏洞/逻辑断层
  | 'low_iq_plot' // 剧情降智
  | 'emotion_cliff' // 情绪断崖
  | 'hook_grade' // 钩子强度分级
  | 'style_match' // 文风匹配度
  | 'cool_point' // 爽点分析（爽文题材）
  | 'quote_contradiction' // 引文语气/动作/情绪矛盾

/** 审稿阈值（数值类检查项的临界值）。 */
export interface ReviewThresholds {
  /** 单章字数下限（对齐技能合格线 2300） */
  minWords: number
  /** 单章字数上限 */
  maxWords: number
  /** 段落字数上限（超此值提醒拆分） */
  maxParagraphLen: number
  /** 破折号密度上限（每 100 字允许的——数量） */
  dashDensityPer100: number
  /** 重复片段判定长度（连续重复字数阈值） */
  repetitionLen: number
  /** 句子字数上限（超此值提醒断句） */
  maxSentenceLen: number
}

/** 用户可编辑的审稿词表。 */
export interface ReviewWordLists {
  /** 打破第四面墙触发词（命中即 error，穿书/系统文题材降级） */
  metaBreak: string[]
  /** 敏感词（仅提醒，不强制修改） */
  sensitive: string[]
}

/** 审稿规则配置（设置里可编辑）。 */
export interface ReviewRulesConfig {
  /** 总开关：false = 跳过所有新增审稿，回到旧质检行为 */
  enabled: boolean
  /** 完整流程里是否自动跑 LLM 深度审稿（默认 false，按需点按钮触发，省 token） */
  autoDeepReview: boolean
  /** 各检查项开关；缺省=开（key 含 custom_ 前缀的自定义项） */
  checks: Partial<Record<string, boolean>>
  thresholds: ReviewThresholds
  wordLists: ReviewWordLists
  /** 内置项元数据覆盖（编辑内置项 label/hint/severity） */
  builtinMeta?: Partial<Record<ReviewCheckId, BuiltinCheckMeta>>
  /** 软删除（隐藏）的内置项 id；可恢复 */
  hiddenBuiltin?: ReviewCheckId[]
  /** 用户自定义检查项 */
  customChecks?: CustomReviewCheck[]
}

/**
 * P13-C：用量预警配置（当月 AI 费用阈值）。
 * enabled: false → 完全不弹预警（适合测试 / 不想被打扰）
 * warning: 达到此费用（元）弹 warning toast
 * exceeded: 达到此费用（元）弹 error toast（更强警告）
 * blockOnExceeded: true → aiGenerate 在 exceeded 时弹确认（用户可取消）
 * 约束：0 < warning < exceeded；非法时降级为默认值
 */
export interface CostAlertConfig {
  enabled: boolean
  warning: number
  exceeded: number
  blockOnExceeded: boolean
}

/**
 * AI 高频词配置
 * - enabled: 是否启用高亮
 * - words: 需要高亮的词列表
 * - examples: 每个词的修改示例（可选）
 */
export interface AiHighFreqWord {
  /** 词或短语 */
  word: string
  /** 修改示例（一句简短的重写范例） */
  example?: string
}

export interface AiHighFreqConfig {
  enabled: boolean
  words: AiHighFreqWord[]
}

export interface UsageBucket {
  input: number
  output: number
  total: number
  cost: number
}

/** P16-C + P17-A：单条 LLM 调用的用量记录（IPC 返回） */
export interface UsageRecord {
  at: string
  feature: string
  projectId?: string
  chapterNumber?: number
  /** 展示用模型名（CLI 可能为「gpt · codex 默认」） */
  model: string
  /** 聚合键：配置里的原始 model 字段 */
  modelId?: string
  protocol?: string
  providerId?: string
  providerLabel?: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/** P15-A：单日用量（趋势图一格） */
export interface DailyUsage {
  /** YYYY-MM-DD */
  date: string
  total: number
  cost: number
  calls: number
}

/** P17-A：按项目聚合（一个项目一行） */
export interface ProjectUsage {
  projectId: string
  total: number
  cost: number
  calls: number
}

/** P17-A：按项目+章节聚合（一个章节一行） */
export interface ChapterUsage extends ProjectUsage {
  chapterNumber: number
}

export interface UsageSummary {
  today: UsageBucket
  month: UsageBucket
  allTime: UsageBucket
  byFeature: { feature: string; total: number; cost: number; calls: number }[]
  /** P15-A：最近 7 天每日用量（按日期升序，固定 7 条） */
  byDay: DailyUsage[]
}

/* ==========================================================
   Phase 12：正文写作技能流程对齐
   ========================================================== */

/** 上一章结尾状态（LLM 从 prevTail 提取） */
export interface PrevEndingState {
  chapterNumber: number
  /** 人物位置：[{ name, location, action }] */
  characterPositions: { name: string; location: string; action: string }[]
  /** 人物状态：[{ name, emotion, body, items }] */
  characterStates: { name: string; emotion: string; body: string; items: string }[]
  /** 时间点：如"傍晚/子时/刚入夜" */
  timePoint: string
  /** 未完成事项：[对话/动作/事件] */
  unfinished: string[]
  /** 章末悬念/钩子 */
  suspense: string
  /** 关键道具 */
  props: string[]
  /** 提取失败时的原始尾段（兜底） */
  rawTail?: string
}

/* ==========================================================
   细纲对照（Phase 12 Task 3）
   ========================================================== */

/** 细纲对照差异类型（SKILL.md 5 种） */
export type OutlineDiffType = 1 | 2 | 3 | 4 | 5

/**
 * 差异推荐处理方向：
 * - updateOutline：以正文为准回写细纲
 * - updateContent：改正文以贴合细纲
 * - either：两者皆可（默认倾向回写细纲）
 * - review：需人工判断（核心事件/结构级）
 */
export type OutlineDiffResolution = 'updateOutline' | 'updateContent' | 'either' | 'review'

/** 细纲对照可回写的字段补丁（与 DetailedOutlineItem 可写字段对齐） */
export type OutlineDiffPatch = Partial<
  Pick<
    DetailedOutlineItem,
    | 'title'
    | 'plotSummary'
    | 'coolPoint'
    | 'hook'
    | 'charactersAppearing'
    | 'foreshadowings'
    | 'wordEstimate'
    | 'goldenLine'
  >
>

export interface OutlineDiffItem {
  /** 1=漏写 2=超纲增量 3=细节调整 4=核心事件改 5=结构性偏离 */
  type: OutlineDiffType
  typeLabel: '漏写' | '超纲增量' | '细节调整' | '核心事件改' | '结构性偏离'
  /** 细纲内容 */
  outline?: string
  /** 正文内容 */
  actual?: string
  /** 处理建议 */
  suggestion: string
  /** 优先级 P0-P2 */
  priority: 'P0' | 'P1' | 'P2'
  /** 推荐处理方向（LLM 给出；缺省时由类型推断） */
  resolution?: OutlineDiffResolution
  /**
   * 以正文为准时，应写入细纲的字段补丁。
   * resolution 为 updateOutline / either / review（接受正文）时尽量给出。
   */
  outlinePatch?: OutlineDiffPatch
}

export interface OutlineDiffReport {
  chapterNumber: number
  /** 5 类差异项 */
  diffs: OutlineDiffItem[]
  /** 总体通过判定（无 P0/P1 即通过） */
  passed: boolean
}

/** 以正文回写细纲的应用结果 */
export interface OutlineDiffApplyResult {
  applied: boolean
  updated?: DetailedOutlineItem
  /** 成功应用的差异条数 */
  appliedCount: number
  errors: string[]
}

/* ==========================================================
   记忆回写（Phase 12 Task 4-6）
   ========================================================== */

/** 记忆提取结果（LLM 从正文提取） */
export interface MemoryExtraction {
  chapterNumber: number
  /** 新增角色（需确认）；appearance/abilities 可选，写入人物卡 */
  newCharacters: {
    name: string
    role: string
    identity: string
    personality: string
    appearance?: string
    abilities?: string
  }[]
  /** 新增地点（需确认）；scope=world 时双写设定/世界观/地理 */
  newLocations: {
    name: string
    category: string
    notes: string
    /** scene=仅记忆；world=常驻地理，写入设定/世界观/地理.md */
    scope?: 'scene' | 'world'
  }[]
  /** 新增道具（需确认） */
  newItems: { name: string; category: string; notes: string }[]
  /** 新增伏笔（需确认） */
  newForeshadowings: { content: string; expectedCollect?: number; note?: string }[]
  /** 新增情节（自动追加到核心情节.md） */
  newPlotPoints: { title: string; event: string; coolPoint?: string }[]
  /**
   * 既有角色的状态/设定变化（自动更新）。
   * field 推荐：伤势/情绪/位置/当前状态/身份/性格/能力/境界/外貌/关系/持有物
   */
  characterStateChanges: { name: string; field: string; oldValue: string; newValue: string }[]
  /** 伏笔回收（自动更新） */
  collectedForeshadowings: { content: string; chapter: number }[]
  /**
   * 设定增量补丁（A 类：只 append，不改底稿）。
   * 高置信可自动应用；见 settingsEvolution 配置。
   */
  settingsPatches?: SettingsPatch[]
  /** 设定建议（C 类：仅提示手改题材定位等，永不自动写） */
  settingsSuggestions?: SettingsSuggestion[]
}

/* ==========================================================
   设定随书进化（A 类增量补丁）
   ========================================================== */

/** 设定补丁目标 */
export type SettingsPatchTarget =
  | 'worldview'
  | 'faction'
  | 'relation'
  | 'customRule'
  | 'geography'

/** 设定增量补丁（MVP：仅 append） */
export interface SettingsPatch {
  target: SettingsPatchTarget
  /** 文件名不含扩展名，如「力量体系」「青帮」；geography 固定地理 */
  fileName: string
  op: 'append_h2' | 'append_bullet'
  /** 追加到哪个 H2；空则文件末尾新建 H2 */
  sectionTitle?: string
  /** 新 H2 标题或条目标题 */
  title?: string
  /** 补丁正文（短） */
  content: string
  /** 依据（≤80 字） */
  reason?: string
  confidence?: 'high' | 'medium' | 'low'
}

/** 设定建议（不自动写） */
export interface SettingsSuggestion {
  topic: string
  reason: string
  suggestedPath: string
}

/** 设定演进模式：off 关闭；confirm_all 全部确认；auto_high 高置信自动 */
export type SettingsEvolutionMode = 'off' | 'confirm_all' | 'auto_high'

export interface SettingsApplyDiffItem {
  target: SettingsPatchTarget
  fileName: string
  op: string
  title: string
  content: string
  reason?: string
  confidence: 'high' | 'medium' | 'low'
  /** 是否可自动（high 且非禁用目标） */
  autoEligible: boolean
  note?: string
}

export interface SettingsApplyPreview {
  diffs: SettingsApplyDiffItem[]
  autoCount: number
  confirmCount: number
  suggestionCount: number
}

export interface SettingsApplyResult {
  applied: number
  skipped: number
  errors: string[]
  appliedDiffs: SettingsApplyDiffItem[]
}

/** 近期设定演进（续写注入） */
export interface SettingsEvolutionEntry {
  date: string
  chapter: string
  kind: string
  file: string
  summary: string
  status: string
}

/** 记忆自动应用前的 diff 预览项 */
export interface MemoryApplyDiffItem {
  kind: 'state' | 'plot' | 'collect'
  /** 角色名 / 情节标题 / 伏笔内容 */
  label: string
  field?: string
  oldValue: string
  newValue: string
  /** 能否应用（角色不存在时 false） */
  applicable: boolean
  note?: string
}

/** 记忆自动应用预览（应用前展示） */
export interface MemoryApplyPreview {
  diffs: MemoryApplyDiffItem[]
  /** 可自动应用的条数 */
  applicableCount: number
  /** 需确认的新增条数（角色/地点/道具/伏笔） */
  confirmCount: number
}

/** 记忆应用结果 */
export interface MemoryApplyResult {
  applied: {
    characters: number
    locations: number
    items: number
    foreshadowings: number
    plotPoints: number
    stateChanges: number
    collected: number
  }
  errors: string[]
  /** 实际写入的 diff（便于 UI 展示已应用内容） */
  appliedDiffs?: MemoryApplyDiffItem[]
}

/** 撤销写后同步的结果 */
export interface ChapterSyncUndoResult {
  ok: boolean
  memory: {
    reverted: {
      stateChanges: number
      plotPoints: number
      collected: number
      tracking: number
    }
    errors: string[]
  }
  settings: {
    reverted: number
    errors: string[]
  }
  message: string
}

/* ==========================================================
   节奏图谱回填（Phase 12 Task 7）
   ========================================================== */

/** LLM 评估的实际节奏值（用于回填节奏图谱） */
export interface RhythmEvaluation {
  chapterNumber: number
  /** LLM 评估的实际情绪值（0-10） */
  actualEmotion: number
  /** 细纲预期情绪值（从节奏图谱读取） */
  expectedEmotion: number
  /** 差异绝对值 |actual - expected| */
  diff: number
  /** 是否自动回写（diff ≤ 1 时 true） */
  autoApply: boolean
  /** LLM 评估理由（一句话） */
  reason: string
}

/** 节奏回填应用结果 */
export interface RhythmApplyResult {
  /** 是否已回写（autoApply=true 或用户确认） */
  applied: boolean
  /** 回写前的情绪值 */
  previousEmotion: number
  /** 回写后的情绪值 */
  newEmotion: number
  /** actualized 标记是否已置为 true */
  actualized: boolean
}

/* ==========================================================
   Mermaid 图解生成（Phase 12 Task 8）
   ========================================================== */

/** LLM 生成的图解草稿（关键转折点触发） */
export interface FigureDraft {
  chapterNumber: number
  /** 是否触发图解生成 */
  shouldGenerate: boolean
  /** 图解类型：战斗/势力/突破/关系/剧情/伏笔回收 */
  type: string
  /** 主题描述（用于文件名） */
  topic: string
  /** 文件名：[类型]_[主题].html */
  fileName: string
  /** Mermaid HTML 完整内容 */
  html: string
  /** LLM 判断理由 */
  reason: string
}

/* ==========================================================
   多章批量续写（Phase 12 Task 9）
   ========================================================== */

/** 批量续写进度 */
export interface BatchProgress {
  /** 总章数 */
  total: number
  /** 当前是第几章（1-based） */
  current: number
  /** 当前章号 */
  currentChapter: number
  /** 起始章号 */
  fromChapter: number
  /** 结束章号 */
  toChapter: number
  /** 状态 */
  status: 'pending' | 'generating' | 'flow' | 'paused' | 'completed' | 'failed'
  /** 暂停原因（差异/失败等） */
  pauseReason?: string
  /** 已完成章节 */
  completed: number[]
  /** 错误信息 */
  error?: string
}

/** 单章完整流程结果（生成→质检→细纲对照→记忆→节奏→图解） */
export interface ChapterFlowResult {
  chapterNumber: number
  /** 生成的正文 */
  content: string
  /** 质检报告 */
  audit: AuditReport
  /** 细纲对照差异 */
  outlineDiff: OutlineDiffReport
  /** 记忆提取 */
  memory: MemoryExtraction
  /** 节奏评估（可能为 null，LLM 失败时） */
  rhythm: RhythmEvaluation | null
  /** 图解草稿 */
  figure: FigureDraft
  /** LLM 深度审稿 findings（仅当 settings.autoDeepReview=true 时填充；否则空数组） */
  deepReview?: AuditViolation[]
}

/* ==========================================================
   拆文库（长/短篇拆文）—— 对齐 oh-story-claudecode skill 包
   产物落在全局 <userData>/teardown-library/<书名>/，与项目解耦，
   供「对标召回」「选题决策」跨项目复用。
   ========================================================== */

/** 拆文篇幅路由：<15k 短篇 / 15-20k 灰区询问 / >20k 长篇 */
export type TeardownLengthKind = 'short' | 'long'

/** 拆文管道阶段。长篇走 0-6，短篇走 2-6（数值对齐 skill 包 Stage 编号）。 */
export type TeardownStage = 0 | 0.5 | 1 | 2 | 3 | 4 | 5 | 6

/** 长篇 _progress.md 的章节边界表一行（全管道唯一切片来源，避免多阶段各自切片不一致）。 */
export interface TeardownChapterBoundary {
  /** 章号（从原文「第N章」解析，1-based） */
  chapter: number
  /** 章节标题（去除「第N章：」前缀） */
  title: string
  /** 在原文中的字符起始偏移 */
  start: number
  /** 在原文中的字符结束偏移（不含） */
  end: number
}

/** 长篇 _progress.md（schema v2）：章节边界表 + 断点 + 失败记录。 */
export interface TeardownLongProgress {
  schemaVersion: 2
  bookName: string
  /** 章节边界表，全管道唯一切片来源 */
  chapterBoundaries: TeardownChapterBoundary[]
  /** 已完成阶段；停靠点 = [0, 0.5, 1] 后等待用户确认继续 */
  stagesCompleted: TeardownStage[]
  /** 正在进行的阶段（落盘前置，crash safety：半成品不被信任，resume 整段重跑） */
  lastStageInProgress?: TeardownStage
  /** Stage 1 后是否停靠（true = 已产快速预览，等待 continueTeardown） */
  pausedAfterStage1: boolean
  /** 失败记录（章节号 + 原因），不中断管道 */
  failures: { chapter?: number; stage: TeardownStage; reason: string; at: string }[]
  updatedAt: string
}

/** 短篇 _meta.json：管道元数据 + 结构计数（Phase 7 验收依据）。 */
export interface TeardownShortMeta {
  version: 1
  bookName: string
  wordCount: number
  genreDetected?: string
  /** 已完成阶段 */
  stagesCompleted: TeardownStage[]
  lastStageInProgress?: TeardownStage
  /** Phase 7.2 强制阈值校验的结构计数 */
  structureCounts: StructureCounts
  updatedAt: string
}

/** 短篇结构计数（_meta.json.structure_counts，Phase 7 依据）。 */
export interface StructureCounts {
  /** 功能分段数（≥4，必含开端/发展/高潮/结局） */
  beats: number
  /** 钩子数（≥3） */
  hooks: number
  /** 铺垫线索数（≥3） */
  setupClues: number
  /** 角色原型数（≥2） */
  characterArchetypes: number
  /** 可复用结构数（≥3） */
  reusableStructures: number
  /** 反转类型（枚举内） */
  reversalType?: string
}

/** 拆文库条目摘要（listTeardowns 返回）。 */
export interface TeardownEntry {
  bookName: string
  lengthKind: TeardownLengthKind
  /** 已完成阶段 */
  stagesCompleted: TeardownStage[]
  /** 当前阶段（进行中） */
  currentStage?: TeardownStage
  /** 是否停在 Stage 1 停靠点（仅长篇） */
  pausedAfterStage1?: boolean
  /** 字数 */
  wordCount: number
  genreDetected?: string
  /** 创建时间（原文落盘时间） */
  createdAt: string
  updatedAt: string
}

/** 拆文进度（轮询用）。 */
export interface TeardownProgressInfo {
  bookName: string
  lengthKind: TeardownLengthKind
  currentStage: TeardownStage | null
  stagesCompleted: TeardownStage[]
  /** 当前进度描述（人类可读） */
  statusText: string
  /** Stage 2 逐章摘要的进度（已完成/总数），仅长篇 Stage 2 */
  chapterProgress?: { done: number; total: number }
}

/** 拆文产物文件项（getTeardownFiles 返回，用于前端预览产物树）。 */
export interface TeardownFileNode {
  /** 相对拆文库根的路径，如 章节/第1-3章_深度拆解.md */
  path: string
  /** 是否目录 */
  isDir: boolean
  /** 文件大小（字节），目录为 0 */
  size: number
}

/** 读取单个拆文产物文件内容（前端预览用）。 */
export interface TeardownFileContent {
  path: string
  content: string
}

/** 启动拆文的输入。 */
export interface StartTeardownInput {
  bookName: string
  /** 原文全文（.txt/.md 内容或对话贴文本） */
  rawText: string
  /** 平台/来源（可选，仅展示用） */
  platform?: string
  /** 强制篇幅；不传则按字数自动路由 */
  lengthKindOverride?: TeardownLengthKind
}

/** 字数路由结果（startTeardown 返回，灰区需前端询问）。 */
export interface TeardownRouteResult {
  lengthKind: TeardownLengthKind
  wordCount: number
  /** 灰区（15-20k）时为 true，需前端确认是否仍走短篇 */
  isGrayZone: boolean
}

/* ==========================================================
   去 AI 味润色（story-deslop）—— 对齐 oh-story-claudecode
   ========================================================== */

/** 去 AI 味检测严重度：blocking 必须改写（复扫到 0）；advisory 仅提示 */
export type DeslopSeverity = 'blocking' | 'advisory'

/** 去 AI 味检测项的 gate 归属（A-G 七道关卡） */
export type DeslopGate = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'

/** 单条去 AI 味检测结果（确定性脚本产出，不调 LLM） */
export interface DeslopFinding {
  /** 1-based 行号 */
  line: number
  /** 1-based 列号 */
  column: number
  /** 检测类型：not-is-comparison / em-dash / period-stutter / long-paragraph / repetition / truncation / placeholder / meta-leak / banned-word */
  type: string
  /** severity：blocking 必须改写复扫到 0；advisory 仅提示 */
  severity: DeslopSeverity
  /** 所属 Gate（A 禁用词 / B 句式 / C 心理外化 / D 节奏 / E 对话 / F 结尾 / G 解释腔） */
  gate: DeslopGate
  /** 用户可读的修复说明 */
  message: string
  /** 命中的原文片段（≤80 字） */
  excerpt: string
  /** 命中的禁用词本身（仅 banned-word 用） */
  word?: string
}

/** 去 AI 味扫描报告（Phase 1 产出） */
export interface DeslopScanReport {
  findings: DeslopFinding[]
  /** 各 severity 计数 */
  counts: { blocking: number; advisory: number }
  /** 6 项量化指标（用于 Phase 2 分级） */
  metrics: DeslopMetrics
  /** 字数 */
  wordCount: number
}

/** 去 AI 味 6 项量化指标（Phase 2 分级依据） */
export interface DeslopMetrics {
  /** 禁用词密度（命中数 / 千字） */
  bannedWordDensity: number
  /** 连续排比命中数 */
  parallelismCount: number
  /** 心理词占比（心中/心头/感到 等命中数 / 千字） */
  psychWordDensity: number
  /** 对话标签密度（"道/说" 占对话比例） */
  dialogueTagDensity: number
  /** 平均段落句数 */
  avgSentencesPerParagraph: number
  /** 重复描写密度（复读命中数 / 千字） */
  repetitionDensity: number
}

/** 去 AI 味严重度分级（Phase 2 产出） */
export type DeslopLevel = 'mild' | 'moderate' | 'severe'

/**
 * 去 AI 味改写的风格语境（IPC 层从项目元数据/文风档案解析后注入）。
 * 让 LLM 改写时对齐项目题材与文风，避免套通用模板。
 */
export interface DeslopStyleContext {
  /** 项目题材（ProjectData.genre，默认"通用"），决定替换语感基调 */
  genre?: string
  /** 文风档案摘要（来自 StyleProfile，可选） */
  style?: {
    /** 文风标识（StyleProfile.identifiedStyle） */
    identifiedStyle?: string
    /** 语感/语气（StyleProfile.tone） */
    tone?: string[]
    /** 句式偏好（StyleProfile.sentencePatterns） */
    sentencePatterns?: string[]
    /** 词汇偏好（StyleProfile.vocabularyPreferences） */
    vocabularyPreferences?: string[]
    /** 跨题材写作手法约束（StyleProfile.styleConstraints） */
    styleConstraints?: string[]
    /** 与题材/设定绑定的剧情手法约束（StyleProfile.plotConstraints） */
    plotConstraints?: string[]
  }
}

/** 去 AI 味润色结果（Phase 4 产出） */
export interface DeslopResult {
  /** 润色后全文（文件模式落盘，文本模式返回） */
  rewritten: string
  /** 命中并处理的 Gate 列表 */
  processedGates: DeslopGate[]
  /** 改写前字数 */
  beforeWords: number
  /** 改写后字数 */
  afterWords: number
  /** 删除比例（afterWords / beforeWords） */
  deleteRatio: number
  /** Phase 3.5 复扫报告（兜底后剩余 finding） */
  remainingFindings: DeslopFinding[]
  /** 改动摘要（逐 Gate 的修改统计） */
  changeSummary: string[]
}

/* ==========================================================
   封面生成（story-cover）—— 对齐 oh-story-claudecode
   ========================================================== */

/** 目标平台（决定封面比例与风格） */
export type CoverPlatform = 'fanqie' | 'qidian' | 'jjwxc' | 'zhihu' | 'qimao' | 'ciweimao' | 'other'

/** 题材（书名关键词推断，决定视觉风格） */
export type CoverGenre =
  | 'xianxia'
  | 'urban'
  | 'ancient_romance'
  | 'modern_romance'
  | 'mystery'
  | 'scifi'
  | 'western_fantasy'
  | 'historical'
  | 'supernatural'
  | 'light_novel'

/** 构图变体 */
export type CoverComposition = 'closeup' | 'fullbody' | 'scene' | 'duo'

/** 封面输入 */
export interface GenerateCoverInput {
  /** 项目 id（封面存到项目目录下） */
  projectId: string
  /** 书名 */
  bookName: string
  /** 作者名（笔名） */
  authorName: string
  /** 目标平台 */
  platform: CoverPlatform
  /** 题材（不传则按书名自动推断） */
  genreOverride?: CoverGenre
  /** 构图变体（默认 closeup） */
  composition?: CoverComposition
  /** 风格偏好补充（可选，追加到 prompt） */
  styleHint?: string
  /** 参考图本地路径（设置后走图生图） */
  refImagePath?: string
}

/** 封面文件信息（落盘后） */
export interface CoverFile {
  /** 文件名，如 封面_v1.png */
  fileName: string
  /** 相对项目目录的路径，如 封面/封面_v1.png */
  relPath: string
  /** 版本号 */
  version: number
  /** 是否平台上传尺寸版（_上传 后缀） */
  isUploadSize: boolean
  /** 文件大小（字节） */
  size: number
  /** 推断/指定的题材 */
  genre: CoverGenre
  /** 生成时间 */
  createdAt: string
}

/** 图像生成 API 配置（存 settings） */
export interface CoverImageConfigInput {
  /** OpenAI 或兼容代理的 API Key */
  apiKey: string
  /** 基础 URL，默认 https://api.openai.com/v1 */
  baseUrl: string
  /** 模型名，默认 gpt-image-2 */
  model: string
}

/** 图像生成 API 配置摘要（脱敏，list 返回） */
export interface CoverImageConfigSummary {
  hasKey: boolean
  keyMasked: string
  baseUrl: string
  model: string
}

/* ==========================================================
   扫榜（story-long-scan / story-short-scan）—— 对齐 oh-story-claudecode
   ========================================================== */

/** 扫榜平台（长篇 + 短篇统一） */
export type ScanPlatform =
  | 'qidian' // 起点长篇
  | 'fanqie' // 番茄长篇
  | 'jjwxc' // 晋江长篇
  | 'qimao' // 七猫长篇
  | 'ciweimao' // 刺猬猫长篇
  | 'dz' // 点众短篇
  | 'heiyan' // 黑岩短篇
  | 'zhihu' // 知乎盐言短篇

/**
 * 扫榜榜单类型（不同平台支持的榜单不同）。
 * 注意：这是开放字符串——各平台 rankType id 不同（起点 'hotsales'、晋江 '12' 等），
 * 运行时由 IPC 层 `z.string().max(50)` 约束，运行时由 getRankTypesForPlatform 提供合法值。
 */
export type ScanRankType = string

/** 单本榜单条目（各采集器统一产出） */
export interface ScanBookRecord {
  rank: number
  title: string
  author: string
  genre: string
  status: string
  descText: string
  url?: string
  tags?: string[]
}

/** 扫榜采集方式 */
export type ScanSourceMode = 'fetch' | 'browser' | 'user' | 'builtin'

/** 采集输入 */
export interface ScanRankInput {
  platform: ScanPlatform
  rankType?: ScanRankType
  /** 用户直接提供的榜单数据（markdown/文本，跳过采集走 user 模式） */
  userData?: string
}

/** 采集结果 */
export interface ScanResult {
  platform: ScanPlatform
  rankType: ScanRankType
  /** 采集方式 */
  sourceMode: ScanSourceMode
  /** 落盘的 markdown 报告文件名 */
  fileName: string
  /** 结构化条目 */
  books: ScanBookRecord[]
  /** 完整 markdown 报告内容 */
  markdown: string
  /** 数据质量提示（采集失败/部分成功时） */
  dataQualityNote?: string
  /** 抓取时间 */
  scannedAt: string
}

/** 扫榜报告摘要（listScanReports 返回） */
export interface ScanReportSummary {
  fileName: string
  platform: ScanPlatform
  rankType: ScanRankType
  bookCount: number
  scannedAt: string
}
