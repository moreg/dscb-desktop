/**
 * 模型退化检测（移植自 oh-story-claudecode check-degeneration.js）。
 *
 * 检测弱模型无法自报的退化指纹：
 * - repetition 复读/打转（长句重复 ≥3 次 / 紧邻整行重复）
 * - truncation 截断（文件无终止标点结尾）
 * - placeholder 占位符/拒绝语/乱码（作为AI / 我无法继续 / 此处省略）
 * - meta-leak 工程词泄漏（细纲/情节点/本章/下一章 漏进正文）
 *
 * 通俗网文刻意用排比/复沓/弹幕刷屏，短句和对话重复豁免。
 */

import type { DeslopFinding } from '../../../shared/types'
import { compact } from './check-ai-patterns'

const REPEAT_MIN_LEN = 12
const REPEAT_MIN_COUNT = 3
const ADJACENT_MIN_LEN = 8

interface PlaceholderPattern {
  re: RegExp
  label: string
  hard: boolean
}

const PLACEHOLDER_PATTERNS: PlaceholderPattern[] = [
  {
    re: /作为(一个)?(AI|人工智能|大?语言模型|智能助手|聊天助手)(?=[，,。、；;：:！!？?\s）)」』"】]|我|无法|不能|没法|$)/,
    label: '元信息泄漏（AI 自指）',
    hard: false
  },
  { re: /[\uFFFD]/, label: '乱码（替换字符）', hard: true },
  { re: /^(Sure|Certainly|Here'?s|As an AI|I (?:cannot|can't|am unable|apologize))/m, label: '元信息泄漏（英文 AI 腔）', hard: true },
  { re: /[（(](此处|以下|这里|下文|后续)?\s*(省略|略)(去|过)?[^）)]{0,10}[）)]/, label: '占位符（括号省略）', hard: true },
  { re: /(未完待续|TODO|占位符|placeholder)/, label: '占位符', hard: true },
  {
    re: /我(无法|不能)(继续(写|创作|生成|下去)|生成(内容|文本|正文)?|创作|续写|完成(这个|本)?(章|篇|创作|请求))/,
    label: '元信息泄漏（生成拒绝语）',
    hard: false
  }
]

const META_TIER1_RE = /细纲|情节点|卷纲|功能标签|目标情绪|字数目标|章首钩子|章尾钩子/
const META_TIER2_RE = /第[一二三四五六七八九十百千万两0-9]+章|本章|这一章|上一章|下一章|上章|下章|前一章|后一章|前文|后文|伏笔|读者|任务描述/

interface ContentLine {
  text: string
  trimmed: string
  lineNo: number
}

export function scanDegeneration(input: string): DeslopFinding[] {
  const lines = input.split(/\r?\n/)
  const content = collectContent(lines)
  const findings: DeslopFinding[] = []
  findings.push(...findRepetition(content))
  findings.push(...findTruncation(content))
  findings.push(...findPlaceholders(content))
  findings.push(...findMetaLeak(content))
  findings.sort((a, b) => a.line - b.line || a.column - b.column)
  return findings
}

