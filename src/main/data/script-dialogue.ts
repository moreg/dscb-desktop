import type { GateIssue, Shot11, StoryboardUnit } from '../../shared/script-studio'

interface Speech { speaker?: string; text: string }
const speakerName = (name: string): string => name.replace(/[（(].*[）)]$/, '').trim()

/** 只识别 M1 中的独立角色行 + 紧随其后的台词，或显式“角色：台词”。 */
export function scriptDialogue(body: string): string[] {
  return scriptSpeech(body).map(line => line.text)
}

function scriptSpeech(body: string): Speech[] {
  const lines = body.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const dialogue: Speech[] = []
  const role = (s: string): boolean => /^[\p{L}\p{N}·_]{1,20}(?:[（(][^）)]{1,30}[）)])?$/u.test(s) &&
    !/^(?:SC\d+|场景|FADE|CUT|DISSOLVE|动作|旁白说明|创作笔记)/i.test(s)
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(/^([\p{L}\p{N}·_]{1,20})[：:]\s*(.+)$/u)
    if (inline && !/^(动作|场景|说明|备注|创作笔记|场景号|镜头|光影|限制)$/.test(inline[1])) {
      dialogue.push({ speaker: inline[1], text: unquote(inline[2]) }); continue
    }
    if (!role(lines[i])) continue
    let next = i + 1
    if (/^[（(].*[）)]$/.test(lines[next] ?? '')) next++
    const text = lines[next]
    if (text && !/^(?:SC\d+|场景\s*\d|FADE|CUT|【|动作[：:])/i.test(text)) {
      dialogue.push({ speaker: speakerName(lines[i]), text: unquote(text) }); i = next
    }
  }
  return dialogue
}

function unquote(text: string): string {
  return text.replace(/^[「“"]([\s\S]*)[」”"]$/, '$1')
}
export function shotDialogue(shot: Pick<Shot11, 'dialogueAndTone'>): string[] {
  return shotSpeech(shot).map(line => line.text)
}

function shotSpeech(shot: Pick<Shot11, 'dialogueAndTone'>): Speech[] {
  const field = shot.dialogueAndTone
  let previousEnd = 0
  // 成对匹配外层引号，保留台词内部使用另一种引号的内容。
  const quoted = [...field.matchAll(/「([^」]*)」|“([^”]*)”|"([^"\n]*)"/g)].map(match => {
    const prefix = field.slice(previousEnd, match.index)
    previousEnd = match.index! + match[0].length
    const speaker = prefix.match(/([\p{L}\p{N}·_]{1,20}(?:[（(][^）)]{1,30}[）)])?)[：:]\s*$/u)?.[1]
    return { ...(speaker ? { speaker: speakerName(speaker) } : {}), text: match[1] ?? match[2] ?? match[3] }
  })
  if (quoted.length) return quoted
  if (/^\s*无对白/.test(field)) return []
  const explicit = field.match(/^(?:[^：:；\n]{1,30}[：:])?(.+?)(?:[；;]\s*(?:语气|音量|语速|口型)[：:]|$)/)
  const speaker = field.match(/^([^：:；\n]{1,30})[：:]/)?.[1]
  return explicit?.[1]?.trim() ? [{ ...(speaker ? { speaker: speakerName(speaker) } : {}), text: unquote(explicit[1].trim()) }] : []
}

/** 单段重生成时必须与原单段完全一致，包括原本无对白的情况。 */
export function unitDialogueIssues(units: StoryboardUnit[], original: StoryboardUnit): GateIssue[] {
  const normalize = (items: StoryboardUnit[]): Speech[] => items.flatMap(u => u.shots.flatMap(shotSpeech))
    .map(line => ({ ...line, text: line.text.replace(/\s/g, '') }))
  const expected = normalize([original]); const actual = normalize(units)
  return expected.length === actual.length && expected.every((line, i) => sameSpeech(line, actual[i])) ? [] : [{
    code: 'DIALOGUE_SOURCE_MISMATCH', severity: 'error', unitId: original.id,
    message: '重生成单元的台词与原单元不一致，请保留该单元全部原台词与顺序。'
  }]
}

function sameSpeech(expected: Speech, actual: Speech): boolean {
  return expected.text === actual.text && (!expected.speaker || !actual.speaker || expected.speaker === actual.speaker)
}

export function dialogueIssues(units: StoryboardUnit[], body: string, partial = false): GateIssue[] {
  const expected = scriptSpeech(body).map(s => ({ ...s, text: s.text.replace(/\s/g, '') }))
  const actual = units.flatMap(u => u.shots.flatMap(shotSpeech)).map(s => ({ ...s, text: s.text.replace(/\s/g, '') }))
  const issue = (code: string, message: string): GateIssue => ({ code, message, severity: 'error' })
  if (!expected.length) {
    if (!actual.length) return []
    if (/^\s*SC\d+\s+[日夜]\s+[内外]/m.test(body)) return [issue('DIALOGUE_SOURCE_MISMATCH', '正式稿没有对白，分镜不得新增对白。')]
    return [{ code: 'DIALOGUE_UNVERIFIED', severity: 'warn',
      message: '正式稿未识别出标准 M1 台词，请人工核对分镜对白；建议使用独立角色行与对白行。' }]
  }
  if (partial) {
    let at = 0
    for (const line of actual) {
      const found = expected.findIndex((item, i) => i >= at && sameSpeech(item, line))
      if (found < 0) return [issue('DIALOGUE_SOURCE_MISMATCH', `分镜台词、说话人或顺序与原稿不符：${line.text.slice(0, 40)}`)]
      at = found + 1
    }
    return []
  }
  if (expected.length !== actual.length || expected.some((line, i) => !sameSpeech(line, actual[i]))) {
    return [issue('DIALOGUE_SOURCE_MISMATCH', '分镜台词与正式稿不一致，存在遗漏、新增、改写、重复、说话人或顺序变化，请保留原台词后再保存。')]
  }
  return actual.some(line => !line.speaker) ? [{ code: 'DIALOGUE_SPEAKER_UNVERIFIED', severity: 'warn',
    message: '部分分镜台词缺少明确说话人，请按“角色：「原台词」；语气：……”补充后核对。' }] : []
}
