/**
 * 结构体检：去 AI 味的第二层判据。
 *
 * 第一层（check-ai-patterns + check-uniformity）查的是词和分布，都能用纯函数算。
 * 这一层查的是词表和 CV 都够不着的部分——人物有没有认知盲区、细节是不是全都有用、
 * 对白会不会答非所问。这些要读懂上下文才能判，只能交给模型。
 *
 * **判定比改写容易，所以这里只判不改。** 而且必须只判不改：deslop 改写器的铁律是
 * 「只改怎么说，不改说什么」，而这五条恰恰要改说什么（补一处人物判断错的地方、
 * 加一个和情节无关的细节）。让改写器去修，等于授权它动情节。所以结构体检出的是
 * 诊断清单，交给作者自己动笔。
 */

import type { DeslopStructureDimension, DeslopStructureFinding } from '../../../../shared/types'

/** 维度定义：id → 中文名 + 判定要点。同时用作 prompt 的问题清单和解析时的合法值表。 */
export const STRUCTURE_DIMENSIONS: {
  id: DeslopStructureDimension
  name: string
  question: string
}[] = [
  {
    id: 'fake-obstacle',
    name: '阻力虚张声势（假危机）',
    question:
      '是否存在危机气氛渲染极其凶险（声势滔天/必死无疑），但实际化解过程却极其儿戏（一招秒杀/对方一秒认怂/巧合解围）？真实爽文需要有实质的推拉抗阻与代价博弈，不能高高举起、轻轻放下。'
  },
  {
    id: 'npc-explainer',
    name: '配角/反派交底说明书',
    question:
      '配角或反派的台词是否沦为了作者的世界观传声筒？是否在向主角刻意科普境界背景，或在对峙中滔滔不绝自报动机与底牌，缺乏角色自身的算计与防备？'
  },
  {
    id: 'unfounded-emotion-leap',
    name: '情绪断层与无因顿悟',
    question:
      '人物的心态、立场或情绪剧变前，是否缺乏具体的外部物理事件刺激或代价交换？是否前一秒惊恐/绝望，仅凭一段内心独白就突然释怀、看透或瞬间冷酷？'
  },
  {
    id: 'equal-length-cadence',
    name: '段落等长与呼吸感缺失',
    question:
      '各情节小节的叙述篇幅是否过度均匀对称？核心高潮打脸是否被压缩得和平铺直叙一样短促，缺乏慢镜头特写与极短句爆发的长短错落？'
  },
  {
    id: 'cognitive-blindspot',
    name: '全知视角与缺乏认知偏差',
    question:
      '角色是否知晓了他身处环境中本不该知道的信息？配角行动是否全在精准预判配合主角的心思，毫无基于自身立场的偏见、私心与信息盲区？'
  }
]

const VALID_DIMENSIONS = new Set<string>([
  ...STRUCTURE_DIMENSIONS.map((d) => d.id),
  'all-purpose-detail',
  'closed-unit',
  'dialogue-always-answers',
  'uniform-information'
])

/** 一次送检的最大问题数已固定为五个维度；超出这个数模型会开始编 */
const MAX_FINDINGS_PER_CHUNK = 12

/**
 * 构建结构体检 prompt。
 * @param text 待检正文
 * @param startLine 本块在全文中的起始行号（分块时用于让模型报出全局行号）
 * @param context 可选的细纲或本章目标上下文
 */
