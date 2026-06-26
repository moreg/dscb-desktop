/**
 * 审稿检查项注册表 + 默认配置。
 *
 * 出自「正文审核」技能 SKILL.md 第 3 步（毒点/引文/成文质量/段落/对话/敏感词）。
 * 这是 UI（检查项清单）与 chapter-audit / review-flow-service（检测引擎）的单一事实源：
 * - UI 据 sections 渲染开关 + hint；
 * - 引擎据 checkId 分发到对应检测函数。
 *
 * 与 chapter-rules.ts 同构：注册表驱动，单一事实源。
 */

import type { AuditSeverity, ReviewCheckId, ReviewThresholds, ReviewWordLists, BuiltinCheckMeta, CustomReviewCheck } from '../../../shared/types'

/** 检查项分类：算法（纯函数）vs LLM（流式语义） */
export type ReviewCheckKind = 'algorithm' | 'llm'

/** 审稿检查项分组（对应技能第 3 步的小节） */
export type ReviewCheckGroup =
  | 'toxic' // 毒点检测
  | 'quote' // 引文一致性
  | 'quality' // 成文质量
  | 'paragraph' // 段落长度
  | 'dialogue' // 对话标签
  | 'sensitive' // 敏感词
  | 'llm_review' // LLM 深度审稿

/** 一条审稿检查项：UI（label + hint + 默认严重度）与引擎（checkId 分发）共用。 */
export interface ReviewCheckSection {
  checkId: ReviewCheckId
  kind: ReviewCheckKind
  group: ReviewCheckGroup
  /** 中文名（UI 列表用） */
  label: string
  /** 默认严重度（用户无法改严重度，只能开关） */
  defaultSeverity: AuditSeverity
  /** 一句话说明命中场景（UI 提示用） */
  hint: string
}

/**
 * 审稿检查项注册表——顺序即 UI 列表呈现顺序。
 * 算法类在前，LLM 类在后。
 */
export const REVIEW_CHECK_SECTIONS: readonly ReviewCheckSection[] = [
  // ── 算法类 ──
  {
    checkId: 'meta_break',
    kind: 'algorithm',
    group: 'toxic',
    label: '打破第四面墙',
    defaultSeverity: 'error',
    hint: '角色提及"第X卷/弹幕/读者/主角/剧情/作者"等元叙事内容（穿书/系统文除外）'
  },
  {
    checkId: 'pov_mix',
    kind: 'algorithm',
    group: 'toxic',
    label: '视角混乱',
    defaultSeverity: 'warn',
    hint: '同段内第一/第三人称代词混用'
  },
  {
    checkId: 'repetition',
    kind: 'algorithm',
    group: 'toxic',
    label: '水字数/重复',
    defaultSeverity: 'warn',
    hint: '连续重复片段（N-gram 检测，长度阈值可配）'
  },
  {
    checkId: 'quote_count',
    kind: 'algorithm',
    group: 'quote',
    label: '引文字数一致性',
    defaultSeverity: 'error',
    hint: '文中"X 个字"描述与引文实际汉字数不符'
  },
  {
    checkId: 'dash_fragment',
    kind: 'algorithm',
    group: 'quality',
    label: '破折号碎片化',
    defaultSeverity: 'error',
    hint: '单字碎片或破折号密度超阈值（/100字）'
  },
  {
    checkId: 'long_sentence',
    kind: 'algorithm',
    group: 'quality',
    label: '超长句',
    defaultSeverity: 'warn',
    hint: '句子超阈值字数无句号（阈值可配）'
  },
  {
    checkId: 'comma_stack',
    kind: 'algorithm',
    group: 'quality',
    label: '逗号堆叠',
    defaultSeverity: 'info',
    hint: '一句内逗号过多，建议拆分'
  },
  {
    checkId: 'ellipsis_abuse',
    kind: 'algorithm',
    group: 'quality',
    label: '省略号滥用',
    defaultSeverity: 'info',
    hint: '同段多处省略号，每语境只用一处'
  },
  {
    checkId: 'long_paragraph',
    kind: 'algorithm',
    group: 'paragraph',
    label: '段落过长',
    defaultSeverity: 'warn',
    hint: '段落超阈值字数，手机阅读易疲劳（阈值可配）'
  },
  {
    checkId: 'dialogue_tag',
    kind: 'algorithm',
    group: 'dialogue',
    label: '对话标签单一',
    defaultSeverity: 'info',
    hint: '"道/说"标签占比过高，建议混用动作/情绪/神态标签'
  },
  {
    checkId: 'sensitive',
    kind: 'algorithm',
    group: 'sensitive',
    label: '敏感词提醒',
    defaultSeverity: 'info',
    hint: '政治/血腥/色情擦边/违法/迷信等（仅提醒，不强制修改）'
  },
  // ── LLM 类 ──
  {
    checkId: 'character_breakdown',
    kind: 'llm',
    group: 'llm_review',
    label: '角色崩坏人设',
    defaultSeverity: 'error',
    hint: '角色行为与性格设定严重不符（对照角色卡）'
  },
  {
    checkId: 'logic_hole',
    kind: 'llm',
    group: 'llm_review',
    label: '逻辑漏洞/断层',
    defaultSeverity: 'error',
    hint: '前后矛盾、时间线混乱、因果不衔接'
  },
  {
    checkId: 'low_iq_plot',
    kind: 'llm',
    group: 'llm_review',
    label: '剧情降智',
    defaultSeverity: 'warn',
    hint: '角色做出不符合智商的决策'
  },
  {
    checkId: 'emotion_cliff',
    kind: 'llm',
    group: 'llm_review',
    label: '情绪断崖',
    defaultSeverity: 'warn',
    hint: '悲伤场景突然转搞笑，破坏情绪连贯'
  },
  {
    checkId: 'hook_grade',
    kind: 'llm',
    group: 'llm_review',
    label: '钩子强度分级',
    defaultSeverity: 'warn',
    hint: '章末钩子分级（悬念强/一般/无）'
  },
  {
    checkId: 'style_match',
    kind: 'llm',
    group: 'llm_review',
    label: '文风匹配度',
    defaultSeverity: 'warn',
    hint: '语言/节奏/对话风格是否匹配题材'
  },
  {
    checkId: 'cool_point',
    kind: 'llm',
    group: 'llm_review',
    label: '爽点分析',
    defaultSeverity: 'info',
    hint: '打脸/装逼爽点是否到位（爽文题材）'
  },
  {
    checkId: 'quote_contradiction',
    kind: 'llm',
    group: 'llm_review',
    label: '引文语气/动作矛盾',
    defaultSeverity: 'warn',
    hint: '对话内容与语气/动作/情绪描述矛盾'
  }
]