function collectContent(lines: string[]): ContentLine[] {
  const out: ContentLine[] = []
  let fence: string | null = null
  let inFrontMatter = hasYamlFrontMatter(lines)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (inFrontMatter) {
      if (i > 0 && trimmed === '---') inFrontMatter = false
      continue
    }
    const fenceMarker = /^(?:`{3,}|~{3,})/.exec(trimmed)
    if (fence) {
      if (fenceMarker && trimmed[0] === fence) fence = null
      continue
    }
    if (fenceMarker) {
      fence = trimmed[0]
      continue
    }
    out.push({ text: line, trimmed, lineNo: i + 1 })
  }
  return out
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

function isContent(trimmed: string): boolean {
  return !!trimmed && !trimmed.startsWith('#') && !/^-{3,}$/.test(trimmed)
}

function isDialogueLike(trimmed: string): boolean {
  return /["“”‘’「」『』【】]/.test(trimmed)
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

function visibleLength(text: string): number {
  const m = text.match(/[一-鿿Ａ-ｚA-Za-z0-9]/g)
  return m ? m.length : 0
}

/* ----- 复读检测 ----- */
function findRepetition(content: ContentLine[]): DeslopFinding[] {
  const findings: DeslopFinding[] = []
  const body = content.filter((c) => isContent(c.trimmed))

  // (1) 紧邻整行重复
  for (let i = 1; i < body.length; i++) {
    if (
      body[i].trimmed === body[i - 1].trimmed &&
      visibleLength(stripQuoted(body[i].trimmed)) >= ADJACENT_MIN_LEN
    ) {
      findings.push({
        line: body[i].lineNo,
        column: 1,
        type: 'repetition',
        severity: 'blocking',
        gate: 'D',
        message: '即时复读：紧邻两行完全相同，重写本段。',
        excerpt: compact(body[i].trimmed.slice(0, 40))
      })
    }
  }

  // (2) 长句重复 ≥3 次（打转）
  const counts = new Map<string, { count: number; firstLine: number }>()
  for (const c of body) {
    for (const sentence of c.trimmed.split(/[。！？!?]/)) {
      const s = sentence.trim()
      if (visibleLength(stripQuoted(s)) < REPEAT_MIN_LEN) continue
      const existing = counts.get(s)
      if (existing) {
        existing.count += 1
      } else {
        counts.set(s, { count: 1, firstLine: c.lineNo })
      }
    }
  }
  for (const [sentence, info] of counts) {
    if (info.count >= REPEAT_MIN_COUNT) {
      findings.push({
        line: info.firstLine,
        column: 1,
        type: 'repetition',
        severity: 'blocking',
        gate: 'D',
        message: `打转复读：长句重复 ${info.count} 次，重写避免雷同。`,
        excerpt: compact(sentence.slice(0, 40))
      })
    }
  }
  return findings
}

/* ----- 截断检测 ----- */
function findTruncation(content: ContentLine[]): DeslopFinding[] {
  const findings: DeslopFinding[] = []
  // 从末尾往前找最后一个非空内容行
  for (let i = content.length - 1; i >= 0; i--) {
    const c = content[i]
    if (!isContent(c.trimmed)) continue
    const last = c.trimmed
    // 正常结尾：句号/感叹号/问号/引号闭合
    if (/[。！？!?"'」』）)】]$/.test(last)) return findings
    findings.push({
      line: c.lineNo,
      column: last.length,
      type: 'truncation',
      severity: 'blocking',
      gate: 'D',
      message: '疑似截断：正文末尾无终止标点，可能是模型输出被截断，请补全。',
      excerpt: compact(last.slice(-30))
    })
    return findings
  }
  return findings
}

/* ----- 占位符/拒绝语检测 ----- */
function findPlaceholders(content: ContentLine[]): DeslopFinding[] {
  const findings: DeslopFinding[] = []
  for (const c of content) {
    if (!isContent(c.trimmed)) continue
    const isDialogue = isDialogueLike(c.trimmed)
    for (const pattern of PLACEHOLDER_PATTERNS) {
      // soft 类（作为AI / 我无法）在对话行豁免（系统流/AI 伴侣题材的合法台词）
      if (!pattern.hard && isDialogue) continue
      const re = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : pattern.re.flags + 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(c.text)) !== null) {
        findings.push({
          line: c.lineNo,
          column: m.index + 1,
          type: 'placeholder',
          severity: pattern.hard ? 'blocking' : 'advisory',
          gate: 'G',
          message: pattern.label + '：正文里不合法，重写本句。',
          excerpt: compact(m[0])
        })
      }
    }
  }
  return findings
}

/* ----- 工程词泄漏检测 ----- */
function findMetaLeak(content: ContentLine[]): DeslopFinding[] {
  const findings: DeslopFinding[] = []
  for (const c of content) {
    if (!isContent(c.trimmed)) continue
    // tier1（纯写作流水线术语，正文永不合法）
    let m: RegExpExecArray | null
    const tier1Re = new RegExp(META_TIER1_RE.source, 'g')
    while ((m = tier1Re.exec(c.text)) !== null) {
      findings.push({
        line: c.lineNo,
        column: m.index + 1,
        type: 'meta-leak',
        severity: 'blocking',
        gate: 'G',
        message: `工程词泄漏「${m[0]}」：写作流水线术语漏进正文，重写。`,
        excerpt: compact(m[0])
      })
    }
    // tier2（章节结构/歧义词，report-only）
    const isDialogue = isDialogueLike(c.trimmed)
    if (isDialogue) continue
    const tier2Re = new RegExp(META_TIER2_RE.source, 'g')
    while ((m = tier2Re.exec(c.text)) !== null) {
      findings.push({
        line: c.lineNo,
        column: m.index + 1,
        type: 'meta-leak',
        severity: 'advisory',
        gate: 'G',
        message: `疑似工程词「${m[0]}」：可能是元信息泄漏，人工确认。`,
        excerpt: compact(m[0])
      })
    }
  }
  return findings
}
