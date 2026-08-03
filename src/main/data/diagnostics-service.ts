import { join } from 'path'
import { promises as fs } from 'fs'
import { ProjectService } from './project-service'
import { readText } from './skill-format/md-parser'
import { parseRhythmData } from './skill-format/rhythm-html'
import { CharacterRepo } from './memory/character-repo'
import { ForeshadowingMdRepo } from './skill-format/foreshadowing-md-repo'
import { OutlineMdRepo } from './skill-format/outline-md-repo'
import { LocationRepo } from './memory/location-repo'
import { WorldviewRepo } from './memory/worldview-repo'
import { DetailedOutlineMdRepo } from './skill-format/detailed-outline-md-repo'
import { DetailedOutlineWriter } from './skill-format/detailed-outline-writer'
import { ChapterRhythmWriter } from './skill-format/chapter-rhythm-writer'
import { ProseRepo } from './skill-format/prose-repo'
import { parseVolumeNumber } from './skill-format/md-parser'
import { serializeRhythmData } from './skill-format/rhythm-html'
import { writeTextAtomic } from './atomic'
import type { Diagnostic, DiagnosticFixKind, DiagnosticFixResult } from '../../shared/types'

// Diagnostic 的形状定义在 shared/types，渲染层和 preload 共用同一份，别在这里另立一个

/** 最多列举几个章号，避免几百章刷屏 */
const SAMPLE_LIMIT = 8
/** 明细最多列几行 */
const DETAIL_LIMIT = 12

/** 细纲与节奏图谱对不上的一章 */
interface Divergence {
  chapter: number
  outlineEmotion: number
  outlineClimax: number
  rhythmEmotion: number
  rhythmClimax: number
}

/**
 * 找出细纲与节奏图谱数值打架的章节。
 * 已回填（actualized）的章节图谱存的是成稿实际值、细纲存的是规划值，本就该允许不同，跳过。
 */
function findDivergences(
  details: readonly { chapterNumber: number; emotion?: number; climax?: number }[],
  entries: readonly { chapter: number; emotion: number; climax: number; actualized: boolean }[]
): Divergence[] {
  const byChapter = new Map(entries.map((e) => [e.chapter, e]))
  const out: Divergence[] = []
  for (const d of details) {
    if (d.emotion === undefined || d.climax === undefined) continue
    const e = byChapter.get(d.chapterNumber)
    if (!e || e.actualized) continue
    if (e.emotion === d.emotion && e.climax === d.climax) continue
    out.push({
      chapter: d.chapterNumber,
      outlineEmotion: d.emotion,
      outlineClimax: d.climax,
      rhythmEmotion: e.emotion,
      rhythmClimax: e.climax
    })
  }
  return out
}

/** 把章号数组压成「1、2、3 等 N 章」 */
function sampleChapters(chapters: readonly number[]): string {
  const head = chapters.slice(0, SAMPLE_LIMIT).join('、')
  return chapters.length > SAMPLE_LIMIT ? `${head}… 共 ${chapters.length} 章` : `${head}（${chapters.length} 章）`
}

/** 削掉字符串两端的分隔符与空白（`· · 她买下了整栋楼` → `她买下了整栋楼`） */
function stripSeparators(s: string): string {
  return s.replace(/^[\s·・\-—_:：|｜、]+/, '').replace(/[\s·・\-—_:：|｜、]+$/, '')
}

