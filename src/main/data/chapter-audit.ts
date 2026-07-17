/**
 * 续写质检（PR2 + zh-humanizer v3.1.1 增量）。
 *
 * 对正文文本做规则化检查：
 * 1. 章末形式：最后 3 段必须包含对话引号 或 事件描述；
 *    命中"说教/感慨/AI 味抒怀"模板时直接判 error。
 * 2. 禁用词扫描：12 类禁用高频词（字面）+ 「嘴角+弧度」等底层模式（正则）。
 *    题材例外（古风/民国/历史允许"渐渐/此刻/一丝/一抹"等）自动降为 info。
 * 3. 字数：仅统计 wordCount，不再产出 word_count 提醒（过长/过短均不提示）。
 * 4. zh-humanizer 规则 1-16（算法可检测）：破折号滥用 / 三段式滥用 / Emoji / 聊天语残留 /
 *    空洞结尾 / 过度讨好 / 填充短语 / 假区间表达 / 加粗强调滥用 / 负向并列 / 意义膨胀 / 同义词轮换。
 *
 * 全部纯算法，无 I/O。便于单测 & 主进程同步调用。
 */

import {
  flattenForbiddenWords,
  flattenForbiddenPatterns,
  FORBIDDEN_WORD_CATEGORIES
} from './skill-prompts/forbidden-words'
import { resolveGenreVoice, type GenreVoice, type GenreKey } from './skill-prompts/genre-voice'
import { DEFAULT_REVIEW_THRESHOLDS } from './skill-prompts'
import { countWords } from './words'
import { runCustomAlgorithmChecks } from './custom-check-engine'
import type {
  AuditReport,
  AuditSeverity,
  AuditViolation,
  ReviewCheckId,
  ReviewRulesConfig,
  ReviewThresholds
} from '../../shared/types'

export interface AuditOptions {
  /**
   * @deprecated 字数区间提醒已关闭，传入无效。
   * 章节目标字数下限（历史字段，保留兼容）。
   */
  minWords?: number
  /**
   * @deprecated 字数区间提醒已关闭，传入无效。
   * 章节目标字数上限（历史字段，保留兼容）。
   */
  maxWords?: number
  /** 同一禁用词最多记录的命中次数（默认 3） */
  perWordCap?: number
  /**
   * 项目题材（中文文本，如"玄幻""古风仙侠""现代都市"）。
   * 提供后自动识别 genre，并对允许的虚词做题材例外降级。
   * 不传则按 urban 算（最普适的兜底）。
   */
  genre?: string
  /**
   * 审稿规则配置（M2 接入）。提供后启用「正文审核」技能的 11 类算法检查：
   * 毒点/引文/成文质量/段落/对话标签/敏感词。enabled=false 或缺省时跳过这些检查（向后兼容）。
   */
  reviewRules?: ReviewRulesConfig
}

const DEFAULT_PER_WORD_CAP = 3
/** 章末抽样：最后 N 个非空段落参与检查 */
const ENDING_PARA_COUNT = 3
/** 章末上下文展示长度上限 */
const ENDING_SNIPPET_MAX = 120

/**
 * 说教/感慨/AI 味抒怀模板。
 * 命中其一即视作章末形式 error。
 */
const ENDING_TABOO_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /才(刚|刚刚)开始/, reason: '"...才刚刚开始" 是 AI 味抒怀典型句式' },
  { pattern: /(留给|给).*?(读者|后人).*?(遐想|思考|想象)/, reason: '"留给读者遐想" 是 AI 味抒怀' },
  { pattern: /(也许|或许)这就是/, reason: '"或许这就是..." 是说教模板' },
  { pattern: /(这就是|就是)(命运|宿命)/, reason: '"这就是命运" 是宿命论说教' },
  { pattern: /(他|她)明白了一个道理/, reason: '"明白了一个道理" 是说教模板' },
  { pattern: /这世界就是(这样|如此)/, reason: '"这世界就是这样" 是说教模板' },
  { pattern: /人生.*?就是这样/, reason: '"人生就是这样" 是说教模板' },
  { pattern: /未来.*?(可期|不可估量)/, reason: '"未来可期" 是 AI 味抒怀' },
  { pattern: /命运的齿轮(开始|缓缓)?转动/, reason: '"命运的齿轮开始转动" 是 AI 套话' },
  { pattern: /故事.*?才(开始|刚刚)/, reason: '"故事才刚刚开始" 是 AI 味结尾' }
]

/** 引号台词正则（中文/英文/日式/嵌套都覆盖） */
const DIALOGUE_PATTERN = /["'""「『][^"'""」』\n]{1,200}["'""」』]/

/**
 * 事件描述启发式（关键词 + 动作/悬念句式）。
 * 旧版关键词过窄：像「越过桌面 / 对准心口 / 却朝着胸口幽幽地转」这类
 * 典型章末卡点会被误判为「纯心理/纯动作」error。
 */
const EVENT_KEYWORDS = [
  '突然', '猛地', '骤然', '陡然', '忽然',
  '砰', '咔', '轰', '哐当', '咚',
  '出现', '冒出', '闪出', '蹦出',
  '推开', '撞开', '踹开', '冲进', '冲出',
  '响起', '传来', '炸开', '崩塌',
  '倒下', '跪下', '站起', '转身', '回头',
  '伸手', '抓住', '抬手', '甩出',
  '断了', '裂开', '爆炸', '坠落',
  // 网文章末常见动作/瞄准/对峙（避免「看着/望着」过宽误放行）
  '越过', '跨过', '翻过', '掠过',
  '对准', '瞄准', '指向', '朝着', '对着', '顶住', '抵住',
  '盯着', '扫过', '瞥见',
  '拔出', '抽出', '按下', '扣下', '举起', '放下',
  '刺向', '砍向', '射向', '砸向', '扑向', '冲向',
  '心口', '胸口', '咽喉', '太阳穴',
  '刀尖', '枪口', '剑尖', '指针'
]

/**
 * 事件/悬念句式。注意：多字词必须用 (a|b) 非捕获组，不能用 [ab] 字符类
 * （[慢慢|缓缓] 只会匹配单字 慢/缓 和字面 |，语义错误）。
 */
