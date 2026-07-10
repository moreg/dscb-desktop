/**
 * 去 AI 味规则分节注册表 + Markdown 序列化/解析 + AI 改写规则 prompt 构建。
 *
 * 把 anti-ai-methods.ts 的 DESLOP_SYSTEM_PROMPT（系统铁律）和 GATE_METHODS（A-G 七道关卡）
 * 包装成「可编辑分节」，供设置页展示与编辑、供 deslop-service 动态注入。
 *
 * 设计参考 src/main/data/skill-prompts/chapter-rules.ts 的 CHAPTER_RULE_SECTIONS 模式：
 * - 注册表是 UI（标题 + 默认正文）与 prompt 拼装（取生效正文）的单一事实源
 * - 用户覆盖存储在 settings.deslopRules.textOverrides，缺 key = 用内置默认
 * - 序列化成 Markdown 供 AI 整体改写，改写后解析回各分节
 */

import { DESLOP_SYSTEM_PROMPT, GATE_METHODS } from './anti-ai-methods'
import { FLATTENED_LEVEL1 } from '../../deslop/banned-words'

/** 可被用户在设置里覆盖的去 AI 味规则小节 key */
export type DeslopRuleKey =
  | 'systemPrompt'
  | 'gateA'
  | 'gateB'
  | 'gateC'
  | 'gateD'
  | 'gateE'
  | 'gateF'
  | 'gateG'

/** 一条可编辑规则小节：UI 用 title+defaultText 展示与恢复默认，prompt 拼装用 key 取生效文本 */
export interface DeslopRuleSection {
  key: DeslopRuleKey
  title: string
  /** 内置默认正文（用户未覆盖时使用） */
  text: string
}

/**
 * 去 AI 味可编辑规则小节注册表——UI（标题 + 默认正文）与 deslop-service（取生效正文）的单一事实源。
 * 顺序即设置页与 Markdown 中的呈现顺序。
 */
export const DESLOP_RULE_SECTIONS: DeslopRuleSection[] = [
  { key: 'systemPrompt', title: '系统铁律（改写总则）', text: DESLOP_SYSTEM_PROMPT },
  { key: 'gateA', title: 'Gate A：禁用词替换', text: GATE_METHODS.A },
  { key: 'gateB', title: 'Gate B：句式去套路', text: GATE_METHODS.B },
  { key: 'gateC', title: 'Gate C：心理描写外化', text: GATE_METHODS.C },
  { key: 'gateD', title: 'Gate D：节奏打碎', text: GATE_METHODS.D },
  { key: 'gateE', title: 'Gate E：对话去腔调', text: GATE_METHODS.E },
  { key: 'gateF', title: 'Gate F：结尾去升华', text: GATE_METHODS.F },
  { key: 'gateG', title: 'Gate G：去解释腔/上帝视角', text: GATE_METHODS.G }
]

/** 分节 key → 标题白名单（序列化/解析与 sanitize 复用） */
export const DESLOP_RULE_TITLE_BY_KEY: Record<DeslopRuleKey, string> = Object.fromEntries(
  DESLOP_RULE_SECTIONS.map((s) => [s.key, s.title])
) as Record<DeslopRuleKey, string>

/** 标题 → key 的反向映射（解析 Markdown 时按标题切节回填 key） */
export const DESLOP_RULE_KEY_BY_TITLE: Record<string, DeslopRuleKey> = Object.fromEntries(
  DESLOP_RULE_SECTIONS.map((s) => [s.title, s.key])
)

/** 禁用词表在 Markdown 里的分节标题（不进 DESLOP_RULE_SECTIONS，单独存为 settings.deslopRules.bannedWords） */
export const DESLOP_BANNED_WORDS_TITLE = '禁用词表（每行一个词）'

/* =========================================================
   Markdown 序列化 / 解析
   ========================================================= */

/**
 * 把可编辑分节 + 草稿合并成完整 Markdown 文档，供 AI 整体改写。
 *
 * 文档结构（每个二级标题一节，正文原样保留）：
 * ```
 * ## 系统铁律（改写总则）
 * <正文>
 *
 * ## Gate A：禁用词替换
 * <正文>
 *
 * ## 禁用词表（每行一个词）
 * 词1
 * 词2
 * ```
 *
 * @param overrides 用户覆盖表（key→正文）；缺 key = 用内置默认
 * @param bannedWords 禁用词列表（每行一个词）
 */
export function serializeDeslopRulesToMd(
  overrides: Record<string, string>,
  bannedWords: string[]
): string {
  const blocks: string[] = []
  for (const sec of DESLOP_RULE_SECTIONS) {
    const ov = overrides[sec.key]
    const text = typeof ov === 'string' ? ov : sec.text
    blocks.push(`## ${sec.title}\n${text}`)
  }
  // 禁用词表作为最后一节
  blocks.push(`## ${DESLOP_BANNED_WORDS_TITLE}\n${bannedWords.join('\n')}`)
  return blocks.join('\n\n')
}

/**
 * 解析 AI 改写后的完整 Markdown，回填到各分节 draft 与禁用词列表。
 *
 * 解析规则：
 * - 按 `^## ` 切节（二级标题行）
 * - 标题 trim 后映射回 key；无法映射的节丢弃（防 AI 乱造标题污染）
 * - 节正文 = 标题行之后到下一个 `## ` 之间的所有行（trim 尾部空行）
 * - 禁用词节按行 split、去空、去重
 *
 * @returns { overrides, bannedWords }；无法识别的节忽略
 */
