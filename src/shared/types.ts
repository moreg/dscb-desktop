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
export type ProviderProtocol = 'openai' | 'anthropic'

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
   */
  protocol?: ProviderProtocol
}

/** 列表接口返回的脱敏 provider —— 永不返回明文 apiKey */
export type ProviderSummary = Omit<ProviderConfig, 'apiKey'> & {
  hasKey: boolean
  keyMasked: string
}

export interface ProvidersConfig {
  /** 当前选中的 provider id */
  activeId: string
  providers: ProviderConfig[]
}

/** 列表接口的返回结构（脱敏） */
export interface ListProvidersResult {
  activeId: string
  providers: ProviderSummary[]
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

export interface RendererApi {
  listProjects: () => Promise<ProjectMeta[]>
  /** 扫描 projectsRoot，将含 大纲/大纲.md 的子目录登记进 library.json */
  scanProjects: () => Promise<ProjectMeta[]>
  createProject: (input: CreateProjectDataInput) => Promise<ProjectMeta>
  getProject: (projectId: string) => Promise<ProjectData>
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
  configureLlm: (apiKey: string) => Promise<boolean>
  hasLlmKey: () => Promise<boolean>
  pingLlm: () => Promise<{ ok: boolean; error?: string; model?: string; providerLabel?: string }>
  listProviders: () => Promise<ListProvidersResult>
  upsertProvider: (p: ProviderConfig) => Promise<ProviderConfig>
  deleteProvider: (id: string) => Promise<void>
  setActiveProvider: (id: string) => Promise<string>
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
  getRhythm: (projectId: string) => Promise<RhythmEntry[]>
  getVolumes: (projectId: string) => Promise<Volume[]>
  getOutlineSections: (projectId: string) => Promise<{ h1Title: string; sections: { title: string; body: string }[] }>
  getDiagnostics: (projectId: string) => Promise<Diagnostic[]>
  listFigures: (projectId: string) => Promise<FigureSummary[]>
  readFigure: (projectId: string, fileName: string) => Promise<ChapterFigure | null>
  openFigure: (projectId: string, fileName: string) => Promise<void>
  generateChapterStream: (
    projectId: string,
    chapterNumber: number,
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
  /** 用户确认后：应用新增角色 */
  applyNewCharacters: (
    projectId: string,
    chars: MemoryExtraction['newCharacters']
  ) => Promise<number>
  /** 用户确认后：应用新增地点 */
  applyNewLocations: (
    projectId: string,
    locs: MemoryExtraction['newLocations']
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
  getWriteAuditConfig: () => Promise<WriteAuditConfig>
  setWriteAuditConfig: (cfg: Partial<WriteAuditConfig>) => Promise<WriteAuditConfig>
  /** P13-C：用量预警配置（当月 AI 费用阈值） */
  getCostAlertConfig: () => Promise<CostAlertConfig>
  setCostAlertConfig: (cfg: Partial<CostAlertConfig>) => Promise<CostAlertConfig>
  /** AI 高频词配置：开关 + 词条 + 改写示例 */
  getAiHighFreqConfig: () => Promise<AiHighFreqConfig>
  setAiHighFreqConfig: (cfg: Partial<AiHighFreqConfig>) => Promise<AiHighFreqConfig>
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

export type MemoryEntityType = 'location' | 'worldview' | 'timeline' | 'plot_point'

export interface MemoryEntity {
  id: string
  name: string
  category?: string
  notes?: string
  /** 原始 .md 解析出的全部字段（超出 name/category/notes 的，如 关联事件/关联角色/当前状态 等） */
  rawFields?: Record<string, string | string[]>
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
  createdAt: string
  updatedAt: string
}

export interface CreateRelationshipInput {
  characterAId: string
  characterBId: string
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
 * 质检类别。与「正文写作」技能的章末/禁用词/字数 + zh-humanizer 1-16 规则 + 题材例外检查项对应。
 * - ending: 章末形式（对话/事件 vs 说教/AI 抒怀）
 * - forbidden_word: 12 类禁用高频词命中（含正则模式）
 * - word_count: 字数偏离 1500-3500 区间
 * - rule: zh-humanizer 识别规则 1-16（破折号/三段式/Emoji/聊天语残留/空洞结尾等算法可检测项）
 */
export type AuditCategory = 'ending' | 'forbidden_word' | 'word_count' | 'rule'

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

export type WriteAuditMode = 'soft' | 'strict'

export interface WriteAuditConfig {
  /** 续写完成后是否自动跑质检 */
  enabled: boolean
  /** soft：违规标红仍可保存；strict：error 必须修复才能保存 */
  mode: WriteAuditMode
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
  model: string
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
}

export interface OutlineDiffReport {
  chapterNumber: number
  /** 5 类差异项 */
  diffs: OutlineDiffItem[]
  /** 总体通过判定（无 P0/P1 即通过） */
  passed: boolean
}

/* ==========================================================
   记忆回写（Phase 12 Task 4-6）
   ========================================================== */

/** 记忆提取结果（LLM 从正文提取） */
export interface MemoryExtraction {
  chapterNumber: number
  /** 新增角色（需确认） */
  newCharacters: { name: string; role: string; identity: string; personality: string }[]
  /** 新增地点（需确认） */
  newLocations: { name: string; category: string; notes: string }[]
  /** 新增伏笔（需确认） */
  newForeshadowings: { content: string; expectedCollect?: number; note?: string }[]
  /** 新增情节（自动追加到核心情节.md） */
  newPlotPoints: { title: string; event: string; coolPoint?: string }[]
  /** 角色状态变化（自动更新） */
  characterStateChanges: { name: string; field: string; oldValue: string; newValue: string }[]
  /** 伏笔回收（自动更新） */
  collectedForeshadowings: { content: string; chapter: number }[]
}

/** 记忆应用结果 */
export interface MemoryApplyResult {
  applied: {
    characters: number
    locations: number
    foreshadowings: number
    plotPoints: number
    stateChanges: number
    collected: number
  }
  errors: string[]
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
}
