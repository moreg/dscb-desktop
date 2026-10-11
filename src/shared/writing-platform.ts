export interface WritingPlatformConfig {
  platform: 'fanqie' | 'qimao' | null
  /** 保留项目约定的频道、章名策略等，避免只传平台名称。 */
  text: string
}

export function parseWritingPlatformConfig(text: string): WritingPlatformConfig {
  // 优先明确字段；配置中的对比说明可能同时提到两个平台，不能全文猜测。
  const lines = text.replace(/\*\*|__|`/g, '').split(/\r?\n/)
  const fields = lines.flatMap((line) => {
    const match = line.match(/^\s*(?:[-*+]\s*)?(?:目标平台|小说平台|平台)\s*[：:]\s*(.+)$/)
      ?? line.match(/^\s*\|\s*(?:目标平台|小说平台|平台)\s*\|\s*([^|]+)\|/)
    return match ? [match[1].trim()] : []
  })
  const values = fields.length ? fields : lines.map((line) => line.replace(/^\s*#+\s*/, '').trim())
  const platforms = new Set<'fanqie' | 'qimao'>()
  for (const value of values) {
    const candidate = value.toLowerCase()
    if (fields.length || /^(?:番茄(?:小说)?|七猫(?:小说|中文网)?|7猫(?:小说|中文网)?|fanqie|qimao)$/.test(candidate)) {
      if (/番茄|\bfanqie\b/.test(candidate)) platforms.add('fanqie')
      if (/七猫|7猫|\bqimao\b/.test(candidate)) platforms.add('qimao')
    }
  }
  return { platform: platforms.size === 1 ? [...platforms][0] : null, text: text.trim() }
}

export function renderWritingPlatformConfig(config: WritingPlatformConfig): string {
  const label = config.platform === 'qimao' ? '七猫' : config.platform === 'fanqie' ? '番茄' : '未明确'
  return [
    '## 项目平台配置（来源：设定/平台配置.md）',
    `目标平台：${label}。以这份项目配置为平台依据，文件里的其他平台比较、示例不代表本书的平台。`,
    '遵循配置中明确的频道、题材、章名策略与编辑要求；与通用写作守则冲突时，平台相关约定以此配置为准。本次用户明确要求优先。',
    '本次字数预算、续写衔接和正文输出格式仍按本次任务执行，日更计划不能作为单章最低字数。平台未明确时保留本书既有风格，不自行切换平台。',
    ...(config.platform === 'qimao' ? ['本书按七猫项目约定写作，不套用番茄专属的章名长度、热梗或固定打脸节奏。章名须具体清楚、贴合内容、不剧透；节奏按题材和已确认细纲执行。'] : []),
    config.text
  ].join('\n\n')
}