const EVENT_ACTION_PATTERNS: readonly RegExp[] = [
  /却(?:朝着|向着|对着|朝向).{0,16}/,
  /对准.{0,16}(?:位置|心口|胸口|咽喉|太阳穴|眉心)/,
  /[刀枪剑弹箭].{0,8}(?:指|对|顶|抵|架)/,
  /(?:慢慢|缓缓|幽幽|轻轻|悄然).{0,6}(?:转|动|晃|抬|落|停)/,
  /最后.{0,12}(?:对准|瞄准|指向|按下|扣下|刺|砍|射)/,
  /正要.{0,12}(?:时|候)/,
  /就在这(?:时|一)/,
  /门(?:被)?(?:忽然|猛地)?.{0,6}(?:开|响|震)/,
  /[手掌拳脚].{0,6}(?:按|压|推|打|踢|踩)/
]

function hasEventEnding(text: string): boolean {
  if (EVENT_KEYWORDS.some((k) => text.includes(k))) return true
  return EVENT_ACTION_PATTERNS.some((re) => re.test(text))
}

// ============================================================
// zh-humanizer 1-16 规则中算法可检测的（其余靠 LLM 改写）
// ============================================================

interface RuleDef {
  id: string
  severity: AuditSeverity
  message: string
  pattern: RegExp
  /** 题材例外（在该题材里降为 info） */
  allowedGenres?: readonly GenreKey[]
  suggestion?: string
}

/**
 * 规则 1-16 中可用正则稳定检测的项。
 * 编号对应 zh-humanizer 技能文档里的 # 列；标注"算法可检测"。
 */
const RULE_PATTERNS: readonly RuleDef[] = [
  // 规则 7: 负向并列（不仅…而且…、不是…而是…）
  // 注意：中段可能有全角逗号/句号/分号/顿号/空白，故字符类需放宽到「中文 + 常见标点 + 空白」
  {
    id: 'rule-7-neg-conjunction',
    severity: 'warn',
    message: '负向并列"不仅…而且…"是 AI 工整对仗',
    pattern: /不仅[\s\S]{1,16}而且/,
    suggestion: '拆成两句直接表达'
  },
  {
    id: 'rule-7-not-but',
    severity: 'warn',
    message: '负向并列"不是…而是…"是 AI 工整对仗',
    pattern: /不是[\s\S]{1,16}而是/,
    suggestion: '拆成两句直接表达'
  },
  // 规则 10: 破折号滥用（AI 常用 —— 制造节奏感）— 单段内连续 2 个以上判 warn
  {
    id: 'rule-10-dash-abuse',
    severity: 'warn',
    message: '破折号连续出现 2 次以上是 AI 制造节奏感的套路',
    pattern: /——[^—\n]{0,40}——/,
    suggestion: '改为句号或逗号，节奏由短句和停顿来，不靠破折号'
  },
  // 规则 12: Emoji（除非指定风格）— 全文 1 个即判 warn
  {
    id: 'rule-12-emoji',
    severity: 'warn',
    message: '正文里出现 Emoji 是 AI 聊天残留',
    pattern: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    suggestion: '删除 Emoji，用文字描写'
  },
  // 规则 13: 聊天语残留
  {
    id: 'rule-13-chat-residual',
    severity: 'warn',
    message: '"好问题/希望这能帮到你" 是聊天语残留',
    pattern: /(好问题|希望这能帮到|如果还有|欢迎随时|有任何问题)/,
    suggestion: '删除客套话'
  },
  // 规则 14: 过度讨好
  {
    id: 'rule-14-over-flattery',
    severity: 'warn',
    message: '"你说得太对了/非常棒的问题" 是过度讨好',
    pattern: /(你说得太对了|非常棒的问题|你说得真好|很棒的问题|很好的问题)/,
    suggestion: '改为客观回应'
  },
  // 规则 15: 填充短语
  {
    id: 'rule-15-filler-phrase',
    severity: 'info',
    message: '"事实上/值得注意的是/总体来说" 是填充短语',
    pattern: /(^|[^一-龥])(事实上|值得注意的是|总体来说|总的来说|毋庸置疑的是|众所周知)([^一-龥]|$)/,
    suggestion: '直接删除，保留真实结论'
  },
  // 规则 16: 空洞结尾
  {
    id: 'rule-16-hollow-ending',
    severity: 'warn',
    message: '"未来可期/值得期待" 是空洞结尾',
    pattern: /(未来可期|值得期待|让我们拭目以待|敬请期待|值得我们去)/,
    suggestion: '改为实际下一步或具体收尾'
  },
  // 规则 4: 广告宣传（卓越/顶级/一站式/全方位 等）— 这些是网文里偶发的"卖点句"
  {
    id: 'rule-4-ad-copy',
    severity: 'warn',
    message: '"卓越/顶级/一站式/全方位" 是广告宣传腔',
    pattern: /(卓越|顶级|一站式|全方位|无与伦比|登峰造极|前所未有|千载难逢)/,
    suggestion: '改为客观描述'
  },
  // 规则 1: 意义膨胀（标志性/里程碑/深远影响）— 出现在对话或叙事里都算
  {
    id: 'rule-1-meaning-inflation',
    severity: 'warn',
    message: '"标志性/里程碑/深远影响" 是意义膨胀',
    pattern: /(标志性(的)?(意义|时刻|事件|阶段|节点)|里程碑(式)?(的)?|深远(的)?影响|划时代(的)?)/,
    suggestion: '删宏大判断，换具体影响'
  },
  // 规则 3: 伪深度动词（提升…能力 / 促进…发展 / 赋能…）
  {
    id: 'rule-3-fake-verb',
    severity: 'info',
    message: '"提升/促进/赋能/打造" 是伪深度动词',
    pattern: /(提升[一-龥]{1,8}(能力|水平|效率|体验|价值)|促进[一-龥]{1,8}(发展|增长|升级)|赋能[一-龥]{1,8}|打造[一-龥]{1,8}(新|全新|极致))/,
    suggestion: '改为具体动作或结果'
  }
]

/** 三段式：单段内 3 个以上顿号分隔的并列短语，节奏雷同 */
const THREE_PART_LIST = /[一-龥]{2,8}、[一-龥]{2,8}、[一-龥]{2,8}(，|。|；|、)/

