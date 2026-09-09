/**
 * 结构均匀度检测（Gate D 的分布层）。
 *
 * 禁用词表查的是「用了什么词」，这里查的是「排得有多整齐」。
 * AI 稿最稳定的特征不在词汇而在分布：句长挤在一个窄峰里，段落长度彼此接近，
 * 对白每句都是中等长度的有效信息。人写的文本是长尾——40 字长句后面跟一个 3 字短句，
 * 一段 200 字后面跟一段 20 字，一句「嗯。」挨着一段 50 字的解释。
 *
 * 三个指标都是变异系数（CV = 总体标准差 / 均值，无量纲，不随篇幅漂移）。
 * **CV 越小越均匀、越像 AI**，方向和禁用词密度相反——密度罚「用了什么」，CV 罚「太齐」。
 * 一篇把禁用词全换干净、但每段都是「起—展—收」的稿子，密度是 0，CV 会把它抓出来。
 *
 * 样本不足时返回 null，classify 直接忽略：十来句话算出来的 CV 是噪声，不是信号。
 *
 * ⚠️ UNIFORMITY_THRESHOLDS 目前是暂定值，尚未用语料标定。
 * 往 tests/fixtures/deslop-corpus/{human,ai} 里放稿子后跑 tests/deslop-corpus.test.ts，
 * 它会打印两组的实测分布和推荐阈值，再回来改这里的常量。
 */

import { collectProseLines } from './check-ai-patterns'

/** 均匀度指标。null = 样本量不足，不参与判定。 */
export interface UniformityMetrics {
  /** 句长变异系数（越小越均匀）；句子数 < MIN_SENTENCES 时为 null */
  sentenceLengthCv: number | null
  /** 段落长度变异系数；段落数 < MIN_PARAGRAPHS 时为 null */
  paragraphLengthCv: number | null
  /** 对白单句长度变异系数；对白句数 < MIN_DIALOGUES 时为 null */
  dialogueLengthCv: number | null
}

/**
 * 判定「过于均匀」的 CV 上限。低于该值算一个均匀信号。
 * 暂定值，见文件头注释。
 */
export const UNIFORMITY_THRESHOLDS = {
  sentenceLengthCv: 0.45,
  paragraphLengthCv: 0.4,
  dialogueLengthCv: 0.45
} as const

/** 样本量下限：低于此值 CV 无意义，返回 null */
export const MIN_SENTENCES = 20
export const MIN_PARAGRAPHS = 8
export const MIN_DIALOGUES = 8

/** 断句符（句子边界） */
const SENTENCE_ENDERS = /[。！？!?]+/
/** 成对引号：中文双引号与直角引号，两种都在中文小说里出现 */
const DIALOGUE_SPANS = /“([^“”]{1,200})”|「([^「」]{1,200})」/g

/**
 * 计算整篇的三个均匀度指标。纯函数，无 IO。
 * @param input 正文文本（含 \n 换行；front matter 与代码块会被跳过）
 */
export function computeUniformity(input: string): UniformityMetrics {
  const proseLines = collectProseLines(input.split(/\r?\n/))
  const paragraphs = proseLines.map((l) => l.text.trim()).filter((t) => t.length > 0)

  const paragraphLengths = paragraphs.map(visibleLength)
  const sentenceLengths = paragraphs.flatMap(splitSentenceLengths)
  const dialogueLengths = collectDialogueLengths(paragraphs)

  return {
    sentenceLengthCv: sentenceLengths.length >= MIN_SENTENCES ? coefficientOfVariation(sentenceLengths) : null,
    paragraphLengthCv: paragraphLengths.length >= MIN_PARAGRAPHS ? coefficientOfVariation(paragraphLengths) : null,
    dialogueLengthCv: dialogueLengths.length >= MIN_DIALOGUES ? coefficientOfVariation(dialogueLengths) : null
  }
}

/**
 * 数有几项低于阈值（0-3）。null（样本不足）不计入，所以短文永远拿 0，
 * 不会因为「测不出来」被当成「很均匀」而误升档。
 */
export function countUniformSignals(m: UniformityMetrics): number {
  let n = 0
  if (m.sentenceLengthCv !== null && m.sentenceLengthCv < UNIFORMITY_THRESHOLDS.sentenceLengthCv) n++
  if (m.paragraphLengthCv !== null && m.paragraphLengthCv < UNIFORMITY_THRESHOLDS.paragraphLengthCv) n++
  if (m.dialogueLengthCv !== null && m.dialogueLengthCv < UNIFORMITY_THRESHOLDS.dialogueLengthCv) n++
  return n
}

/** 给 prompt / UI 用的人话描述；无信号时返回 null */
export function describeUniformity(m: UniformityMetrics): string | null {
  const parts: string[] = []
  if (m.sentenceLengthCv !== null && m.sentenceLengthCv < UNIFORMITY_THRESHOLDS.sentenceLengthCv) {
    parts.push(`句长过于均匀（CV ${m.sentenceLengthCv.toFixed(2)}）：长短句没有拉开，缺少长句后接短句的落差`)
  }
  if (m.paragraphLengthCv !== null && m.paragraphLengthCv < UNIFORMITY_THRESHOLDS.paragraphLengthCv) {
    parts.push(`段落长度过于均匀（CV ${m.paragraphLengthCv.toFixed(2)}）：每段都写成差不多大小的完整单元，缺少一句话独立成段的顿挫`)
  }
  if (m.dialogueLengthCv !== null && m.dialogueLengthCv < UNIFORMITY_THRESHOLDS.dialogueLengthCv) {
    parts.push(`对白长度过于均匀（CV ${m.dialogueLengthCv.toFixed(2)}）：每句台词都是中等长度的有效信息，缺少「嗯。」这类极短应答和长段独白的对比`)
  }
  return parts.length > 0 ? parts.join('；') : null
}

/* =========================================================
   内部
   ========================================================= */

/** 可见长度：去掉空白后的字符数（标点保留——标点也占节奏） */
function visibleLength(text: string): number {
  return text.replace(/\s/g, '').length
}

/** 把一段拆成句子，返回每句的可见长度（跳过空句和纯标点句） */
function splitSentenceLengths(paragraph: string): number[] {
  return paragraph
    .split(SENTENCE_ENDERS)
    .map(visibleLength)
    .filter((n) => n > 0)
}

/** 抽出所有引号内的台词长度 */
function collectDialogueLengths(paragraphs: string[]): number[] {
  const out: number[] = []
  for (const p of paragraphs) {
    const re = new RegExp(DIALOGUE_SPANS.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(p)) !== null) {
      const len = visibleLength(m[1] ?? m[2] ?? '')
      if (len > 0) out.push(len)
    }
  }
  return out
}

/** 总体变异系数。均值为 0 时返回 0（全空样本，视为无差异）。 */
export function coefficientOfVariation(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  if (mean === 0) return 0
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return Math.sqrt(variance) / mean
}
