export const FIELD_CHAPTERS = '字段记录章'

export function observationChapters(value: unknown): Record<string, number> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : null
    return Object.fromEntries(Object.entries(parsed ?? {}).filter(([key, n]) =>
      key.length < 80 && Number.isSafeInteger(n) && Number(n) > 0)) as Record<string, number>
  } catch { return {} }
}

export function observationLabel(field: string, dates: Record<string, number>): string {
  const key = field === '显性性格' ? '性格' : field === '金手指' ? '能力' : field
  return dates[key] ? `${field}（第${dates[key]}章观察）` : field
}

/** Labels carry provenance; repository values remain plain for ownership/rollback comparisons. */
export function normalizeObservationLabels(text: string): string {
  return text.replace(/\*\*([^*\n]+?)（第\d+章观察）\*\*/g, '**$1**')
}

export function datedEntityNotes(notes: string | undefined, chapter: number): string | undefined {
  return notes && Number.isSafeInteger(chapter) && chapter > 0
    ? `第${chapter}章观察快照（历史记录，不代表后续当前状态；以已审正文连续性台账为准）：\n\n${notes}`
    : notes
}
