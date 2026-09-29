import { findJsonArray, findJsonObject } from './json-extract'
import type { CoverStylePreset } from './types'

/** 番茄多书名实验：书名含标点最多 15 字。 */
export const FANQIE_BOOK_TEST_TITLE_MAX = 15
/** 除原书名外，单次实验最多提交的套数。列表里可以多留，提交前再减。 */
export const FANQIE_BOOK_TEST_SUBMIT_MAX = 5
/** 一次向模型要的书名条数上限。 */
export const BOOK_TEST_BATCH_MAX = 8
/** 一个项目里留着的测试方案上限，避免记录文件无限涨。 */
export const BOOK_TEST_POOL_MAX = 40

export const BOOK_TEST_STYLE_PRESETS = [
  'auto',
  'photorealistic',
  'anime_illustration',
  'fanqie_impact',
  'ancient_romance',
  'ink_minimal',
  'dark_suspense',
  'urban_cinematic',
  'anime_light',
  'retro_period',
  'epic_fantasy',
  'concept_symbol',
  'glamour_romance',
  'cute_doodle',
  'warm_period_life',
  'rural_healing',
  'male_power_type',
  'folk_horror',
  'war_spy_epic',
  'game_neon',
  'western_adventure',
  'minimal_typographic'
] as const satisfies readonly CoverStylePreset[]

const CONTENT = /[\u4e00-\u9fffA-Za-z0-9]/
const ALLOWED = /[\u4e00-\u9fffA-Za-z0-9，！？【】：]/

const PUNCT_MAP: Record<string, string> = {
  '!': '！',
  '?': '？',
  ',': '，',
  ':': '：',
  ';': '，',
  '[': '【',
  ']': '】',
  '(': '【',
  ')': '】',
  '、': '，'
}

export function countChars(text: string): number {
  return [...text].length
}

export function clampChars(text: string, max: number): string {
  return [...text].slice(0, max).join('')
}

function toHalfwidth(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    out += code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : ch
  }
  return out
}

/**
 * 把模型或手输的书名收成番茄实验能提交的形状。
 * 去掉书名号和空格，英文标点换成中文标点。超长和非法字符留给检查函数报出来。
 */