export function buildStructureJudgePrompt(
  text: string,
  startLine = 1,
  context?: { outlineSummary?: string; chapterGoal?: string }
): string {
  const numbered = text
    .split('\n')
    .map((line, i) => `${startLine + i}| ${line}`)
    .join('\n')

  const questions = STRUCTURE_DIMENSIONS.map((d, i) => `${i + 1}. **${d.name}**（\`${d.id}\`）\n   ${d.question}`).join(
    '\n'
  )

  const outlineSection =
    context?.outlineSummary || context?.chapterGoal
      ? `\n### 细纲与剧情规划参考\n${context.outlineSummary ? `- 本章细纲：${context.outlineSummary}\n` : ''}${context.chapterGoal ? `- 本章目标：${context.chapterGoal}\n` : ''}（请结合细纲规划，重点排查正文的高潮爽点是否被一笔带过、阻力是否被虚化）\n`
      : ''

  return `## 任务：结构体检（只判定，不改写）

你在读一段中文小说正文，判断它有没有 AI 生成文本的**结构特征**。
注意：不要查用词、不要查标点、不要查错别字——那些另有工具负责。你只看结构。
${outlineSection}
### 判定维度

${questions}

### 判定要求

- **宁缺毋滥**：只报你能在正文里指出具体位置的问题。找不到就报空数组，不要为了凑数编。
- 最多报 ${MAX_FINDINGS_PER_CHUNK} 条。同一个问题在多处出现，报最典型的一处即可。
- 行号用正文每行前面的数字，不要自己数。
- \`excerpt\` 必须是原文里**逐字存在**的片段，不超过 40 字。
- \`suggestion\` 要具体到能直接动笔（写出改成什么样），不要写「增加细节」这种空话。
- 这段正文可能是长文的中间一段，开头结尾不完整是正常的，不要因此报问题。

### 输出格式

只输出一个 JSON 数组，不要任何解释文字，不要 markdown 代码块标记：

[
  {"dimension": "维度 id", "line": 行号, "excerpt": "原文片段", "why": "为什么像 AI 写的", "suggestion": "具体怎么改"}
]

没有发现问题就输出：[]

### 待检正文（行号 | 正文）

${numbered}
`
}

/**
 * 从模型输出里抽出 findings。
 *
 * 模型经常在 JSON 前后加解释、套 ``` 代码块、或者整个截断，所以这里按「最外层方括号」
 * 定位再解析，任何一步失败都返回 null——调用方据此计入 unparsedChunks 并告诉用户
 * 结果不完整，而不是把空数组当成「体检通过」。
 *
 * @param minLine/@param maxLine 合法行号区间；越界的条目丢弃（模型自己数行时经常越界）
 */
export function parseStructureJudgeOutput(
  output: string,
  minLine: number,
  maxLine: number
): DeslopStructureFinding[] | null {
  const raw = extractJsonArray(output)
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const findings: DeslopStructureFinding[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>

    const dimension = typeof o.dimension === 'string' ? o.dimension : ''
    if (!VALID_DIMENSIONS.has(dimension)) continue

    const line = typeof o.line === 'number' ? Math.floor(o.line) : Number.NaN
    if (!Number.isFinite(line) || line < minLine || line > maxLine) continue

    const excerpt = typeof o.excerpt === 'string' ? o.excerpt.trim() : ''
    const why = typeof o.why === 'string' ? o.why.trim() : ''
    const suggestion = typeof o.suggestion === 'string' ? o.suggestion.trim() : ''
    // why/suggestion 空的条目没有任何行动价值，等于噪声
    if (!excerpt || !why || !suggestion) continue

    findings.push({
      dimension: dimension as DeslopStructureDimension,
      line,
      excerpt: excerpt.slice(0, 80),
      why,
      suggestion
    })
    if (findings.length >= MAX_FINDINGS_PER_CHUNK) break
  }
  return findings
}

/** 取最外层 [...]，容忍前后的解释文字和代码块围栏 */
function extractJsonArray(output: string): string | null {
  const start = output.indexOf('[')
  const end = output.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  return output.slice(start, end + 1)
}

const LEGACY_NAMES: Record<string, string> = {
  'all-purpose-detail': '细节全都有用（旧）',
  'closed-unit': '每段自带收束（旧）',
  'dialogue-always-answers': '对白永远有效（旧）',
  'uniform-information': '信息密度均匀（旧）'
}

/** 维度 id → 中文名（UI 与日志用） */
export function structureDimensionName(id: DeslopStructureDimension): string {
  return STRUCTURE_DIMENSIONS.find((d) => d.id === id)?.name ?? LEGACY_NAMES[id] ?? id
}
