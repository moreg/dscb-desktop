import type { StyleProfile, UpdateStyleProfileInput } from '../../../../shared/types'

/**
 * 比较 draft 与原 profile，返回非空字段的 patch。
 * service 端会兜底保留未传字段的原值。
 */
export function diffStyleProfile(
  draft: StyleProfile,
  original: StyleProfile[]
): UpdateStyleProfileInput {
  const before = original.find((p) => p.id === draft.id)
  if (!before) return {}
  const patch: UpdateStyleProfileInput = {}
  if (draft.name.trim() !== before.name) patch.name = draft.name.trim()
  if (draft.identifiedStyle.trim() !== before.identifiedStyle) {
    patch.identifiedStyle = draft.identifiedStyle.trim()
  }
  const arrayFields: Array<keyof UpdateStyleProfileInput> = [
    'sentencePatterns',
    'vocabularyPreferences',
    'punctuationAndRhythm',
    'narrativePerspective',
    'tone',
    'narrativeTemplates',
    'styleConstraints',
    'characterConstraints',
    'plotConstraints'
  ]
  for (const key of arrayFields) {
    const next = draft[key] as string[] | undefined
    const prev = before[key] as string[] | undefined
    if (!arraysEqual(next ?? [], prev ?? [])) {
      ;(patch as Record<string, unknown>)[key] = next ?? []
    }
  }
  if (draft.stylePrompt.trim() !== before.stylePrompt) {
    patch.stylePrompt = draft.stylePrompt.trim()
  }
  return patch
}

export function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
