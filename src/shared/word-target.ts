/**
 * 章节目标字数解析（主进程 / 渲染进程共用）。
 *
 * 单一真相源：写正文的 prompt、写后自检的字数项、编辑器右栏的「本章字数目标」
 * 必须用同一套解析，否则会出现「界面显示 3000、模型只被要求 2500」这种口径分裂。
 *
 * 容忍细纲里的各种人写法：全角数字、全角波浪号、「至」、「3千字」「1.2万字」
 * 「三千字」等量词写法。解析不出来时明确回报 fromOutline=false，由调用方决定是否提示，
 * 而不是静默兜底。
 */

/** 每章默认目标字数（细纲没写或解析不出时的兜底）。基于典型网文节奏约 2500 字/章。 */
export const DEFAULT_TARGET_WORDS = 2500

/** 防止用户在细纲里填出极端值（如 0 或 50000）的夹取区间。 */
export const MIN_TARGET_WORDS = 800
export const MAX_TARGET_WORDS = 8000

export interface WordTargetResolution {
  /** 最终采用的整章目标字数（已夹取到 [MIN, MAX]） */
  targetWords: number
  /** 是否真的从细纲「字数预估」解析出来；false 表示走了 DEFAULT_TARGET_WORDS 兜底 */
  fromOutline: boolean
  /** 解析值被夹取时给出夹取前的原值，供提示「你填的 N 已被按上/下限处理」 */
  clampedFrom?: number
  /**
   * 细纲这个数字的语义：
   * - 'min'：目标/下限（默认，「约 3000 字」「3000-3500」都按这个）
   * - 'about'：上限口径（「不超过 3000 字」「3000 字以内」），此时不能当硬性下限下发
   */
  bound: 'min' | 'about'
  /** 细纲原文，供提示展示 */
  raw?: string
}

/** 上限口径的措辞：命中则字数只能当「约 / 不要超过」用，不能当硬性下限 */
const UPPER_BOUND_RE = /不超过|不多于|不得超过|以内|最多|上限|封顶/

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
}

/** 「三」「十」「十五」「二十」「二十五」→ 数值；认不出返回 NaN */
function cnSmallToNumber(s: string): number {
  if (!s) return NaN
  if (s[0] === '十') {
    const rest = s.slice(1)
    if (!rest) return 10
    const d = CN_DIGITS[rest[0]]
    return d === undefined ? NaN : 10 + d
  }
  const head = CN_DIGITS[s[0]]
  if (head === undefined) return NaN
  if (s.length === 1) return head
  if (s[1] !== '十') return NaN
  const rest = s.slice(2)
  if (!rest) return head * 10
  const d = CN_DIGITS[rest[0]]
  return d === undefined ? NaN : head * 10 + d
}

/**
 * 把「3千」「1.2万」「三千」「两千五」「一万二」展开成阿拉伯数字。
 * 单位后跟的单个数字按「半个单位」计（两千五 = 2500、一万二 = 12000），这是中文口语惯例。
 */
function expandUnits(s: string): string {
  return s.replace(
    /(\d+(?:\.\d+)?|[零一二两三四五六七八九十]+)\s*([千万])\s*([零一二两三四五六七八九]|\d)?/g,
    (whole, headRaw: string, unit: string, tailRaw?: string) => {
      const head = /^[\d.]+$/.test(headRaw) ? Number(headRaw) : cnSmallToNumber(headRaw)
      if (!Number.isFinite(head)) return whole
      const mult = unit === '万' ? 10000 : 1000
      let n = head * mult
      if (tailRaw) {
        const t = /^\d$/.test(tailRaw) ? Number(tailRaw) : CN_DIGITS[tailRaw]
        if (t !== undefined && Number.isFinite(t)) n += t * (mult / 10)
      }
      return String(Math.round(n))
    }
  )
}

/** 全角数字/小数点归一化，各类区间分隔符统一成 '-' */
function normalize(raw: string): string {
  return raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．]/g, '.')
    .replace(/[~～〜—–－至到]/g, '-')
}

export function clampTargetWords(n: number): number {
  return Math.min(MAX_TARGET_WORDS, Math.max(MIN_TARGET_WORDS, n))
}

/**
 * 从细纲「字数预估」文本解析目标字数。
 * 区间取上限（「2500-3000」→ 3000）；解析不出返回 undefined。
 */