export function auditChapter(content: string, opts: AuditOptions = {}): AuditReport {
  const perWordCap = opts.perWordCap ?? DEFAULT_PER_WORD_CAP
  const voice = resolveGenreVoice(opts.genre)
  // 审稿规则：缺省或 enabled=false 时不跑「正文审核」技能的新增检查（向后兼容）。
  const rules = opts.reviewRules?.enabled ? opts.reviewRules : null
  const thresholds = rules?.thresholds ?? DEFAULT_REVIEW_THRESHOLDS

  const violations: AuditViolation[] = []
  pushEndingViolations(content, violations)
  pushForbiddenWordViolations(content, perWordCap, voice, violations)
  pushPatternViolations(content, voice, violations)
  pushRuleViolations(content, voice, violations)
  // 字数只写入 report.wordCount，不产出 word_count 违例
  pushProhibitionViolations(content, violations)

  // 「正文审核」技能新增的算法检查（M2）。每项读 checks[id] !== false 决定是否跳过。
  if (rules) {
    pushMetaBreakViolations(content, voice, rules, violations)
    pushPovMixViolations(content, rules, violations)
    pushRepetitionViolations(content, thresholds, rules, violations)
    pushQuoteCountViolations(content, rules, violations)
    pushQualityViolations(content, thresholds, rules, violations)
    pushLongParagraphViolations(content, thresholds, rules, violations)
    pushDialogueTagViolations(content, rules, violations)
    pushSensitiveViolations(content, rules, violations)
    pushHookStrengthViolations(content, rules, violations)
    // 用户自定义算法检查项（keyword/regex）；传入 checks 开关表，关掉的项跳过
    runCustomAlgorithmChecks(content, rules.customChecks, violations, rules.checks)
  }

  const counts = countSeverities(violations)
  const passed = computePassed(violations)
  return {
    schemaVersion: 1,
    wordCount: countWords(content),
    passed,
    counts,
    violations
  }
}

/** 读检查项开关：未在 checks 表里出现 = 开（默认开）。 */
function isCheckOn(rules: ReviewRulesConfig, id: ReviewCheckId): boolean {
  return rules.checks[id] !== false
}

// ----------------------------------------------------------------------
// 章末形式
// ----------------------------------------------------------------------

function pushEndingViolations(content: string, out: AuditViolation[]): void {
  const paragraphs = splitParagraphs(content)
  if (paragraphs.length === 0) {
    out.push({
      category: 'ending',
      severity: 'error',
      message: '正文为空，无法判定章末形式'
    })
    return
  }

  const ending = paragraphs.slice(-ENDING_PARA_COUNT).join('\n\n')
  const snippet = truncate(ending, ENDING_SNIPPET_MAX)
  const endingStart = Math.max(0, content.lastIndexOf(ending))

  // 1. 先查"说教/AI 味抒怀"模板——命中直接 error
  for (const taboo of ENDING_TABOO_PATTERNS) {
    const m = ending.match(taboo.pattern)
    if (m) {
      out.push({
        category: 'ending',
        severity: 'error',
        message: `章末命中说教/AI 味结尾：${taboo.reason}`,
        snippet: m[0],
        offset: endingStart + (m.index ?? 0)
      })
    }
  }

  // 2. 再判断是否含对话或事件（事件含关键词 + 动作/悬念句式）
  const hasDialogue = DIALOGUE_PATTERN.test(ending)
  const hasEvent = hasEventEnding(ending)
  if (!hasDialogue && !hasEvent) {
    // 仅当真像「睡着了/梦里什么都没有」类空收束才提示；降为 warn，避免把合法卡点标成必须修复
    out.push({
      category: 'ending',
      severity: 'warn',
      message: '章末未检测到对话或明确事件卡点，钩子可能偏弱',
      snippet,
      offset: endingStart,
      suggestion: '可考虑对话留白（如"我不会让你——"）或具体事件/动作卡点收尾'
    })
  }
  // 有对话或事件即视为合规章末，不再额外 info 打扰
}

