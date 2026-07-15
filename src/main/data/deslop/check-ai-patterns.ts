/**
 * 去 AI 味模式检测（移植自 oh-story-claudecode check-ai-patterns.js）。
 *
 * 纯函数，无 IO。检测 4 类高风险 AI 散文模式：
 * - not-is-comparison「不是A，而是B」（★★★★★ 最毒，blocking）
 * - em-dash 破折号（blocking，按功能改写非机械替换）
 * - period-stutter 碎句号（advisory，连续短叙述句）
 * - long-paragraph 长段落（advisory，按镜头断段）
 *
 * 另整合 banned-words 的 Gate A 句式扫描（toxic patterns + 禁用词）。
 * 算法与原脚本一致，确保检测行为可溯源。
 */

import type { DeslopFinding, DeslopGate, DeslopSeverity } from '../../../shared/types'
import { TOXIC_PATTERNS, FLATTENED_LEVEL1, PARALLELISM_PATTERNS, SUBLIMATION_PATTERNS, PSYCH_TELL_PATTERNS } from './banned-words'

const STOP_CHARS = new Set(['。', '！', '？', '!', '?', '\n'])
const SOFT_SEPARATORS = new Set(['，', ',', '、', '；', ';', '：', ':'])
const HARD_SEPARATORS = new Set(['。', '.', '！', '!', '？', '?'])
const MAX_NEGATIVE_SPAN = 80
const MAX_POSITIVE_SPAN = 80

// 碎句号：连续 STUTTER_MIN_RUN 个叙述短句（每句可见字数 ≤ STUTTER_MAX_SENTENCE）
const STUTTER_MIN_RUN = 6
const STUTTER_MAX_SENTENCE = 5
// 长段落阈值
const LONG_PARAGRAPH_CHARS = 200

// 「不是A就是B / 不是A也是B」里紧贴「是」是连词
const COMPACT_EITHER_OR_PREV = new Set(['不', '就', '也'])
// 句尾语气/反问助词（是吗/是吧/是嘛 是反问尾巴）
const TAG_PARTICLES = new Set(['吗', '吧', '嘛'])

export interface ScanOptions {
  /** 项目级白名单（豁免词，命中不报） */
  whitelist?: Set<string>
  /** 用户配置的禁用词表（覆盖内置 FLATTENED_LEVEL1）；缺省 = 用内置默认 */
  bannedWords?: string[]
}

/**
 * 扫描整篇文档，返回全部 finding。
 * @param input 正文文本（含 \n 换行）
 */
export function scanAiPatterns(input: string, opts: ScanOptions = {}): DeslopFinding[] {
  const findings: DeslopFinding[] = []
  const lines = input.split(/\r?\n/)

  // 过滤 front matter / 代码块，收集正文行
  const proseLines = collectProseLines(lines)

  // 1. not-is-comparison（跨行块扫描）
  findings.push(...scanNotIsComparison(proseLines))

  // 2. 逐行段落检测：em-dash / long-paragraph / period-stutter
  findings.push(...scanProsePatterns(proseLines))

  // 3. Gate A 句式：toxic patterns
  findings.push(...scanToxicPatterns(proseLines))

  // 4. Gate A 禁用词（用户配置优先，否则内置默认）
  findings.push(...scanBannedWords(proseLines, opts.bannedWords ?? FLATTENED_LEVEL1, opts.whitelist))

  // 5. Gate B 排比
  findings.push(...scanParallelism(proseLines))

  // 6. Gate F 结尾升华（章末段落降级 blocking）
  findings.push(...scanSublimation(proseLines))

  // 7. Gate C 心理描写外化（告诉而非展示）
  findings.push(...scanPsychTell(proseLines))

  // 8. Gate E 对话标签单一化
  findings.push(...scanDialogueTags(proseLines))

  findings.sort((a, b) => a.line - b.line || a.column - b.column)
  return findings
}

/* =========================================================
   正文行收集（跳过 front matter / 代码块 / 空行）
   ========================================================= */

interface ProseLine {
  text: string
  lineNo: number
}

