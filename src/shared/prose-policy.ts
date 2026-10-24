import legacyDefaults from './legacy-prose-defaults.json'
import policy from './prose-policy.json'
export const PROSE_POLICY_VERSION = policy.version
export const NATURAL_PARAGRAPHS = policy.paragraphs
export const DIALOGUE_PARAGRAPHS = policy.dialogueParagraphs
export const SEMANTIC_PUNCTUATION = policy.punctuation
export const SCENE_DIALOGUE = policy.dialogue
export const PROSE_PRESERVATION = policy.preservation
export const READER_NOTE_BOUNDARY = policy.readerNoteBoundary
export const FANQIE_FIRST_CHAPTER_NOTE = policy.fanqieFirstChapterNote
export const PROSE_POLICY_RULES = `【正文保真共享规则 ${policy.version}】
${policy.paragraphs}
${policy.dialogueParagraphs}
${policy.punctuation}
${policy.dialogue}
${policy.preservation}
${policy.fanqieFirstChapterNote}`

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
