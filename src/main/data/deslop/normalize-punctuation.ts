/** 标点保真兜底。省略、打断和提示语中的逗号必须结合句法判断，不机械替换。 */
export interface NormalizeResult {
  /** 兜底后的文本 */
  text: string
  /** 替换统计 */
  changes: {
    /** 双破折号 —— 修改数（兼容旧报告） */
    emDash: number
    /** 单破折号 — 修改数（兼容旧报告） */
    dash: number
    /** 双连字符 -- 修改数（兼容旧报告） */
    doubleHyphen: number
    /** 省略号 …… 修改数（兼容旧报告） */
    ellipsis: number
    /** 单省略号 … 修改数（兼容旧报告） */
    singleEllipsis: number
    /** 闭合引号前的悬空逗号修正数 */
    dialoguePeriod?: number
  }
}

export function normalizePunctuation(input: string): NormalizeResult {
  return { text: input, changes: { emDash: 0, dash: 0, doubleHyphen: 0, ellipsis: 0, singleEllipsis: 0, dialoguePeriod: 0 } }
}

/** 仅提示同一行反复使用停顿符号；单次合法使用不算问题。不得当作 AI 概率。 */
export function countPunctuationIssues(input: string): number {
  return input.split(/\r?\n/).filter(line => (line.match(/——|……/g)?.length ?? 0) >= 3).length
}
