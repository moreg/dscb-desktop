import { join, resolve, relative, isAbsolute } from 'path'
import { CharacterRepo } from './memory/character-repo'
import { LocationRepo } from './memory/location-repo'
import { ItemRepo } from './memory/item-repo'
import { PlotPointRepo } from './memory/plot-point-repo'
import { ForeshadowingMdRepo } from './skill-format/foreshadowing-md-repo'
import { appendH3UnderH2, appendH2Section } from './skill-format/md-writer'
import { writeTextAtomic } from './atomic'
import { readText } from './skill-format/md-parser'
import { sanitizeForFileName } from './memory/entity-helpers'
import type { MemoryExtraction, MemoryApplyResult } from '../../shared/types'

/**
 * 记忆回写器（v4：单一真相源策略）。
 * - 新增内容（角色/地点/伏笔）：需用户确认，由 UI 调 applyNew* 方法
 *   - 角色 → 记忆/人物/<name>.md
 *   - 地点 → 记忆/地点/<name>.md
 *   - 伏笔 → 追踪/伏笔.md（PR2 单一真相源）
 * - 状态变化（伤势/情绪/位置/关系）：自动更新角色卡（CharacterRepo）
 * - 情节追加：自动追加到 记忆/剧情点/第NNN章 <title>.md
 * - 伏笔回收：自动更新 追踪/伏笔.md 状态
 */
export class MemoryWriter {
  constructor(private readonly projectDir: string) {}

  /**
   * 自动应用：状态变化 + 情节追加 + 伏笔回收。
   * 新增内容不在此方法处理（需用户确认）。
   */
  async applyAutomatic(extraction: MemoryExtraction): Promise<MemoryApplyResult> {
    const errors: string[] = []
    let stateChanges = 0
    let plotPoints = 0
    let collected = 0

    // 1. 角色状态变化：更新 记忆/人物/<name>.md 的 synopsis
    for (const change of extraction.characterStateChanges) {
      try {
        const applied = await this.updateCharacterState(
          change.name,
          change.field,
          change.newValue
        )
        if (applied) stateChanges++
      } catch (e) {
        errors.push(`角色状态更新失败 ${change.name}: ${(e as Error).message}`)
      }
    }

    // 2. 情节追加：写到 记忆/剧情点/第NNN章 <title>.md
    for (const pp of extraction.newPlotPoints) {
      try {
        const applied = await this.appendPlotPoint(extraction.chapterNumber, pp.title, pp.event, pp.coolPoint)
        if (applied) plotPoints++
      } catch (e) {
        errors.push(`情节追加失败: ${(e as Error).message}`)
      }
    }

    // 2.5 时间线追加：把本章事件追加到 追踪/时间线.md 的对照表
    if (extraction.newPlotPoints.length > 0) {
      try {
        await this.appendTimeline(extraction.chapterNumber, extraction.newPlotPoints)
      } catch (e) {
        errors.push(`时间线追加失败: ${(e as Error).message}`)
      }
    }

    // 2.6 进度摘要追加：把本章进度追加到 追踪/上下文.md 的进度表
    // 续写时 TrackingMdRepo.parseProgress 取最后 3 条注入 prompt，是「上一章写到哪」的承接信息
    try {
      await this.appendProgress(extraction.chapterNumber, extraction.newPlotPoints)
    } catch (e) {
      errors.push(`进度摘要追加失败: ${(e as Error).message}`)
    }

    // 3. 伏笔回收：更新 追踪/伏笔.md 状态
    for (const cf of extraction.collectedForeshadowings) {
      try {
        const applied = await this.collectForeshadowing(cf.content, cf.chapter)
        if (applied) collected++
      } catch (e) {
        errors.push(`伏笔回收失败 ${cf.content}: ${(e as Error).message}`)
      }
    }

    return {
      applied: {
        characters: 0,
        locations: 0,
        items: 0,
        foreshadowings: 0,
        plotPoints,
        stateChanges,
        collected
      },
      errors
    }
  }

