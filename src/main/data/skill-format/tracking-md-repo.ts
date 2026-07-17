import { join } from 'path'
import { readText, parseDoc, parseTable } from './md-parser'
import type { VolumeOutline } from '../../../shared/types'

/**
 * 写作前的追踪上下文（来自 `追踪/` 目录）。
 * 这些文件记录写作过程中的状态变化（角色状态、时间线、上下文、问题等）。
 * 用于让续写 LLM 知晓角色当前实力/立场、近期进度、未解决问题。
 */
export interface TrackingContext {
  /** 角色状态快照（来自 追踪/角色状态.md 的「当前状态」表） */
  characterStates: CharacterStateSnapshot[]
  /** 状态变更记录（来自「状态变更记录」表，截到 chapterNumber 及之前） */
  stateChanges: StateChangeRecord[]
  /** 时间线文字（来自 追踪/时间线.md 的「历史事件与小说事件对照表」节 body） */
  timeline: string
  /** 日更进度摘要（来自 追踪/上下文.md，取最后 3 条） */
  recentProgress: ProgressEntry[]
  /** 待处理问题（来自 追踪/问题记录.md，过滤状态含「待处理/处理中」） */
  openIssues: IssueRecord[]
}

export interface CharacterStateSnapshot {
  name: string
  /** 当前实力（如「暗劲；铁罗盘 Lv.1」） */
  power: string
  /** 当前立场 */
  stance: string
  /** 当前目标 */
  goal: string
  /** 关键道具 */
  items: string
  /** 关系快照 */
  relations: string
  /** 更新章节号 */
  updateChapter: number
}

export interface StateChangeRecord {
  chapter: number
  name: string
  change: string
}

export interface ProgressEntry {
  date: string
  chapter: string
  summary: string
  nextGoal: string
  blocker: string
}

export interface IssueRecord {
  date: string
  problem: string
  analysis: string
  fix: string
  status: string
}

/**
 * 读取 `追踪/` 目录下的 4 个追踪文件，聚合为 TrackingContext。
 * 任一文件缺失时对应字段返回空数组/空串，不报错。
 * 返回 null 表示 `追踪/` 目录不存在。
 */
export class TrackingMdRepo {
  constructor(private readonly projectDir: string) {}

  async read(chapterNumber: number): Promise<TrackingContext | null> {
    const dir = join(this.projectDir, '追踪')
    const [statesText, timelineText, progressText, issuesText] = await Promise.all([
      readText(join(dir, '角色状态.md')),
      readText(join(dir, '时间线.md')),
      readText(join(dir, '上下文.md')),
      readText(join(dir, '问题记录.md'))
    ])

    // 4 个文件全空 -> 视为追踪目录不存在
    if (!statesText && !timelineText && !progressText && !issuesText) return null

    const rawTimeline = timelineText ? extractTimelineTable(timelineText) : ''
    // 开书骨架只有表头、无「第 N 章」数据行时视为空，避免续写 prompt 注入空表噪音
    const timeline = hasTimelineDataRows(rawTimeline) ? rawTimeline : ''

    const result: TrackingContext = {
      characterStates: statesText ? parseCharacterStates(statesText) : [],
      stateChanges: statesText ? parseStateChanges(statesText, chapterNumber) : [],
      timeline,
      recentProgress: progressText ? parseProgress(progressText) : [],
      openIssues: issuesText ? parseIssues(issuesText) : []
    }

    // 内容全空（项目创建时的空模板）-> 返回 null，避免注入空段
    const hasContent =
      result.characterStates.length > 0 ||
      result.stateChanges.length > 0 ||
      result.timeline.trim() !== '' ||
      result.recentProgress.length > 0 ||
      result.openIssues.length > 0
    if (!hasContent) return null

    return result
  }

