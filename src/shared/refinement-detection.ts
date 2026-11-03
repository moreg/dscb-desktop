import type { RefinementInput } from './chapter-refinement'

export function detectionRanges(input: RefinementInput): Array<{ start: number; end: number; before: string }> {
  if (input.goal !== 'detection') return []
  if (input.selection) throw new Error('标黄精修按粘贴片段定位，请取消选区范围')
  const excerpts = input.detection?.excerpts
  if (!excerpts?.length || excerpts.length > 20) throw new Error('请粘贴 1 至 20 段朱雀标黄原文')
  const score = input.detection?.score
  if (score !== undefined && (!Number.isFinite(score) || score < 0 || score > 100)) throw new Error('检测分数应在 0 至 100 之间')
  const ranges = excerpts.map(before => {
    if (typeof before !== 'string' || before.trim().length < 8) throw new Error('标黄片段至少 8 字符，请粘贴足够原文以便定位')
    const start = input.content.indexOf(before)
    if (start < 0) throw new Error('标黄原文与当前正文不一致，请重新复制，不要改动标点或空白')
    if (input.content.indexOf(before, start + 1) >= 0) throw new Error('标黄片段出现多次，请连同相邻原文一起粘贴以便唯一定位')
    return { start, end: start + before.length, before }
  }).sort((a, b) => a.start - b.start)
  if (ranges.some((range, i) => i > 0 && range.start < ranges[i - 1].end)) throw new Error('标黄片段重复或重叠，请合并后粘贴')
  return ranges
}

/** The model supplies replacements, never an editable copy of protected text. */
export function applyDetectionEdits(input: RefinementInput, edits: unknown): { content: string; pairs: Array<{ before: string; after: string }> } {
  const ranges = detectionRanges(input)
  if (!Array.isArray(edits) || edits.length !== ranges.length) throw new Error('候选须逐一返回全部标黄片段的替换，不得扩大或遗漏范围')
  const pairs = ranges.map(range => {
    const matches = edits.filter(edit => edit && typeof edit === 'object' && edit.before === range.before)
    if (matches.length !== 1 || typeof matches[0].after !== 'string' || !matches[0].after.trim()) throw new Error('标黄替换原文无法唯一匹配，或候选为空')
    const after = matches[0].after as string
    if (after === range.before) throw new Error('标黄片段没有实际修改，不能作为精修完成')
    if (after.length < range.before.length * 0.5 || after.length > Math.max(range.before.length * 2, range.before.length + 300)) throw new Error('标黄片段删减或扩写过多，请缩小修改幅度')
    return { before: range.before, after }
  })
  let content = input.content
  for (let i = ranges.length - 1; i >= 0; i--) content = content.slice(0, ranges[i].start) + pairs[i].after + content.slice(ranges[i].end)
  return { content, pairs }
}
