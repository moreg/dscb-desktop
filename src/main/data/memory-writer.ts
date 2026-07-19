import { join, resolve, relative, isAbsolute } from 'path'
import { promises as fs } from 'fs'
import { CharacterRepo } from './memory/character-repo'
import { LocationRepo } from './memory/location-repo'
import { ItemRepo } from './memory/item-repo'
import { PlotPointRepo } from './memory/plot-point-repo'
import { ForeshadowingMdRepo } from './skill-format/foreshadowing-md-repo'
import { appendH3UnderH2, appendH2Section } from './skill-format/md-writer'
import { writeTextAtomic } from './atomic'
import { withFileLock } from './file-lock'
import { readText } from './skill-format/md-parser'
import { sanitizeForFileName } from './memory/entity-helpers'
import type {
  Character,
  MemoryApplyDiffItem,
  MemoryApplyPreview,
  MemoryApplyResult,
  MemoryExtraction,
  UpdateCharacterInput
} from '../../shared/types'

/**
 * 记忆回写器（v4：单一真相源策略）。
 * - 新增内容（角色/地点/伏笔）：需用户确认，由 UI 调 applyNew* 方法
 * - 状态/设定变化：映射到人物卡 first-class 字段或 customFields，并追加状态轨迹
 * - 情节追加 / 伏笔回收：自动
 */
export class MemoryWriter {
  constructor(private readonly projectDir: string) {}

  /**
   * 自动应用前预览：读当前人物卡/剧情/伏笔，拼 old→new diff。
   * field 一律 normalizeStateField，与写入路径一致。
   */
  async previewAutomatic(extraction: MemoryExtraction): Promise<MemoryApplyPreview> {
    const diffs: MemoryApplyDiffItem[] = []
    const charRepo = new CharacterRepo(this.projectDir)
    const chars = await charRepo.list()
    const foreshadowings = await new ForeshadowingMdRepo(this.projectDir).list()

    for (const change of extraction.characterStateChanges) {
      const match = findCharacterByName(chars, change.name)
      const field = normalizeStateField((change.field || '状态').trim())
      const oldFromCard = match?.char ? readCharacterField(match.char, field) : ''
      const oldValue =
        oldFromCard ||
        (typeof change.oldValue === 'string' && change.oldValue.trim()
          ? change.oldValue.trim()
          : '（无）')
      let note: string | undefined
      if (!match) note = '人物卡不存在，跳过'
      else if (match.fuzzy) note = `近似匹配人物「${match.char.name}」`
      diffs.push({
        kind: 'state',
        label: match?.char.name ?? change.name,
        field,
        oldValue,
        newValue: String(change.newValue ?? '').trim() || '（空）',
        applicable: Boolean(match),
        note
      })
    }

    for (const pp of extraction.newPlotPoints) {
      const dir = join(this.projectDir, '记忆', '剧情点')
      const safeTitle = sanitizeForFileName(pp.title)
      const fileName = `第${String(extraction.chapterNumber).padStart(3, '0')}章 ${safeTitle}.md`
      const exists = Boolean(await readText(join(dir, fileName)))
      diffs.push({
        kind: 'plot',
        label: pp.title || `第${extraction.chapterNumber}章`,
        oldValue: exists ? '（文件已存在，不覆盖）' : '（无）',
        newValue: pp.event || '',
        applicable: !exists,
        note: exists ? '已有剧情点文件' : undefined
      })
    }

    for (const cf of extraction.collectedForeshadowings) {
      const hit = foreshadowings.find(
        (x) => x.content.includes(cf.content) || cf.content.includes(x.content)
      )
      diffs.push({
        kind: 'collect',
        label: cf.content,
        oldValue: hit
          ? hit.status === 'collected'
            ? '已回收'
            : '已埋设/未回收'
          : '（库中无匹配）',
        newValue: `第 ${cf.chapter} 章回收`,
        applicable: Boolean(hit) && hit!.status !== 'collected',
        note: !hit
          ? '未找到对应伏笔'
          : hit.status === 'collected'
            ? '已回收，跳过'
            : undefined
      })
    }

    const confirmCount =
      extraction.newCharacters.length +
      extraction.newLocations.length +
      extraction.newItems.length +
      extraction.newForeshadowings.length

    return {
      diffs,
      applicableCount: diffs.filter((d) => d.applicable).length,
      confirmCount
    }
  }