function splitParagraphs(content: string): string[] {
  return content
    .split(/\r?\n\s*\r?\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + '…'
}

// ----------------------------------------------------------------------
// 禁用词扫描（字面）
// ----------------------------------------------------------------------

function pushForbiddenWordViolations(
  content: string,
  perWordCap: number,
  voice: GenreVoice,
  out: AuditViolation[]
): void {
  // 建立 词条 → 类别名 的索引（用于报告 wordCategory 字段）
  const wordToCategory = new Map<string, { name: string; allowedGenres?: readonly GenreKey[] }>()
  for (const cat of FORBIDDEN_WORD_CATEGORIES) {
    for (const w of cat.words) {
      // 多类别共享词条时保留首次出现的类别
      if (!wordToCategory.has(w)) wordToCategory.set(w, { name: cat.name, allowedGenres: cat.allowedGenres })
    }
  }

  for (const word of flattenForbiddenWords()) {
    if (!word) continue
    const entry = wordToCategory.get(word)
    const isGenreAllowed = !!entry?.allowedGenres?.includes(voice.key)
    let from = 0
    let hits = 0
    while (hits < perWordCap) {
      const idx = content.indexOf(word, from)
      if (idx < 0) break
      out.push({
        category: 'forbidden_word',
        severity: isGenreAllowed ? 'info' : 'warn',
        message: isGenreAllowed
          ? `禁用词命中（${voice.label}题材允许保留）：「${word}」`
          : `禁用词命中：「${word}」（${entry?.name ?? '禁用词'}）`,
        snippet: extractContext(content, idx, word.length),
        offset: idx,
        wordCategory: entry?.name,
        word,
        suggestion: isGenreAllowed
          ? `${voice.label}里此词可用，但请确认上下文不是 AI 模板组合`
          : genreReplacementSuggestion(word, voice)
      })
      hits++
      from = idx + word.length
    }
  }
}

// ----------------------------------------------------------------------
// 禁用词扫描（正则模式：「嘴角+弧度」底层模式等）
// ----------------------------------------------------------------------

function pushPatternViolations(
  content: string,
  voice: GenreVoice,
  out: AuditViolation[]
): void {
  for (const p of flattenForbiddenPatterns()) {
    const isGenreAllowed = !!p.allowedGenres?.includes(voice.key)
    const re = new RegExp(p.pattern.source, p.pattern.flags.includes('g') ? p.pattern.flags : p.pattern.flags + 'g')
    const matches = content.matchAll(re)
    let count = 0
    for (const m of matches) {
      if (count >= 3) break
      if (m.index === undefined) continue
      out.push({
        category: 'forbidden_word',
        severity: isGenreAllowed ? 'info' : 'warn',
        message: isGenreAllowed
          ? `${p.reason}（${voice.label}题材允许保留）`
          : `${p.reason}（命中模式：${p.id}）`,
        snippet: extractContext(content, m.index, m[0].length),
        offset: m.index,
        wordCategory: p.category,
        word: p.id,
        suggestion: genreReplacementSuggestion(p.id, voice)
      })
      count++
    }
  }
}

// ----------------------------------------------------------------------
// zh-humanizer 规则 1-16 扫描
// ----------------------------------------------------------------------

function pushRuleViolations(
  content: string,
  voice: GenreVoice,
  out: AuditViolation[]
): void {
  // 规则模式列表：每条 1 次/全文（避免噪音）
  for (const rule of RULE_PATTERNS) {
    const isGenreAllowed = !!rule.allowedGenres?.includes(voice.key)
    const m = content.match(rule.pattern)
    if (!m || m.index === undefined) continue
    out.push({
      category: 'rule',
      severity: isGenreAllowed ? 'info' : rule.severity,
      message: isGenreAllowed
        ? `${rule.message}（${voice.label}题材允许）`
        : rule.message,
      snippet: extractContext(content, m.index, m[0].length),
      offset: m.index,
      ruleId: rule.id,
      suggestion: rule.suggestion
    })
  }

  // 三段式滥用：找前 5 个不重叠命中（避免长列表里重复刷屏）
  const threePartRe = new RegExp(THREE_PART_LIST.source, 'g')
  const seen = new Set<number>()
  let threeHits = 0
  for (const m of content.matchAll(threePartRe)) {
    if (threeHits >= 5) break
    if (m.index === undefined) continue
    // 跳过距离 < 20 字符的重叠命中
    if ([...seen].some((s) => Math.abs(s - m.index) < 20)) continue
    seen.add(m.index)
    threeHits++
    out.push({
      category: 'rule',
      severity: 'info',
      message: '三段式并列（X、X、X）节奏雷同',
      snippet: extractContext(content, m.index, m[0].length),
      offset: m.index,
      ruleId: 'rule-6-three-part',
      suggestion: '保留重点，删填充项或换成短句'
    })
  }
}

// ----------------------------------------------------------------------
// 题材替换语感（从 genre-voice 表里查）
// ----------------------------------------------------------------------

/**
 * 在题材的 replacements 表里查 AI 味原词，给出本题材的自然写法。
 * 命中"嘴角_弧度_底层模式"等模式 id 时，取该 id 对应的中文原词再查表。
 */
function genreReplacementSuggestion(aiFlavor: string, voice: GenreVoice): string {
  // 模式 id → 中文原词的映射（用于查表）
  const patternIdToOriginal: Record<string, string> = {
    '嘴角_弧度_底层模式': '嘴角带了点弧度',
    '嘴角_上扬变体': '嘴角带了点弧度'
  }
  const lookup = patternIdToOriginal[aiFlavor] ?? aiFlavor
  for (const [bad, good] of voice.replacements) {
    if (bad === lookup) {
      return `${voice.label}替换：${bad} → ${good}`
    }
  }
  return `请改为${voice.label}语感对应的自然表达`
}

// ----------------------------------------------------------------------
// 汇总
// ----------------------------------------------------------------------

function countSeverities(violations: AuditViolation[]): AuditReport['counts'] {
  const counts: Record<AuditSeverity, number> = { error: 0, warn: 0, info: 0 }
  for (const v of violations) counts[v.severity]++
  return counts
}

function computePassed(violations: AuditViolation[]): AuditReport['passed'] {
  // passed 只暴露 ending/forbiddenWords/wordCount 三项（向后兼容）；
  // 新增 category 的 error 级违例已通过 report.counts.error 影响 strict 模式阻断保存，
  // 不必再进 passed 结构。
  const errored = {
    ending: false,
    forbidden_word: false,
    word_count: false
  }
  for (const v of violations) {
    if (v.severity === 'error') {
      if (v.category === 'ending') errored.ending = true
      else if (v.category === 'forbidden_word') errored.forbidden_word = true
      else if (v.category === 'word_count') errored.word_count = true
    }
  }
  return {
    ending: !errored.ending,
    forbiddenWords: !errored.forbidden_word,
    wordCount: !errored.word_count
  }
}

// ----------------------------------------------------------------------
// 「正文审核」技能新增检查（M2 算法层）
// ----------------------------------------------------------------------

/**
 * 题材例外白名单：穿书文/系统文世界观支持角色知道自身处境，
 * meta_break（打破第四面墙）在这两类题材降为 info（提醒，不阻断）。
 * 当前 genre 表无穿书/系统文专门 key，默认所有题材都判 error（最严）。
 * 如需放宽，把对应 GenreKey 加入此数组。
 */
const META_BREAK_ALLOWED_GENRES: readonly GenreKey[] = []

/** 中文数字 → 数值，用于 quote_count 的引文字数核对 */
const CN_DIGIT_MAP: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 千: 1000
}

/** 把"一二三"/"5"/"二十"这类字数描述解析成数字；无法解析返回 null */
function parseCnNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s)
  // 简单中文数字：1-99 范围（"五"/"十二"/"二十三"）
  if (!/^[一二三四五六七八九十百两]+$/.test(s)) return null
  if (s === '十') return 10
  if (s.startsWith('十')) return 10 + parseCnNumber(s.slice(1))!
  if (s.includes('十')) {
    const [a, b] = s.split('十')
    const tens = (a ? CN_DIGIT_MAP[a] : 1) * 10
    return tens + (b ? CN_DIGIT_MAP[b] : 0)
  }
  if (s.startsWith('百')) return 100
  return CN_DIGIT_MAP[s[0]] ?? null
}

/**
 * 🚨 打破第四面墙：角色提及元叙事词（第X卷/弹幕/读者/主角/剧情/作者）。
 * 穿书文/系统文题材降级为 info。出自技能 3.1 #14。
 */
function pushMetaBreakViolations(
  content: string,
  voice: GenreVoice,
  rules: ReviewRulesConfig,
  out: AuditViolation[]
): void {
  if (!isCheckOn(rules, 'meta_break')) return
  // 用户自定义词表（来自设置）+ "第N卷"模式
  const words = rules.wordLists.metaBreak
  const isAllowed = META_BREAK_ALLOWED_GENRES.includes(voice.key)
  let reported = 0
  // 先扫字面词表
  for (const word of words) {
    if (reported >= 5) break
    let from = 0
    let hits = 0
    while (hits < 3 && reported < 5) {
      const idx = content.indexOf(word, from)
      if (idx < 0) break
      out.push({
        category: 'toxic',
        severity: isAllowed ? 'info' : 'error',
        message: isAllowed
          ? `打破第四面墙提醒（${voice.label}题材可能支持）：「${word}」`
          : `🚨 打破第四面墙：角色提及元叙事词「${word}」，建议删除`,
        snippet: extractContext(content, idx, word.length),
        offset: idx,
        ruleId: 'meta_break',
        word,
        suggestion: isAllowed
          ? '确认本作世界观是否支持角色知晓自身处境，不支持则删除'
          : '删除元叙事内容，除非世界观明确支持（穿书/系统文）'
      })
      reported++
      hits++
      from = idx + word.length
    }
  }
  // 再扫"第N卷/N章"这类数字变体（技能强调的典型）
  const volRe = /第([一二三四五六七八九十百零\d]+)[卷部季]/g
  if (!isAllowed) {
    let m: RegExpExecArray | null
    while ((m = volRe.exec(content)) !== null && reported < 5) {
      // 排除"第三天/第三章"这类时间/章节正常表述（只抓"卷/部/季"这类出版单位）
      out.push({
        category: 'toxic',
        severity: 'error',
        message: `🚨 打破第四面墙：提及"第${m[1]}卷/部/季"等出版单位，疑似元叙事`,
        snippet: extractContext(content, m.index, m[0].length),
        offset: m.index,
        ruleId: 'meta_break',
        word: m[0],
        suggestion: '删除"第X卷"这类元叙事表述（角色不应知道自己身处第几卷）'
      })
      reported++
    }
  }
}

