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

    // 2.5 时间线
    if (extraction.newPlotPoints.length > 0) {
      try {
        await this.appendTimeline(extraction.chapterNumber, extraction.newPlotPoints)
      } catch (e) {
        errors.push(`时间线追加失败: ${(e as Error).message}`)
      }
    }

    // 2.6 进度摘要
    try {
      await this.appendProgress(extraction.chapterNumber, extraction.newPlotPoints)
    } catch (e) {
      errors.push(`进度摘要追加失败: ${(e as Error).message}`)
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