  /**
   * 自动应用：状态/设定变化 + 情节追加 + 伏笔回收。
   * 新增内容不在此方法处理（需用户确认）。
   */
  async applyAutomatic(extraction: MemoryExtraction): Promise<MemoryApplyResult> {
    const errors: string[] = []
    let stateChanges = 0
    let plotPoints = 0
    let collected = 0
    const appliedDiffs: MemoryApplyDiffItem[] = []

    // 应用前快照 + 人物 list 一次，避免每条状态变化重复 list
    const preview = await this.previewAutomatic(extraction)
    const charRepo = new CharacterRepo(this.projectDir)
    const chars = await charRepo.list()

    // 1. 角色状态/设定变化
    for (const change of extraction.characterStateChanges) {
      try {
        const field = normalizeStateField((change.field || '状态').trim())
        const match = findCharacterByName(chars, change.name)
        const applied = await this.updateCharacterState(
          change.name,
          change.field,
          change.newValue,
          match?.char
        )
        if (applied) {
          stateChanges++
          const d = preview.diffs.find(
            (x) =>
              x.kind === 'state' &&
              x.field === field &&
              (x.label === change.name || x.label === match?.char.name)
          )
          if (d) appliedDiffs.push({ ...d, applicable: true })
          // 写回后刷新内存中的角色快照，便于同次 apply 多条同一人
          if (match) {
            const refreshed = await charRepo.get(match.char.id)
            if (refreshed) {
              const idx = chars.findIndex((c) => c.id === refreshed.id)
              if (idx >= 0) chars[idx] = refreshed
            }
          }
        }
      } catch (e) {
        errors.push(`角色状态更新失败 ${change.name}: ${(e as Error).message}`)
      }
    }

    // 2. 情节追加
    for (const pp of extraction.newPlotPoints) {
      try {
        const applied = await this.appendPlotPoint(
          extraction.chapterNumber,
          pp.title,
          pp.event,
          pp.coolPoint
        )
        if (applied) {
          plotPoints++
          appliedDiffs.push({
            kind: 'plot',
            label: pp.title || `第${extraction.chapterNumber}章`,
            oldValue: '（无）',
            newValue: pp.event || '',
            applicable: true
          })
        }
      } catch (e) {
        errors.push(`情节追加失败: ${(e as Error).message}`)
      }
    }

    // 2.5 时间线（有情节点时写；缺文件会自动建骨架）
    if (extraction.newPlotPoints.length > 0) {
      try {
        await this.appendTimeline(extraction.chapterNumber, extraction.newPlotPoints)
      } catch (e) {
        errors.push(`时间线追加失败: ${(e as Error).message}`)
      }
    }

    // 2.6 上下文进度：始终写入 追踪/上下文.md（续写会读最近 3 条）
    try {
      await this.appendProgress(
        extraction.chapterNumber,
        extraction.newPlotPoints,
        extraction.characterStateChanges
      )
    } catch (e) {
      errors.push(`进度摘要追加失败: ${(e as Error).message}`)
    }

    // 2.7 追踪角色状态表：写入 追踪/角色状态.md（续写读「当前状态/变更记录」）
    if (extraction.characterStateChanges.length > 0) {
      try {
        await this.syncTrackingCharacterStates(
          extraction.chapterNumber,
          extraction.characterStateChanges
        )
      } catch (e) {
        errors.push(`追踪角色状态写入失败: ${(e as Error).message}`)
      }
    }

    // 3. 伏笔回收
    for (const cf of extraction.collectedForeshadowings) {
      try {
        const applied = await this.collectForeshadowing(cf.content, cf.chapter)
        if (applied) {
          collected++
          appliedDiffs.push({
            kind: 'collect',
            label: cf.content,
            oldValue: '已埋设/未回收',
            newValue: `第 ${cf.chapter} 章回收`,
            applicable: true
          })
        }
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
      errors,
      appliedDiffs
    }
  }

  /**
   * 撤销一次 applyAutomatic 的自动写入（best-effort）。
   * 依据 extraction + appliedDiffs 回滚：角色字段、剧情点文件、时间线/上下文行、
   * 角色状态变更记录、伏笔回收。不碰用户手动确认的新增角色/地点等。
   */
  async revertAutomatic(
    extraction: MemoryExtraction,
    appliedDiffs: MemoryApplyDiffItem[] = []
  ): Promise<{
    reverted: {
      stateChanges: number
      plotPoints: number
      collected: number
      tracking: number
    }
    errors: string[]
  }> {
    const errors: string[] = []
    let stateChanges = 0
    let plotPoints = 0
    let collected = 0
    let tracking = 0
    const chapter = extraction.chapterNumber

    // 1. 角色状态：按 appliedDiffs 的 oldValue 恢复
    const stateDiffs = appliedDiffs.filter((d) => d.kind === 'state')
    const charRepo = new CharacterRepo(this.projectDir)
    const chars = await charRepo.list()
    for (const d of stateDiffs) {
      try {
        const match = findCharacterByName(chars, d.label)
        if (!match) {
          errors.push(`撤销状态跳过：找不到人物「${d.label}」`)
          continue
        }
        const restoreRaw = (d.oldValue || '').trim()
        const restore =
          !restoreRaw || restoreRaw === '（无）' || restoreRaw === '（空）' ? '' : restoreRaw
        const field = d.field || '当前状态'
        if (restore) {
          const ok = await this.updateCharacterState(match.char.name, field, restore, match.char)
          if (ok) {
            stateChanges++
            const refreshed = await charRepo.get(match.char.id)
            if (refreshed) {
              const idx = chars.findIndex((c) => c.id === refreshed.id)
              if (idx >= 0) chars[idx] = refreshed
            }
          }
        } else {
          // 旧值为空：写占位「-」避免把卡片字段删到非法空；轨迹记撤销
          const ok = await this.updateCharacterState(match.char.name, field, '-', match.char)
          if (ok) stateChanges++
        }
      } catch (e) {
        errors.push(`撤销角色状态失败 ${d.label}: ${(e as Error).message}`)
      }
    }

    // 2. 删除本批剧情点文件
    for (const pp of extraction.newPlotPoints) {
      try {
        const deleted = await this.deletePlotPointFile(chapter, pp.title)
        if (deleted) plotPoints++
      } catch (e) {
        errors.push(`撤销剧情点失败: ${(e as Error).message}`)
      }
    }

    // 3. 追踪表：移除本章时间线 / 上下文行；移除本批状态变更记录
    try {
      if (extraction.newPlotPoints.length > 0) {
        const n = await this.removeTrackingChapterRow('timeline', chapter)
        tracking += n
      }
    } catch (e) {
      errors.push(`撤销时间线失败: ${(e as Error).message}`)
    }
    try {
      // 上下文几乎总会写入
      const n = await this.removeTrackingChapterRow('context', chapter)
      tracking += n
    } catch (e) {
      errors.push(`撤销上下文失败: ${(e as Error).message}`)
    }
    try {
      if (extraction.characterStateChanges.length > 0) {
        const names = extraction.characterStateChanges.map((c) => c.name.trim()).filter(Boolean)
        const n = await this.removeCharacterStateChangeLogs(chapter, names)
        tracking += n
      }
    } catch (e) {
      errors.push(`撤销角色状态记录失败: ${(e as Error).message}`)
    }

    // 4. 伏笔回收回滚
    for (const cf of extraction.collectedForeshadowings) {
      try {
        const ok = await this.uncollectForeshadowing(cf.content)
        if (ok) collected++
      } catch (e) {
        errors.push(`撤销伏笔回收失败 ${cf.content}: ${(e as Error).message}`)
      }
    }

    return {
      reverted: { stateChanges, plotPoints, collected, tracking },
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
        const created = await repo.create({
          name: c.name,
          role: c.role,
          identity: c.identity,
          personality: c.personality,
          abilities: c.abilities
        })
        if (c.appearance?.trim()) {
          await repo.update(created.id, {
            customFields: { 外貌: c.appearance.trim() }
          })
        }
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
   * 更新角色状态/设定：
   * - 标准字段映射到 identity/personality/abilities/synopsis/role 或 customFields
   * - 同时追加 customFields['状态轨迹'] 保留历史
   * @param cached 可选；传入则跳过 list（apply 路径已 list 一次）
   */
  private async updateCharacterState(
    name: string,
    field: string,
    value: string,
    cached?: Character
  ): Promise<boolean> {
    const repo = new CharacterRepo(this.projectDir)
    const existing =
      cached ?? findCharacterByName(await repo.list(), name)?.char
    if (!existing) return false
    const v = String(value ?? '').trim()
    if (!v) return false

    const patch: UpdateCharacterInput = {}
    const custom: Record<string, string> = {}
    const key = normalizeStateField((field || '状态').trim())

    if (key === '身份') patch.identity = v
    else if (key === '性格') patch.personality = v
    else if (key === '能力' || key === '境界' || key === '金手指') patch.abilities = v
    else if (key === '角色定位') patch.role = v
    else if (key === '当前状态') patch.synopsis = v
    else {
      // 伤势/情绪/位置/外貌/关系/持有物 等 → 当前值写入同名 custom 字段
      custom[key] = v
    }

    const prevTrack = fieldToPlain(existing.customFields?.['状态轨迹'])
    const entry = `${key}：${v}`
    const newTrack = prevTrack ? `${prevTrack}；${entry}` : entry
    custom['状态轨迹'] = newTrack
    patch.customFields = custom

    await repo.update(existing.id, patch)
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
    return withFileLock(file, async () => {
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
    })
  }

  /**
   * 追加时间线：把本章剧情点事件追加到 追踪/时间线.md。
   * 缺文件时自动建骨架；同章已有行则更新描述。
   */
  private async appendTimeline(
    chapter: number,
    plotPoints: MemoryExtraction['newPlotPoints']
  ): Promise<void> {
    const file = join(this.projectDir, '追踪', '时间线.md')
    await this.ensureTrackingSkeleton('timeline')
    await withFileLock(file, async () => {
      let text = (await readText(file)) ?? ''

      const chapterMarker = `第 ${chapter} 章`
      const events = plotPoints.map((p) => p.event).filter(Boolean)
      const desc = escapeTableCell(events.join('；'))
      const title = escapeTableCell(plotPoints[0]?.title ?? `第${chapter}章`)
      const row = `| ${chapterMarker} | ${title} | - | - | ${desc} |`

      text = upsertTrackingTableRow(text, chapter, row)
      await writeTextAtomic(file, text)
    })
  }

  /**
   * 写入 追踪/上下文.md 进度表（续写会读最近 3 条）。
   * 缺文件自动建骨架；同章已有行则覆盖摘要（重同步刷新）。
   */
  private async appendProgress(
    chapter: number,
    plotPoints: MemoryExtraction['newPlotPoints'],
    stateChanges: MemoryExtraction['characterStateChanges'] = []
  ): Promise<void> {
    const file = join(this.projectDir, '追踪', '上下文.md')
    await this.ensureTrackingSkeleton('context')
    await withFileLock(file, async () => {
      let text = (await readText(file)) ?? ''

      const chapterMarker = `第 ${chapter} 章`
      const summaryParts = plotPoints.map((p) => {
        const t = p.title?.trim()
        const e = p.event?.trim()
        return t && e ? `${t}：${e}` : t || e || ''
      }).filter(Boolean)
      if (stateChanges.length > 0) {
        const st = stateChanges
          .slice(0, 6)
          .map((c) => `${c.name}.${normalizeStateField(c.field || '状态')}→${c.newValue}`)
          .join('；')
        if (st) summaryParts.push(`状态：${st}`)
      }
      const summary = escapeTableCell(
        summaryParts.length > 0 ? summaryParts.join('；') : `完成第 ${chapter} 章写作`
      )
      const today = new Date().toISOString().slice(0, 10)
      const row = `| ${today} | ${chapterMarker} | ${summary} | - | - |`

      text = upsertTrackingTableRow(text, chapter, row)
      await writeTextAtomic(file, text)
    })
  }

  /**
   * 把角色状态变化同步进 追踪/角色状态.md：
   * - 「当前状态」表 upsert 行
   * - 「状态变更记录」表追加变更
   * 续写 loadChapterContext 会读这两处注入 prompt。
   */
  private async syncTrackingCharacterStates(
    chapter: number,
    changes: MemoryExtraction['characterStateChanges']
  ): Promise<void> {
    if (changes.length === 0) return
    const file = join(this.projectDir, '追踪', '角色状态.md')
    await this.ensureTrackingSkeleton('characterStates')
    await withFileLock(file, async () => {
      let text = (await readText(file)) ?? ''

      // 按角色聚合本批 field→value
      const byName = new Map<string, { field: string; value: string }[]>()
      for (const c of changes) {
        const name = c.name?.trim()
        if (!name) continue
        const list = byName.get(name) ?? []
        list.push({
          field: normalizeStateField((c.field || '状态').trim()),
          value: String(c.newValue ?? '').trim()
        })
        byName.set(name, list)
      }

      for (const [name, fields] of byName) {
        text = upsertCharacterStateSnapshot(text, name, chapter, fields)
        for (const f of fields) {
          if (!f.value) continue
          text = appendCharacterStateChangeLog(text, chapter, name, `${f.field}：${f.value}`)
        }
      }

      await writeTextAtomic(file, text)
    })
  }

  /** 确保追踪骨架文件存在（与 project-service 开书模板对齐） */
  private async ensureTrackingSkeleton(
    kind: 'context' | 'timeline' | 'characterStates'
  ): Promise<void> {
    const dir = join(this.projectDir, '追踪')
    await fs.mkdir(dir, { recursive: true })
    const file =
      kind === 'context'
        ? join(dir, '上下文.md')
        : kind === 'timeline'
          ? join(dir, '时间线.md')
          : join(dir, '角色状态.md')
    const existing = await readText(file)
    if (existing && existing.trim()) return

    const body =
      kind === 'context'
        ? `# 上下文（日更进度摘要）\n\n| 日期 | 章节 | 进度摘要 | 下一章目标 | 阻塞点 |\n|---|---|---|---|---|\n`
        : kind === 'timeline'
          ? `# 时间线\n\n| 章节 | 事件名 | 时间跨度 | 涉及角色 | 详细描述 |\n|---|---|---|---|---|\n`
          : `# 角色状态快照\n\n## 当前状态\n\n| 角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 更新章节 |\n|---|---|---|---|---|---|---|\n\n## 状态变更记录\n\n| 章节 | 角色 | 变更内容 |\n|---|---|---|\n`
    await writeTextAtomic(file, body)
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

  private async uncollectForeshadowing(content: string): Promise<boolean> {
    const repo = new ForeshadowingMdRepo(this.projectDir)
    const list = await repo.list()
    const f = list.find(
      (x) => x.content.includes(content) || content.includes(x.content)
    )
    if (!f || f.status !== 'collected') return false
    await repo.uncollect(f.id)
    return true
  }

  private async deletePlotPointFile(chapter: number, title: string): Promise<boolean> {
    const dir = join(this.projectDir, '记忆', '剧情点')
    const safeTitle = sanitizeForFileName(title)
    const fileName = `第${String(chapter).padStart(3, '0')}章 ${safeTitle}.md`
    const file = resolve(dir, fileName)
    const rel = relative(dir, file)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`剧情点路径越界：${title}`)
    }
    try {
      await fs.unlink(file)
      return true
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return false
      throw e
    }
  }

  /** 删除追踪表中含「第 N 章」的行；返回删除行数 */
  private async removeTrackingChapterRow(
    kind: 'timeline' | 'context',
    chapter: number
  ): Promise<number> {
    const file =
      kind === 'timeline'
        ? join(this.projectDir, '追踪', '时间线.md')
        : join(this.projectDir, '追踪', '上下文.md')
    return withFileLock(file, async () => {
      const text = await readText(file)
      if (!text) return 0
      const chapterSeenRe = new RegExp(`\\|\\s*第\\s*${chapter}\\s*章\\s*\\|`)
      const lines = text.split(/\r?\n/)
      let removed = 0
      const next = lines.filter((line) => {
        if (chapterSeenRe.test(line)) {
          removed++
          return false
        }
        return true
      })
      if (removed > 0) await writeTextAtomic(file, next.join('\n'))
      return removed
    })
  }

  /** 删除「状态变更记录」中本章、指定角色的行 */
  private async removeCharacterStateChangeLogs(
    chapter: number,
    names: string[]
  ): Promise<number> {
    if (names.length === 0) return 0
    const file = join(this.projectDir, '追踪', '角色状态.md')
    const nameSet = new Set(names)
    return withFileLock(file, async () => {
      const text = await readText(file)
      if (!text) return 0
      const lines = text.split(/\r?\n/)
      let inLog = false
      let removed = 0
      const next = lines.filter((line) => {
        if (/^##\s*状态变更/.test(line.trim())) {
          inLog = true
          return true
        }
        if (inLog && /^##\s+/.test(line.trim())) {
          inLog = false
          return true
        }
        if (!inLog || !line.trim().startsWith('|') || line.includes('---')) return true
        if (/章节/.test(line) && /角色/.test(line)) return true
        const chapterHit = new RegExp(`第\\s*${chapter}\\s*章`).test(line)
        if (!chapterHit) return true
        const hitName = [...nameSet].some(
          (n) => line.includes(`| ${n} |`) || line.includes(`|${n}|`)
        )
        if (hitName) {
          removed++
          return false
        }
        return true
      })
      if (removed > 0) await writeTextAtomic(file, next.join('\n'))
      return removed
    })
  }
}

/** 字段名归一：同义映射到标准名（预览与写入共用） */
export function normalizeStateField(field: string): string {
  const f = field.trim()
  const map: Record<string, string> = {
    伤: '伤势',
    受伤: '伤势',
    伤势情况: '伤势',
    情绪状态: '情绪',
    心情: '情绪',
    所在: '位置',
    所在地: '位置',
    地点: '位置',
    状态: '当前状态',
    现状: '当前状态',
    人设: '性格',
    性格特点: '性格',
    能力境界: '境界',
    修为: '境界',
    功法: '能力',
    长相: '外貌',
    相貌: '外貌',
    关系网: '关系',
    人物关系: '关系',
    物品: '持有物',
    随身: '持有物',
    定位: '角色定位',
    role: '角色定位',
    identity: '身份',
    personality: '性格',
    abilities: '能力',
    appearance: '外貌'
  }
  return map[f] ?? f
}

function fieldToPlain(v: string | string[] | undefined): string {
  if (v == null) return ''
  return Array.isArray(v) ? v.join('；') : String(v)
}

/** 从人物卡读当前字段值（供 diff 预览）；field 应已 normalize 或内部再 normalize */
function readCharacterField(c: Character, field: string): string {
  const key = normalizeStateField(field)
  if (key === '身份') return c.identity?.trim() || ''
  if (key === '性格') return c.personality?.trim() || ''
  if (key === '能力' || key === '境界' || key === '金手指') return c.abilities?.trim() || ''
  if (key === '角色定位') return c.role?.trim() || ''
  if (key === '当前状态') return c.synopsis?.trim() || ''
  const cf = c.customFields?.[key]
  if (cf != null) return fieldToPlain(cf)
  const rf = c.rawFields?.[key]
  if (rf != null) return fieldToPlain(rf)
  return ''
}

/**
 * 精确名优先；否则在「包含关系唯一命中」时模糊匹配（LLM 名与卡名略不一致）。
 */
function findCharacterByName(
  chars: Character[],
  name: string
): { char: Character; fuzzy: boolean } | undefined {
  const n = name.trim()
  if (!n) return undefined
  const exact = chars.find((c) => c.name === n)
  if (exact) return { char: exact, fuzzy: false }
  const hits = chars.filter((c) => c.name.includes(n) || n.includes(c.name))
  if (hits.length === 1) return { char: hits[0], fuzzy: true }
  return undefined
}

function escapeTableCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

/**
 * 在 markdown 表中 upsert 含「第 N 章」的行：已有则替换，否则插到最后一行数据后。
 */
function upsertTrackingTableRow(text: string, chapter: number, newRow: string): string {
  const chapterSeenRe = new RegExp(`\\|\\s*第\\s*${chapter}\\s*章\\s*\\|`)
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (chapterSeenRe.test(lines[i])) {
      lines[i] = newRow
      return lines.join('\n')
    }
  }
  let lastTableRow = -1
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (/^\|.*\|$/.test(t) && !t.includes('---')) lastTableRow = i
  }
  if (lastTableRow >= 0) lines.splice(lastTableRow + 1, 0, newRow)
  else lines.push(newRow)
  return lines.join('\n')
}