/**
 * 视角混乱：同段内第一人称（我）与第三人称代词（他/她/它）指代同一主角混用。
 * 启发式：单段同时出现"我"+（"他/她/它"作为主语）即提醒。出自技能 3.1 #10。
 */
function pushPovMixViolations(
  content: string,
  rules: ReviewRulesConfig,
  out: AuditViolation[]
): void {
  if (!isCheckOn(rules, 'pov_mix')) return
  const paragraphs = splitParagraphs(content)
  let scanFrom = 0
  let reported = 0
  for (const para of paragraphs) {
    if (reported >= 3) break
    const rel = content.indexOf(para, scanFrom)
    if (rel < 0) {
      scanFrom = 0
      continue
    }
    scanFrom = rel + para.length
    const hasFirst = /我/.test(para)
    const thirdCount = (para.match(/[他她它]/g) || []).length
    // 第一人称段落里频繁出现第三人称代词（>3 次）疑似视角混乱
    if (hasFirst && thirdCount > 3) {
      out.push({
        category: 'toxic',
        severity: 'warn',
        message: '视角混乱：第一人称段落里大量出现第三人称代词，疑似视角跳跃',
        snippet: truncate(para, 80),
        offset: rel,
        ruleId: 'pov_mix',
        suggestion: '统一叙事视角，或在人称切换处明确交代'
      })
      reported++
    }
  }
}

/**
 * 水字数/重复：连续重复片段（N-gram）。出自技能 3.1 #5/#17。
 * 检测：连续 ≥ repetitionLen 字的片段在 100 字内重复出现 ≥2 次。
 */
function pushRepetitionViolations(
  content: string,
  thresholds: ReviewThresholds,
  rules: ReviewRulesConfig,
  out: AuditViolation[]
): void {
  if (!isCheckOn(rules, 'repetition')) return
  const len = Math.max(4, thresholds.repetitionLen)
  // 按段落扫描，避免跨段误判
  for (const para of splitParagraphs(content)) {
    if (para.length < len * 2) continue
    const seen = new Set<string>()
    let reported = false
    for (let i = 0; i + len <= para.length && !reported; i++) {
      const gram = para.slice(i, i + len)
      if (seen.has(gram)) {
        const idx = content.indexOf(gram)
        if (idx >= 0) {
          out.push({
            category: 'toxic',
            severity: 'warn',
            message: `水字数/重复：片段「${gram}」在同段重复`,
            snippet: extractContext(content, idx, gram.length),
            offset: idx,
            ruleId: 'repetition',
            word: gram,
            suggestion: '精简重复内容，除非是刻意强调'
          })
          reported = true
        }
      } else {
        seen.add(gram)
      }
    }
  }
}

/**
 * 🚨 引文字数一致性：文中"X个字"描述与最近引文实际汉字数不符。出自技能 3.2。
 * 示例："你做得不错。"她说这三个字的时候… → 引文 5 字，描述 3 字 → error。
 */
function pushQuoteCountViolations(
  content: string,
  rules: ReviewRulesConfig,
  out: AuditViolation[]
): void {
  if (!isCheckOn(rules, 'quote_count')) return
  // 抓"(这|那|这些|那些)X个字"描述
  const descRe = /([这那])([些]?)([一二三四五六七八九十百零\d两]+)个字(的时候)?/g
  let m: RegExpExecArray | null
  let reported = 0
  while ((m = descRe.exec(content)) !== null && reported < 3) {
    const claimed = parseCnNumber(m[3])
    if (claimed == null) continue
    const descIdx = m.index
    // 回溯找最近的引文
    const before = content.slice(0, descIdx)
    const quoteRe = /["“”'‘「『]+([^"””'’」』\n]{1,200})["””'’」』]+/g
    let lastQuote: { text: string; idx: number } | null = null
    let qm: RegExpExecArray | null
    while ((qm = quoteRe.exec(before)) !== null) {
      lastQuote = { text: qm[1], idx: qm.index }
    }
    if (!lastQuote) continue
    const actual = countHanChars(lastQuote.text)
    if (actual !== claimed) {
      out.push({
        category: 'quote',
        severity: 'error',
        message: `🚨 引文字数描述错误：描述"${m[0]}"，但前文引文实际 ${actual} 字`,
        snippet: extractContext(content, lastQuote.idx, lastQuote.text.length),
        offset: descIdx,
        ruleId: 'quote_count',
        word: m[0],
        suggestion: `核对引文字数：引文「${lastQuote.text}」实为 ${actual} 字，描述应改为"${m[1]}${m[2]}${actual}个字"`
      })
      reported++
    }
  }
}

/** 数汉字数（不含标点） */
function countHanChars(s: string): number {
  return (s.match(/[一-龥]/g) || []).length
}

/**
 * 成文质量：破折号碎片化🚨 + 超长句 + 逗号堆叠 + 省略号滥用。出自技能 3.3。
 */
