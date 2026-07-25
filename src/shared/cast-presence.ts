/**
 * 章节登场人物识别：presence 解析与 JSON 提取（纯函数，便于单测）。
 *
 * appeared = 真正出场（可一键加入本章登场）
 * mentioned = 仅被点名（默认不自动加入）
 *
 * 模型漏写 presence 时 fail-closed 为 mentioned，避免把「仅提及」误当出场。
 */

export type CastPresence = 'appeared' | 'mentioned'

export interface CastParseItem {
  name: string
  reason: string
  quote: string
  presence: CastPresence
}

const APPEARED_LABELS = new Set([
  'appeared',
  'appear',
  'present',
  '出场',
  '登场',
  '到场',
  '在场'
])

const MENTIONED_LABELS = new Set([
  'mentioned',
  'mention',
  'reference',
  '提及',
  '仅提及',
  '被提及',
  '点名'
])

/** reason 中明确「没到场」的兜底 */
const MENTIONED_REASON_RE =
  /仅[被]?提及|只[被是]?提及|未出场|没有出场|并未出场|只是被提起|被人提起|仅作[为]?提及|名字被提起|口头提及|侧面提起/

/** reason 中明确「到场行动」的兜底（仅在 presence 缺失时使用） */
const APPEARED_REASON_RE =
  /真正出场|实际出场|亲自出场|本人出场|到场[，,、]?|登场[，,、]?|在场行动|参与对戏|有对话|有动作|开口说话/

/**
 * 将模型输出的 presence / 别名 / reason 归一为 appeared | mentioned。
 * 未知或缺失 → mentioned（一键应用 fail-closed）。
 */
export function normalizeCastPresence(raw: unknown, reason: string): CastPresence {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (v && APPEARED_LABELS.has(v)) return 'appeared'
  if (v && MENTIONED_LABELS.has(v)) return 'mentioned'
  // 英文大小写已 lower；中文原串再试一次（trim 后未 lower 的中文）
  const rawTrim = typeof raw === 'string' ? raw.trim() : ''
  if (rawTrim && APPEARED_LABELS.has(rawTrim)) return 'appeared'
  if (rawTrim && MENTIONED_LABELS.has(rawTrim)) return 'mentioned'

  if (MENTIONED_REASON_RE.test(reason)) return 'mentioned'
  if (APPEARED_REASON_RE.test(reason)) return 'appeared'
  return 'mentioned'
}

/**
 * 从 LLM 文本中提取登场建议 JSON 数组。
 * 容忍 ```json 包裹与前后杂讯。
 */
export function parseCastJson(text: string): CastParseItem[] {
  const m = text.match(/\[\s*[\s\S]*?\]\s*(?=$|[^\]]*$)/)
  const candidate = m ? m[0] : text
  try {
    const arr = JSON.parse(candidate)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((x) => x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string')
      .map((x) => {
        const row = x as {
          name: string
          reason?: unknown
          quote?: unknown
          presence?: unknown
          status?: unknown
          type?: unknown
        }
        const reason = typeof row.reason === 'string' ? row.reason.trim() : ''
        return {
          name: String(row.name).trim(),
          reason,
          quote: typeof row.quote === 'string' ? row.quote.trim() : '',
          presence: normalizeCastPresence(row.presence ?? row.status ?? row.type, reason)
        }
      })
      .filter((x) => x.name)
  } catch {
    return []
  }
}