export function normalizeFanqieTestTitle(raw: string): string {
  const stripped = toHalfwidth(raw.trim()).replace(
    /[\s《》〈〉「」『』\u201c\u201d\u2018\u2019"']/g,
    ''
  )
  let out = ''
  for (const ch of stripped) out += PUNCT_MAP[ch] ?? ch
  return out
}

export function fanqieTestTitleIssues(
  raw: string,
  options?: { originalTitle?: string; otherTitles?: string[] }
): { title: string; issues: string[] } {
  const title = normalizeFanqieTestTitle(raw)
  const issues: string[] = []
  if (!title) {
    issues.push('书名是空的')
    return { title, issues }
  }
  if (![...title].some((ch) => CONTENT.test(ch))) {
    issues.push('书名里没有实际的字')
  }
  const length = countChars(title)
  if (length > FANQIE_BOOK_TEST_TITLE_MAX) {
    issues.push(`有 ${length} 个字，番茄多书名实验最多 ${FANQIE_BOOK_TEST_TITLE_MAX} 个`)
  }
  const illegal: string[] = []
  for (const ch of title) {
    if (!ALLOWED.test(ch) && !illegal.includes(ch)) illegal.push(ch)
  }
  if (illegal.length > 0) {
    issues.push(`有实验不收的字符：${illegal.slice(0, 8).join(' ')}`)
  }
  const original = normalizeFanqieTestTitle(options?.originalTitle ?? '')
  if (original && original === title) issues.push('和当前书名相同')
  const duplicated = (options?.otherTitles ?? []).some(
    (other) => normalizeFanqieTestTitle(other) === title
  )
  if (duplicated) issues.push('和另一套测试书名重复')
  return { title, issues }
}

export function bookTestCoverIsStale(candidate: {
  title: string
  coverFileName?: string
  coverTitle?: string
}): boolean {
  if (!candidate.coverFileName || !candidate.coverTitle) return false
  return normalizeFanqieTestTitle(candidate.coverTitle) !== normalizeFanqieTestTitle(candidate.title)
}

const OUTLINE_PRIORITY = ['基本信息', '简介', '卖点', '金手指', '主线', '核心设定', '人设', '人物']

/** 大纲摘录：先拿卖点和主线，再补其它节，总长有上限。 */
export function selectOutlineExcerpt(
  sections: { title: string; body: string }[],
  maxChars = 2800
): string {
  const ranked = sections
    .map((section, index) => {
      const score = OUTLINE_PRIORITY.findIndex((key) => section.title.includes(key))
      return { ...section, index, score: score === -1 ? 100 : score }
    })
    .sort((a, b) => a.score - b.score || a.index - b.index)

  let out = ''
  for (const section of ranked) {
    const body = section.body.trim().slice(0, 700)
    if (!body) continue
    const block = `## ${section.title}\n${body}`
    const room = maxChars - countChars(out)
    if (room <= 80) break
    const piece = countChars(block) > room ? clampChars(block, room) : block
    out += (out ? '\n\n' : '') + piece
  }
  return out
}

export interface BookTestPromptInput {
  bookName: string
  genre?: string
  description?: string
  outlineExcerpt: string
  existingTitles: string[]
  count: number
  direction?: string
  avoidHook?: string
}

export function buildBookTestTitlePrompt(input: BookTestPromptInput): string {
  const lines = [
    '你在为番茄小说的「多书名实验」起测试书名。同一本书会用不同的书名和封面分发给不同读者，看哪套更吸量。',
    '',
    '规则：',
    `- 正好给出 ${input.count} 条。每条打一个不同的卖点。`,
    `- 每条书名含标点最多 ${FANQIE_BOOK_TEST_TITLE_MAX} 个字。汉字、字母、数字、标点都算 1 个字。`,
    '- 只用汉字、英文字母、阿拉伯数字，以及这些中文标点：，！？【】：',
    '- 不要书名号，不要空格，不要英文标点，不要引号。',
    '- 卖点必须是这本书里真有的，不要为了起名发明书里没有的设定。',
    '- 不要和原书名相同，也不要只改一两个字。开头几个字就要有冲突、身份或结果。',
    '- hook 用一句话说明这套在测哪个卖点，给作者挑选时看。',
    '- coverHint 用一句话写这套封面该画什么，必须扣住这条书名的卖点，不要五套封面只换字。',
    '',
    `原书名：${input.bookName || '（还没有书名）'}`
  ]
  if (input.genre?.trim()) lines.push(`题材：${clampChars(input.genre.trim(), 40)}`)
  if (input.description?.trim()) lines.push(`简介：${clampChars(input.description.trim(), 800)}`)
  if (input.direction?.trim()) lines.push(`作者这轮想测的方向：${clampChars(input.direction.trim(), 200)}`)
  if (input.avoidHook?.trim()) lines.push(`不要再测这个卖点：${clampChars(input.avoidHook.trim(), 80)}`)
  if (input.existingTitles.length > 0) {
    lines.push('已经有的测试书名，不要重复，也不要换汤不换药：')
    for (const title of input.existingTitles.slice(0, BOOK_TEST_POOL_MAX)) {
      lines.push(`- ${title}`)
    }
  }
  if (input.outlineExcerpt.trim()) {
    lines.push('', '大纲摘录：', input.outlineExcerpt.trim())
  } else if (!input.description?.trim()) {
    lines.push('', '现在几乎没有大纲和简介。只根据原书名起名，hook 里写明「素材少，卖点需要作者核对」。')
  }
  lines.push(
    '',
    '只输出 JSON，不要解释：',
    '{"candidates":[{"title":"","hook":"","coverHint":""}]}'
  )
  return lines.join('\n')
}

export interface BookTestDraft {
  title: string
  hook: string
  coverHint: string
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 从模型输出里取出书名方案。标题会先做过实验规则的规范化。 */
export function parseBookTestDrafts(raw: string): BookTestDraft[] {
  const object = findJsonObject(raw)
  const fromObject = object?.candidates
  const list = Array.isArray(fromObject) ? fromObject : (findJsonArray(raw) ?? [])

  const drafts: BookTestDraft[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const title = normalizeFanqieTestTitle(asText(row.title))
    if (!title || seen.has(title)) continue
    seen.add(title)
    drafts.push({
      title,
      hook: clampChars(asText(row.hook), 80),
      coverHint: clampChars(asText(row.coverHint), 200)
    })
  }
  return drafts
}
