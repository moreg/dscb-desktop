import type { BenchmarkArtifacts } from './benchmark-resolver'

/**
 * 对标召回层：把拆文产物（情绪模块.md/节奏.md/文风.md）提炼成精简的写作召回片段。
 *
 * 不能整篇塞进 prompt（浪费 token + 干扰），按 oh-story-claudecode 的召回契约提取关键：
 * - 情绪模块：EM-* 模块卡的「情绪链 + 戏剧单元 + 复现步骤」
 * - 节奏：爆发节奏总结 + 爽点循环结构
 * - 文风：句长/标点/对话潜台词要点（非全文）
 */

export interface BenchmarkRecall {
  /** 召回的书名 */
  bookName: string
  /** 召回的情绪模块（精简，≤1500 字） */
  emotionRecall: string
  /** 召回的节奏参照（精简，≤1000 字） */
  rhythmRecall: string
  /** 召回的文风约束（精简，≤1200 字） */
  styleRecall: string
  /** 召回的可借鉴套路（来自拆文报告，≤600 字） */
  techniqueRecall: string
}

/** 最大召回字符数（单类） */
const LIMITS = {
  emotion: 1500,
  rhythm: 1000,
  style: 1200,
  technique: 600
}

/**
 * 从 BenchmarkArtifacts 召回精简片段。
 * 缺失某类产物时该字段为空字符串（不影响其他类）。
 */
export function recallBenchmark(artifacts: BenchmarkArtifacts): BenchmarkRecall {
  return {
    bookName: artifacts.bookName,
    emotionRecall: artifacts.emotionModuleMd
      ? extractEmotionRecall(artifacts.emotionModuleMd)
      : '',
    rhythmRecall: artifacts.rhythmMd
      ? extractRhythmRecall(artifacts.rhythmMd)
      : '',
    styleRecall: artifacts.styleMd
      ? extractStyleRecall(artifacts.styleMd)
      : '',
    techniqueRecall: artifacts.reportMd
      ? extractTechniqueRecall(artifacts.reportMd)
      : ''
  }
}

/**
 * 多本对标书的召回合并（按顺序拼接，每本独立标注）。
 */
export function mergeRecalls(recalls: BenchmarkRecall[]): {
  emotion: string
  rhythm: string
  style: string
  technique: string
  bookNames: string[]
} {
  if (recalls.length === 0) {
    return { emotion: '', rhythm: '', style: '', technique: '', bookNames: [] }
  }
  const bookNames = recalls.map((r) => r.bookName)
  const joinIfAny = (kind: 'emotionRecall' | 'rhythmRecall' | 'styleRecall' | 'techniqueRecall'): string =>
    recalls
      .filter((r) => r[kind].trim())
      .map((r) => `【对标《${r.bookName}》】\n${r[kind]}`)
      .join('\n\n---\n\n')
  return {
    emotion: joinIfAny('emotionRecall'),
    rhythm: joinIfAny('rhythmRecall'),
    style: joinIfAny('styleRecall'),
    technique: joinIfAny('techniqueRecall'),
    bookNames
  }
}

/* =========================================================
   各类召回的提取逻辑（从 markdown 提炼关键段落）
   ========================================================= */

/** 情绪模块召回：提取「可复现模块卡」+「读者需求/情绪引擎」+「重组指南」 */
function extractEmotionRecall(md: string): string {
  const sections: string[] = []
  // 读者需求 / 情绪引擎 表
  const needsSection = extractSection(md, ['读者需求', '情绪引擎'])
  if (needsSection) sections.push(needsSection.slice(0, LIMITS.emotion / 3))
  // 可复现模块卡（EM-001...）
  const modulesSection = extractSection(md, ['可复现模块卡', '可复现模块'])
  if (modulesSection) sections.push(modulesSection.slice(0, LIMITS.emotion / 2))
  // 重组与复现指南
  const guideSection = extractSection(md, ['重组与复现指南', '重组指南'])
  if (guideSection) sections.push(guideSection.slice(0, LIMITS.emotion / 4))
  return sections.join('\n\n').slice(0, LIMITS.emotion)
}

/** 节奏召回：提取「爆发节奏总结」+「爽点循环索引」要点 */
function extractRhythmRecall(md: string): string {
  const sections: string[] = []
  const summarySection = extractSection(md, ['爆发节奏总结', '爆发节奏'])
  if (summarySection) sections.push(summarySection.slice(0, LIMITS.rhythm / 2))
  const cycleSection = extractSection(md, ['爽点循环索引', '爽点循环'])
  if (cycleSection) sections.push(cycleSection.slice(0, LIMITS.rhythm / 2))
  return sections.join('\n\n').slice(0, LIMITS.rhythm)
}

/** 文风召回：提取「整体语感」+「对话技法」+「情绪交替」+「原文锚点」要点 */
function extractStyleRecall(md: string): string {
  const sections: string[] = []
  for (const heading of ['整体语感', '对话技法', '情绪交替模式', '可借鉴技巧']) {
    const section = extractSection(md, [heading])
    if (section) sections.push(section.slice(0, LIMITS.style / 4))
  }
  // 原文锚点片段（取第一段示例，控制长度）
  const anchorSection = extractSection(md, ['原文锚点片段', '原文锚点'])
  if (anchorSection) {
    // 只取第一个锚点块（### 片段 A）
    const firstAnchor = anchorSection.split(/###\s*片段/)[0] || anchorSection.slice(0, 400)
    sections.push('原文锚点示例：\n' + firstAnchor.slice(0, 400))
  }
  return sections.join('\n\n').slice(0, LIMITS.style)
}

/** 写法技巧召回：从拆文报告提取「可借鉴套路」+「写法技巧」 */
function extractTechniqueRecall(md: string): string {
  const sections: string[] = []
  const tropes = extractSection(md, ['可借鉴套路', '可借鉴'])
  if (tropes) sections.push(tropes.slice(0, LIMITS.technique / 2))
  const techniques = extractSection(md, ['写法技巧'])
  if (techniques) sections.push(techniques.slice(0, LIMITS.technique / 2))
  return sections.join('\n\n').slice(0, LIMITS.technique)
}

/**
 * 从 markdown 提取一个章节（从标题到下一个同级或更高级标题）。
 * @param headings 候选标题关键词（按优先级）
 */
function extractSection(md: string, headings: string[]): string {
  for (const heading of headings) {
    // 匹配 ## 或 ### 标题（heading 是关键词，标题行可能含其他字）
    const re = new RegExp(`^(#{1,3})\\s+[^\\n]*${escapeRegExp(heading)}[^\\n]*$`, 'm')
    const match = re.exec(md)
    if (!match) continue
    const level = match[1].length
    const startIdx = match.index
    // 找下一个同级或更高级标题
    const afterStart = startIdx + match[0].length
    const nextRe = new RegExp(`^#{1,${level}}\\s`, 'm')
    const after = md.slice(afterStart)
    const nextMatch = nextRe.exec(after)
    const endIdx = nextMatch ? afterStart + nextMatch.index : md.length
    return md.slice(startIdx, endIdx).trim()
  }
  return ''
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
