import legacyDefaults from './legacy-prose-defaults.json'
import policy from './prose-policy.json'
export const PROSE_POLICY_VERSION = policy.version
export const NATURAL_PARAGRAPHS = policy.paragraphs
export const DIALOGUE_PARAGRAPHS = policy.dialogueParagraphs
export const SEMANTIC_PUNCTUATION = policy.punctuation
/** 台词标点审核与修复共用口径：引号内除末尾外不出现句号（多句拆段），结尾句号保留。提示词必须引用本常量，避免与规则版本漂移。 */
export const DIALOGUE_PUNCTUATION_RULE = `同一对引号内除末尾句号外不出现中文句号，多句台词按语意拆成引号完整的独立对话段；${SEMANTIC_PUNCTUATION}`
export const SCENE_DIALOGUE = policy.dialogue
export const PROSE_PRESERVATION = policy.preservation
export const READER_NOTE_BOUNDARY = policy.readerNoteBoundary
export const PROSE_POLICY_RULES = `【正文保真共享规则 ${policy.version}】
${policy.paragraphs}
${policy.dialogueParagraphs}
${policy.punctuation}
${policy.dialogue}
${policy.preservation}
${policy.readerNoteBoundary}`

/** Only exact, previously shipped fragments are migrated; settings bytes are never rewritten. */
export function migrateLegacyProseDefaults(text: string): string {
  let result = text
  for (const { before, after } of legacyDefaults) {
    result = result.replaceAll(before, after).replaceAll(before.replace(/\n/g, '\r\n'), after)
  }
  return result
}

export function serializeProseOverrides(overrides: unknown): string {
  return JSON.stringify(overrides, (_key, value) => typeof value === 'string' ? migrateLegacyProseDefaults(value) : value)
}