  /**
   * 为 UI 展示读取全部追踪数据（不按章号过滤状态变更、不截断进度、含全部问题）。
   * 与 read() 的区别：read() 面向续写 prompt（按章号过滤/截断/只取未关闭问题），
   * readForDisplay() 面向追踪页 UI（展示全量数据供用户查看）。
   * 返回 null 表示 `追踪/` 目录不存在。
   */
  async readForDisplay(): Promise<TrackingDisplayData | null> {
    const dir = join(this.projectDir, '追踪')
    const [statesText, timelineText, progressText, issuesText] = await Promise.all([
      readText(join(dir, '角色状态.md')),
      readText(join(dir, '时间线.md')),
      readText(join(dir, '上下文.md')),
      readText(join(dir, '问题记录.md'))
    ])

    if (!statesText && !timelineText && !progressText && !issuesText) return null

    return {
      characterStates: statesText ? parseCharacterStates(statesText) : [],
      stateChanges: statesText ? parseAllStateChanges(statesText) : [],
      timeline: timelineText ? extractTimelineTable(timelineText) : '',
      recentProgress: progressText ? parseAllProgress(progressText) : [],
      openIssues: issuesText ? parseIssues(issuesText) : [],
      allIssues: issuesText ? parseAllIssues(issuesText) : []
    }
  }
}

/**
 * 展示用追踪数据：与 TrackingContext 字段一致，但 stateChanges 不按章号过滤、
 * recentProgress 不截断、allIssues 含全部问题（含已关闭）。
 */
export interface TrackingDisplayData {
  characterStates: CharacterStateSnapshot[]
  stateChanges: StateChangeRecord[]
  timeline: string
  recentProgress: ProgressEntry[]
  openIssues: IssueRecord[]
  allIssues: IssueRecord[]
}

/**
 * 解析「当前状态」表（H2「当前状态」节下的表）。
 * 表头：角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 更新章节
 */
function parseCharacterStates(text: string): CharacterStateSnapshot[] {
  const doc = parseDoc(text)
  const sec = doc.sections.find((s) => s.title.includes('当前状态'))
  const body = sec ? sec.body : doc.body
  const { headers, rows } = parseTable(body)
  if (headers.length < 5) return []
  const idx = {
    name: headers.findIndex((h) => h.includes('角色') || h.includes('姓名')),
    power: headers.findIndex((h) => h.includes('实力')),
    stance: headers.findIndex((h) => h.includes('立场')),
    goal: headers.findIndex((h) => h.includes('目标')),
    items: headers.findIndex((h) => h.includes('道具')),
    relations: headers.findIndex((h) => h.includes('关系')),
    updateCh: headers.findIndex((h) => h.includes('更新') && h.includes('章节'))
  }
  const result: CharacterStateSnapshot[] = []
  for (const row of rows) {
    const name = cell(row, idx.name)
    if (!name || name === '-') continue
    result.push({
      name,
      power: cell(row, idx.power),
      stance: cell(row, idx.stance),
      goal: cell(row, idx.goal),
      items: cell(row, idx.items),
      relations: cell(row, idx.relations),
      updateChapter: parseChapterNum(cell(row, idx.updateCh)) ?? 0
    })
  }
  return result
}

/**
 * 解析「状态变更记录」表，过滤章号 <= chapterNumber。
 * 表头：章节 | 角色 | 变更内容
 */
function parseStateChanges(text: string, chapterNumber: number): StateChangeRecord[] {
  const doc = parseDoc(text)
  const sec = doc.sections.find((s) => s.title.includes('状态变更') || s.title.includes('变更记录'))
  if (!sec) return []
  const { headers, rows } = parseTable(sec.body)
  if (headers.length < 3) return []
  const idxCh = headers.findIndex((h) => h.includes('章节'))
  const idxName = headers.findIndex((h) => h.includes('角色'))
  const idxChange = headers.findIndex((h) => h.includes('变更'))
  const result: StateChangeRecord[] = []
  for (const row of rows) {
    const ch = parseChapterNum(cell(row, idxCh))
    if (ch == null || ch > chapterNumber) continue
    const name = cell(row, idxName)
    const change = cell(row, idxChange)
    if (name) result.push({ chapter: ch, name, change })
  }
  return result
}

