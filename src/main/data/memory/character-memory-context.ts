import type { Character } from '../../../shared/types'

/** Explicit labels for one character, for retrieval only; these are not new story facts. */
export interface CharacterAliasGroup {
  name: string
  aliases: string[]
}

export interface HistoricalCharacterIdentity {
  name: string
  updateChapter: number
  role?: string
  personality?: string
  identity?: string
}

/** A latest character card cannot establish someone's personality or role in an earlier chapter. */
export function projectCharactersForChapter(
  characters: Character[],
  beforeChapter: number,
  snapshots: HistoricalCharacterIdentity[],
  historical: boolean
): Character[] {
  if (!historical) return characters
  const history = new Map<string, HistoricalCharacterIdentity>()
  for (const snapshot of snapshots) {
    // Legacy undated "current state" rows parse as zero; they are not a dated baseline.
    if (!Number.isSafeInteger(snapshot.updateChapter) || snapshot.updateChapter <= 0 || snapshot.updateChapter >= beforeChapter) continue
    const previous = history.get(snapshot.name)
    if (!previous || snapshot.updateChapter >= previous.updateChapter) history.set(snapshot.name, snapshot)
  }
  return characters.map((character) => {
    const snapshot = history.get(character.name)
    return {
      ...character,
      role: knownValue(snapshot?.role),
      personality: knownValue(snapshot?.personality),
      identity: knownValue(snapshot?.identity),
      abilities: undefined,
      synopsis: undefined,
      tags: undefined,
      customFields: undefined,
      rawFields: undefined
    }
  })
}

const ALIAS_FIELDS = new Set(['别名', '别称', '化名', '曾用名', '旧名', '昵称', '外号', '绰号', 'aliases', 'alias'])
const EMPTY_VALUES = new Set(['无', '暂无', '未知', '未定', '待定', '未命名', '不详', '-', '—', 'none', 'unknown', 'n/a'])

function knownValue(value?: string): string | undefined {
  const trimmed = value?.trim()
  return trimmed && !EMPTY_VALUES.has(trimmed.toLocaleLowerCase()) ? trimmed : undefined
}

/**
 * Only explicit alias fields are accepted. Do not infer identity from a synopsis, title,
 * surname, or fuzzy name match. Dated aliases are unavailable before their stated chapter;
 * undated aliases can also be excluded when backfilling an earlier chapter.
 */
export function buildCharacterAliasGroups(
  characters: Character[],
  beforeChapter: number,
  options: { excludeUndated?: boolean } = {}
): CharacterAliasGroup[] {
  const groups = characters.map((character) => {
    const aliases = new Set<string>()
    for (const [field, value] of Object.entries({ ...character.rawFields, ...character.customFields })) {
      if (!ALIAS_FIELDS.has(field.trim().toLocaleLowerCase())) continue
      for (const entry of Array.isArray(value) ? value : [value]) {
        for (const item of entry.split(/[、,，;；\n]+/)) {
          const alias = parseAlias(item, beforeChapter, Boolean(options.excludeUndated))
          if (alias && alias.toLocaleLowerCase() !== character.name.trim().toLocaleLowerCase()) aliases.add(alias)
          if (aliases.size >= 12) break
        }
        if (aliases.size >= 12) break
      }
    }
    return { name: character.name, aliases: [...aliases] }
  })
  // Shared labels (e.g. two people's "老张") and labels equal to someone else's name are
  // ambiguous. Keep the separate entities, but never expand either through that label.
  const owners = new Map<string, Set<string>>()
  for (const group of groups) {
    for (const label of [group.name, ...group.aliases]) {
      const key = label.trim().toLocaleLowerCase()
      const names = owners.get(key) ?? new Set<string>()
      names.add(group.name)
      owners.set(key, names)
    }
  }
  return groups.map((group) => ({
    ...group,
    aliases: group.aliases.filter((alias) => owners.get(alias.toLocaleLowerCase())?.size === 1)
  })).filter((group) => group.aliases.length > 0)
}

function parseAlias(raw: string, beforeChapter: number, excludeUndated: boolean): string | undefined {
  let alias = raw.trim().replace(/^[-*]\s+/, '')
  const chapter = alias.match(/[（(]\s*第\s*(\d+)\s*章(?:起|开始|揭晓|确认)?\s*[）)]$/)
  if (chapter) {
    if (Number(chapter[1]) >= beforeChapter) return undefined
    alias = alias.slice(0, chapter.index).trim()
  } else if (excludeUndated) return undefined
  alias = alias.replace(/^[“”"'「」]+|[“”"'「」]+$/g, '').trim()
  if (!knownValue(alias) || alias.length < 2 || alias.length > 40) return undefined
  // A prose claim or a conditional explanation is not an explicit entity label.
  if (!/^[\p{L}\p{N}·・.'’\- ]+$/u.test(alias) || /(?:第\s*\d+\s*章|后来|目前|暂时|可能|又称|自称|称为|尚未|从未)/.test(alias)) return undefined
  return alias
}

/** Expand only a directly selected or mentioned explicit label; ambiguous labels stay separate. */
export function expandCharacterAliasTerms(
  names: string[],
  text: string,
  groups: CharacterAliasGroup[]
): string[] {
  const selected = new Set(names.map((name) => name.trim().toLocaleLowerCase()))
  const normalizedText = text.toLocaleLowerCase()
  const result = new Set<string>()
  for (const group of groups) {
    const labels = [group.name, ...group.aliases]
    if (!labels.some((label) => selected.has(label.toLocaleLowerCase()) || containsLabel(normalizedText, label))) continue
    for (const label of labels) result.add(label)
  }
  return [...result]
}

function containsLabel(text: string, label: string): boolean {
  const normalized = label.toLocaleLowerCase()
  let start = text.indexOf(normalized)
  while (start >= 0) {
    const end = start + normalized.length
    const leftOk = !/^[a-z0-9]/.test(normalized) || !/[a-z0-9]/.test(text[start - 1] ?? '')
    const rightOk = !/[a-z0-9]$/.test(normalized) || !/[a-z0-9]/.test(text[end] ?? '')
    if (leftOk && rightOk) return true
    start = text.indexOf(normalized, start + 1)
  }
  return false
}
