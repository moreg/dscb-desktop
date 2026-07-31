export interface ProjectInspirationInput {
  genre?: string
  projectName?: string
  description?: string
  synopsis?: string
  theme?: string
  mainLine?: string
  detailedPlots?: string
  proseExcerpt?: string
  extraDirection?: string
  variationSeed?: string
  excludedNames?: string[]
}

export interface ProjectInspirationResult {
  name: string
  description: string
}

export function buildProjectInspirationPrompt(input: ProjectInspirationInput): string {
  const genre = input.genre?.trim() || '未指定，由你选择有市场辨识度的题材方向'
  const excluded = input.excludedNames?.filter(Boolean).join('、') || '无'

  return `你是一名熟悉番茄小说读者阅读习惯的中文网文策划编辑。请根据下面这本书的真实内容，重新生成一个匹配内容、具有移动端点击吸引力的书名和简介。只学习平台常见的包装结构，不得照搬、仿写或提及任何具体作品。

题材：${genre}
当前书名：${input.projectName?.trim() || '未命名'}
现有简介：${input.description?.trim() || '无'}
故事梗概：${input.synopsis?.trim() || '无'}
主题：${input.theme?.trim() || '无'}
主线：${input.mainLine?.trim() || '无'}
部分章节情节：${input.detailedPlots?.trim() || '无'}
正文片段：${input.proseExcerpt?.trim() || '无'}
用户额外方向：${input.extraDirection?.trim() || '无'}
本次随机创意签：${input.variationSeed?.trim() || '自由发挥'}
本轮禁止重复的旧书名：${excluded}

要求：
1. 不能脱离已有故事内容，不得虚构会改变核心剧情的新设定。
2. 书名优先采用“主角身份或处境 + 核心反差、独特机制或强结果”的高信息密度结构；可以是短标题，也可以是有节奏的长标题。建议 6—18 个汉字，不要使用《》包裹，且不能与禁用书名重复。
3. 简介建议 140—260 个汉字，按“题材标签（可选）→ 主角身份与开局变故 → 独特机制或关键关系 → 具体冲突升级 → 爽点、情感期待或悬念钩子”组织。
4. 开头两句内必须让读者知道“谁遇到了什么事”；多写具体人物、行动、代价和反差，少写世界观说明、主题总结与空泛赞美。
5. 标签只选 2—5 个确实符合内容的关键词，可写成“【标签+标签】”；悬疑、现实、传统文学气质等不适合标签先行的题材可以省略。不得添加正文没有的“系统、重生、无敌、团宠”等卖点。
6. 可按题材加入一小段对话、排比或场景化短句来增强节奏，但不要机械套模板；结尾应留下明确的冲突、选择、秘密或成长期待。
7. 不写“年度爆款、全网火爆”等无法验证的宣传语，不写作者寄语、避雷说明、求收藏或 PS，不堆砌感叹号和网络热词。
8. “随机创意签”只控制包装角度和文案气质，不能改变书里的事实。资料不足时宁可保守表达，也不要自行补出关键设定。
9. 不要写分析过程，不要使用“这是一个关于……”等空泛开头。
10. 只输出下面格式的严格 JSON，JSON 字符串中的换行必须转义为 \\n，不要输出 Markdown 代码块或其他文字：
{"name":"书名","description":"简介"}`
}

export function parseProjectInspiration(raw: string): ProjectInspirationResult {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('AI 返回内容中没有可解析的 JSON')

  let value: unknown
  try {
    value = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    throw new Error('AI 返回格式不正确，请重新生成')
  }
  if (!value || typeof value !== 'object') throw new Error('AI 返回格式不正确，请重新生成')

  const record = value as Record<string, unknown>
  const nameValue = record.name ?? record.title ?? record.bookName ?? record['书名']
  const descriptionValue =
    record.description ?? record.introduction ?? record.summary ?? record['简介']
  const name = typeof nameValue === 'string' ? nameValue.trim().replace(/^《|》$/g, '') : ''
  const description = typeof descriptionValue === 'string' ? descriptionValue.trim() : ''

  if (!name || !description) throw new Error('AI 没有返回完整的书名和简介，请重新生成')
  if (name.length > 255) throw new Error('AI 生成的书名过长，请重新生成')
  if (description.length > 5000) throw new Error('AI 生成的简介过长，请重新生成')
  return { name, description }
}
