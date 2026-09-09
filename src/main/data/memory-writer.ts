import { join, resolve, relative, isAbsolute } from 'path'
import { promises as fs } from 'fs'
import { CharacterRepo } from './memory/character-repo'
import { LocationRepo } from './memory/location-repo'
import { ItemRepo } from './memory/item-repo'
import { PlotPointRepo } from './memory/plot-point-repo'
import { hashProse } from './memory/prose-memory-index'
import { parseCharacterStatesAt, type CharacterStateSnapshot } from './skill-format/tracking-md-repo'
import { ForeshadowingMdRepo } from './skill-format/foreshadowing-md-repo'
import { writeTextAtomic } from './atomic'
import { withFileLock } from './file-lock'
import { readText, parseDoc, parseTable } from './skill-format/md-parser'
import { sanitizeForFileName } from './memory/entity-helpers'
import type {
  Character,
  Foreshadowing,
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
      const existing = await readText(join(dir, fileName))
      const exists = Boolean(existing)
      const managed = isManagedPlotPoint(existing, extraction.chapterNumber)
      diffs.push({
        kind: 'plot',
        label: pp.title || `第${extraction.chapterNumber}章`,
        oldValue: exists ? managed ? '（自动摘要，将重建）' : '（文件已存在，保留作者内容）' : '（无）',
        newValue: pp.event || '',
        applicable: !exists || managed,
        note: exists && !managed ? '已有剧情点文件，未修改' : undefined
      })
    }

    for (const cf of extraction.collectedForeshadowings) {
      const hit = resolveAutomaticForeshadowing(foreshadowings, cf)
      const applicable = Boolean(hit && hit.status !== 'collected' && hit.plantChapter && cf.chapter === extraction.chapterNumber && cf.chapter >= hit.plantChapter)
      diffs.push({
        kind: 'collect',
        label: cf.content,
        oldValue: hit
          ? hit.status === 'collected'
            ? '已回收'
            : '已埋设/未回收'
          : '（库中无匹配）',
        newValue: `第 ${cf.chapter} 章回收`,
        applicable,
        note: !hit
          ? '未找到唯一可靠对应伏笔，需使用准确编号'
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
  async applyAutomatic(extraction: MemoryExtraction, opts?: { sourceContent?: string }): Promise<MemoryApplyResult> {
    if (extraction.parseError) throw new Error(`记忆提取未完成，未写入或清理历史：${extraction.parseError}`)
    const errors: string[] = []
    let stateChanges = 0
    let plotPoints = 0
    let collected = 0
    const appliedDiffs: MemoryApplyDiffItem[] = []

    // 自动字段按章重放；只改仍与上次自动写入值一致的卡片字段。
    const preview = await this.previewAutomatic(extraction)
    try {
      const applied = await this.reconcileAutomaticCharacterCards(extraction.chapterNumber, extraction.characterStateChanges)
      stateChanges = applied.count
      appliedDiffs.push(...preview.diffs.filter((d) => d.kind === 'state' && d.applicable && applied.fields.has(`${d.label}:${cardFieldKey(d.field || '当前状态')}`)))
    } catch (e) {
      errors.push(`角色状态更新失败: ${(e as Error).message}`)
    }

    // 2. 移除同章已失效且无人编辑的自动摘要，再写入本轮摘要。
    try {
      await this.removeObsoletePlotPoints(extraction.chapterNumber, extraction.newPlotPoints.map((p) => p.title))
    } catch (e) {
      errors.push(`旧情节摘要清理失败: ${(e as Error).message}`)
    }
    for (const pp of extraction.newPlotPoints) {
      try {
        const applied = await this.appendPlotPoint(
          extraction.chapterNumber,
          pp.title,
          pp.event,
          pp.coolPoint,
          opts?.sourceContent != null ? hashProse(opts.sourceContent) : undefined
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

    // 空提取也要清除同章旧自动事件；作者手写记录不属于自动替换范围。
    try {
      await this.appendTimeline(extraction.chapterNumber, extraction.newPlotPoints)
    } catch (e) {
      errors.push(`时间线追加失败: ${(e as Error).message}`)
    }

    // 2.6 上下文进度：始终写入 追踪/上下文.md（续写会读最近若干条日更备注；章级记忆另走剧情点）
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
    try {
      // An empty extraction also replaces this chapter's previous automatic history after a rewrite.
      await this.syncTrackingCharacterStates(extraction.chapterNumber, extraction.characterStateChanges)
    } catch (e) {
      errors.push(`追踪角色状态写入失败: ${(e as Error).message}`)
    }

    // 3. 唯一定位与本章回收；空回收也对账，撤回重写后消失的自动回收。
    const fRepo = new ForeshadowingMdRepo(this.projectDir)
    const foreshadowings = await fRepo.list()
    const collections: { foreshadowingId: string; evidence?: string }[] = []
    let invalidCollections = false
    for (const cf of extraction.collectedForeshadowings) {
      const hit = resolveAutomaticForeshadowing(foreshadowings, cf)
      if (!hit || cf.chapter !== extraction.chapterNumber) {
        errors.push(`伏笔回收未应用 ${cf.foreshadowingId || cf.content || '（空引用）'}：需要唯一编号或完整内容，且回收章节必须是本章`)
        invalidCollections = true
        continue
      }
      collections.push({ foreshadowingId: hit.id, evidence: cf.evidence })
    }
    try {
      const result = invalidCollections ? { collectedIds: [], warnings: [], changes: [] } : await fRepo.reconcileAutomaticCollections(extraction.chapterNumber, collections, opts?.sourceContent)
      collected = result.collectedIds.length
      errors.push(...result.warnings)
      for (const change of result.changes) appliedDiffs.push({ kind: 'collect', label: foreshadowings.find((f) => f.id === change.foreshadowingId)?.content || change.foreshadowingId,
        oldValue: change.action === 'collect' ? '已埋设/未回收' : `第 ${extraction.chapterNumber} 章已回收`,
        newValue: change.action === 'collect' ? `第 ${extraction.chapterNumber} 章回收` : '撤回本章自动回收，恢复原状态', applicable: true,
        foreshadowingId: change.foreshadowingId, receiptId: change.receiptId, collectionAction: change.action })
    } catch (e) {
      errors.push(`伏笔回收对账失败: ${(e as Error).message}`)
    }

    PlotPointRepo.invalidateCache(this.projectDir)

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
    const hasStateLedger = Boolean(await readText(join(this.projectDir, '追踪', '.automatic-state-ledger.json')))
    if (hasStateLedger) {
      try {
        await this.reconcileAutomaticCharacterCards(chapter, [])
        stateChanges = stateDiffs.length
      } catch (e) {
        errors.push(`撤销角色状态失败: ${(e as Error).message}`)
      }
    }
    for (const d of hasStateLedger ? [] : stateDiffs) {
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
        if (readCharacterField(match.char, field) !== d.newValue) continue
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
      await this.syncTrackingCharacterStates(chapter, [])
      tracking++
    } catch (e) {
      errors.push(`撤销角色状态记录失败: ${(e as Error).message}`)
    }

    // 4. 仅撤销本程序本章仍持有归属的回收，不再以文本猜测回滚目标。
    try {
      const receipts = appliedDiffs.filter((diff) => diff.kind === 'collect' && diff.applicable && diff.foreshadowingId && diff.receiptId)
        .map((diff) => ({ foreshadowingId: diff.foreshadowingId!, receiptId: diff.receiptId! }))
      const result = await new ForeshadowingMdRepo(this.projectDir).undoAutomaticCollections(chapter, receipts)
      collected = result.reverted
      errors.push(...result.warnings)
    } catch (e) {
      errors.push(`伏笔回收撤销失败: ${(e as Error).message}`)
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
   * 记录字段基线和每章变更，按章节重放当前卡片。lastApplied 是写入归属检查：
   * 作者改过的字段不会因改旧章或撤销而被自动覆盖。
   */
  private async reconcileAutomaticCharacterCards(
    chapter: number,
    changes: MemoryExtraction['characterStateChanges']
  ): Promise<{ count: number; fields: Set<string> }> {
    const file = join(this.projectDir, '追踪', '.automatic-state-ledger.json')
    return withFileLock(file, async () => {
      const existing = await readText(file)
      const ledger: AutomaticStateLedger = existing ? JSON.parse(existing) : { version: 1, fields: {}, tracks: {}, chapters: {} }
      if (ledger.version !== 1 || !ledger.fields || !ledger.tracks || !ledger.chapters) throw new Error('自动状态账本格式无效，已停止覆盖人物卡')
      const repo = new CharacterRepo(this.projectDir)
      const chars = await repo.list()
      if (!existing) {
        const history = await readText(join(this.projectDir, '追踪', '角色状态.md'))
        migrateLegacyCardLedger(ledger, history, chars)
      }
      const nextChanges: LedgerStateChange[] = []
      for (const change of changes) {
        const match = findCharacterByName(chars, change.name)
        const value = String(change.newValue ?? '').trim()
        if (!match || !value) continue
        const field = normalizeStateField(change.field || '状态')
        const key = cardFieldKey(field)
        const recordKey = `${match.char.id}:${key}`
        if (!ledger.fields[recordKey]) {
          const current = readCharacterField(match.char, key)
          ledger.fields[recordKey] = { characterId: match.char.id, field: key, baseline: current, lastApplied: current }
        }
        if (!ledger.tracks[match.char.id]) {
          const current = fieldToPlain(match.char.customFields?.['状态轨迹'])
          ledger.tracks[match.char.id] = { baseline: current, lastApplied: current }
        }
        nextChanges.push({ characterId: match.char.id, field, key, value })
      }
      if (nextChanges.length) ledger.chapters[String(chapter)] = nextChanges
      else delete ledger.chapters[String(chapter)]
      const ordered = Object.entries(ledger.chapters).sort(([a], [b]) => Number(a) - Number(b))
      const accepted = new Set<string>()
      for (const char of chars) {
        const patch: UpdateCharacterInput = { customFields: {} }
        let dirty = false
        for (const record of Object.values(ledger.fields).filter((r) => r.characterId === char.id)) {
          let desired = record.baseline
          for (const [, chapterChanges] of ordered) {
            for (const change of chapterChanges) if (change.characterId === char.id && change.key === record.field) desired = change.value
          }
          if (readCharacterField(char, record.field) !== record.lastApplied) continue
          accepted.add(`${char.id}:${record.field}`)
          if (desired !== record.lastApplied) {
            Object.assign(patch, buildCharacterFieldPatch(record.field, desired, patch.customFields))
            record.lastApplied = desired
            dirty = true
          }
        }
        const track = ledger.tracks[char.id]
        if (track && fieldToPlain(char.customFields?.['状态轨迹']) === track.lastApplied) {
          const entries = ordered.flatMap(([n, chapterChanges]) => chapterChanges
            .filter((c) => c.characterId === char.id && accepted.has(`${char.id}:${c.key}`))
            .map((c) => `第${n}章 ${c.field}：${c.value}`))
          const desired = [track.baseline, ...entries].filter(Boolean).join('；')
          if (desired !== track.lastApplied) {
            patch.customFields!['状态轨迹'] = desired
            track.lastApplied = desired
            dirty = true
          }
        }
        if (dirty) await repo.update(char.id, patch)
      }
      await writeTextAtomic(file, JSON.stringify(ledger, null, 2) + '\n')
      return {
        count: nextChanges.filter((c) => accepted.has(`${c.characterId}:${c.key}`)).length,
        fields: new Set(chars.flatMap((char) => Object.values(ledger.fields)
          .filter((r) => r.characterId === char.id && accepted.has(`${char.id}:${r.field}`))
          .map((r) => `${char.name}:${r.field}`)))
      }
    })
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
    coolPoint?: string,
    sourceHash?: string
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
      if (text && !isManagedPlotPoint(text, chapter)) return false
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
        coolPoint ? `- **爽点/打脸**：${coolPoint}` : null,
        sourceHash ? `- **正文哈希**：${sourceHash}` : null
      ].filter((l): l is string => l !== null).join('\n') + '\n'
      const managed = `${body}\n<!-- writer-plot:${chapter}:${hashProse(body)} -->\n`
      if (managed === text) return false
      await writeTextAtomic(file, managed)
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
      const row = events.length ? `| ${chapterMarker} | ${title} | - | - | ${desc} |` : ''

      text = replaceManagedTrackingRow(text, 'timeline', chapter, row)
      await writeTextAtomic(file, text)
    })
  }

  /**
   * 写入 追踪/上下文.md 进度表（续写会读最近若干条日更备注）。
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

      text = replaceManagedTrackingRow(text, 'context', chapter, row)
      await writeTextAtomic(file, text)
    })
  }

  /**
   * 把角色状态变化同步进 追踪/角色状态.md：
   * 保留作者的原有状态表，追加按章历史快照与变更；同章重写只替换本程序管理的节。
   * 每轮从上一章有效快照重新计算，避免把上次同章的旧事件反复累加。
   */
  private async syncTrackingCharacterStates(
    chapter: number,
    changes: MemoryExtraction['characterStateChanges']
  ): Promise<void> {
    const file = join(this.projectDir, '追踪', '角色状态.md')
    if (changes.length === 0 && !(await readText(file))) return
    await this.ensureTrackingSkeleton('characterStates')
    await withFileLock(file, async () => {
      const original = (await readText(file)) ?? ''
      const blocks = readManagedStateBlocks(original)
      const own = blocks.find((b) => b.chapter === chapter)
      if (own && !own.intact) throw new Error(`第 ${chapter} 章自动历史已被人工编辑，已保留；请先核对该章历史`)
      const toRebuild = blocks.filter((b) => b.chapter >= chapter && b.intact)
      let text = original
      const changed = stateChangesKey(own?.changes ?? []) !== stateChangesKey(changes)
      const invalidated = changed ? blocks.filter((b) => b.chapter > chapter && !b.intact && !b.full.includes('writer-state-invalidated:')) : []
      for (const block of invalidated) {
        const start = `<!-- writer-state-history:${block.chapter}:start -->`
        text = text.replace(block.full, block.full.replace(start, `${start}\n<!-- writer-state-invalidated:${block.chapter} -->\n> 前章状态已改写：本节含人工编辑，原文保留，自动续写暂停采用，待核对后重新确认。`))
      }
      for (const block of toRebuild) text = text.replace(block.full, '')
      const deltas = new Map(toRebuild.map((b) => [b.chapter, b.changes]))
      deltas.set(chapter, changes)
      for (const [number, stateChanges] of [...deltas].sort(([a], [b]) => a - b)) {
        const prior = new Map(parseCharacterStatesAt(text, number - 1).map((s) => [s.name, s]))
        const body = renderStateHistory(number, stateChanges, prior)
        if (!body) continue
        const data = Buffer.from(JSON.stringify(stateChanges), 'utf8').toString('base64')
        const content = `<!-- writer-state-data:${data} -->\n${body}`
        const block = `<!-- writer-state-history:${number}:start -->\n<!-- writer-state-checksum:${hashProse(content)} -->\n${content}\n<!-- writer-state-history:${number}:end -->`
        text = text.trimEnd() + `\n\n${block}\n`
      }
      await writeTextAtomic(file, text)
      if (invalidated.length) throw new Error(`${invalidated.length} 个后章历史含人工编辑，已标记待核对并暂停用于自动续写，原文保留`)
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

  private async deletePlotPointFile(chapter: number, title: string): Promise<boolean> {
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
      if (!isManagedPlotPoint(text, chapter)) return false
      await fs.unlink(file)
      return true
    })
  }

  private async removeObsoletePlotPoints(chapter: number, titles: string[]): Promise<void> {
    const dir = join(this.projectDir, '记忆', '剧情点')
    const keep = new Set(titles.map((title) => `第${String(chapter).padStart(3, '0')}章 ${sanitizeForFileName(title)}.md`))
    let files: string[]
    try { files = await fs.readdir(dir) } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
    for (const name of files) {
      if (!name.endsWith('.md') || keep.has(name)) continue
      const file = join(dir, name)
      await withFileLock(file, async () => {
        if (isManagedPlotPoint(await readText(file), chapter)) await fs.unlink(file)
      })
    }
  }

  /** 只删除 checksum 未变的本程序追踪行。 */
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
      const next = replaceManagedTrackingRow(text, kind, chapter, '')
      if (next === text) return 0
      await writeTextAtomic(file, next)
      return 1
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
function replaceManagedTrackingRow(text: string, kind: 'timeline' | 'context', chapter: number, newRow: string): string {
  const re = new RegExp(`<!-- writer-tracking:${kind}:${chapter}:([a-f0-9]+) -->\\r?\\n([^\\n]*)(?:\\r?\\n)?<!-- writer-tracking:${kind}:${chapter}:end -->`, 'g')
  let protectedBlock = false
  let replaced = false
  const block = newRow ? `<!-- writer-tracking:${kind}:${chapter}:${hashProse(newRow)} -->\n${newRow}\n<!-- writer-tracking:${kind}:${chapter}:end -->` : ''
  const next = text.replace(re, (whole: string, checksum: string, row: string) => {
    if (hashProse(row.replace(/\r$/, '')) !== checksum) {
      protectedBlock = true
      return whole
    }
    replaced = true
    return block
  })
  if (replaced || protectedBlock || !newRow) return next
  const lines = text.split(/\r?\n/)
  let lastTableRow = -1
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (/^\|.*\|$/.test(t) && !t.includes('---')) lastTableRow = i
  }
  // Append after the final complete managed block, never inside another chapter's markers.
  if (lastTableRow >= 0 && /^<!-- writer-tracking:.*:end -->$/.test(lines[lastTableRow + 1] ?? '')) lastTableRow++
  if (lastTableRow >= 0) lines.splice(lastTableRow + 1, 0, block)
  else lines.push(block)
  return lines.join('\n')
}

/** 字段 → 角色状态表列 */
function mapFieldToStateColumn(
  field: string
): StateColumn | null {
  const f = normalizeStateField(field)
  if (['伤势', '当前状态', '能力', '境界', '金手指', '实力'].includes(f)) return 'power'
  if (['情绪', '立场'].includes(f)) return 'stance'
  if (f === '目标') return 'goal'
  if (['持有物', '物品'].includes(f)) return 'items'
  if (['关系', '关系网'].includes(f)) return 'relations'
  if (f === '性格') return 'personality'
  if (f === '角色定位') return 'role'
  if (f === '身份') return 'identity'
  return null
}

type StateColumn = 'power' | 'stance' | 'goal' | 'items' | 'relations' | 'personality' | 'role' | 'identity'

function stateChangesKey(changes: MemoryExtraction['characterStateChanges']): string {
  return JSON.stringify(changes.map((c) => [c.name.trim(), normalizeStateField(c.field || '状态'), String(c.newValue ?? '').trim()]))
}

/** IDs take precedence. Legacy text references must be substantive, near-complete and unique. */
export function resolveAutomaticForeshadowing(
  foreshadowings: Foreshadowing[],
  reference: { foreshadowingId?: string; content: string }
): Foreshadowing | undefined {
  const id = reference.foreshadowingId?.trim()
  const normalize = (value: string) => value.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
  const content = normalize(reference.content || '')
  if (id) {
    const hits = foreshadowings.filter((item) => item.id === id)
    return hits.length === 1 && content.length >= 4 && normalize(hits[0].content) === content ? hits[0] : undefined
  }
  if (content.length < 4) return undefined
  const exact = foreshadowings.filter((item) => normalize(item.content) === content)
  if (exact.length) return exact.length === 1 ? exact[0] : undefined
  if (content.length < 8) return undefined
  const hits = foreshadowings.filter((item) => {
    const target = normalize(item.content)
    return Math.min(target.length, content.length) / Math.max(target.length, content.length) >= 0.85 && (target.includes(content) || content.includes(target))
  })
  return hits.length === 1 ? hits[0] : undefined
}
interface LedgerStateChange { characterId: string; field: string; key: string; value: string }
interface AutomaticStateLedger {
  version: 1
  fields: Record<string, { characterId: string; field: string; baseline: string; lastApplied: string }>
  tracks: Record<string, { baseline: string; lastApplied: string }>
  chapters: Record<string, LedgerStateChange[]>
}

function cardFieldKey(field: string): string {
  return ['能力', '境界', '金手指'].includes(field) ? '能力' : field
}

/** Upgrade only fields corroborated by the previous automatic history and trajectory. */
function migrateLegacyCardLedger(ledger: AutomaticStateLedger, history: string, chars: Character[]): void {
  const blocks = readManagedStateBlocks(history).filter((b) => b.intact).sort((a, b) => a.chapter - b.chapter)
  const evidence = new Map<string, { character: Character; field: string; firstChapter: number; latest: string; entries: string[] }>()
  for (const block of blocks) {
    for (const change of block.changes) {
      const character = findCharacterByName(chars, change.name)?.char
      const value = String(change.newValue ?? '').trim()
      if (!character || !value) continue
      const field = normalizeStateField(change.field || '状态')
      const key = cardFieldKey(field)
      const recordKey = `${character.id}:${key}`
      const prior = evidence.get(recordKey)
      evidence.set(recordKey, { character, field: key, firstChapter: prior?.firstChapter ?? block.chapter, latest: value, entries: [...(prior?.entries ?? []), `${field}：${value}`] })
    }
  }
  for (const [recordKey, record] of evidence) {
    const track = fieldToPlain(record.character.customFields?.['状态轨迹'])
    // Existing cards without the old writer's matching trail are author data, never inferred ownership.
    if (readCharacterField(record.character, record.field) !== record.latest || !record.entries.some((entry) => track.includes(entry))) continue
    const prior = parseCharacterStatesAt(history, record.firstChapter - 1).find((s) => s.name === record.character.name)
    const column = mapFieldToStateColumn(record.field)
    const provedBaseline = prior && column && (column !== 'power' || record.field === '能力' || record.field === '实力') ? prior[column] : undefined
    ledger.fields[recordKey] = {
      characterId: record.character.id, field: record.field,
      // Missing historical evidence is explicitly unknown; retaining the deleted event would invent history.
      baseline: provedBaseline && provedBaseline !== '-' ? provedBaseline : '', lastApplied: record.latest
    }
  }
  for (const block of blocks) {
    const changes: LedgerStateChange[] = []
    for (const change of block.changes) {
      const character = findCharacterByName(chars, change.name)?.char
      const field = normalizeStateField(change.field || '状态')
      const key = cardFieldKey(field)
      if (!character || !ledger.fields[`${character.id}:${key}`]) continue
      changes.push({ characterId: character.id, field, key, value: String(change.newValue ?? '').trim() })
    }
    if (changes.length) ledger.chapters[String(block.chapter)] = changes
  }
  for (const character of chars) {
    const entries = blocks.flatMap((block) => (ledger.chapters[String(block.chapter)] ?? [])
      .filter((c) => c.characterId === character.id).map((c) => `${c.field}：${c.value}`))
    if (!entries.length) continue
    const lastApplied = fieldToPlain(character.customFields?.['状态轨迹'])
    let baseline = lastApplied
    for (;;) {
      const suffix = entries.find((entry) => baseline === entry || baseline.endsWith(`；${entry}`))
      if (!suffix) break
      baseline = baseline.slice(0, baseline.length - suffix.length).replace(/；$/, '')
    }
    if (baseline !== lastApplied) ledger.tracks[character.id] = { baseline, lastApplied }
  }
}

function buildCharacterFieldPatch(field: string, value: string, custom: UpdateCharacterInput['customFields'] = {}): UpdateCharacterInput {
  const key = normalizeStateField(field)
  if (key === '身份') return { identity: value }
  if (key === '性格') return { personality: value }
  if (key === '能力') return { abilities: value }
  if (key === '角色定位') return { role: value }
  if (key === '当前状态') return { synopsis: value }
  return { customFields: { ...custom, [key]: value } }
}

function isManagedPlotPoint(text: string, chapter: number): boolean {
  const match = text.match(/\n<!-- writer-plot:(\d+):([a-f0-9]{64}) -->\r?\n?$/)
  return Boolean(match && Number(match[1]) === chapter && hashProse(text.slice(0, match.index)) === match[2])
}

function renderStateHistory(
  chapter: number,
  changes: MemoryExtraction['characterStateChanges'],
  prior: Map<string, CharacterStateSnapshot>,
  legacy = false
): string {
  const byName = new Map<string, { field: string; value: string }[]>()
  for (const c of changes) {
    const name = c.name?.trim()
    const value = String(c.newValue ?? '').trim()
    if (!name || !value) continue
    const list = byName.get(name) ?? []
    list.push({ field: normalizeStateField(c.field || '状态'), value })
    byName.set(name, list)
  }
  const snapshots: CharacterStateSnapshot[] = []
  const logs: string[] = []
  for (const [name, fields] of byName) {
    const state: CharacterStateSnapshot = { name, power: '-', stance: '-', goal: '-', items: '-', relations: '-', ...prior.get(name), updateChapter: chapter }
    const columns = new Map<StateColumn, string[]>()
    for (const f of fields) {
      const column = (legacy && ['性格', '角色定位', '身份'].includes(f.field) ? null : mapFieldToStateColumn(f.field)) ?? 'power'
      columns.set(column, [...(columns.get(column) ?? []), f.value])
      logs.push(`| 第 ${chapter} 章 | ${escapeTableCell(name)} | ${escapeTableCell(`${f.field}：${f.value}`)} |`)
    }
    for (const [column, values] of columns) state[column] = [...new Set(values)].join('；')
    snapshots.push(state)
  }
  if (!snapshots.length) return ''
  return [
    `## 自动历史快照（第 ${chapter} 章）`, '',
    legacy ? '| 角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 更新章节 |' : '| 角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 性格 | 角色定位 | 身份 | 更新章节 |',
    legacy ? '|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|---|---|---|---|',
    ...snapshots.map((s) => `| ${[s.name, s.power, s.stance, s.goal, s.items, s.relations,
      ...(!legacy ? [s.personality || '-', s.role || '-', s.identity || '-'] : []), `第 ${chapter} 章`].map(escapeTableCell).join(' | ')} |`),
    '', `## 自动状态变更（第 ${chapter} 章）`, '',
    '| 章节 | 角色 | 变更内容 |', '|---|---|---|', ...logs, ''
  ].join('\n')
}

function readManagedStateBlocks(text: string): { chapter: number; full: string; intact: boolean; changes: MemoryExtraction['characterStateChanges'] }[] {
  const blocks: { chapter: number; full: string; intact: boolean; changes: MemoryExtraction['characterStateChanges'] }[] = []
  for (const match of text.matchAll(/<!-- writer-state-history:(\d+):start -->\r?\n([\s\S]*?)\r?\n<!-- writer-state-history:\1:end -->/g)) {
    const chapter = Number(match[1])
    const body = match[2]
    const checked = body.match(/^<!-- writer-state-checksum:([a-f0-9]{64}) -->\r?\n([\s\S]*)$/)
    let changes: MemoryExtraction['characterStateChanges'] = []
    let intact = false
    if (checked) {
      const data = checked[2].match(/^<!-- writer-state-data:([A-Za-z0-9+/=]+) -->/)
      try {
        changes = data ? JSON.parse(Buffer.from(data[1], 'base64').toString('utf8')) : []
        intact = Boolean(data && Array.isArray(changes) && hashProse(checked[2]) === checked[1])
      } catch { /* A damaged or author-edited block is never overwritten. */ }
    } else {
      // One-time migration of the exact previous renderer output. Unrecognised/manual blocks stay untouched.
      const section = parseDoc(body).sections.find((s) => s.title.includes('自动状态变更'))
      const rows = section ? parseTable(section.body).rows : []
      changes = rows.flatMap((row) => {
        const split = row[2]?.indexOf('：') ?? -1
        return split < 0 ? [] : [{ name: row[1], field: row[2].slice(0, split), oldValue: '', newValue: row[2].slice(split + 1) }]
      })
      const prior = new Map(parseCharacterStatesAt(text, chapter - 1).map((s) => [s.name, s]))
      intact = renderStateHistory(chapter, changes, prior, true).trim() === body.trim()
    }
    blocks.push({ chapter, full: match[0], intact, changes })
  }
  return blocks
}
