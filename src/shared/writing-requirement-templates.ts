export interface WritingRequirementTemplate {
  id: string
  name: string
  description: string
  requirements: string[]
}

export const DEFAULT_WRITING_REQUIREMENT_TEMPLATES: WritingRequirementTemplate[] = [
  {
    id: 'tomato-high-tension',
    name: '番茄爽文推进',
    description: '适合网文主线推进，强调强情绪、快节奏和章末钩子。',
    requirements: [
      '开头三段内抛出冲突或情绪爆点，不要慢热铺垫',
      '正文按事件推进，少空泛抒情，多动作、反应和结果',
      '每个场景都要服务主线推进，避免无效闲聊',
      '结尾必须留下推动读者继续看的钩子'
    ]
  },
  {
    id: 'dialogue-character-voice',
    name: '角色对话鲜明',
    description: '适合人物对手戏，强调台词区分度、语气和潜台词。',
    requirements: [
      '人物对话要符合各自身份、性格和当下情绪',
      '台词尽量短促有来回，避免大段解释背景',
      '通过停顿、动作和反应补足潜台词，不要只靠直说',
      '关键情绪变化优先通过对话碰撞来体现'
    ]
  },
  {
    id: 'suspense-clue-burial',
    name: '悬念线索埋设',
    description: '适合推进谜团与伏笔，强调信息控制和线索投放。',
    requirements: [
      '正文中自然埋入 1 到 2 个后续可回收的线索',
      '线索要藏在人物反应、细节异样或对话错位里',
      '不要一次性把谜底说透，要保留读者猜测空间',
      '章末用事件或一句对话把悬念再往前推一步'
    ]
  },
  {
    id: 'light-humor-relaxed',
    name: '轻松幽默节奏',
    description: '适合轻快桥段，强调口语感、节奏感和趣味互动。',
    requirements: [
      '整体语气轻快自然，允许适度俏皮和吐槽',
      '人物互动要有来有回，避免一本正经地平铺直叙',
      '笑点优先落在反差、误会和嘴上交锋，不要硬抖包袱',
      '轻松氛围下仍要保持剧情推进，不能只聊天不办事'
    ]
  }
]

export function cloneWritingRequirementTemplates(
  templates: WritingRequirementTemplate[]
): WritingRequirementTemplate[] {
  return templates.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    requirements: [...item.requirements]
  }))
}

export function getWritingRequirementTemplate(
  templateId?: string | null,
  templates: WritingRequirementTemplate[] = DEFAULT_WRITING_REQUIREMENT_TEMPLATES
): WritingRequirementTemplate | null {
  if (!templateId) return null
  return templates.find((item) => item.id === templateId) ?? null
}

export function normalizeWritingRequirementLines(text?: string | null): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  if (!text) return []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[\-\*\d\.\)\s、]+/, '').trim()
    if (!line || seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

export function composeWritingRequirements(
  templateId?: string | null,
  customText?: string | null,
  legacyText?: string | null,
  templates: WritingRequirementTemplate[] = DEFAULT_WRITING_REQUIREMENT_TEMPLATES
): string {
  const legacy = legacyText?.trim() ?? ''
  if (legacy && (templateId || customText)) {
    return legacy
  }

  const merged: string[] = []
  const seen = new Set<string>()

  const template = getWritingRequirementTemplate(templateId, templates)
  for (const line of template?.requirements ?? []) {
    const text = line.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    merged.push(text)
  }

  for (const line of normalizeWritingRequirementLines(customText)) {
    if (seen.has(line)) continue
    seen.add(line)
    merged.push(line)
  }

  if (merged.length === 0) {
    return legacyText?.trim() ?? ''
  }

  return merged.join('\n')
}