/** 所有 checkId 的白名单集合（sanitize 用）。 */
export const REVIEW_CHECK_KEYS: ReadonlySet<ReviewCheckId> = new Set(
  REVIEW_CHECK_SECTIONS.map((s) => s.checkId)
)

/** 算法类 checkId（chapter-audit.ts 用，便于运行时校验）。 */
export const ALGORITHM_CHECK_IDS: ReadonlySet<ReviewCheckId> = new Set(
  REVIEW_CHECK_SECTIONS.filter((s) => s.kind === 'algorithm').map((s) => s.checkId)
)

/** LLM 类 checkId（review-flow-service.ts 用）。 */
export const LLM_CHECK_IDS: ReadonlySet<ReviewCheckId> = new Set(
  REVIEW_CHECK_SECTIONS.filter((s) => s.kind === 'llm').map((s) => s.checkId)
)

/** 默认阈值（对齐技能合格线/手机阅读标准）。 */
export const DEFAULT_REVIEW_THRESHOLDS: ReviewThresholds = {
  minWords: 2300, // 技能合格线
  maxWords: 3500,
  maxParagraphLen: 300, // 技能：>300 字必须拆分
  dashDensityPer100: 2, // 技能：段落破折号密度不应超过每 100 字 2 处
  repetitionLen: 8, // 连续重复 8 字判为水字数
  maxSentenceLen: 80 // 超长句阈值
}

/**
 * 默认打破第四面墙触发词。
 * 出自技能 3.1 #14：第X卷/弹幕/剧情/主角/读者等元叙事词。
 * 穿书文/系统文题材自动降级（引擎层处理，不在此区分）。
 */
export const DEFAULT_META_BREAK_WORDS: readonly string[] = [
  '第X卷', // 模板：实际命中靠"第N卷"正则补充，这里留作示例
  '弹幕',
  '读者',
  '作者',
  '主角',
  '配角',
  '反派',
  '剧情',
  '书里',
  '书外',
  '这本小说',
  '这本网文',
  '书评区',
  '章评',
  '段评',
  '追读',
  '月票',
  '推荐票',
  '上架',
  '完本'
]

/**
 * 默认敏感词表（出自技能 3.9，仅作提醒）。
 * 按敏感类型分组在这里扁平化为词表——具体分类标签由引擎按命中归类。
 */
export const DEFAULT_SENSITIVE_WORDS: readonly string[] = [
  // 政治相关（极简示例，实际应外接敏感词库）
  // 血腥暴力（描写手法类，命中即提醒含蓄化）
  '脑浆迸裂',
  '肠子流',
  '鲜血喷涌',
  // 色情擦边
  '赤身裸体',
  '肌肤相亲',
  // 违法犯罪手法
  '制作炸弹',
  '提炼毒品',
  '洗钱手法'
]

/** 默认词表。 */
export const DEFAULT_REVIEW_WORD_LISTS: ReviewWordLists = {
  metaBreak: [...DEFAULT_META_BREAK_WORDS],
  sensitive: [...DEFAULT_SENSITIVE_WORDS]
}

/**
 * 默认审稿规则配置。
 * - enabled 默认 true（与现有质检一致，新增项默认启用）
 * - autoDeepReview 默认 false（避免每次续写烧 token，按需手动触发）
 * - 所有检查项默认开启（checks 为空对象 = 全开）
 */
export const DEFAULT_REVIEW_RULES = {
  enabled: true,
  autoDeepReview: false,
  checks: {} as Partial<Record<string, boolean>>,
  thresholds: { ...DEFAULT_REVIEW_THRESHOLDS },
  wordLists: {
    metaBreak: [...DEFAULT_REVIEW_WORD_LISTS.metaBreak],
    sensitive: [...DEFAULT_REVIEW_WORD_LISTS.sensitive]
  },
  builtinMeta: {} as Partial<Record<ReviewCheckId, BuiltinCheckMeta>>,
  hiddenBuiltin: [] as ReviewCheckId[],
  customChecks: [] as CustomReviewCheck[]
}