export function parseWordEstimate(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const s = expandUnits(normalize(raw))
  const range = s.match(/(\d{3,6})\s*-\s*(\d{3,6})/)
  if (range) {
    const high = Number(range[2])
    if (Number.isFinite(high)) return high
  }
  const single = s.match(/(\d{3,6})/)
  if (single) {
    const n = Number(single[1])
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** 正文字数口径：剥掉全部空白后的字符数（与 main/data/words.ts 的 countWords 一致） */
export function countProseWords(text: string): number {
  return text.replace(/\s/g, '').length
}

/** 一次正文生成实际使用的字数口径（主进程按细纲算出） */
export interface ChapterWordBudgetLike {
  targetWords: number
  chapterTargetWords: number
  writtenWords: number
  fromOutline: boolean
}

/** 低于目标这个比例才提示，避免差几十字也弹 */
const SHORTFALL_RATIO = 0.95

/**
 * 生成「写够没有」的提示文案；达标返回 null。
 *
 * 模型算不准中文字数，写不够是常态。此前全链路没有任何地方核对实际字数，
 * 写少了既没提示也没人补，用户只能自己盯着进度条猜。
 */
export function describeWordShortfall(
  budget: ChapterWordBudgetLike | undefined,
  finalContent: string
): string | null {
  if (!budget || budget.chapterTargetWords <= 0) return null
  const total = countProseWords(finalContent)
  const chapterGap = budget.chapterTargetWords - total
  const chapterShort = total < budget.chapterTargetWords * SHORTFALL_RATIO
  const suffix = budget.fromOutline ? '' : '（细纲未填字数预估，用的是默认目标）'

  // 续写：本次增量和整章进度分别报
  if (budget.writtenWords > 0) {
    const added = Math.max(0, total - budget.writtenWords)
    const roundShort = added < budget.targetWords * SHORTFALL_RATIO
    if (!roundShort && !chapterShort) return null
    const chapterPart = chapterShort
      ? `全章 ${total}/${budget.chapterTargetWords} 字，还差 ${chapterGap} 字，可再点一次续写`
      : `全章 ${total}/${budget.chapterTargetWords} 字，已达标`
    return roundShort
      ? `本次只写了 ${added} 字（本次目标 ${budget.targetWords} 字）；${chapterPart}${suffix}`
      : `${chapterPart}${suffix}`
  }

  if (!chapterShort) return null
  return `本章只写了 ${total} 字，比目标 ${budget.chapterTargetWords} 字少 ${chapterGap} 字，可点「续写」补足${suffix}`
}

/**
 * 去 AI 味之后的篇幅提示；仍达标返回 null。
 *
 * 改写允许合法删掉最多 35%（deslop 的 deleteLimitPct），3000 字改完剩 2000 字属于"通过"，
 * 但成品就此低于细纲目标，而改写链路上没有任何地方拿细纲字数对过账。
 * 这里只做提示——删多少由 deslop 的护栏决定，补不补由作者决定。
 */
export function describeDeslopShortfall(
  afterWords: number,
  target: Pick<WordTargetResolution, 'targetWords' | 'fromOutline'>,
  beforeWords?: number
): string | null {
  if (!target.targetWords || afterWords >= target.targetWords * SHORTFALL_RATIO) return null
  const gap = target.targetWords - afterWords
  const change =
    beforeWords != null && beforeWords !== afterWords
      ? `${beforeWords} → ${afterWords} 字`
      : `${afterWords} 字`
  const source = target.fromOutline ? '细纲目标' : '默认目标'
  return `去 AI 味后 ${change}，低于${source} ${target.targetWords} 字，还差 ${gap} 字——应用后可点「续写」补足。`
}

/**
 * 解析细纲字数并给出完整口径信息（是否兜底、是否被夹取、是下限还是上限）。
 * 写正文、写后自检、编辑器目标条都走这一个入口。
 */
export function resolveChapterTargetWords(raw: string | undefined): WordTargetResolution {
  const parsed = parseWordEstimate(raw)
  if (parsed === undefined) {
    return { targetWords: DEFAULT_TARGET_WORDS, fromOutline: false, bound: 'min', raw }
  }
  const targetWords = clampTargetWords(parsed)
  return {
    targetWords,
    fromOutline: true,
    clampedFrom: targetWords === parsed ? undefined : parsed,
    bound: UPPER_BOUND_RE.test(raw ?? '') ? 'about' : 'min',
    raw
  }
}