/** 文件名里不能出现的字符换成下划线，并压掉中间多余的分隔符 */
function sanitizeFileNamePart(s: string): string {
  return stripSeparators(s.replace(/[\\/:*?"<>|]/g, '_').replace(/[\s·・]{2,}/g, ' '))
}

/**
 * 正文文件名规范化：扩展名 .txt → .md，章号补齐三位零填充。
 * 分隔符（空格/下划线）与标题保持原样——ProseRepo 两种分隔符都认。
 */
function normalizeProseFileName(fileName: string): string {
  return fileName
    .replace(/^第\s*(\d+)\s*章/, (_all, n: string) => `第${n.padStart(3, '0')}章`)
    .replace(/\.txt$/, '.md')
}

/** 列目录，不存在时返回空数组（新建项目不报错） */
async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

/**
 * 格式体检：对项目内各 v4 真相源文件做解析健康检查。
 *
 * 两类检查：
 * 1. **解析健康**：文件存在且有内容，但解析结果为空/异常 → 格式偏离规范（静默丢数据）
 * 2. **交叉一致性**：各处都能解析，但相互对不上 → 数据静默失真，肉眼最难自查
 *
 * 文件不存在（新建项目）一律不报。
 */
export class DiagnosticsService {
  constructor(private readonly projectService: ProjectService) {}

  async report(projectId: string): Promise<Diagnostic[]> {
    const dir = await this.projectService.resolveDir(projectId)
    const out: Diagnostic[] = []
    out.push(...(await this.checkCharacterCard(dir)))
    out.push(...(await this.checkForeshadowing(dir)))
    out.push(...(await this.checkOutline(dir)))
    out.push(...(await this.checkRhythm(dir)))
    out.push(...(await this.checkLocations(dir)))
    out.push(...(await this.checkWorldview(dir)))
    out.push(...(await this.checkChapterConsistency(dir)))
    out.push(...(await this.checkUnreadableFiles(dir)))
    return out
  }

  /**
   * 执行一键修复。只处理机械、确定的修复；需要作者判断的问题不提供入口。
   * 修复后调用方应重新 report 一次，拿到最新状态。
   */
  async applyFix(projectId: string, kind: DiagnosticFixKind): Promise<DiagnosticFixResult> {
    const dir = await this.projectService.resolveDir(projectId)
    switch (kind) {
      case 'reset-actualized':
        return this.fixActualized(dir)
      case 'rename-volume-outlines':
        return this.fixVolumeOutlineNames(dir)
      case 'rename-prose-txt':
        return this.fixProseTxt(dir)
      case 'backfill-outline-rhythm':
        return this.fixOutlineRhythm(dir)
      case 'align-outline-to-rhythm':
        return this.fixAlignOutlineToRhythm(dir)
      case 'align-rhythm-to-outline':
        return this.fixAlignRhythmToOutline(dir)
      default:
        throw new Error(`未知的修复类型：${kind}`)
    }
  }

  /** 数值打架 → 改细纲，向节奏图谱看齐（技能规定的默认方向） */
  private async fixAlignOutlineToRhythm(dir: string): Promise<DiagnosticFixResult> {
    const diverged = await this.loadDivergences(dir)
    if (diverged.length === 0) {
      return { kind: 'align-outline-to-rhythm', changed: 0, message: '没有对不上的章节' }
    }
    const writer = new DetailedOutlineWriter(dir)
    let changed = 0
    const skipped: string[] = []
    for (const x of diverged) {
      try {
        await writer.update(x.chapter, { emotion: x.rhythmEmotion, climax: x.rhythmClimax })
        changed++
      } catch (err) {
        skipped.push(`第 ${x.chapter} 章（${(err as Error).message}）`)
      }
    }
    return {
      kind: 'align-outline-to-rhythm',
      changed,
      message: `${changed} 章细纲已按节奏图谱改写；节奏图谱与大纲表未改动`,
      skipped: skipped.length > 0 ? skipped : undefined
    }
  }

  /**
   * 数值打架 → 改节奏图谱，向细纲看齐。
   * 走 ChapterRhythmWriter，因此图谱 / 大纲逐章表 / 细纲三处一起同步，不会只改一处又跑偏。
   */
  private async fixAlignRhythmToOutline(dir: string): Promise<DiagnosticFixResult> {
    const diverged = await this.loadDivergences(dir)
    if (diverged.length === 0) {
      return { kind: 'align-rhythm-to-outline', changed: 0, message: '没有对不上的章节' }
    }
    const writer = new ChapterRhythmWriter(dir)
    let changed = 0
    const skipped: string[] = []
    for (const x of diverged) {
      try {
        await writer.update(x.chapter, { emotion: x.outlineEmotion, climax: x.outlineClimax })
        changed++
      } catch (err) {
        skipped.push(`第 ${x.chapter} 章（${(err as Error).message}）`)
      }
    }
    return {
      kind: 'align-rhythm-to-outline',
      changed,
      message: `${changed} 章节奏图谱已按细纲改写，大纲逐章节奏标注表同步更新`,
      skipped: skipped.length > 0 ? skipped : undefined
    }
  }

  /** 修复前重新算一次差异，避免拿 UI 上的旧快照去改文件 */
  private async loadDivergences(dir: string): Promise<Divergence[]> {
    const html = await readText(join(dir, '图解', '节奏图谱.html'))
    const entries = html ? parseRhythmData(html) : null
    if (!entries || entries.length === 0) return []
    const details = await new DetailedOutlineMdRepo(dir).listAll()
    return findDivergences(details, entries)
  }

  /** 把没有正文的章节 actualized 改回 false（有正文的保持 true，不动其 emotion/climax） */
  private async fixActualized(dir: string): Promise<DiagnosticFixResult> {
    const file = join(dir, '图解', '节奏图谱.html')
    const html = await readText(file)
    const entries = html ? parseRhythmData(html) : null
    if (!html || !entries) {
      return { kind: 'reset-actualized', changed: 0, message: '没找到可解析的节奏图谱' }
    }
    const written = new Set(await new ProseRepo(dir).listChapterNumbers())
    const next = entries.map((e) =>
      e.actualized && !written.has(e.chapter) ? { ...e, actualized: false } : e
    )
    const changed = next.filter((e, i) => e.actualized !== entries[i].actualized).length
    if (changed === 0) {
      return { kind: 'reset-actualized', changed: 0, message: '没有需要改的章节' }
    }
    await writeTextAtomic(file, serializeRhythmData(html, next))
    return {
      kind: 'reset-actualized',
      changed,
      message: `${changed} 章改回预测值（actualized=false），${written.size} 章已成稿的保持不变`
    }
  }

  /** 卷纲文件名改成 `第N卷_卷名.md`；卷名优先取原文件名里的，取不到再从 H1 提取 */
  private async fixVolumeOutlineNames(dir: string): Promise<DiagnosticFixResult> {
    const outlineDir = join(dir, '大纲')
    const files = await listDir(outlineDir)
    const existing = new Set(files)
    const targets = files.filter(
      (f) => f.endsWith('.md') && f.includes('卷') && !f.startsWith('细纲') && !/^第\d+卷/.test(f)
    )
    let changed = 0
    const skipped: string[] = []
    for (const f of targets) {
      const base = f.replace(/\.md$/, '')
      const num = parseVolumeNumber(base)
      if (num == null) {
        skipped.push(`${f}（文件名里没有卷号）`)
        continue
      }
      // 卷名：去掉「卷纲_」前缀和「第X卷」段后剩下的部分；为空则从 H1 里找
      let name = base
        .replace(/^卷纲[_\s-]*/, '')
        .replace(/第\s*[\d一二三四五六七八九十]+\s*卷[_\s-]*/, '')
        .trim()
      if (!name) {
        const text = await readText(join(outlineDir, f))
        const h1 = text?.match(/^#\s+(.+)$/m)?.[1] ?? ''
        // H1 形态多样：`# 卷纲 第一卷：角落里的素人（第 1-30 章）` / `# 卷纲 · 第1卷 · 她买下了整栋楼`
        // 统一做法：砍掉「卷纲」和「第X卷」两段，去掉尾部章节范围括号，再削掉两端的分隔符
        name = stripSeparators(
          h1
            .replace(/卷纲/g, '')
            .replace(/第\s*[\d一二三四五六七八九十]+\s*卷/, '')
            .replace(/（[^）]*）\s*$/, '')
            .replace(/\([^)]*\)\s*$/, '')
        )
      }
      name = sanitizeFileNamePart(name)
      const next = name ? `第${num}卷_${name}.md` : `第${num}卷.md`
      if (existing.has(next)) {
        skipped.push(`${f}（目标 ${next} 已存在）`)
        continue
      }
      await fs.rename(join(outlineDir, f), join(outlineDir, next))
      existing.delete(f)
      existing.add(next)
      changed++
    }
    return {
      kind: 'rename-volume-outlines',
      changed,
      message: changed > 0 ? `${changed} 份卷纲已改名，应用现在能读到了` : '没有可改名的卷纲',
      skipped: skipped.length > 0 ? skipped : undefined
    }
  }

  /**
   * 正文 .txt 改扩展名为 .md，同时把章号补齐到三位（内容不动）。
   *
   * 章号必须一起补：ProseRepo 读正文时用 `第NNN章` 三位零填充做前缀匹配，
   * 而 listChapterNumbers 用 `^第0*(\d+)章` 能认两位。只改扩展名的话，
   * 章节会出现在列表里却读不出内容——比原来的「完全看不见」更难排查。
   */
  private async fixProseTxt(dir: string): Promise<DiagnosticFixResult> {
    const proseDir = join(dir, '正文')
    const files = await listDir(proseDir)
    const existing = new Set(files)
    const targets = files.filter((f) => f.endsWith('.txt') && /第\s*\d+\s*章/.test(f))
    let changed = 0
    const skipped: string[] = []
    for (const f of targets) {
      const next = normalizeProseFileName(f)
      if (next === f) continue
      if (existing.has(next)) {
        skipped.push(`${f}（目标 ${next} 已存在）`)
        continue
      }
      await fs.rename(join(proseDir, f), join(proseDir, next))
      existing.delete(f)
      existing.add(next)
      changed++
    }
    return {
      kind: 'rename-prose-txt',
      changed,
      message: changed > 0 ? `${changed} 章正文已改为 .md（章号补齐三位）` : '没有需要改的正文文件',
      skipped: skipped.length > 0 ? skipped : undefined
    }
  }

  /** 细纲缺情绪值/爽点时，按节奏图谱补 `- **节奏标注**：` 字段 */
  private async fixOutlineRhythm(dir: string): Promise<DiagnosticFixResult> {
    const html = await readText(join(dir, '图解', '节奏图谱.html'))
    const entries = html ? parseRhythmData(html) : null
    if (!entries || entries.length === 0) {
      return { kind: 'backfill-outline-rhythm', changed: 0, message: '没找到可解析的节奏图谱' }
    }
    const rhythm = new Map(entries.map((e) => [e.chapter, e]))
    const details = await new DetailedOutlineMdRepo(dir).listAll()
    const need = details.filter((d) => d.emotion === undefined || d.climax === undefined)

    let changed = 0
    const skipped: string[] = []
    for (const d of need) {
      const r = rhythm.get(d.chapterNumber)
      if (!r) {
        skipped.push(`第 ${d.chapterNumber} 章（节奏图谱里没有这一章）`)
        continue
      }
      try {
        await new DetailedOutlineWriter(dir).update(d.chapterNumber, {
          emotion: r.emotion,
          climax: r.climax
        })
        changed++
      } catch (err) {
        skipped.push(`第 ${d.chapterNumber} 章（${(err as Error).message}）`)
      }
    }
    return {
      kind: 'backfill-outline-rhythm',
      changed,
      message: changed > 0 ? `${changed} 章细纲已按节奏图谱补上节奏标注` : '没有需要补的章节',
      skipped: skipped.length > 0 ? skipped : undefined
    }
  }

  /**
   * 「文件在那儿，但应用读不到」——命名不合约定导致的静默失效。
   *
   * 这类问题最难自查：目录里明明有东西，界面上就是没有，也不报错。
   * 两处真实案例：`恋综直播` 的 10 份卷纲叫 `卷纲_第一卷.md`（前缀不对 + 中文数字），
   * 从没被注入过写作 prompt；`师父的七个师姐` 的 3 章正文存成 `.txt`，应用里一章都看不到。
   */
  private async checkUnreadableFiles(dir: string): Promise<Diagnostic[]> {
    const out: Diagnostic[] = []

    // 卷纲：应用按 /^第(\d+)卷/ 匹配，其余命名一律读不到
    const outlineFiles = await listDir(join(dir, '大纲'))
    // 排除 细纲_*.md —— 旧项目会把按卷细纲放在 大纲/ 下（如 `细纲_第01卷.md`），那不是卷纲
    const volumeLike = outlineFiles.filter(
      (f) => f.endsWith('.md') && f.includes('卷') && !f.startsWith('细纲')
    )
    if (volumeLike.length > 0 && !volumeLike.some((f) => /^第\d+卷/.test(f))) {
      out.push({
        severity: 'warn',
        file: '大纲/',
        message: `${volumeLike.length} 份卷纲的文件名应用读不到：${volumeLike.slice(0, 3).join('、')}${volumeLike.length > 3 ? '…' : ''}`,
        hint: '卷纲文件名须以「第N卷」开头且用阿拉伯数字（如 `第1卷_觉醒.md`）。`卷纲_第X卷.md`、`卷纲_第一卷.md` 都不匹配，这些卷纲不会被注入写作 prompt',
        fixes: [{ kind: 'rename-volume-outlines', label: '批量改名' }]
      })
    }

    // 正文：应用只读 .md
    const proseFiles = await listDir(join(dir, '正文'))
    const txtChapters = proseFiles.filter((f) => f.endsWith('.txt') && /第\s*\d+\s*章/.test(f))
    if (txtChapters.length > 0) {
      out.push({
        severity: 'warn',
        file: '正文/',
        message: `${txtChapters.length} 章正文存成了 .txt，应用不会读取：${txtChapters.slice(0, 3).join('、')}${txtChapters.length > 3 ? '…' : ''}`,
        hint: '正文一律用 `.md`（`第NNN章 标题.md`）。旧版「正文写作」技能会落盘成 .txt，改扩展名即可恢复',
        fixes: [{ kind: 'rename-prose-txt', label: '改为 .md' }]
      })
    }

    return out
  }

  /**
   * 交叉一致性体检：节奏图谱 / 细纲 / 正文 三者对照。
   *
   * 覆盖三类真实踩过的坑：
   * - actualized 被误当成「细纲已落盘」刷成 true，把全书预测值伪装成实际值
   * - 细纲丢了 `> 节奏对齐` 引用块，情绪值静默回退节奏图谱（表面正常，改细纲不生效）
   * - 细纲与节奏图谱数值不一致（细纲应以图谱为准）
   */
  private async checkChapterConsistency(dir: string): Promise<Diagnostic[]> {
    const html = await readText(join(dir, '图解', '节奏图谱.html'))
    const entries = html ? parseRhythmData(html) : null
    if (!entries || entries.length === 0) return []

    const out: Diagnostic[] = []
    const written = new Set(await new ProseRepo(dir).listChapterNumbers())

    // 1. actualized 越权：标了实际值，却没有正文
    const overMarked = entries.filter((e) => e.actualized && !written.has(e.chapter)).map((e) => e.chapter)
    if (overMarked.length > 0) {
      out.push({
        severity: 'warn',
        file: '图解/节奏图谱.html',
        message: `${overMarked.length} 章标记为实际值（actualized=true）但还没有正文：${sampleChapters(overMarked)}`,
        hint: 'actualized 只该在正文写完后回填。写细纲/批量同步时误刷成 true，会让图表把预测值当实际值画实线，卷终情绪等违规检查也会对着预测值空跑。把没有正文的章改回 false',
        fixes: [{ kind: 'reset-actualized', label: '改回 false' }]
      })
    }

    // 2. 正文已成稿却仍是预测值（提示级：回填是可选动作）
    const unMarked = entries.filter((e) => !e.actualized && written.has(e.chapter)).map((e) => e.chapter)
    if (unMarked.length > 0) {
      out.push({
        severity: 'info',
        file: '图解/节奏图谱.html',
        message: `${unMarked.length} 章正文已成稿，但节奏图谱仍是预测值：${sampleChapters(unMarked)}`,
        hint: '按成稿实际效果回填 emotion / climax 并置 actualized: true，图谱才能反映真实曲线'
      })
    }

    const details = await new DetailedOutlineMdRepo(dir).listAll()
    if (details.length === 0) return out

    // 3. 细纲读不出情绪值/爽点 —— 会静默回退节奏图谱，改细纲不生效
    const missing = details.filter((d) => d.emotion === undefined || d.climax === undefined).map((d) => d.chapterNumber)
    if (missing.length > 0) {
      out.push({
        severity: 'warn',
        file: '细纲/',
        message: `${missing.length} 章细纲读不到情绪值/爽点，正在静默回退节奏图谱：${sampleChapters(missing)}`,
        hint: '章号块下补引用块 `> 节奏对齐：情绪值 N、爽点类型 N（层级）`，或加字段 `- **节奏标注**：` + 缩进的 `- 情绪值：N`',
        fixes: [{ kind: 'backfill-outline-rhythm', label: '按节奏图谱补齐' }]
      })
    }

    // 4. 细纲与节奏图谱数值打架。已回填章节的图谱值是「实际」、细纲是「规划」，本就该允许不同，跳过
    const diverged = findDivergences(details, entries)
    if (diverged.length > 0) {
      out.push({
        severity: 'warn',
        file: '细纲/',
        message: `${diverged.length} 章细纲的情绪值/爽点与节奏图谱不一致：${sampleChapters(diverged.map((x) => x.chapter))}`,
        hint: '按技能规定，节奏图谱是节奏的真相源，细纲须向它看齐。但如果是你改了细纲、图谱没跟上，就选反方向',
        details: diverged
          .slice(0, DETAIL_LIMIT)
          .map(
            (x) =>
              `第 ${x.chapter} 章：细纲 情绪${x.outlineEmotion}/爽点${x.outlineClimax} ↔ 图谱 情绪${x.rhythmEmotion}/爽点${x.rhythmClimax}`
          )
          .concat(diverged.length > DETAIL_LIMIT ? [`…另有 ${diverged.length - DETAIL_LIMIT} 章`] : []),
        fixes: [
          {
            kind: 'align-outline-to-rhythm',
            label: '以节奏图谱为准',
            title: '改细纲的情绪值/爽点，向节奏图谱看齐。节奏图谱与大纲表不动'
          },
          {
            kind: 'align-rhythm-to-outline',
            label: '以细纲为准',
            title: '改节奏图谱，向细纲看齐。会同时同步大纲逐章节奏标注表'
          }
        ]
      })
    }

    return out
  }

  /** 角色：设定/角色/*.md 含 `- **字段**` 但 0 角色 -> 角色块/分类节格式问题 */
  private async checkCharacterCard(dir: string): Promise<Diagnostic[]> {
    const rolesDir = join(dir, '设定', '角色')
    let files: string[]
    try {
      files = await fs.readdir(rolesDir)
    } catch {
      return []
    }
    const mdFiles = files.filter((f) => f.endsWith('.md'))
    if (mdFiles.length === 0) return []
    // 任一文件含 bold field 但 CharacterRepo 解析到 0 个角色 -> 报警
    let hasFields = false
    for (const f of mdFiles) {
      const text = await readText(join(rolesDir, f))
      if (text && text.includes('- **')) {
        hasFields = true
        break
      }
    }
    if (!hasFields) return []
    const count = (await new CharacterRepo(dir).list()).length
    if (count > 0) return []
    return [
      {
        severity: 'warn',
        file: '设定/角色/',
        message: '角色文件含字段但解析到 0 个角色',
        hint: '每个角色文件须以 `# 人名` 开头，字段用 `- **字段名**：值` 格式'
      }
    ]
  }

  /** 伏笔：表存在（≥3 行）但 0 条 -> 表头关键词不匹配（最常见） */
  private async checkForeshadowing(dir: string): Promise<Diagnostic[]> {
    const text = await readText(join(dir, '追踪', '伏笔.md'))
    if (!text) return []
    const tableRows = text
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith('|') && !l.includes('---')).length
    if (tableRows < 3) return []
    const count = (await new ForeshadowingMdRepo(dir).list()).length
    if (count > 0) return []
    return [
      {
        severity: 'warn',
        file: '追踪/伏笔.md',
        message: '伏笔表存在但解析到 0 条（疑似表头不匹配）',
        hint: '表头须含：编号 / 内容 / 类型 / 埋设 / 预计回收 / 实际回收 / 状态'
      }
    ]
  }

  /** 大纲：有卷标题 H3 但 0 卷 -> 卷标题格式偏离 */
  private async checkOutline(dir: string): Promise<Diagnostic[]> {
    const text = await readText(join(dir, '大纲', '大纲.md'))
    if (!text) return []
    if (!/### 第\s*[一二三四五六七八九十\d]+\s*[卷部]/.test(text)) return []
    const read = await new OutlineMdRepo(dir).read()
    if (read && read.volumes.length > 0) return []
    return [
      {
        severity: 'warn',
        file: '大纲/大纲.md',
        message: '检测到卷标题但解析到 0 卷',
        hint: '卷标题须为 `### 第N卷：卷名（第X-Y章）`（中/阿数字均可，须有中文冒号和章节范围）'
      }
    ]
  }

  /** 节奏图谱：有 rhythmData 块但 0 条 -> entry JS 字面量格式偏离 */
  private async checkRhythm(dir: string): Promise<Diagnostic[]> {
    const html = await readText(join(dir, '图解', '节奏图谱.html'))
    if (!html || !html.includes('rhythmData')) return []
    const entries = parseRhythmData(html)
    if (entries && entries.length > 0) return []
    return [
      {
        severity: 'warn',
        file: '图解/节奏图谱.html',
        message: 'rhythmData 块存在但解析到 0 条',
        hint: "每条须为 { chapter: N, title: '...', emotion: N, climax: N, volume: N, actualized: bool }（单引号、小写 true/false）"
      }
    ]
  }

  /** 地点：设定/世界观/地理.md 有 H2 节但 0 个 -> 节标题格式问题 */
  private async checkLocations(dir: string): Promise<Diagnostic[]> {
    const text = await readText(join(dir, '设定', '世界观', '地理.md'))
    if (!text || !/^##\s/m.test(text)) return []
    const count = (await new LocationRepo(dir).list()).length
    if (count > 0) return []
    return [
      {
        severity: 'warn',
        file: '设定/世界观/地理.md',
        message: '有地点节但解析到 0 个',
        hint: '每个地点须为独立的 `## N. 地名` 节'
      }
    ]
  }

  /** 世界观：设定/世界观/*.md 有 H2 节但 0 个 */
  private async checkWorldview(dir: string): Promise<Diagnostic[]> {
    const wvDir = join(dir, '设定', '世界观')
    let files: string[]
    try {
      files = await fs.readdir(wvDir)
    } catch {
      return []
    }
    const mdFiles = files.filter((f) => f.endsWith('.md') && f !== '地理.md')
    if (mdFiles.length === 0) return []
    // 任一文件含 H2 节但 WorldviewRepo 解析到 0 个 -> 报警
    let hasSections = false
    for (const f of mdFiles) {
      const text = await readText(join(wvDir, f))
      if (text && /^##\s/m.test(text)) {
        hasSections = true
        break
      }
    }
    if (!hasSections) return []
    const count = (await new WorldviewRepo(dir).list()).length
    if (count > 0) return []
    return [
      {
        severity: 'warn',
        file: '设定/世界观/',
        message: '有世界观节但解析到 0 个',
        hint: '每个条目须为独立的 `## 节标题`'
      }
    ]
  }
}