  /** 用户确认后：应用新增角色（写 记忆/人物/<name>.md） */
  async applyNewCharacters(
    chars: MemoryExtraction['newCharacters']
  ): Promise<number> {
    const repo = new CharacterRepo(this.projectDir)
    let n = 0
    for (const c of chars) {
      try {
        await repo.create({
          name: c.name,
          role: c.role,
          identity: c.identity,
          personality: c.personality
        })
        n++
      } catch {
        // skip
      }
    }
    return n
  }

  /** 用户确认后：应用新增地点（写 记忆/地点/<name>.md） */
  async applyNewLocations(locs: MemoryExtraction['newLocations']): Promise<number> {
    const repo = new LocationRepo(this.projectDir)
    let n = 0
    for (const l of locs) {
      try {
        await repo.create({ name: l.name, category: l.category, notes: l.notes })
        n++
      } catch {
        // skip
      }
    }
    return n
  }

  /** 用户确认后：应用新增道具（写 记忆/道具/<name>.md） */
  async applyNewItems(items: MemoryExtraction['newItems']): Promise<number> {
    const repo = new ItemRepo(this.projectDir)
    let n = 0
    for (const it of items) {
      try {
        await repo.create({ name: it.name, category: it.category, notes: it.notes })
        n++
      } catch {
        // skip
      }
    }
    return n
  }

  /** 用户确认后：应用新增伏笔（写 追踪/伏笔.md） */
  async applyNewForeshadowings(
    fs: MemoryExtraction['newForeshadowings']
  ): Promise<number> {
    const repo = new ForeshadowingMdRepo(this.projectDir)
    let n = 0
    for (const f of fs) {
      try {
        await repo.create({
          content: f.content,
          expectedCollect: f.expectedCollect,
          note: f.note
        })
        n++
      } catch {
        // skip
      }
    }
    return n
  }

  /**
   * 追加角色状态变化轨迹到 customFields['状态轨迹']（不污染 synopsis 字段）。
   * 多次变化以「；」拼接，保留完整历史。返回是否实际应用。
   */
  private async updateCharacterState(
    name: string,
    field: string,
    value: string
  ): Promise<boolean> {
    const repo = new CharacterRepo(this.projectDir)
    const existing = (await repo.list()).find((c) => c.name === name)
    if (!existing) return false
    const prevTrack = existing.customFields?.['状态轨迹']
    const entry = `${field}：${value}`
    const newTrack = prevTrack ? `${prevTrack}；${entry}` : entry
    await repo.update(existing.id, { customFields: { '状态轨迹': newTrack } })
    return true
  }