/**
 * 提取时间线文件中的表格 body（含表格），用于注入续写 prompt。
 * 兼容两种结构：
 * - H2 节（标题含「对照」/「历史事件」）下的表（技能规范格式）
 * - H1 `# 时间线` 下的裸表（开书流程产出的格式）
 * 找不到 H2 节时回退到 doc.body（H1 下的全部正文，含裸表）。
 */
function extractTimelineTable(text: string): string {
  const doc = parseDoc(text)
  const sec = doc.sections.find((s) => s.title.includes('对照') || s.title.includes('历史事件'))
  if (sec) return sec.body.trim()
  // 回退：H1 下的裸表（开书格式）或第一个 H2 节
  if (doc.body.trim()) return doc.body.trim()
  if (doc.sections.length > 0) return doc.sections[0].body.trim()
  return ''
}

/** 时间线是否含真实数据行（排除仅表头/分隔行的空骨架） */
function hasTimelineDataRows(timeline: string): boolean {
  if (!timeline.trim()) return false
  // 数据行通常含「第 N 章」或非表头的 |…|
  if (/第\s*\d+\s*章/.test(timeline)) return true
  const lines = timeline.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (const line of lines) {
    if (!line.startsWith('|')) {
      // 非表格正文（如说明句）也算有内容
      if (!line.startsWith('#') && line.length > 2) return true
      continue
    }
    if (line.includes('---')) continue
    if (/章节|事件|时间|角色|详细|描述|对照/.test(line) && !/第\s*\d+/.test(line)) continue
    // 其它表格行视为数据
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean)
    if (cells.some((c) => c && c !== '-')) return true
  }
  return false
}

/**
 * 解析日更进度表，取最后 3 条。
 * 表头：日期 | 章节 | 进度摘要 | 下一章目标 | 阻塞点
 */
function parseProgress(text: string): ProgressEntry[] {
  const doc = parseDoc(text)
  const { headers, rows } = parseTable(doc.body)
  if (headers.length < 4) return []
  const idx = {
    date: headers.findIndex((h) => h.includes('日期')),
    chapter: headers.findIndex((h) => h.includes('章节')),
    summary: headers.findIndex((h) => h.includes('进度') || h.includes('摘要')),
    nextGoal: headers.findIndex((h) => h.includes('下一章') || h.includes('目标')),
    blocker: headers.findIndex((h) => h.includes('阻塞') || h.includes('问题'))
  }
  const entries: ProgressEntry[] = []
  for (const row of rows) {
    const date = cell(row, idx.date)
    if (!date || date === '-') continue
    entries.push({
      date,
      chapter: cell(row, idx.chapter),
      summary: cell(row, idx.summary),
      nextGoal: cell(row, idx.nextGoal),
      blocker: cell(row, idx.blocker)
    })
  }
  return entries.slice(-3)
}

/**
 * 解析问题记录表，过滤状态含「待处理/处理中」。
 * 表头：日期 | 问题描述 | 原因分析 | 修正方案 | 状态
 */
function parseIssues(text: string): IssueRecord[] {
  const doc = parseDoc(text)
  const { headers, rows } = parseTable(doc.body)
  if (headers.length < 4) return []
  const idx = {
    date: headers.findIndex((h) => h.includes('日期')),
    problem: headers.findIndex((h) => h.includes('问题')),
    analysis: headers.findIndex((h) => h.includes('原因') || h.includes('分析')),
    fix: headers.findIndex((h) => h.includes('修正') || h.includes('方案') || h.includes('解决')),
    status: headers.findIndex((h) => h.includes('状态'))
  }
  const result: IssueRecord[] = []
  for (const row of rows) {
    const status = cell(row, idx.status)
    const problem = cell(row, idx.problem)
    if (!problem || problem === '-') continue
    // 只取未关闭的问题
    if (status && !status.includes('待处理') && !status.includes('处理中') && !status.includes('未解决')) continue
    result.push({
      date: cell(row, idx.date),
      problem,
      analysis: cell(row, idx.analysis),
      fix: cell(row, idx.fix),
      status
    })
  }
  return result
}