/** 字段 → 角色状态表列 */
function mapFieldToStateColumn(
  field: string
): 'power' | 'stance' | 'goal' | 'items' | 'relations' | null {
  const f = normalizeStateField(field)
  if (['伤势', '当前状态', '能力', '境界', '金手指', '实力'].includes(f)) return 'power'
  if (['情绪', '立场'].includes(f)) return 'stance'
  if (f === '目标') return 'goal'
  if (['持有物', '物品'].includes(f)) return 'items'
  if (['关系', '关系网'].includes(f)) return 'relations'
  return null
}

/**
 * upsert 当前状态表中某角色行。
 * 表头：角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 更新章节
 */
function upsertCharacterStateSnapshot(
  text: string,
  name: string,
  chapter: number,
  fields: { field: string; value: string }[]
): string {
  const lines = text.split(/\r?\n/)
  // 找「当前状态」节内表头
  let headerIdx = -1
  let inCurrent = false
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s*当前状态/.test(lines[i].trim())) {
      inCurrent = true
      continue
    }
    if (inCurrent && /^##\s+/.test(lines[i].trim())) break
    if (
      (inCurrent || headerIdx < 0) &&
      /^\|/.test(lines[i].trim()) &&
      /角色/.test(lines[i]) &&
      /实力|立场/.test(lines[i])
    ) {
      headerIdx = i
      break
    }
  }
  if (headerIdx < 0) {
    // 无表则追加整段
    return (
      text.trimEnd() +
      `\n\n## 当前状态\n\n| 角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 更新章节 |\n|---|---|---|---|---|---|---|\n| ${escapeTableCell(name)} | - | - | - | - | - | 第 ${chapter} 章 |\n`
    )
  }

  // 数据行范围：header 后跳过分隔行
  let dataStart = headerIdx + 1
  if (dataStart < lines.length && lines[dataStart].includes('---')) dataStart++
  let dataEnd = dataStart
  while (dataEnd < lines.length && /^\|/.test(lines[dataEnd].trim()) && !/^##\s+/.test(lines[dataEnd].trim())) {
    dataEnd++
  }

  let power = '-'
  let stance = '-'
  let goal = '-'
  let items = '-'
  let relations = '-'
  let foundRow = -1
  const nameRe = new RegExp(`^\\|\\s*${escapeRegExp(name)}\\s*\\|`)

  for (let i = dataStart; i < dataEnd; i++) {
    if (nameRe.test(lines[i].trim()) || lines[i].includes(`| ${name} |`) || lines[i].includes(`|${name}|`)) {
      foundRow = i
      const cells = splitTableRow(lines[i])
      // cells[0] empty before first |, then 角色, 实力, 立场, 目标, 道具, 关系, 更新章节
      power = cells[2] || '-'
      stance = cells[3] || '-'
      goal = cells[4] || '-'
      items = cells[5] || '-'
      relations = cells[6] || '-'
      break
    }
  }

  for (const f of fields) {
    if (!f.value) continue
    const col = mapFieldToStateColumn(f.field)
    if (col === 'power') power = mergeCell(power, f.value)
    else if (col === 'stance') stance = f.value
    else if (col === 'goal') goal = f.value
    else if (col === 'items') items = mergeCell(items, f.value)
    else if (col === 'relations') relations = mergeCell(relations, f.value)
    else {
      // 未映射字段叠到实力列备注
      power = mergeCell(power, `${f.field}：${f.value}`)
    }
  }

  const newRow = `| ${escapeTableCell(name)} | ${escapeTableCell(power)} | ${escapeTableCell(stance)} | ${escapeTableCell(goal)} | ${escapeTableCell(items)} | ${escapeTableCell(relations)} | 第 ${chapter} 章 |`
  if (foundRow >= 0) lines[foundRow] = newRow
  else lines.splice(dataEnd, 0, newRow)
  return lines.join('\n')
}