function collectProseLines(lines: string[]): ProseLine[] {
  const out: ProseLine[] = []
  let fence: { char: string; length: number } | null = null
  let inFrontMatter = hasYamlFrontMatter(lines)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (inFrontMatter) {
      if (i > 0 && trimmed === '---') inFrontMatter = false
      continue
    }

    const fenceMarker = parseFenceMarker(trimmed)
    if (fence) {
      if (fenceMarker && fenceMarker.char === fence.char && fenceMarker.length >= fence.length) {
        fence = null
      }
      continue
    }
    if (fenceMarker) {
      fence = fenceMarker
      continue
    }

    out.push({ text: line, lineNo: i + 1 })
  }
  return out
}

function parseFenceMarker(trimmedLine: string): { char: string; length: number } | null {
  const match = /^(?:`{3,}|~{3,})/.exec(trimmedLine)
  if (!match) return null
  return { char: match[0][0], length: match[0].length }
}

function hasYamlFrontMatter(lines: string[]): boolean {
  if (!lines[0] || lines[0].trim() !== '---') return false
  let sawYamlField = false
  for (let i = 1; i < Math.min(lines.length, 40); i++) {
    const trimmed = lines[i].trim()
    if (trimmed === '---') return sawYamlField
    if (/^[A-Za-z0-9_-]+:\s*/.test(trimmed)) sawYamlField = true
  }
  return false
}

/* =========================================================
   not-is-comparison「不是A，而是B」（精确算法移植）
   ========================================================= */

function scanNotIsComparison(proseLines: ProseLine[]): DeslopFinding[] {
  const findings: DeslopFinding[] = []
  const text = proseLines.map((l) => l.text).join('\n')
  const lineStarts = computeLineStarts(proseLines)

  let offset = 0
  while (offset < text.length) {
    const start = text.indexOf('不是', offset)
    if (start === -1) break

    // 跳过「是不是」
    if (start > 0 && text[start - 1] === '是') {
      offset = start + 2
      continue
    }

    const candidate = text.slice(start)
    const markerEnd = findPositiveFlipEnd(candidate)

    if (markerEnd === -1) {
      offset = start + 2
      continue
    }

    const raw = trimTrailingNoise(extractFinding(candidate, markerEnd))
    if (raw.length >= 4) {
      const pos = positionForOffset(lineStarts, start)
      findings.push({
        line: pos.line,
        column: pos.column,
        type: 'not-is-comparison',
        severity: 'blocking' as DeslopSeverity,
        gate: 'B',
        message: '高频 AI 对比句式「不是A，而是B」；删掉否定铺垫，直接写后项，或改成动作/细节呈现。',
        excerpt: compact(raw)
      })
    }

    offset = start + Math.max(raw.length, 2)
  }
  return findings
}

function findPositiveFlipEnd(candidate: string): number {
  let index = 2
  let scanned = 0
  let crossedSeparator = false

  while (index < candidate.length && scanned <= MAX_NEGATIVE_SPAN) {
    const char = candidate[index]

    if (startsWithAt(candidate, index, '而是')) return index + 2

    if (SOFT_SEPARATORS.has(char)) {
      const next = skipGap(candidate, index + 1)
      if (startsWithAt(candidate, next, '而是')) return next + 2
      if (candidate[next] === '是' && !TAG_PARTICLES.has(candidate[next + 1])) return next + 1
      crossedSeparator = true
    }

    if (HARD_SEPARATORS.has(char)) {
      const next = skipGap(candidate, index + 1)
      if (candidate[next] === '是' && !TAG_PARTICLES.has(candidate[next + 1])) return next + 1
      if (char !== '.') break
      crossedSeparator = true
    }

    if (STOP_CHARS.has(char)) break

    if (char === '是' && !COMPACT_EITHER_OR_PREV.has(candidate[index - 1]) && !crossedSeparator) {
      return index + 1
    }

    index += 1
    scanned += 1
  }
  return -1
}

function extractFinding(candidate: string, markerEnd: number): string {
  let end = markerEnd
  const limit = Math.min(candidate.length, markerEnd + MAX_POSITIVE_SPAN)
  while (end < limit) {
    if (STOP_CHARS.has(candidate[end])) break
    end += 1
  }
  return candidate.slice(0, end)
}

function computeLineStarts(proseLines: ProseLine[]): { offset: number; lineNo: number }[] {
  const starts: { offset: number; lineNo: number }[] = []
  let cursor = 0
  for (const entry of proseLines) {
    starts.push({ offset: cursor, lineNo: entry.lineNo })
    cursor += entry.text.length + 1
  }
  return starts
}

function positionForOffset(
  lineStarts: { offset: number; lineNo: number }[],
  offset: number
): { line: number; column: number } {
  let low = 0
  let high = lineStarts.length - 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const current = lineStarts[mid]
    const next = lineStarts[mid + 1]
    if (offset < current.offset) {
      high = mid - 1
    } else if (next && offset >= next.offset) {
      low = mid + 1
    } else {
      return { line: current.lineNo, column: offset - current.offset + 1 }
    }
  }
  return { line: lineStarts[0].lineNo, column: 1 }
}

/* =========================================================
   段落检测：em-dash / long-paragraph / period-stutter
   ========================================================= */

function scanProsePatterns(proseLines: ProseLine[]): DeslopFinding[] {
  const findings: DeslopFinding[] = []

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim()
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue

    // em-dash（破折号，blocking）
    const dashRe = /——|—|--+/g
    let dash: RegExpExecArray | null
    while ((dash = dashRe.exec(text)) !== null) {
      findings.push({
        line: lineNo,
        column: dash.index + 1,
        type: 'em-dash',
        severity: 'blocking',
        gate: 'D',
        message: '破折号按功能改写：打断→动作 beat/短句，拖长音→省略或动作，插入说明→逗号/冒号；勿一律改句号。',
        excerpt: compact(text.slice(Math.max(0, dash.index - 8), dash.index + dash[0].length + 8))
      })
    }

    // long-paragraph（advisory）
    if (trimmed.length > LONG_PARAGRAPH_CHARS) {
      findings.push({
        line: lineNo,
        column: 1,
        type: 'long-paragraph',
        severity: 'advisory',
        gate: 'D',
        message: `段落过长（${trimmed.length} 字）：按镜头/新动作/新线索/视线切换断段，别一段到底。`,
        excerpt: compact(trimmed.slice(0, 40))
      })
    }
  }

  // period-stutter（碎句号，advisory）
  findings.push(...findPeriodStutter(proseLines))
  return findings
}

function findPeriodStutter(proseLines: ProseLine[]): DeslopFinding[] {
  const findings: DeslopFinding[] = []
  let runLen = 0
  let runStartLine: number | null = null
  const runSample: string[] = []

  const flush = (): void => {
    if (runLen >= STUTTER_MIN_RUN && runStartLine !== null) {
      findings.push({
        line: runStartLine,
        column: 1,
        type: 'period-stutter',
        severity: 'advisory',
        gate: 'D',
        message: `碎句号：连续 ${runLen} 个短句无呼吸；按目标句长把碎句合并成中长句、补回画面与连接。`,
        excerpt: compact(runSample.join(' '))
      })
    }
    runLen = 0
    runStartLine = null
    runSample.length = 0
  }

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim()
    if (!trimmed) continue
    if (isDivider(trimmed) || isStructural(trimmed)) {
      flush()
      continue
    }
    const narrative = stripQuoted(trimmed)
    if (visibleLength(narrative) === 0) {
      flush()
      continue
    }
    for (const sentence of splitSentences(narrative)) {
      if (visibleLength(sentence) <= STUTTER_MAX_SENTENCE) {
        if (runLen === 0) runStartLine = lineNo
        runLen += 1
        if (runSample.length < 6) runSample.push(sentence)
      } else {
        flush()
      }
    }
  }
  flush()
  return findings
}

/* =========================================================
   Gate A 句式：toxic patterns + 禁用词 + 排比
   ========================================================= */

function scanToxicPatterns(proseLines: ProseLine[]): DeslopFinding[] {
  const findings: DeslopFinding[] = []
  for (const { text, lineNo } of proseLines) {
    for (const pattern of TOXIC_PATTERNS) {
      const re = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : pattern.re.flags + 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        findings.push({
          line: lineNo,
          column: m.index + 1,
          type: pattern.id,
          severity: pattern.stars >= 4 ? 'blocking' : 'advisory',
          gate: 'A',
          message: `${pattern.name}（${'★'.repeat(pattern.stars)}）：${pattern.fix}`,
          excerpt: compact(m[0]),
          word: m[0]
        })
      }
    }
  }
  return findings
}

function scanBannedWords(
  proseLines: ProseLine[],
  bannedWords: string[],
  whitelist?: Set<string>
): DeslopFinding[] {
  const findings: DeslopFinding[] = []
  const words = bannedWords.filter((w) => !whitelist?.has(w))
  for (const { text, lineNo } of proseLines) {
    for (const word of words) {
      let idx = text.indexOf(word)
      while (idx !== -1) {
        findings.push({
          line: lineNo,
          column: idx + 1,
          type: 'banned-word',
          severity: 'advisory',
          gate: 'A',
          message: `禁用词「${word}」：出现即替换为具体动作/白描。`,
          excerpt: compact(text.slice(Math.max(0, idx - 8), idx + word.length + 8)),
          word
        })
        idx = text.indexOf(word, idx + word.length)
      }
    }
  }
  return findings
}

function scanParallelism(proseLines: ProseLine[]): DeslopFinding[] {
  const findings: DeslopFinding[] = []
  for (const { text, lineNo } of proseLines) {
    for (const re of PARALLELISM_PATTERNS) {
      const globalRe = new RegExp(re.source, 'g')
      let m: RegExpExecArray | null
      while ((m = globalRe.exec(text)) !== null) {
        findings.push({
          line: lineNo,
          column: m.index + 1,
          type: 'parallelism',
          severity: 'advisory',
          gate: 'B',
          message: 'AI 排比套路：保留最强一条，删掉其余同结构句。',
          excerpt: compact(m[0])
        })
      }
    }
  }
  return findings
}

/* =========================================================
   Gate F：结尾升华句式
   ========================================================= */

/**
 * 扫描升华句式（"他终于明白""这一刻，""这就是X的意义"等）。
 * 章末段落（最后 2 行）命中降级为 blocking--升华句在结尾最有害。
 */
function scanSublimation(proseLines: ProseLine[]): DeslopFinding[] {
  if (proseLines.length === 0) return []
  const findings: DeslopFinding[] = []
  // 章末 = 最后 2 个非空正文行
  const lastLineNo = proseLines[proseLines.length - 1].lineNo
  const secondLastLineNo = proseLines.length > 1 ? proseLines[proseLines.length - 2].lineNo : lastLineNo

  for (const { text, lineNo } of proseLines) {
    for (const re of SUBLIMATION_PATTERNS) {
      const globalRe = new RegExp(re.source, 'g')
      let m: RegExpExecArray | null
      while ((m = globalRe.exec(text)) !== null) {
        const isEnding = lineNo >= secondLastLineNo
        findings.push({
          line: lineNo,
          column: m.index + 1,
          type: 'sublimation',
          severity: isEnding ? 'blocking' : 'advisory',
          gate: 'F',
          message: isEnding
            ? '章末升华句：删掉总结/预告，改用具体钩子物件/事件收束。'
            : '升华句式：删掉作者总结，让读者自己体会。',
          excerpt: compact(m[0])
        })
      }
    }
  }
  return findings
}

/* =========================================================
   Gate C：心理描写外化（告诉而非展示）
   ========================================================= */

/**
 * 扫描"告诉而非展示"的心理描写（"他感到愤怒""她觉得自己很累""他心想"）。
 * 只报直接贴情绪标签的写法；"心中一凛"这类已带身体反应的由 Gate A 扫描。
 */
function scanPsychTell(proseLines: ProseLine[]): DeslopFinding[] {
  const findings: DeslopFinding[] = []
  for (const { text, lineNo } of proseLines) {
    for (const re of PSYCH_TELL_PATTERNS) {
      const globalRe = new RegExp(re.source, 'g')
      let m: RegExpExecArray | null
      while ((m = globalRe.exec(text)) !== null) {
        findings.push({
          line: lineNo,
          column: m.index + 1,
          type: 'psych-tell',
          severity: 'advisory',
          gate: 'C',
          message: '心理描写直接贴标签（告诉而非展示）：用动作/身体反应/可见反应代替（如"攥紧拳头""呼吸压低"）。',
          excerpt: compact(m[0])
        })
      }
    }
  }
  return findings
}

/* =========================================================
   Gate E：对话标签单一化
   ========================================================= */

// 对话标签"他说道/她问道/他笑道"等（代词 + 动词 + 道）
// 只匹配明确的对话标签词，避免误匹配"这道题""他说了话"等非标签用法
const DIALOGUE_TAG_RE = /[他她](说道|问道|喊道|笑道|答道|骂道|低声道|轻声道|淡淡道|冷冷道|平静道)/

/**
 * 扫描对话标签单一化：连续 3+ 个对话行都用"X道/说道/问道"类标签。
 * 命中后整组报一条 finding，指向第一个单调标签所在行。
 */
function scanDialogueTags(proseLines: ProseLine[]): DeslopFinding[] {
  const findings: DeslopFinding[] = []
  let runStart: { lineNo: number; column: number; excerpt: string } | null = null
  let runLen = 0

  const flush = (): void => {
    if (runLen >= 3 && runStart) {
      findings.push({
        line: runStart.lineNo,
        column: runStart.column,
        type: 'dialogue-tag-monotone',
        severity: 'advisory',
        gate: 'E',
        message: `对话标签单一化：连续 ${runLen} 个对话行都用"X道"类标签；改用动作替代标签、省略标签，或区分角色语气。`,
        excerpt: runStart.excerpt
      })
    }
    runStart = null
    runLen = 0
  }

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim()
    if (!trimmed) {
      flush()
      continue
    }
    // 只看含引号的对话行
    if (!/[""「」''']/.test(trimmed)) {
      flush()
      continue
    }
    const m = DIALOGUE_TAG_RE.exec(trimmed)
    if (m) {
      if (runLen === 0) {
        runStart = { lineNo, column: m.index + 1, excerpt: compact(m[0]) }
      }
      runLen += 1
    } else {
      flush()
    }
  }
  flush()
  return findings
}

/* =========================================================
   通用辅助（与原脚本一致）
   ========================================================= */

function isDivider(trimmed: string): boolean {
  return /^-{3,}$/.test(trimmed) || /^[*_]{3,}$/.test(trimmed)
}

function isStructural(trimmed: string): boolean {
  return /^(#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|\|)/.test(trimmed)
}

function stripQuoted(text: string): string {
  return text
    .replace(/「[^」]*」/g, '')
    .replace(/『[^』]*』/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/“[^”]*”/g, '')
    .replace(/‘[^’]*’/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/'[^']*'/g, '')
}

function splitSentences(trimmed: string): string[] {
  return trimmed
    .split(/[。！？!?]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function visibleLength(sentence: string): number {
  const m = sentence.match(/[一-鿿Ａ-ｚA-Za-z0-9]/g)
  return m ? m.length : 0
}

function startsWithAt(text: string, index: number, needle: string): boolean {
  return text.slice(index, index + needle.length) === needle
}

function skipGap(text: string, index: number): number {
  while (index < text.length && isInlineSpace(text[index])) index += 1
  if (text[index] === '\n') {
    index += 1
    while (index < text.length && isInlineSpace(text[index])) index += 1
  }
  return index
}

function isInlineSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r'
}

function trimTrailingNoise(text: string): string {
  return text.replace(/[\s|）)】\]]+$/u, '')
}

export function compact(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized
}