function pushQualityViolations(
  content: string,
  thresholds: ReviewThresholds,
  rules: ReviewRulesConfig,
  out: AuditViolation[]
): void {
  // 🚨 破折号碎片化：单字碎片（——单字——）直接 error
  if (isCheckOn(rules, 'dash_fragment')) {
    const singleFragRe = /——[一-龥]——/g
    let m: RegExpExecArray | null
    let reported = 0
    while ((m = singleFragRe.exec(content)) !== null && reported < 3) {
      out.push({
        category: 'quality',
        severity: 'error',
        message: '🚨 破折号碎片化：破折号将单字隔开，阅读体验极差',
        snippet: extractContext(content, m.index, m[0].length),
        offset: m.index,
        ruleId: 'dash_fragment',
        word: m[0],
        suggestion: '用逗号/句号替代，保留极少数有强调效果的破折号'
      })
      reported++
    }
    // 密度超阈值：段落内 —— 数量 / 段落字数 * 100 > 阈值 → warn
    for (const para of splitParagraphs(content)) {
      const dashCount = (para.match(/——/g) || []).length
      const hanCount = countHanChars(para)
      if (hanCount >= 20 && dashCount > 0) {
        const density = (dashCount / hanCount) * 100
        if (density > thresholds.dashDensityPer100) {
          const idx = content.indexOf(para)
          if (idx >= 0) {
            out.push({
              category: 'quality',
              severity: 'warn',
              message: `破折号密度过高：本段 ${dashCount} 处 ——（约每 100 字 ${density.toFixed(1)} 处）`,
              snippet: truncate(para, 80),
              offset: idx,
              ruleId: 'dash_fragment',
              suggestion: '改为句号/逗号控制节奏，破折号每章不超过 3-5 处'
            })
          }
        }
      }
    }
  }

  // 超长句：句间（。！？）分隔的句子超阈值字数
  if (isCheckOn(rules, 'long_sentence')) {
    const sentences = content.split(/[。！？\n]/)
    let scanFrom = 0
    let reported = 0
    for (const s of sentences) {
      if (reported >= 3) break
      const hanCount = countHanChars(s)
      if (hanCount > thresholds.maxSentenceLen) {
        const idx = content.indexOf(s, scanFrom)
        if (idx >= 0) {
          out.push({
            category: 'quality',
            severity: 'warn',
            message: `超长句：连续 ${hanCount} 字无句号，建议断句`,
            snippet: truncate(s, 80),
            offset: idx,
            ruleId: 'long_sentence',
            suggestion: '拆成 2-3 句，降低阅读负担'
          })
          scanFrom = idx + s.length
          reported++
        }
      }
    }
  }

  // 逗号堆叠：单句内连续 5+ 个逗号
  if (isCheckOn(rules, 'comma_stack')) {
    const commaRe = /[^。！？\n]{0,5}(，[^。！？\n，]{1,30}){5,}/g
    let m: RegExpExecArray | null
    let reported = 0
    while ((m = commaRe.exec(content)) !== null && reported < 2) {
      out.push({
        category: 'quality',
        severity: 'info',
        message: '逗号堆叠：一句内逗号过多，节奏拖沓',
        snippet: extractContext(content, m.index, m[0].length),
        offset: m.index,
        ruleId: 'comma_stack',
        suggestion: '拆分成多个短句'
      })
      reported++
    }
  }

  // 省略号滥用：同段 3+ 处省略号
  if (isCheckOn(rules, 'ellipsis_abuse')) {
    for (const para of splitParagraphs(content)) {
      const ellipsisCount = (para.match(/(……|\.\.\.)/g) || []).length
      if (ellipsisCount >= 3) {
        const idx = content.indexOf(para)
        if (idx >= 0) {
          out.push({
            category: 'quality',
            severity: 'info',
            message: `省略号滥用：本段 ${ellipsisCount} 处省略号`,
            snippet: truncate(para, 60),
            offset: idx,
            ruleId: 'ellipsis_abuse',
            suggestion: '每个语境只用一处省略号'
          })
        }
      }
    }
  }
}

/**
 * 段落过长：单段超阈值字数（手机阅读不友好）。出自技能 3.8。
 */
function pushLongParagraphViolations(
  content: string,
  thresholds: ReviewThresholds,
  rules: ReviewRulesConfig,
  out: AuditViolation[]
): void {
  if (!isCheckOn(rules, 'long_paragraph')) return
  let reported = 0
  for (const para of splitParagraphs(content)) {
    if (reported >= 5) break
    const hanCount = countHanChars(para)
    if (hanCount > thresholds.maxParagraphLen) {
      const idx = content.indexOf(para)
      if (idx >= 0) {
        out.push({
          category: 'paragraph',
          severity: 'warn',
          message: `段落过长：${hanCount} 字，手机阅读易疲劳`,
          snippet: truncate(para, 60),
          offset: idx,
          ruleId: 'long_paragraph',
          suggestion: `拆分为 2-3 段（建议单段 ${thresholds.maxParagraphLen} 字以内）`
        })
        reported++
      }
    }
  }
}

/**
 * 对话标签单一："道/说"占对话标签比例过高。出自技能 3.7。
 * 启发式：统计对话后的"X道/说/问"标签，若"道/说"占 ≥ 70% 且总数 ≥ 5 → info。
 */
function pushDialogueTagViolations(
  content: string,
  rules: ReviewRulesConfig,
  out: AuditViolation[]
): void {
  if (!isCheckOn(rules, 'dialogue_tag')) return
  const tagRe = /["'""」』][^"'""」』]{1,100}["'""」』]\s*([一-龥]{1,4})(道|说|问|答|喊|哼|嘟囔|喃喃|笑道|问道|答道)/g
  const counts: Record<string, number> = {}
  let total = 0
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(content)) !== null) {
    const tag = m[2]
    counts[tag] = (counts[tag] ?? 0) + 1
    total++
  }
  if (total < 5) return
  const daoShuo = (counts['道'] ?? 0) + (counts['说'] ?? 0) + (counts['笑道'] ?? 0)
  const ratio = daoShuo / total
  if (ratio >= 0.7) {
    out.push({
      category: 'dialogue',
      severity: 'info',
      message: `对话标签单一：${daoShuo}/${total} 个标签用"道/说/笑"，占比 ${(ratio * 100).toFixed(0)}%`,
      offset: 0,
      ruleId: 'dialogue_tag',
      suggestion: '混用动作/情绪/神态标签（点头/皱眉/冷笑/沉默），或直接用对话开头省略标签'
    })
  }
}

/**
 * 敏感词提醒：命中敏感词表（仅提醒，不强制修改）。出自技能 3.9。
 */
function pushSensitiveViolations(
  content: string,
  rules: ReviewRulesConfig,
  out: AuditViolation[]
): void {
  if (!isCheckOn(rules, 'sensitive')) return
  const words = rules.wordLists.sensitive
  let reported = 0
  for (const word of words) {
    if (reported >= 5) break
    let from = 0
    let hits = 0
    while (hits < 1 && reported < 5) {
      const idx = content.indexOf(word, from)
      if (idx < 0) break
      out.push({
        category: 'sensitive',
        severity: 'info',
        message: `敏感词提醒：「${word}」（仅提醒，不强制修改）`,
        snippet: extractContext(content, idx, word.length),
        offset: idx,
        ruleId: 'sensitive',
        word,
        suggestion: '根据平台风险等级自行判断：架空/含蓄化/删减'
      })
      reported++
      hits++
      from = idx + word.length
    }
  }
}

