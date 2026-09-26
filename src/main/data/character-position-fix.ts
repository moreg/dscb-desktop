/**
 * 写后自检「人物位置对应线索」的定点修补：只把人物首次出场的那一两段交给模型，
 * 让它补一句「仍在原地」或「怎么到的新地点」，再按段落下标拼回原文。
 * 其余正文一字不动，所以不必整章重写，也不会被模型顺手改掉别的段落。
 */

import type { CharacterPositionAssessment } from './chapter-self-check'
import { normalizePunctuation } from './deslop/normalize-punctuation'

/** 每段允许新增的字数上限：补衔接只需要一句话，超出就说明模型在改剧情 */
const MAX_ADDED_CHARS = 80
/** 改后长度不能低于原段的比例：防止模型删信息 */
const MIN_KEEP_RATIO = 0.7

export interface CharacterPositionFixTarget {
  name: string
  location: string
  action: string
  /** 允许修改的段落下标（content.split('\n')） */
  lines: number[]
}

/** 每个未对上的人物：可改首次出场行及其前一个非空行（场景句） */
export function pickFixTargets(
  content: string,
  assessment: CharacterPositionAssessment
): CharacterPositionFixTarget[] {
  const lines = content.split('\n')
  return assessment.uncertain.map((p) => {
    let prev = p.firstLine - 1
    while (prev >= 0 && !lines[prev].trim()) prev--
    return {
      name: p.name,
      location: p.location,
      action: p.action,
      lines: prev >= 0 ? [prev, p.firstLine] : [p.firstLine]
    }
  })
}

export function buildCharacterPositionFixPrompt(input: {
  chapterNumber: number
  content: string
  prevTail: string
  targets: CharacterPositionFixTarget[]
}): { prompt: string; allowed: number[] } {
  const lines = input.content.split('\n')
  const allowed = [...new Set(input.targets.flatMap((t) => t.lines))].sort((a, b) => a - b)
  const prompt = [
    `## 任务：补齐第 ${input.chapterNumber} 章开头的人物位置衔接`,
    '',
    '上一章结尾时，下列人物分别在某处。本章里他们首次出场的段落没有交代清楚：是仍在原地，还是已经换了地方。',
    '请只修改下面给出的段落，用最小改动补上衔接：',
    '- 如果从上下文看人物仍在原地，就在其首次出场的句子里自然点明所在地点（例如把「某某放下杯子」改成「某某还站在某地，放下杯子」）。',
    '- 如果本段情节表明人物已在别处，就补一句简短转场，交代其如何到达（例如「某某赶到某地时……」）。',
    '- 地点写进该人物自己的句子里，不要和其他人物挤在同一个逗号分句。',
    '- 不改对白内容，不改情节走向，不新增人物，不删除原有信息；每段新增不超过 40 字。',
    '- 沿用原文语气与句式，不写旁白式总结；不要用破折号和省略号。',
    '- 某段本来就交代清楚、无需改动时，可以不输出该段。',
    '',
    '## 需要补衔接的人物（上章结尾位置）',
    ...input.targets.map((t) => `- ${t.name}：在${t.location}${t.action ? `，${t.action}` : ''}`),
    '',
    '## 上一章结尾（只读参考）',
    input.prevTail.slice(-600),
    '',
    '## 本章可修改的段落（index 为段落编号）',
    ...allowed.map((i) => `[${i}] ${lines[i].trim()}`),
    '',
    '## 输出要求',
    '严格 JSON，不要解释、不要 Markdown 代码块：',
    '{ "paragraphs": [ { "index": 段落编号, "text": "修改后的整段文字" } ] }',
    'index 只能取上面列出的编号；text 是该段修改后的完整文字。'
  ].join('\n')
  return { prompt, allowed }
}

export interface CharacterPositionFixApplied {
  content: string
  /** 实际被替换的段落下标 */
  changedLines: number[]
  /** 模型给了但被校验拒掉的段落及原因 */
  rejected: { index: number; reason: string }[]
}

/**
 * 解析模型输出并拼回原文。每段都要过校验：编号合法、非空、增删幅度在阈值内。
 * 标点按项目规则确定性归一，免得修补本身又触发标点守则。
 */
export function applyCharacterPositionFix(
  content: string,
  raw: string,
  allowed: readonly number[]
): CharacterPositionFixApplied {
  const lines = content.split('\n')
  const allowedSet = new Set(allowed)
  const changedLines: number[] = []
  const rejected: { index: number; reason: string }[] = []

  for (const entry of parseParagraphs(raw)) {
    const { index } = entry
    if (!allowedSet.has(index)) {
      rejected.push({ index, reason: '段落编号不在可修改范围内' })
      continue
    }
    const original = lines[index]
    const oldText = original.trim()
    const newText = normalizePunctuation(entry.text.replace(/\s*\n\s*/g, '').trim()).text
    if (!newText) {
      rejected.push({ index, reason: '修改后为空' })
      continue
    }
    if (newText === oldText) continue
    if (newText.length > oldText.length + MAX_ADDED_CHARS) {
      rejected.push({ index, reason: '新增文字过多，疑似改动了情节' })
      continue
    }
    if (newText.length < oldText.length * MIN_KEEP_RATIO) {
      rejected.push({ index, reason: '删减过多，疑似丢失原有信息' })
      continue
    }
    const indent = original.match(/^\s*/)?.[0] ?? ''
    lines[index] = indent + newText
    changedLines.push(index)
  }

  return { content: lines.join('\n'), changedLines, rejected }
}

function parseParagraphs(raw: string): { index: number; text: string }[] {
  const body = raw.replace(/```(?:json)?/gi, '').trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const obj = JSON.parse(body.slice(start, end + 1)) as { paragraphs?: unknown }
    if (!Array.isArray(obj.paragraphs)) return []
    const seen = new Set<number>()
    const out: { index: number; text: string }[] = []
    for (const p of obj.paragraphs as { index?: unknown; text?: unknown }[]) {
      const index = typeof p?.index === 'number' ? p.index : Number(p?.index)
      if (!Number.isInteger(index) || typeof p?.text !== 'string' || seen.has(index)) continue
      seen.add(index)
      out.push({ index, text: p.text })
    }
    return out
  } catch {
    return []
  }
}