/** 「第 3 章」→ 3；「第 30/65 章」→ 30；无数字 → undefined */
function parseChapterNum(text: string): number | undefined {
  if (!text) return undefined
  const m = text.match(/(\d+)/)
  return m ? parseInt(m[1], 10) : undefined
}

/**
 * 安全取表格单元格：列越界（row 比 headers 短）时返回空串，避免 undefined.trim() 崩溃。
 * 用户手写的 markdown 表格常有列数不齐的行（如引用块、附注表），parseTable 不区分连续块。
 */
function cell(row: string[], i: number): string {
  return i >= 0 && i < row.length ? row[i].trim() : ''
}

/**
 * 解析全部状态变更记录（不按章号过滤），供追踪页 UI 展示。
 */
function parseAllStateChanges(text: string): StateChangeRecord[] {
  const doc = parseDoc(text)
  const sec = doc.sections.find((s) => s.title.includes('状态变更') || s.title.includes('变更记录'))
  if (!sec) return []
  const { headers, rows } = parseTable(sec.body)
  if (headers.length < 3) return []
  const idxCh = headers.findIndex((h) => h.includes('章节'))
  const idxName = headers.findIndex((h) => h.includes('角色'))
  const idxChange = headers.findIndex((h) => h.includes('变更'))
  const result: StateChangeRecord[] = []
  for (const row of rows) {
    const ch = parseChapterNum(cell(row, idxCh))
    if (ch == null) continue
    const name = cell(row, idxName)
    const change = cell(row, idxChange)
    if (name) result.push({ chapter: ch, name, change })
  }
  return result
}

/**
 * 解析全部日更进度（不截断），供追踪页 UI 展示。
 */
function parseAllProgress(text: string): ProgressEntry[] {
  const doc = parseDoc(text)
  const { headers, rows } = parseTable(doc.body)
  if (headers.length < 4) return []
  const idx = {
    date: headers.findIndex((h) => h.includes('日期')),
    chapter: headers.findIndex((h) => h.includes('章节')),
    summary: headers.findIndex((h) => h.includes('进度') || h.includes('摘要')),
    nextGoal: headers.findIndex((h) => h.includes('下一章') || h.includes('目标')),
    blocker: headers.findIndex((h) => h.includes('阻塞') || h.includes('问题'))
  }
  const entries: ProgressEntry[] = []
  for (const row of rows) {
    const date = cell(row, idx.date)
    if (!date || date === '-') continue
    entries.push({
      date,
      chapter: cell(row, idx.chapter),
      summary: cell(row, idx.summary),
      nextGoal: cell(row, idx.nextGoal),
      blocker: cell(row, idx.blocker)
    })
  }
  return entries
}

/**
 * 解析全部问题记录（含已关闭），供追踪页 UI 展示。
 */
function parseAllIssues(text: string): IssueRecord[] {
  const doc = parseDoc(text)
  const { headers, rows } = parseTable(doc.body)
  if (headers.length < 4) return []
  const idx = {
    date: headers.findIndex((h) => h.includes('日期')),
    problem: headers.findIndex((h) => h.includes('问题')),
    analysis: headers.findIndex((h) => h.includes('原因') || h.includes('分析')),
    fix: headers.findIndex((h) => h.includes('修正') || h.includes('方案') || h.includes('解决')),
    status: headers.findIndex((h) => h.includes('状态'))
  }
  const result: IssueRecord[] = []
  for (const row of rows) {
    const status = cell(row, idx.status)
    const problem = cell(row, idx.problem)
    if (!problem || problem === '-') continue
    result.push({
      date: cell(row, idx.date),
      problem,
      analysis: cell(row, idx.analysis),
      fix: cell(row, idx.fix),
      status
    })
  }
  return result
}