/**
 * 章末钩子强度检测（算法类）。出自「正文审核」技能 3.6 钩子检测。
 * 检查最后几段是否包含悬念/冲突/反转/伏笔类关键词。
 * 钩子类型：悬念型/冲突型（强）、转折型/伏笔型/对话留白（中）、场景型（弱）、无钩子（弱）。
 */
function pushHookStrengthViolations(
  content: string,
  rules: ReviewRulesConfig,
  out: AuditViolation[]
): void {
  if (!isCheckOn(rules, 'hook_strength')) return
  const paras = splitParagraphs(content)
  if (paras.length === 0) return

  // 取最后 3 段非空段落
  const tailParas = paras.filter((p) => p.trim().length > 0).slice(-3)
  if (tailParas.length === 0) return
  const tail = tailParas.join('\n')

  // 强钩子关键词：悬念/冲突/反转
  const strongPatterns = [
    /[？?]\s*$/, // 以问号结尾（悬念）
    /到底是什么|究竟是谁|怎么会|不可能|怎么可能|难道说/,
    /突然|忽然|猛地|陡然/, // 突发事件
    /却发现|却不知|殊不知/, // 反转
    /转身.*只见|回头.*看到/,
    /出现在.*身后|站在.*背后/
  ]
  // 中等钩子关键词：伏笔/对话留白
  const mediumPatterns = [
    /……$/, // 省略号结尾（留白）
    /没有.*说话|沉默|不再开口/,
    /心中.*一动|若有所思|陷入了沉思/,
    /这件事.*不简单|没那么简单/
  ]
  // 对话留白：末尾是对话
  const dialoguePattern = /[""「].+?[""」]\s*$/

  const hasStrong = strongPatterns.some((re) => re.test(tail))
  const hasMedium = mediumPatterns.some((re) => re.test(tail))
  const hasDialogue = dialoguePattern.test(tail.trim())

  if (hasStrong) return // 强钩子，不报

  if (hasMedium || hasDialogue) {
    // 中等钩子，不报 error
    return
  }

  // 场景型/无钩子 → warn
  out.push({
    category: 'paragraph',
    severity: 'warn',
    message: '章末钩子偏弱：末段未检测到悬念/冲突/反转/伏笔关键词或对话留白',
    snippet: tailParas[tailParas.length - 1]?.slice(-60) ?? '',
    ruleId: 'hook_strength',
    suggestion: '建议章末以对话留白、悬念问句、突发事件或反转收尾，增强读者追读动力'
  })
}

const CONTEXT_RADIUS = 12

function extractContext(content: string, idx: number, wordLen: number): string {
  const start = Math.max(0, idx - CONTEXT_RADIUS)
  const end = Math.min(content.length, idx + wordLen + CONTEXT_RADIUS)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  return prefix + content.slice(start, end).replace(/\s+/g, ' ') + suffix
}

// ============================================================
// 公开 API：稳定违例键（P5-C）
// ============================================================

/**
 * 给违例生成稳定键（不依赖列表位置）。
 * 同 category + 同 word + 同 offset 视为"同一处违例"，跨 re-audit 可保留 humanize 结果。
 *
 * 边界情况：
 * - word 为空（用 category 替代作"普通 warn"）
 * - offset 为 undefined（rule 类违例）→ 用 ruleId 替代
 */
export function violationKey(v: AuditViolation): string {
  const loc = v.offset != null ? String(v.offset) : (v.ruleId ?? 'nooffset')
  const ident = v.word ?? v.wordCategory ?? 'general'
  return `${v.category}:${ident}:${loc}`
}

/**
 * 给定新的 violations 列表 + 旧的 humanizeMap，返回"只保留仍在新报告里"的精简 map。
 * 用途：re-audit 后选择性清理（而不是一键全清）。
 */
export function pruneHumanizeMap<V>(
  newViolations: readonly AuditViolation[],
  oldMap: Record<string, V>
): Record<string, V> {
  const activeKeys = new Set(newViolations.map(violationKey))
  const next: Record<string, V> = {}
  for (const [k, v] of Object.entries(oldMap)) {
    if (activeKeys.has(k)) next[k] = v
  }
  return next
}

/**
 * 增强的 3 条写作禁制质检规则。
 * 1. 禁制 1：禁止对工具人/背景板路人进行外貌、衣着、小动作描写。
 * 2. 禁制 2：禁止对话中夹杂长神态/多动作描写，动作应单独成行，同一人对话需一口气说完。
 * 3. 禁制 3：严格执行“事件-反应-结果”闭环，拒绝纯氛围/纯环境与心理抒发。
 */