  /**
   * 追加情节：写到 记忆/剧情点/第NNN章 <title>.md。
   * 旧版是 append 到 记忆系统/核心情节.md 的 H2 节下；v4 改为每章一个独立文件。
   * 返回是否实际写入（文件已存在则保留手动编辑，返回 false）。
   */
  private async appendPlotPoint(
    chapter: number,
    title: string,
    event: string,
    coolPoint?: string
  ): Promise<boolean> {
    const dir = join(this.projectDir, '记忆', '剧情点')
    const safeTitle = sanitizeForFileName(title)
    const fileName = `第${String(chapter).padStart(3, '0')}章 ${safeTitle}.md`
    const file = resolve(dir, fileName)
    const rel = relative(dir, file)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`剧情点路径越界：${title}`)
    }
    const text = await readText(file)
    if (text) return false // 已存在则不覆盖（保留手动编辑）
    const body = [
      `# 第${chapter}章 ${title}`,
      '',
      '## 描述',
      '',
      event,
      '',
      '## 字段',
      '',
      `- **核心事件**：${event}`,
      coolPoint ? `- **爽点/打脸**：${coolPoint}` : null
    ].filter((l): l is string => l !== null).join('\n') + '\n'
    await writeTextAtomic(file, body)
    return true
  }

  /**
   * 追加时间线：把本章剧情点事件追加到 追踪/时间线.md 的对照表末尾。
   * 表头格式：| 章节 | 事件名 | 时间跨度 | 涉及角色 | 详细描述 |
   * 同一章只追加一次（检测已有「第 N 章」行则跳过，避免重复）。
   */
  private async appendTimeline(
    chapter: number,
    plotPoints: MemoryExtraction['newPlotPoints']
  ): Promise<void> {
    const file = join(this.projectDir, '追踪', '时间线.md')
    const text = await readText(file)
    if (!text) return // 文件不存在，不创建（追踪/时间线.md 需项目侧先建骨架）

    // 同章已追加过则跳过（避免重复写入）；正则容忍空格变化（用户手改表格格式时不误判）
    const chapterMarker = `第 ${chapter} 章`
    const chapterSeenRe = new RegExp(`\\|\\s*第\\s*${chapter}\\s*章\\s*\\|`)
    if (chapterSeenRe.test(text)) return

    // 把所有 plotPoint 的 event 合并为详细描述
    const events = plotPoints.map((p) => p.event).filter(Boolean)
    const desc = events.join('；')
    const title = plotPoints[0]?.title ?? `第${chapter}章`
    const row = `| ${chapterMarker} | ${title} | - | - | ${desc} |`

    // 找到表格最后一行，追加在其后
    const lines = text.split(/\r?\n/)
    let lastTableRow = -1
    for (let i = 0; i < lines.length; i++) {
      if (/^\|.*\|$/.test(lines[i].trim()) && !lines[i].includes('---')) {
        lastTableRow = i
      }
    }
    if (lastTableRow >= 0) {
      lines.splice(lastTableRow + 1, 0, row)
    } else {
      // 无表格行，追加到文件末尾
      lines.push(row)
    }
    await writeTextAtomic(file, lines.join('\n'))
  }

  /**
   * 追加进度摘要：把本章进度追加到 追踪/上下文.md 的进度表末尾。
   * 表头格式：| 日期 | 章节 | 进度摘要 | 下一章目标 | 阻塞点 |
   * 续写时 TrackingMdRepo.parseProgress 取最后 3 条注入 prompt。
   * 同一章只追加一次（检测已有「第 N 章」行则跳过，避免重复）。
   */
  private async appendProgress(
    chapter: number,
    plotPoints: MemoryExtraction['newPlotPoints']
  ): Promise<void> {
    const file = join(this.projectDir, '追踪', '上下文.md')
    const text = await readText(file)
    if (!text) return // 文件不存在，不创建（追踪/上下文.md 需项目侧先建骨架）

    // 同章已追加过则跳过；正则容忍空格变化
    const chapterMarker = `第 ${chapter} 章`
    const chapterSeenRe = new RegExp(`\\|\\s*第\\s*${chapter}\\s*章\\s*\\|`)
    if (chapterSeenRe.test(text)) return

    // 拼进度摘要：plotPoint 的 title + event
    const summaryParts = plotPoints.map((p) => {
      const t = p.title?.trim()
      const e = p.event?.trim()
      return t && e ? `${t}：${e}` : t || e || ''
    }).filter(Boolean)
    const summary = summaryParts.length > 0 ? summaryParts.join('；') : `完成第 ${chapter} 章写作`
    const today = new Date().toISOString().slice(0, 10)
    const row = `| ${today} | ${chapterMarker} | ${summary} | - | - |`

    // 找到表格最后一行，追加在其后
    const lines = text.split(/\r?\n/)
    let lastTableRow = -1
    for (let i = 0; i < lines.length; i++) {
      if (/^\|.*\|$/.test(lines[i].trim()) && !lines[i].includes('---')) {
        lastTableRow = i
      }
    }
    if (lastTableRow >= 0) {
      lines.splice(lastTableRow + 1, 0, row)
    } else {
      lines.push(row)
    }
    await writeTextAtomic(file, lines.join('\n'))
  }

  /** 伏笔回收：按内容模糊匹配，更新状态为已回收。返回是否实际应用。 */
  private async collectForeshadowing(content: string, chapter: number): Promise<boolean> {
    const repo = new ForeshadowingMdRepo(this.projectDir)
    const list = await repo.list()
    const f = list.find(
      (x) => x.content.includes(content) || content.includes(x.content)
    )
    if (!f) return false
    await repo.collect(f.id, chapter)
    return true
  }
}
