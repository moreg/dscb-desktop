import { join } from 'path'
import { CharacterCardMdRepo } from './skill-format/character-card-md-repo'
import { LocationMdRepo } from './skill-format/location-md-repo'
import { ForeshadowingMdRepo } from './skill-format/foreshadowing-md-repo'
import { appendH3UnderH2, appendH2Section } from './skill-format/md-writer'
import { writeTextAtomic } from './atomic'
import { readText } from './skill-format/md-parser'
import type { MemoryExtraction, MemoryApplyResult } from '../../shared/types'

/**
 * 记忆回写器（混合策略）。
 * - 新增内容（角色/地点/伏笔）：需用户确认，由 UI 调 applyNew* 方法
 * - 状态变化（伤势/情绪/位置/关系）：自动更新角色卡
 * - 情节追加：自动追加到核心情节.md
 * - 伏笔回收：自动更新伏笔追踪.md 状态
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

    // 1. 角色状态变化：更新角色卡.md 的"当前状态"字段
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

    // 2. 情节追加：追加到核心情节.md
    for (const pp of extraction.newPlotPoints) {
      try {
        await this.appendPlotPoint(extraction.chapterNumber, pp.title, pp.event, pp.coolPoint)
        plotPoints++
      } catch (e) {
        errors.push(`情节追加失败: ${(e as Error).message}`)
      }
    }

    // 3. 伏笔回收：更新伏笔追踪.md 状态
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
        foreshadowings: 0,
        plotPoints,
        stateChanges,
        collected
      },
      errors
    }
  }

  /** 用户确认后：应用新增角色 */
  async applyNewCharacters(
    chars: MemoryExtraction['newCharacters']
  ): Promise<number> {
    const repo = new CharacterCardMdRepo(this.projectDir)
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

  /** 用户确认后：应用新增地点 */
  async applyNewLocations(locs: MemoryExtraction['newLocations']): Promise<number> {
    const repo = new LocationMdRepo(this.projectDir)
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

  /** 用户确认后：应用新增伏笔 */
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

  /** 更新角色卡的"当前状态"字段（追加变化轨迹，不覆盖原值）。返回是否实际应用。 */
  private async updateCharacterState(
    name: string,
    field: string,
    value: string
  ): Promise<boolean> {
    const repo = new CharacterCardMdRepo(this.projectDir)
    const existing = (await repo.list()).find((c) => c.name === name)
    if (!existing) return false
    const newSynopsis = existing.synopsis
      ? `${existing.synopsis}；${field}：${value}`
      : `${field}：${value}`
    await repo.update(name, { synopsis: newSynopsis })
    return true
  }

  /** 追加情节到核心情节.md 的最后一个 H2（卷）下 */
  private async appendPlotPoint(
    chapter: number,
    title: string,
    event: string,
    coolPoint?: string
  ): Promise<void> {
    const file = join(this.projectDir, '记忆系统', '核心情节.md')
    const text = await readText(file)
    if (!text) {
      // 文件不存在，创建初始结构
      const init = `# 核心情节\n\n## 第一卷\n\n### 第${chapter}章：${title}\n- **核心事件**：${event}\n- **爽点/打脸**：${coolPoint ?? ''}\n- **角色变动**：\n- **伏笔**：\n`
      await writeTextAtomic(file, init)
      return
    }
    const block = `### 第${chapter}章：${title}\n- **核心事件**：${event}\n- **爽点/打脸**：${coolPoint ?? ''}\n- **角色变动**：\n- **伏笔**：\n`
    // 找最后一个 H2 节，追加到其末尾
    const lines = text.split(/\r?\n/)
    let lastH2Title = ''
    for (const line of lines) {
      if (/^## [^#]/.test(line)) {
        lastH2Title = line.replace(/^##\s+/, '').trim()
      }
    }
    let next: string
    if (lastH2Title) {
      next = appendH3UnderH2(text, lastH2Title, block)
    } else {
      // 无 H2，先建第一卷再追加
      const withVol = appendH2Section(text, '第一卷', '')
      next = appendH3UnderH2(withVol, '第一卷', block)
    }
    await writeTextAtomic(file, next)
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
