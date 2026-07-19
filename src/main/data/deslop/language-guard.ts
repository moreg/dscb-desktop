/**
 * 去 AI 味语言守卫：拦截把中文正文改成英文（或混入英文代词/整句翻译）的改写。
 *
 * 典型故障（模型越权翻译）：
 * - 「他」→「He」
 * - 「（直接 说 吧，）」→「(Just say it.)」
 * - 整段中文对话被译成英文
 *
 * 策略：以空行/行切段对齐后，对「原文偏中文、改后新增大量拉丁字母」的段回退原文。
 */

import { splitUnits } from '../../../shared/text-diff'

/** 连续拉丁字母词（含撇号，如 don't） */
const LATIN_WORD_RE = /[A-Za-z][A-Za-z']*/g

/** CJK 统一汉字 + 扩展 A 常见区 */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g

/** 英文人称/系动词泄漏：中文小说改写里几乎不该凭空出现（他→He 最常见） */
const EN_PRONOUN_LEAK =
  /\b(He|She|They|We|You|Him|Her|His|Their|Me|My|Your|I'm|He's|She's|It's|Don't|Just)\b/

export function countLatinWords(text: string): number {
  return (text.match(LATIN_WORD_RE) ?? []).length
}

export function countCjkChars(text: string): number {
  return (text.match(CJK_RE) ?? []).length
}

/** 是否像以中文为主的段落（汉字显著多于拉丁词） */
export function isPrimarilyChinese(text: string): boolean {
  const cjk = countCjkChars(text)
  const latin = countLatinWords(text)
  if (cjk === 0) return false
  // 允许少量英文专名/型号；汉字主导即可
  return cjk >= 2 && cjk >= latin * 2
}

/**
 * 检测改写段是否「相对原文」引入了不该有的英文。
 * - 原文是中文主导
 * - 改后拉丁词明显增多，或出现英文人称词泄漏
 */
export function unitHasLanguageLeak(original: string, rewritten: string): boolean {
  if (!original || original === rewritten) return false
  if (!isPrimarilyChinese(original)) return false

  const oLatin = countLatinWords(original)
  const rLatin = countLatinWords(rewritten)
  const oCjk = countCjkChars(original)
  const rCjk = countCjkChars(rewritten)

  // 人称代词等单点泄漏：他→He
  if (rLatin > oLatin && EN_PRONOUN_LEAK.test(rewritten) && !EN_PRONOUN_LEAK.test(original)) {
    return true
  }

  // 拉丁词从 0 变多，或增幅 ≥ 2 且汉字没跟着大幅减少到「整段变英文」
  if (oLatin === 0 && rLatin >= 1) return true
  if (rLatin >= oLatin + 2) return true

  // 汉字大幅消失 + 拉丁词上升 = 疑似整段翻译
  if (oCjk >= 4 && rCjk < oCjk * 0.5 && rLatin > oLatin) return true

  return false
}

export interface LanguageGuardResult {
  text: string
  /** 因语言泄漏回退的段数 */
  revertedUnits: number
  /** 简要说明，供日志/changeSummary */
  notes: string[]
}

/**
 * 对齐原文与改写，回退发生语言泄漏的段；结构无法对齐时若全文泄漏则整篇回退。
 */
export function guardLanguageLeak(original: string, rewritten: string): LanguageGuardResult {
  if (!original || original === rewritten) {
    return { text: rewritten, revertedUnits: 0, notes: [] }
  }

  // 全文级：原文中文主导，改后拉丁词暴涨
  if (isPrimarilyChinese(original)) {
    const oL = countLatinWords(original)
    const rL = countLatinWords(rewritten)
    if (oL === 0 && rL >= 8) {
      return {
        text: original,
        revertedUnits: 1,
        notes: ['- 语言守卫｜改写后出现大量英文，已整篇回退原文']
      }
    }
    if (rL >= oL + 12 && countCjkChars(rewritten) < countCjkChars(original) * 0.7) {
      return {
        text: original,
        revertedUnits: 1,
        notes: ['- 语言守卫｜改写疑似整篇英译，已整篇回退原文']
      }
    }
  }

  const beforeUnits = splitUnits(original)
  const afterUnits = splitUnits(rewritten)

  // 段数一致时按位对齐（改味通常不拆合段）
  if (beforeUnits.length === afterUnits.length && beforeUnits.length > 0) {
    let reverted = 0
    const notes: string[] = []
    const fixed = afterUnits.map((u, i) => {
      if (unitHasLanguageLeak(beforeUnits[i], u)) {
        reverted++
        const clip = beforeUnits[i].replace(/\s+/g, ' ').slice(0, 24)
        notes.push(`- 语言守卫｜第${i + 1}段回退（疑似改成英文）：${clip}${beforeUnits[i].length > 24 ? '…' : ''}`)
        return beforeUnits[i]
      }
      return u
    })
    if (reverted === 0) {
      return { text: rewritten, revertedUnits: 0, notes: [] }
    }
    // 尽量保留原文换行结构：用改写的分隔风格重拼
    const joiner = rewritten.includes('\n\n') ? '\n\n' : '\n'
    return { text: fixed.join(joiner), revertedUnits: reverted, notes }
  }

  // 段数不一致：扫改写全文是否新增了大量拉丁词（相对原文集合）
  if (isPrimarilyChinese(original) && countLatinWords(rewritten) > countLatinWords(original) + 3) {
    // 尝试按行对齐的 LCS 成本高；保守：若泄漏词很多则回退全文
    const extra = countLatinWords(rewritten) - countLatinWords(original)
    if (extra >= 3) {
      return {
        text: original,
        revertedUnits: 1,
        notes: [`- 语言守卫｜改写结构变化且新增 ${extra} 个英文词，已回退原文（请重试）`]
      }
    }
  }

  return { text: rewritten, revertedUnits: 0, notes: [] }
}