function pushProhibitionViolations(content: string, out: AuditViolation[]): void {
  // --- 禁制 1：工具人/背景板路人描写 ---
  const PROHIBITION_1_PATTERNS = [
    {
      pattern: /(老者|老头|老妇|妇人|壮汉|大汉|汉子|青年|少年|少女|小厮|伙计|掌柜|店小二|小二|差役|侍卫|守卫|门卫|路人|旁人|百姓|兵丁|士兵|将士|仆人|丫鬟|侍女|客官|商贩|小贩|摊主)[^。！\n]{0,15}?(身穿|身着|穿着|一身|头戴|戴着|披着|裹着|衣着|装扮)[^。！\n]{1,10}/,
      message: '违反禁制 1：禁止对工具人/背景板路人进行衣着描写',
      suggestion: '删除衣着描写，让读者自然脑补，工具人只写功能性动作'
    },
    {
      pattern: /(老者|老头|老妇|妇人|壮汉|大汉|汉子|青年|少年|少女|小厮|伙计|掌柜|店小二|小二|差役|侍卫|守卫|门卫|路人|旁人|百姓|兵丁|士兵|将士|仆人|丫鬟|侍女|客官|商贩|小贩|摊主)[^。！\n]{0,15}?([花白黑粗稀]的?(胡须|胡子|发|鬓角|胡|须)|胡须|胡子|鬓角)[^。！\n]{0,10}?(有|多|少|长|短|发白|泛白|白了|花白)/,
      message: '违反禁制 1：禁止对工具人/背景板路人进行外貌/胡须/白发描写',
      suggestion: '删除外貌描写，工具人只写功能性动作'
    },
    {
      pattern: /(老者|老头|老妇|妇人|壮汉|大汉|汉子|青年|少年|少女|小厮|伙计|掌柜|店小二|小二|差役|侍卫|守卫|门卫|路人|旁人|百姓|兵丁|士兵|将士|仆人|丫鬟|侍女|客官|商贩|小贩|摊主)[^。！\n]{0,15}?([摸捋]了?[摸捋]?(胡子|胡须)|抽了?口?烟|吸了?口?烟|歪了?歪?头|摸了?摸?下巴)/,
      message: '违反禁制 1：禁止对工具人/背景板路人进行细微小动作描写',
      suggestion: '删除小动作描写，路人只写功能性动作（如“他递过文书”）'
    },
    {
      pattern: /帽子(歪了|歪戴|戴歪|有些歪)/,
      message: '违反禁制 1：命中工具人小动作套路“帽子歪了”',
      suggestion: '删除该与剧情推进无关的动作描写'
    }
  ]

  for (const item of PROHIBITION_1_PATTERNS) {
    const re = new RegExp(item.pattern.source, 'g')
    const matches = content.matchAll(re)
    let count = 0
    for (const m of matches) {
      if (count >= 3) break
      if (m.index === undefined) continue
      out.push({
        category: 'toxic',
        severity: 'warn',
        message: item.message,
        snippet: extractContext(content, m.index, m[0].length),
        offset: m.index,
        ruleId: 'prohibition-1-bystander-detail',
        suggestion: item.suggestion
      })
      count++
    }
  }

  // --- 禁制 2：对话神态动作排版/长神态 ---
  const paragraphs = splitParagraphs(content)
  for (const para of paragraphs) {
    const idx = content.indexOf(para)
    if (idx < 0) continue

    // 检查是否包含任何引号
    if (!para.includes('"') && !para.includes('「') && !para.includes('“') && !para.includes('”') && !para.includes('『') && !para.includes('』')) {
      continue
    }

    // 取得所有引号对
    const quoteRegex = /(".*?"|“.*?”|「.*?」|『.*?』)/g
    const parts = para.split(quoteRegex)
    if (parts.length <= 1) continue

    const before = parts[0] ? parts[0].trim() : ''
    const after = parts[parts.length - 1] ? parts[parts.length - 1].trim() : ''

    // 检查夹在多个引号对中间的文本
    let hasMiddleText = false
    for (let i = 1; i < parts.length - 1; i++) {
      if (i % 2 === 0 && parts[i].trim().length > 0) {
        hasMiddleText = true
        break
      }
    }

    if (hasMiddleText) {
      out.push({
        category: 'dialogue',
        severity: 'warn',
        message: '违反禁制 2：对话行内夹杂动作/旁白打断（同一人的对话需一口气说完）',
        snippet: truncate(para, 80),
        offset: idx,
        ruleId: 'prohibition-2-dialogue-layout',
        suggestion: '删除中间穿插的动作，或者将动作提到对话前、对话后独立成行'
      })
    }

    if (after.length > 0) {
      const cleanAfter = after.replace(/^[。！？，；、…]+/, '').trim()
      if (cleanAfter.length > 0) {
        out.push({
          category: 'dialogue',
          severity: 'warn',
          message: '违反禁制 2：动作描写跟在同一段台词后面挤在同一行',
          snippet: truncate(para, 80),
          offset: idx,
          ruleId: 'prohibition-2-dialogue-layout',
          suggestion: '将台词后的动作/神态描写移动到台词前单独成行，或在台词后另起一段'
        })
      }
    }

    if (before.length > 0) {
      const cleanBefore = before.replace(/[：:\s]+$/, '').trim()
      const hasMultipleActions = cleanBefore.includes('，') || cleanBefore.includes('；') || cleanBefore.includes('、')
      const longPre = cleanBefore.length > 8
      const hasTabooWords = /(捋|摸|闪过|精光|沉沉|缓缓|沉吟|皱眉|叹气|叹了口)/.test(cleanBefore)

      if (cleanBefore.length > 0 && (hasMultipleActions || longPre || hasTabooWords)) {
        out.push({
          category: 'dialogue',
          severity: 'warn',
          message: '违反禁制 2：对话前存在长神态/多动作铺垫（路人/说话要直奔主题，动作应独立成行）',
          snippet: truncate(before, 60),
          offset: idx,
          ruleId: 'prohibition-2-dialogue-layout',
          suggestion: '将长神态/小动作描写提到前面单独成行，对话前只保留简短的“某某说：”或“某某问：”'
        })
      }
    }
  }

  // --- 禁制 3：事件-反应-结果 闭环 ---
  const PROHIBITION_3_PATTERNS = [
    {
      pattern: /(天空|天色|夜色|月色|月光|微风|冷风|山风|晚霞|暮色|残阳|云雾|落叶|空气|氛围|气氛|四周)[^。！\n]{0,30}?(渐|呼啸|掠过|弥漫|笼罩|格外|十分|安静|沉闷|如墨|微凉)[^。！\n]{0,30}?[。！]\s{0,10}(他|她|我)[^。！\n]{0,20}?(站在|看着|望着|凝视|眺望|环顾|打量|靠在)[^。！\n]{0,20}?(心中|心底|思绪|感慨|情绪|感叹|回忆|思念|叹息|茫然|复杂|一股)/,
      message: '违反禁制 3：拒绝纯氛围/纯环境描写，每个描写单元都必须形成“事件-反应-结果”闭环',
      suggestion: '增加具体的突发事件与人物反应（例如“他听到身后脚步声，猛然转身”），避免纯抒情/纯感慨'
    },
    {
      pattern: /(夜色如墨|微风不燥|月光如水|清风徐来|微风吹过|微风拂过)[^。！\n]{0,20}?[。！]\s{0,10}(他|她|我)[^。！\n]{0,20}?(陷入|思索|回忆|叹息|发呆|感慨)/,
      message: '违反禁制 3：命中纯环境渲染与纯心理活动套路（无事件/无结果闭环）',
      suggestion: '删除纯氛围描写，或改为具体的“事件-反应-结果”闭环结构'
    }
  ]

  for (const item of PROHIBITION_3_PATTERNS) {
    const re = new RegExp(item.pattern.source, 'g')
    const matches = content.matchAll(re)
    let count = 0
    for (const m of matches) {
      if (count >= 3) break
      if (m.index === undefined) continue
      out.push({
        category: 'quality',
        severity: 'warn',
        message: item.message,
        snippet: extractContext(content, m.index, m[0].length),
        offset: m.index,
        ruleId: 'prohibition-3-atmosphere-loop',
        suggestion: item.suggestion
      })
      count++
    }
  }
}
