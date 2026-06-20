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
export interface ProviderConfig {
  id: string
  /** 展示名（用户可改），例如「主力 / 备用 / DeepSeek」 */
  label: string
  /** 厂商主页，仅展示用 */
  homepage?: string
  /** 形如 https://api.example.com/v1；请求时会拼上 /chat/completions */
  baseUrl: string
  /** 模型名，传给请求体里的 model 字段 */
  model: string
  /** API Key；空字符串表示未配置（保留旧值时由 main 端处理） */
  apiKey: string
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
  createProject: (input: CreateProjectDataInput) => Promise<ProjectMeta>
  getProject: (projectId: string) => Promise<ProjectData>
  listChapters: (projectId: string) => Promise<ChapterMeta[]>
  getChapter: (projectId: string, n: number) => Promise<ChapterContent>
  createChapter: (projectId: string, input: CreateChapterInput) => Promise<ChapterMeta>
  updateChapterContent: (projectId: string, n: number, content: string) => Promise<ChapterMeta>
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
  generateDetailedOutline: (projectId: string, chapterNumber: number) => Promise<DetailedOutlineItem>
  generateChapterStream: (
    projectId: string,
    chapterNumber: number,
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
  getUsageSummary: () => Promise<UsageSummary>
  clearUsage: () => Promise<boolean>
  getPricing: () => Promise<{ inputRate: number; outputRate: number }>
  setPricing: (patch: { inputRate?: number; outputRate?: number }) => Promise<{ inputRate: number; outputRate: number }>
  getDailyWordGoal: () => Promise<number>
  setDailyWordGoal: (goal: number) => Promise<number>
  getPomodoroConfig: () => Promise<{ focus: number; brk: number }>
  setPomodoroConfig: (cfg: { focus: number; brk: number }) => Promise<{ focus: number; brk: number }>
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
  plotSummary: string
  emotionPoint?: string
  coolPoint?: string
  hook?: string
}

export interface DetailedOutline {
  schemaVersion: number
  updatedAt: string
  items: DetailedOutlineItem[]
}

export interface UsageBucket {
  input: number
  output: number
  total: number
  cost: number
}

export interface UsageSummary {
  today: UsageBucket
  month: UsageBucket
  allTime: UsageBucket
  byFeature: { feature: string; total: number; cost: number; calls: number }[]
}