/** 追加状态变更记录行（同章同角色同内容不重复） */
function appendCharacterStateChangeLog(
  text: string,
  chapter: number,
  name: string,
  change: string
): string {
  const lines = text.split(/\r?\n/)
  let headerIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s*状态变更/.test(lines[i].trim())) {
      // 找该节下表头
      for (let j = i + 1; j < lines.length; j++) {
        if (/^##\s+/.test(lines[j].trim())) break
        if (/^\|/.test(lines[j].trim()) && /章节/.test(lines[j]) && /角色/.test(lines[j])) {
          headerIdx = j
          break
        }
      }
      break
    }
  }
  if (headerIdx < 0) {
    return (
      text.trimEnd() +
      `\n\n## 状态变更记录\n\n| 章节 | 角色 | 变更内容 |\n|---|---|---|\n| 第 ${chapter} 章 | ${escapeTableCell(name)} | ${escapeTableCell(change)} |\n`
    )
  }

  let dataStart = headerIdx + 1
  if (dataStart < lines.length && lines[dataStart].includes('---')) dataStart++
  let dataEnd = dataStart
  while (dataEnd < lines.length && /^\|/.test(lines[dataEnd].trim()) && !/^##\s+/.test(lines[dataEnd].trim())) {
    dataEnd++
  }

  const chapterMarker = `第 ${chapter} 章`
  const row = `| ${chapterMarker} | ${escapeTableCell(name)} | ${escapeTableCell(change)} |`
  // 已有完全相同行则跳过
  for (let i = dataStart; i < dataEnd; i++) {
    if (lines[i].includes(chapterMarker) && lines[i].includes(name) && lines[i].includes(change)) {
      return text
    }
  }
  lines.splice(dataEnd, 0, row)
  return lines.join('\n')
}

function splitTableRow(line: string): string[] {
  const t = line.trim()
  const inner = t.startsWith('|') ? t.slice(1) : t
  const parts = inner.endsWith('|') ? inner.slice(0, -1) : inner
  return parts.split('|').map((c) => c.trim())
}

function mergeCell(prev: string, next: string): string {
  const p = prev === '-' || !prev ? '' : prev
  if (!p) return next
  if (p.includes(next)) return p
  return `${p}；${next}`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
