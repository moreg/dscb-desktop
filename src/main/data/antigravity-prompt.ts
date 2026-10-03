/** Leave room below the runner's 30,000-character argument limit. */
export const AGY_PROMPT_BUDGET = 28_000

/** Last resort for every agy request: keep both initial rules and final task instructions. */
function capPrompt(text: string): string {
  if (text.length <= AGY_PROMPT_BUDGET) return text
  const marker = '\n[agy 长度限制：输入过长，中间部分已截取省略；仅依据保留内容执行任务。]\n'
  const available = AGY_PROMPT_BUDGET - marker.length
  let headEnd = Math.ceil(available / 2)
  let tailStart = text.length - Math.floor(available / 2)
  // Do not leave half of a UTF-16 surrogate pair at either cut boundary.
  if (/[\uD800-\uDBFF]/.test(text[headEnd - 1])) headEnd--
  if (/[\uDC00-\uDFFF]/.test(text[tailStart])) tailStart++
  return text.slice(0, headEnd) + marker + text.slice(tailStart)
}

interface Section {
  title: string
  text: string
}

// Only recognize headings outside fenced source material (prose may contain headings).
function sections(text: string, level: number): Section[] {
  const result: Section[] = []
  let current: Section = { title: '', text: '' }
  let fence = ''
  for (const line of text.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1][0]
      else if (marker[1][0] === fence) fence = ''
    }
    if (!fence && (line.startsWith('#'.repeat(level) + ' ') ||
        (level === 1 && line.startsWith('**【本章已写正文前部】**')))) {
      result.push(current)
      current = { title: line, text: '' }
    }
    current.text += (current.text ? '\n' : '') + line
  }
  result.push(current)
  return result
}

function excerpt(text: string, budget: number, tailWeight = 0.25): string {
  if (text.length <= budget) return text
  const marker = '\n[agy 长度限制：此处省略部分背景，仅据保留材料写作，不补造事实]\n'
  if (budget <= marker.length) return ''
  const available = budget - marker.length
  const tail = Math.floor(available * tailWeight)
  return text.slice(0, available - tail) + marker + (tail ? text.slice(-tail) : '')
}

/** Share space fairly, reclaiming unused space from short documents. */
function fit(texts: string[], budget: number, tailWeight = 0.25): string[] {
  const limits = texts.map(() => 0)
  let remaining = Math.max(0, budget)
  let pending = texts.map((_, index) => index)
  while (pending.length && remaining > 0) {
    const share = Math.floor(remaining / pending.length)
    const short = pending.filter((index) => texts[index].length <= share)
    if (!short.length) {
      for (const index of pending) limits[index] = share
      break
    }
    for (const index of short) {
      limits[index] = texts[index].length
      remaining -= limits[index]
    }
    pending = pending.filter((index) => !short.includes(index))
  }
  return texts.map((text, index) => excerpt(text, limits[index], tailWeight))
}

function fitBackground(section: Section, budget: number): string {
  // Keep each setting/character document represented instead of dropping later cards.
  const docs = sections(section.text, 3)
  const headingCost = docs.reduce((sum, doc) => sum + doc.title.length + 1, 0)
  const bodies = docs.map((doc) => doc.title ? doc.text.slice(doc.title.length + 1) : doc.text)
  const fitted = fit(bodies, budget - headingCost - docs.length)
  return docs.map((doc, index) => [doc.title, fitted[index]].filter(Boolean).join('\n')).join('\n')
}

/**
 * Applied only by the resolved antigravity provider. First compact chapter
 * backgrounds while preserving task text and drafts; if still oversized (or
 * another request format), directly cut the middle to enforce the final budget.
 */
export function buildAntigravityPrompt(prompt: string, system: string | undefined, preamble: string): string {
  const merge = (user: string) => preamble + (system?.trim() ? `${system}\n\n---\n\n${user}` : user)
  const original = merge(prompt)
  if (original.length <= AGY_PROMPT_BUDGET) return original
  const parts = sections(prompt, 1)
  if (!parts.some((part) => /^# 第 \d+ 章 写作任务$/.test(part.title)) ||
      !parts.some((part) => /^# 现在请写第 \d+ 章正文$/.test(part.title))) return capPrompt(original)

  const background = (part: Section) => !part.title ||
    /^# (项目设定|卷级定位：|角色信息|角色状态追踪|相关旧章概要|伏笔追踪)/.test(part.title) ||
    /^# 第 \d+ 章 衔接原料$/.test(part.title) ||
    /^# (较早已写章节概要|与本章有关的历史正文证据)/.test(part.title)
  const optional = parts.filter(background)
  const essential = parts.filter((part) => !background(part))
  const fixedCost = merge('').length + essential.reduce((sum, part) => sum + part.text.length, 0) + parts.length
  const budget = AGY_PROMPT_BUDGET - fixedCost
  if (budget <= optional.length * 150) return capPrompt(original)
  // Allocate by section, then by individual setting/character document.
  const allocations = fit(optional.map((part) => part.text), budget)
  let index = 0
  const user = parts.map((part) => {
    if (!background(part)) return part.text
    const allocation = allocations[index++].length
    if (/衔接原料/.test(part.title)) {
      // Previous chapter tail is most useful for the next chapter's opening.
      const body = part.text.slice(part.title.length)
      return part.title + '\n' + excerpt(body, Math.max(0, allocation - part.title.length - 1), 0.8)
    }
    return fitBackground(part, allocation)
  }).join('\n')
  return capPrompt(merge(user))
}
