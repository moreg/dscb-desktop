import { join } from 'path'
import { readText, parseDoc, parseTable } from './md-parser'
import type { VolumeOutline } from '../../../shared/types'

/**
 * 写作前的追踪上下文（来自 `追踪/` 目录）。
 * 这些文件由 opening-service 在开书时创建，记录写作过程中的状态变化。
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
 * 返回 null 表示 `追踪/` 目录不存在（老项目或未开书）。
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

    // 4 个文件全空 → 视为追踪目录不存在
    if (!statesText && !timelineText && !progressText && !issuesText) return null

    const result: TrackingContext = {
      characterStates: statesText ? parseCharacterStates(statesText) : [],
      stateChanges: statesText ? parseStateChanges(statesText, chapterNumber) : [],
      timeline: timelineText ? extractTimelineTable(timelineText) : '',
      recentProgress: progressText ? parseProgress(progressText) : [],
      openIssues: issuesText ? parseIssues(issuesText) : []
    }

    // 内容全空（项目创建时的空模板）→ 返回 null，避免注入空段
    const hasContent =
      result.characterStates.length > 0 ||
      result.stateChanges.length > 0 ||
      result.timeline.trim() !== '' ||
      result.recentProgress.length > 0 ||
      result.openIssues.length > 0
    if (!hasContent) return null

    return result
  }
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
    const name = idx.name >= 0 ? row[idx.name].trim() : ''
    if (!name || name === '-') continue
    result.push({
      name,
      power: idx.power >= 0 ? row[idx.power].trim() : '',
      stance: idx.stance >= 0 ? row[idx.stance].trim() : '',
      goal: idx.goal >= 0 ? row[idx.goal].trim() : '',
      items: idx.items >= 0 ? row[idx.items].trim() : '',
      relations: idx.relations >= 0 ? row[idx.relations].trim() : '',
      updateChapter: idx.updateCh >= 0 ? parseChapterNum(row[idx.updateCh]) ?? 0 : 0
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
    const ch = parseChapterNum(idxCh >= 0 ? row[idxCh] : '')
    if (ch == null || ch > chapterNumber) continue
    const name = idxName >= 0 ? row[idxName].trim() : ''
    const change = idxChange >= 0 ? row[idxChange].trim() : ''
    if (name) result.push({ chapter: ch, name, change })
  }
  return result
}

/**
 * 提取时间线文件中的「历史事件与小说事件对照表」节 body（含表格）。
 * 优先取对照表节；若不存在则取全书时间轴图后的文字。
 */
function extractTimelineTable(text: string): string {
  const doc = parseDoc(text)
  const sec = doc.sections.find((s) => s.title.includes('对照') || s.title.includes('历史事件'))
  if (sec) return sec.body.trim()
  // 回退：取第一个 H2 节的 body（可能是 mermaid 图，对 LLM 也有参考价值）
  if (doc.sections.length > 0) return doc.sections[0].body.trim()
  return ''
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
    const date = idx.date >= 0 ? row[idx.date].trim() : ''
    if (!date || date === '—') continue
    entries.push({
      date,
      chapter: idx.chapter >= 0 ? row[idx.chapter].trim() : '',
      summary: idx.summary >= 0 ? row[idx.summary].trim() : '',
      nextGoal: idx.nextGoal >= 0 ? row[idx.nextGoal].trim() : '',
      blocker: idx.blocker >= 0 ? row[idx.blocker].trim() : ''
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
    const status = idx.status >= 0 ? row[idx.status].trim() : ''
    const problem = idx.problem >= 0 ? row[idx.problem].trim() : ''
    if (!problem || problem === '—') continue
    // 只取未关闭的问题
    if (status && !status.includes('待处理') && !status.includes('处理中') && !status.includes('未解决')) continue
    result.push({
      date: idx.date >= 0 ? row[idx.date].trim() : '',
      problem,
      analysis: idx.analysis >= 0 ? row[idx.analysis].trim() : '',
      fix: idx.fix >= 0 ? row[idx.fix].trim() : '',
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