export function parseDeslopRulesFromMd(md: string): {
  overrides: Record<string, string>
  bannedWords: string[]
} {
  const overrides: Record<string, string> = {}
  let bannedWords: string[] = []

  // 按二级标题切节
  const lines = md.split(/\r?\n/)
  let currentTitle = ''
  let currentBody: string[] = []

  const flush = (): void => {
    if (!currentTitle) return
    const body = currentBody.join('\n').replace(/\s+$/u, '')
    if (currentTitle === DESLOP_BANNED_WORDS_TITLE) {
      const seen = new Set<string>()
      const words: string[] = []
      for (const raw of body.split(/\r?\n/)) {
        const w = raw.trim()
        if (!w || seen.has(w)) continue
        seen.add(w)
        words.push(w)
      }
      bannedWords = words
      return
    }
    const key = DESLOP_RULE_KEY_BY_TITLE[currentTitle]
    if (key) overrides[key] = body
  }

  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/u.exec(line)
    if (m) {
      flush()
      currentTitle = m[1].trim()
      currentBody = []
    } else if (currentTitle) {
      currentBody.push(line)
    }
  }
  flush()

  return { overrides, bannedWords }
}

/* =========================================================
   AI 改写规则 prompt
   ========================================================= */

/**
 * 构建「AI 用自然语言改写去 AI 味规则」的 prompt。
 *
 * 输入：当前完整规则 Markdown + 用户自然语言指令。
 * 输出：保持分节结构（`## 标题\n正文`）的完整 Markdown，AI 只改用户要求改的部分，其余原样保留。
 *
 * 设计要点：
 * - 强制保持二级标题不变（系统铁律/Gate A-G/禁用词表），否则解析会丢节
 * - 不允许新增/删除分节、不允许改标题文字
 * - 改完仍是一份完整的、可直接解析的规则文档
 */
export function buildDeslopRuleEditPrompt(currentMd: string, instruction: string): string {
  return `## 任务：用自然语言改写「去 AI 味规则」

你收到一份完整的去 AI 味规则文档（Markdown 格式，每个 \`## \` 二级标题是一节）。用户会用自然语言描述想怎么改，你需要：

1. **只改用户指令涉及的节**，其余节原样保留（包括标题和正文）。
2. **必须保持所有 \`## \` 二级标题的文字完全不变**（含「系统铁律（改写总则）」「Gate A：禁用词替换」……「禁用词表（每行一个词）」共 9 节）。不得新增、删除、重命名任何标题，否则下游解析会丢节。
3. **禁用词表节**：正文是「每行一个词」的纯词表，改这节时按行操作，每行一个词，不要加编号、逗号、解释。
4. **其余节**（系统铁律、Gate A-G）：正文是规则说明文字，保留原有的命令式语气、示例格式（✓/❌、带「-」的列表项），不要把规则改写成解释性散文。
5. 改写不得引入与去 AI 味无关的内容；不得削弱原有的硬性约束（删除比例上限、保留伏笔等铁律不得删除）。
6. 不要输出任何前言、解释、代码块包裹，直接输出改写后的完整 Markdown，从第一个 \`## \` 开始。

### 用户的修改指令
${instruction.trim() || '（用户未给出具体指令，请整体优化措辞但保留所有规则点）'}

### 当前规则文档（待改写）
${currentMd}

### 输出要求
- 直接输出改写后的完整 Markdown，9 个 \`## \` 二级标题按原顺序保留
- 不要加 \`\`\`markdown 代码块包裹
- 不要在文档前后加任何解释文字`
}

/* =========================================================
   生效正文解析（供 deslop-service 消费）
   ========================================================= */

/**
 * 从 settings 覆盖表 + 内置默认合成 deslop-service 实际使用的规则文本。
 * @param overrides settings.deslopRules.textOverrides（清洗后）
 * @returns { systemPrompt, gates: { A?: string, B?: string, ... } } 只含覆盖过的字段
 */
export function resolveDeslopTextOverrides(
  overrides: Record<string, string>
): {
  systemPrompt?: string
  gates: Partial<Record<string, string>>
} {
  const out: { systemPrompt?: string; gates: Partial<Record<string, string>> } = { gates: {} }
  for (const sec of DESLOP_RULE_SECTIONS) {
    const ov = overrides[sec.key]
    if (typeof ov !== 'string') continue
    if (ov === sec.text) continue // 与默认相同 = 不生效
    if (sec.key === 'systemPrompt') {
      out.systemPrompt = ov
    } else {
      const gateLetter = sec.key.replace('gate', '')
      out.gates[gateLetter] = ov
    }
  }
  return out
}

/**
 * 取生效的禁用词列表：用户配置过就用配置（即便为空数组=清空扫描），否则用内置 FLATTENED_LEVEL1。
 * @returns undefined 表示「未配置，请用默认」；返回数组（含空数组）表示「用户已显式配置」
 */
export function resolveDeslopBannedWords(
  bannedWords: string[] | undefined
): string[] | undefined {
  if (!Array.isArray(bannedWords)) return undefined
  return bannedWords
}

/** 内置默认禁用词（供设置页展示「默认」状态 + sanitize 上限时复用） */
export const DEFAULT_DESLOP_BANNED_WORDS: string[] = [...FLATTENED_LEVEL1]
