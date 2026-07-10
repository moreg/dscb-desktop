import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { LlmService } from './llm-service'
import { ProjectService } from './project-service'
import { BenchmarkResolver } from './teardown/benchmark-resolver'
import { recallBenchmark, mergeRecalls } from './teardown/benchmark-recall'
import { writeTextAtomic } from './atomic'
import {
  OPENING_SYSTEM_PROMPT,
  inferStrength,
  STRENGTH_LABELS
} from './skill-prompts/opening/topic-routing'
import { buildCoreSettingsPrompt, type BenchmarkRecallContext } from './skill-prompts/opening/core-settings'
import { buildVolumeOutlinePrompt } from './skill-prompts/opening/volume-outline'
import { buildChapterOutlinePrompt, FIRST_CHAPTERS_BATCH } from './skill-prompts/opening/chapter-outline'
import type { ProjectData } from '../../shared/types'
import { OutlineMdRepo } from './skill-format/outline-md-repo'
import { buildRhythmHtml, extractRhythmFromMarkdown } from './rhythm-html-builder'
import { checkOpeningConsistency, type ConsistencyReport } from './opening-postcheck'
import { DeslopService } from './deslop/deslop-service'
import { deslopFileMap, deslopChapterContent } from './opening-deslop-helper'
import { writeTrackingFiles, persistChapterOutlines, compileMemorySystemCompat } from './opening-persist-helpers'
import {
  normalizeOutlinePath,
  toChineseVolumeAlias,
  parseMergedMarkdown,
  isSafeRelPath,
  splitByChapterMarker
} from './opening-markdown'


export interface OpeningCallbacks {
  onToken?: (token: string) => void
}

/** 寮€涔﹂粯璁ら厤缃紙椤圭洰鏈～鏃跺厹搴曪級 */
const DEFAULT_TARGET_CHAPTERS = 200
const DEFAULT_CHAPTER_WORDCOUNT = 2500
const CORE_SETTINGS_MAX_TOKENS = 12_288
const FIRST_CHAPTERS_MAX_TOKENS = 16_384
const MAX_OPENING_CONTINUATIONS = 2

function volumeOutlineMaxTokens(targetChapters: number): number {
  const recommendedVolumes = Math.max(6, Math.ceil(targetChapters / 30))
  return Math.min(65_536, Math.max(32_768, recommendedVolumes * 6_144))
}

/**
 * 从卷级大纲中截取第 [from, from+count-1] 章的内容。
 * 大纲格式约定：每章以 `### 第N章：{标题}` 起始，到下一章标题或文件末尾结束。
 * 截取结果同时保留卷级骨架（卷名/章节范围）以维持上下文。
 */
function sliceVolumeOutlineForChapters(
  volumeOutline: string,
  fromChapter: number,
  count: number
): string {
  if (!volumeOutline.trim()) return ''
  const endChapter = fromChapter + count - 1
  // 1) 定位"总章表格"前/后/中的有用骨架信息
  const lines = volumeOutline.split('\n')
  const result: string[] = []
  let currentChapterNum: number | null = null
  let capturing = false

  for (const line of lines) {
    // 识别章节起始：### 第N章：xxx
    const m = line.match(/^#{2,4}\s*第\s*(\d+)\s*章[：:]/i)
    if (m) {
      const n = parseInt(m[1], 10)
      currentChapterNum = n
      if (n >= fromChapter && n <= endChapter) {
        capturing = true
        result.push(line)
      } else if (n > endChapter) {
        capturing = false
      } else {
        capturing = false
      }
      continue
    }
    if (capturing) {
      result.push(line)
    }
  }

  // 2) 附加全局骨架：保留"关键转折点"表格（前 endChapter 范围内出现的）
  const kpRows: string[] = []
  let inKpTable = false
  for (const line of lines) {
    if (/^#{0,4}\s*关键转折点/i.test(line)) inKpTable = true
    else if (inKpTable && /^#{0,4}\s+\S/.test(line) && !/关键转折点/i.test(line)) inKpTable = false
    if (inKpTable && line.startsWith('|')) {
      const chMatch = line.match(/第\s*(\d+)\s*章/)
      if (chMatch) {
        const n = parseInt(chMatch[1], 10)
        if (n >= fromChapter && n <= endChapter) kpRows.push(line)
      } else if (/^[\s|:-]+$/.test(line) || /编号\s*\|/.test(line)) {
        kpRows.push(line)
      }
    }
  }
  if (kpRows.length > 1) {
    result.unshift('### 关键转折点（前 N 章相关）')
    result.splice(1, 0, ...kpRows)
    result.splice(kpRows.length + 1, 0, '')
  }

  // 3) 附加伏笔表（前 N 章范围内已埋设的）
  const fbRows: string[] = []
  let inFbTable = false
  for (const line of lines) {
    if (/^#{0,4}\s*伏笔/i.test(line)) inFbTable = true
    else if (inFbTable && /^#{0,4}\s+\S/.test(line) && !/伏笔/i.test(line)) inFbTable = false
    if (inFbTable && line.startsWith('|')) {
      const chMatch = line.match(/第\s*(\d+)\s*章/)
      if (chMatch) {
        const n = parseInt(chMatch[1], 10)
        if (n >= fromChapter && n <= endChapter) fbRows.push(line)
      } else if (/^[\s|:-]+$/.test(line) || /编号\s*\|/.test(line)) {
        fbRows.push(line)
      }
    }
  }
  if (fbRows.length > 1) {
    result.unshift('### 伏笔（前 N 章相关）')
    result.splice(fbRows.length + 1, 0, ...fbRows)
    result.splice(fbRows.length * 2 + 1, 0, '')
  }

  // 4) 顶部加一行说明
  const header = `> 以下为第 ${fromChapter}-${endChapter} 章的卷级大纲片段（自动从完整大纲中截取，避免上下文过长）\n`
  return header + result.join('\n').trim()
}

function buildVolumeOutlineContinuationPrompt(
  coreSettings: string,
  targetChapters: number,
  chapterWordCount: number,
  partialOutline: string
): string {
  return `## 任务：继续补全被截断的卷级大纲输出
Internal marker: CONTINUE_TRUNCATED_VOLUME_OUTLINE.

上一次输出因为长度限制中断。请严格从「已输出内容」的末尾之后继续写，不要重复已输出内容，不要解释，不要重新开头，继续保持 \`=== 相对路径 ===\` 文件分隔格式，直到补完所有卷纲文件。

### 核心设定
${coreSettings}

### 篇幅
- 预计总章数：${targetChapters} 章
- 每章字数：约 ${chapterWordCount} 字

### 已输出内容
${partialOutline}

继续输出：`
}

function buildCoreSettingsContinuationPrompt(brainDump: string, partial: string): string {
  return `## 任务：继续补全被截断的核心设定输出
Internal marker: CONTINUE_TRUNCATED_CORE_SETTINGS.

上一次输出因为长度限制中断。请严格从「已输出内容」的末尾之后继续写，不要重复已输出内容，不要解释，不要重新开头，继续保持 Markdown 格式输出。

### 原始脑洞
${brainDump}

### 已输出内容
${partial}

继续输出：`
}

function buildFirstChaptersContinuationPrompt(
  coreSettings: string,
  volumeOutline: string,
  fromChapter: number,
  count: number,
  chapterWordCount: number,
  isGolden: boolean,
  partial: string
): string {
  return `## 任务：继续补全被截断的章节细纲输出
Internal marker: CONTINUE_TRUNCATED_CHAPTER_OUTLINE.

上一次输出因为长度限制中断。请严格从「已输出内容」的末尾之后继续写，不要重复已输出内容，不要解释，不要重新开头，继续保持章节细纲格式，直到写完第 ${fromChapter + count - 1} 章。

### 核心设定
${coreSettings}

### 卷级大纲
${volumeOutline}

### 要求
- 从第 ${fromChapter} 章开始，共 ${count} 章
- 每章约 ${chapterWordCount} 字${isGolden ? '\n- 前三章为黄金三章，需特别注重钩子和代入感' : ''}

### 已输出内容
${partial}

继续输出：`
}

/**
 * 寮€涔︽湇鍔★紙缂栨帓 story-long-write Phase 1-3锛夈€? *
 * 4 姝ユ祦绋嬶紝姣忔鐙珛鍙皟锛堝墠绔悜瀵奸€愭纭锛夛細
 * 1. generateCoreSettings锛氳剳娲?鈫?鏍稿績璁惧畾琛紙娴佸紡锛? * 2. generateVolumeOutline锛氭牳蹇冭瀹?鈫?鍗风骇澶х翰锛堟祦寮忥級
 * 3. generateFirstChapters锛氭牳蹇冭瀹?+ 鍗风骇澶х翰 鈫?鍓?N 绔犵粏绾诧紙浜旀寮?+ 瀛楁暟棰勭畻锛? * 4. persistOpening锛氬皢涓婅堪鏍稿績璁惧畾銆佸嵎绾蹭笌缁嗙翰瑙ｆ瀽骞惰惤鐩樺埌鏂扮増鐨?璁惧畾/銆佸ぇ绾? 涓?杩借釜/ 绛夌洰褰曘€? */
export class OpeningService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly llm: LlmService,
    private readonly benchmarkResolver?: BenchmarkResolver,
    private readonly deslopService?: DeslopService
  ) {}

  /* =========================================================
     Step 1：脑洞 → 核心设定表（流式）
     ========================================================= */

  async generateCoreSettings(
    projectId: string,
    brainDump: string,
    cb: OpeningCallbacks = {}
  ): Promise<string> {
    if (!brainDump.trim()) throw new Error('鑴戞礊涓嶈兘涓虹┖')
    const project = await this.projectService.getProjectData(projectId)
    const strength = inferStrength(brainDump)
    const recall = await this.loadBenchmarkRecall(projectId, project)

    let prompt = buildCoreSettingsPrompt(
      brainDump.trim(),
      `${STRENGTH_LABELS[strength]}（推荐题材：${this.recommendGenres(strength)}）`,
      recall
    )
    let md = ''
    const onToken = (token: string): void => {
      md += token
      cb.onToken?.(token)
    }

    for (let attempt = 0; attempt <= MAX_OPENING_CONTINUATIONS; attempt++) {
      try {
        await this.llm.generateStream(prompt, {
          systemPrompt: OPENING_SYSTEM_PROMPT,
          maxTokens: CORE_SETTINGS_MAX_TOKENS,
          meta: { feature: 'opening', projectId },
          onToken
        })
        return md
      } catch (err) {
        if ((err as Error).message !== 'LLM_OUTPUT_TRUNCATED' || attempt === MAX_OPENING_CONTINUATIONS) {
          throw err
        }
        prompt = buildCoreSettingsContinuationPrompt(brainDump, md)
      }
    }
    return md
  }

  /* =========================================================
     Step 2：核心设定 → 卷级大纲（流式）
     ========================================================= */

  async generateVolumeOutline(
    projectId: string,
    coreSettings: string,
    cb: OpeningCallbacks = {}
  ): Promise<string> {
    const project = await this.projectService.getProjectData(projectId)
    const targetChapters = project.targetChapters ?? DEFAULT_TARGET_CHAPTERS
    const chapterWordCount = project.chapterWordCount ?? DEFAULT_CHAPTER_WORDCOUNT

    let prompt = buildVolumeOutlinePrompt(coreSettings, targetChapters, chapterWordCount)
    let md = ''
    const maxTokens = volumeOutlineMaxTokens(targetChapters)
    const onToken = (token: string): void => {
      md += token
      cb.onToken?.(token)
    }

    for (let attempt = 0; attempt <= MAX_OPENING_CONTINUATIONS; attempt++) {
      try {
        await this.llm.generateStream(prompt, {
          systemPrompt: OPENING_SYSTEM_PROMPT,
          maxTokens,
          meta: { feature: 'opening', projectId },
          onToken
        })
        return md
      } catch (err) {
        if ((err as Error).message !== 'LLM_OUTPUT_TRUNCATED' || attempt === MAX_OPENING_CONTINUATIONS) {
          throw err
        }
        prompt = buildVolumeOutlineContinuationPrompt(
          coreSettings,
          targetChapters,
          chapterWordCount,
          md
        )
      }
    }
    return md
  }

  /* =========================================================
     Step 3：核心设定 + 卷级大纲 → 前 N 章细纲（流式）
     ========================================================= */

  async generateFirstChapters(
    projectId: string,
    coreSettings: string,
    volumeOutline: string,
    fromChapter: number,
    count: number,
    cb: OpeningCallbacks = {}
  ): Promise<string> {
    const project = await this.projectService.getProjectData(projectId)
    const chapterWordCount = project.chapterWordCount ?? DEFAULT_CHAPTER_WORDCOUNT
    const isGolden = fromChapter <= 3
    const slicedOutline = sliceVolumeOutlineForChapters(volumeOutline, fromChapter, count)

    let prompt = buildChapterOutlinePrompt(
      coreSettings,
      slicedOutline,
      fromChapter,
      count,
      chapterWordCount,
      isGolden
    )
    let md = ''
    const onToken = (token: string): void => {
      md += token
      cb.onToken?.(token)
    }

    for (let attempt = 0; attempt <= MAX_OPENING_CONTINUATIONS; attempt++) {
      try {
        await this.llm.generateStream(prompt, {
          systemPrompt: OPENING_SYSTEM_PROMPT,
          maxTokens: FIRST_CHAPTERS_MAX_TOKENS,
          meta: { feature: 'opening', projectId },
          onToken
        })
        return md
      } catch (err) {
        if ((err as Error).message !== 'LLM_OUTPUT_TRUNCATED' || attempt === MAX_OPENING_CONTINUATIONS) {
          throw err
        }
        prompt = buildFirstChaptersContinuationPrompt(
          coreSettings,
          slicedOutline,
          fromChapter,
          count,
          chapterWordCount,
          isGolden,
          md
        )
      }
    }
    return md
  }

  /* =========================================================
     手动续写：传入已有内容，从断点继续生成
     ========================================================= */

  async continueCoreSettings(
    projectId: string,
    brainDump: string,
    partial: string,
    cb: OpeningCallbacks = {}
  ): Promise<string> {
    if (!brainDump.trim()) throw new Error('脑洞不能为空')
    if (!partial.trim()) throw new Error('已有内容为空，无法续写')
    const project = await this.projectService.getProjectData(projectId)
    const strength = inferStrength(brainDump)
    const recall = await this.loadBenchmarkRecall(projectId, project)

    let prompt = buildCoreSettingsContinuationPrompt(brainDump, partial)
    let md = partial
    const onToken = (token: string): void => {
      md += token
      cb.onToken?.(token)
    }

    for (let attempt = 0; attempt <= MAX_OPENING_CONTINUATIONS; attempt++) {
      try {
        await this.llm.generateStream(prompt, {
          systemPrompt: OPENING_SYSTEM_PROMPT,
          maxTokens: CORE_SETTINGS_MAX_TOKENS,
          meta: { feature: 'opening', projectId },
          onToken
        })
        return md
      } catch (err) {
        if ((err as Error).message !== 'LLM_OUTPUT_TRUNCATED' || attempt === MAX_OPENING_CONTINUATIONS) {
          throw err
        }
        prompt = buildCoreSettingsContinuationPrompt(brainDump, md)
      }
    }
    return md
  }

  async continueVolumeOutline(
    projectId: string,
    coreSettings: string,
    partial: string,
    cb: OpeningCallbacks = {}
  ): Promise<string> {
    if (!coreSettings.trim()) throw new Error('核心设定为空')
    if (!partial.trim()) throw new Error('已有内容为空，无法续写')
    const project = await this.projectService.getProjectData(projectId)
    const targetChapters = project.targetChapters ?? DEFAULT_TARGET_CHAPTERS
    const chapterWordCount = project.chapterWordCount ?? DEFAULT_CHAPTER_WORDCOUNT

    let prompt = buildVolumeOutlineContinuationPrompt(coreSettings, targetChapters, chapterWordCount, partial)
    let md = partial
    const maxTokens = volumeOutlineMaxTokens(targetChapters)
    const onToken = (token: string): void => {
      md += token
      cb.onToken?.(token)
    }

    for (let attempt = 0; attempt <= MAX_OPENING_CONTINUATIONS; attempt++) {
      try {
        await this.llm.generateStream(prompt, {
          systemPrompt: OPENING_SYSTEM_PROMPT,
          maxTokens,
          meta: { feature: 'opening', projectId },
          onToken
        })
        return md
      } catch (err) {
        if ((err as Error).message !== 'LLM_OUTPUT_TRUNCATED' || attempt === MAX_OPENING_CONTINUATIONS) {
          throw err
        }
        prompt = buildVolumeOutlineContinuationPrompt(coreSettings, targetChapters, chapterWordCount, md)
      }
    }
    return md
  }

  async continueFirstChapters(
    projectId: string,
    coreSettings: string,
    volumeOutline: string,
    fromChapter: number,
    count: number,
    partial: string,
    cb: OpeningCallbacks = {}
  ): Promise<string> {
    if (!coreSettings.trim()) throw new Error('核心设定为空')
    if (!partial.trim()) throw new Error('已有内容为空，无法续写')
    const project = await this.projectService.getProjectData(projectId)
    const chapterWordCount = project.chapterWordCount ?? DEFAULT_CHAPTER_WORDCOUNT
    const isGolden = fromChapter <= 3
    const slicedOutline = sliceVolumeOutlineForChapters(volumeOutline, fromChapter, count)

    let prompt = buildFirstChaptersContinuationPrompt(
      coreSettings, slicedOutline, fromChapter, count, chapterWordCount, isGolden, partial
    )
    let md = partial
    const onToken = (token: string): void => {
      md += token
      cb.onToken?.(token)
    }

    for (let attempt = 0; attempt <= MAX_OPENING_CONTINUATIONS; attempt++) {
      try {
        await this.llm.generateStream(prompt, {
          systemPrompt: OPENING_SYSTEM_PROMPT,
          maxTokens: FIRST_CHAPTERS_MAX_TOKENS,
          meta: { feature: 'opening', projectId },
          onToken
        })
        return md
      } catch (err) {
        if ((err as Error).message !== 'LLM_OUTPUT_TRUNCATED' || attempt === MAX_OPENING_CONTINUATIONS) {
          throw err
        }
        prompt = buildFirstChaptersContinuationPrompt(
          coreSettings, slicedOutline, fromChapter, count, chapterWordCount, isGolden, md
        )
      }
    }
    return md
  }

  /* =========================================================
     Step 2.5：节奏图谱 HTML 生成（独立可调，落盘前的预览入口）
     ========================================================= */

  /**
   * 根据卷级大纲生成节奏图谱 HTML 字符串（不落盘）。
   * 用于 Step2 大纲确认后、Step3 细纲生成前的预览。
   * 落盘时 persistOpening 仍会重新生成并写入 图解/节奏图谱.html。
   */
  async generateRhythmHtml(
    projectId: string,
    volumeOutline: string
  ): Promise<string> {
    if (!volumeOutline.trim()) throw new Error('卷级大纲为空，无法生成节奏图谱')

    const project = await this.projectService.getProjectData(projectId)
    const targetChapters = project.targetChapters ?? DEFAULT_TARGET_CHAPTERS
    const today = new Date().toISOString().slice(0, 10)

    // 从 volumeOutline 中提取主大纲内容（=== 大纲/大纲.md === 标记块，或整段）
    const outlineMap = parseMergedMarkdown(volumeOutline)
    let mainOutlineContent = ''
    if (Object.keys(outlineMap).length === 0) {
      mainOutlineContent = volumeOutline
    } else {
      const key = Object.keys(outlineMap).find((k) => k.endsWith('大纲.md'))
      mainOutlineContent = key ? outlineMap[key] : Object.values(outlineMap)[0] ?? ''
    }

    // 内存中解析逐章节奏（不依赖文件落盘）
    const rhythmEntries = extractRhythmFromMarkdown(mainOutlineContent)

    return buildRhythmHtml(
      rhythmEntries,
      project.name ?? '未命名',
      today,
      targetChapters
    )
  }

  /* =========================================================
     Step 4：落盘（核心设定 + 卷级大纲 + 细纲）
     ========================================================= */

  async persistOpening(
    projectId: string,
    coreSettings: string,
    volumeOutline: string,
    chaptersMd?: string,
    fromChapter?: number
  ): Promise<{ settingsFile: string; outlineFile: string; chapterFiles: string[]; consistencyReport?: ConsistencyReport }> {
    if (!coreSettings.trim()) throw new Error('核心设定为空，无法落盘')
    if (!volumeOutline.trim()) throw new Error('卷级大纲为空，无法落盘')
    if (chaptersMd !== undefined && !chaptersMd.trim()) throw new Error('细纲为空')


    const dir = await this.projectService.resolveDir(projectId)
    const today = new Date().toISOString().slice(0, 10)

    const settingsMap = parseMergedMarkdown(coreSettings)
    const characterNames: string[] = []
    await fs.mkdir(join(dir, '设定'), { recursive: true })
    await writeTextAtomic(join(dir, '设定', '核心设定.md'), coreSettings)
    let primarySettingsFile = '设定/题材定位.md'

    if (Object.keys(settingsMap).length === 0) {
      const fullPath = join(dir, primarySettingsFile)
      await fs.mkdir(dirname(fullPath), { recursive: true })
      await writeTextAtomic(fullPath, coreSettings)
    } else {
      // 落盘前去 AI 味（叙述性文件：题材定位、角色卡、世界观、势力、关系）
      const deslopedSettingsMap = await this.deslopSettingsMap(settingsMap)
      for (const [relPath, content] of Object.entries(deslopedSettingsMap)) {
        if (!isSafeRelPath(relPath, ['设定'])) {
          console.warn(`[opening-service] 拒绝越界设定路径：${relPath}`)
          continue
        }
        const fullPath = join(dir, relPath)
        await fs.mkdir(dirname(fullPath), { recursive: true })
        await writeTextAtomic(fullPath, content)
        if (relPath.startsWith('设定/角色/')) {
          characterNames.push(relPath.replace('设定/角色/', '').replace(/\.md$/, ''))
        }
      }
      if (!settingsMap[primarySettingsFile]) primarySettingsFile = '设定/核心设定.md'
    }

    const outlineMap = parseMergedMarkdown(volumeOutline)
    let mainOutlineContent = ''
    if (Object.keys(outlineMap).length === 0) {
      mainOutlineContent = volumeOutline
      const relPath = '大纲/大纲.md'
      const fullPath = join(dir, relPath)
      await fs.mkdir(dirname(fullPath), { recursive: true })
      await writeTextAtomic(fullPath, volumeOutline)
    } else {
      // 落盘前去 AI 味（大纲主文件 + 卷纲，叙述性内容）
      const deslopedOutlineMap = await this.deslopOutlineMap(outlineMap)
      for (const [relPath, content] of Object.entries(deslopedOutlineMap)) {
        const normalizedRelPath = normalizeOutlinePath(relPath)
        if (!isSafeRelPath(normalizedRelPath, ['大纲'])) {
          console.warn(`[opening-service] 拒绝越界大纲路径：${normalizedRelPath}`)
          continue
        }
        const fullPath = join(dir, normalizedRelPath)
        await fs.mkdir(dirname(fullPath), { recursive: true })
        await writeTextAtomic(fullPath, content)
        if (normalizedRelPath.endsWith('大纲.md')) mainOutlineContent = content
        if (normalizedRelPath.startsWith('大纲/卷纲_第') && normalizedRelPath.endsWith('卷.md')) {
          const aliasRelPath = toChineseVolumeAlias(normalizedRelPath)
          if (aliasRelPath && aliasRelPath !== normalizedRelPath && isSafeRelPath(aliasRelPath, ['大纲'])) {
            const aliasFullPath = join(dir, aliasRelPath)
            await fs.mkdir(dirname(aliasFullPath), { recursive: true })
            await writeTextAtomic(aliasFullPath, content)
          }
        }
      }
      if (!mainOutlineContent) {
        const key = Object.keys(deslopedOutlineMap).find((k) => k.endsWith('大纲.md'))
        if (key) mainOutlineContent = deslopedOutlineMap[key]
      }
    }

    const outlineRepo = new OutlineMdRepo(dir)
    const parsedOutline = await outlineRepo.read()
    const rhythmEntries = parsedOutline?.rhythmFallback ?? []
    const project = await this.projectService.getProjectData(projectId)
    const targetChapters = project.targetChapters ?? DEFAULT_TARGET_CHAPTERS

    const htmlContent = buildRhythmHtml(
      rhythmEntries,
      project.name ?? '未命名',
      today,
      targetChapters
    )
    await fs.mkdir(join(dir, '图解'), { recursive: true })
    await writeTextAtomic(join(dir, '图解', '节奏图谱.html'), htmlContent)

    await fs.mkdir(join(dir, '追踪'), { recursive: true })
    await this.writeTrackingFiles(dir, today, mainOutlineContent, parsedOutline?.volumes ?? [], characterNames)

    // 编译并写入 记忆系统/ 兼容层（diagnostics-service 依赖）
    await compileMemorySystemCompat(dir, today, settingsMap, outlineMap, parsedOutline?.volumes ?? [])

    let chapterFiles: string[] = []
    if (chaptersMd) {
      // 落盘前去 AI 味（细纲叙述性内容：五段式/情节点/人物关系等描写段）
      const deslopedChapters = await this.deslopChapterContent(chaptersMd)
      chapterFiles = await this.persistChapterOutlines(dir, deslopedChapters, fromChapter ?? 1)
    }

    // 生成后处理 — 逻辑自洽 6 项检查（确定性，不调 LLM）
    // 违规以 warning 形式返回（不阻塞落盘），前端展示供用户决策
    let consistencyReport: ConsistencyReport | undefined
    try {
      consistencyReport = await checkOpeningConsistency(dir)
    } catch (err) {
      console.warn('[opening-service] 逻辑自洽检查失败，降级跳过:', err)
    }

    return { settingsFile: primarySettingsFile, outlineFile: '大纲/大纲.md', chapterFiles, consistencyReport }
  }

  private async writeTrackingFiles(
    dir: string,
    today: string,
    mainOutlineContent: string,
    volumes: Array<{ number: number; name: string; chapterStart: number; chapterEnd: number }>,
    characterNames: string[]
  ): Promise<void> {
    await writeTrackingFiles(dir, today, mainOutlineContent, volumes, characterNames)
  }


  private async persistChapterOutlines(
    dir: string,
    md: string,
    fromChapter: number
  ): Promise<string[]> {
    return persistChapterOutlines(dir, md, fromChapter)
  }

  private async loadBenchmarkRecall(
    projectId: string,
    project: ProjectData
  ): Promise<BenchmarkRecallContext | undefined> {
    if (!this.benchmarkResolver || !project.benchmarkBooks?.length) return undefined
    try {
      const dir = await this.projectService.resolveDir(projectId)
      const artifacts = await this.benchmarkResolver.resolveAll(dir, project.benchmarkBooks)
      if (artifacts.length === 0) return undefined
      const recalls = artifacts.map((a) => recallBenchmark(a))
      const merged = mergeRecalls(recalls)
      if (!merged.emotion && !merged.rhythm) return undefined
      return { bookNames: merged.bookNames, emotion: merged.emotion, rhythm: merged.rhythm }
    } catch (err) {
      console.warn('[opening-service] 对标召回失败，降级为无对标:', err)
      return undefined
    }
  }

  /* =========================================================
     生成后处理 — 去 AI 味（接入 DeslopService）
     落盘前对叙述性文件跑 deslop；失败降级为原文（不阻塞落盘）。
     保留边界：不删结构字段（节奏标注/字数/伏笔编号/表格列头），只清洗叙述性段落。
     ========================================================= */

  /** 对设定目录的多文件内容去 AI 味 */
  private async deslopSettingsMap(
    settingsMap: Record<string, string>
  ): Promise<Record<string, string>> {
    return deslopFileMap(settingsMap, this.deslopService)
  }

  /** 对大纲目录的多文件内容去 AI 味 */
  private async deslopOutlineMap(
    outlineMap: Record<string, string>
  ): Promise<Record<string, string>> {
    return deslopFileMap(outlineMap, this.deslopService)
  }

  /** 对细纲合并内容去 AI 味（按章拆分后逐章 deslop，保留章节分隔符） */
  private async deslopChapterContent(chaptersMd: string): Promise<string> {
    return deslopChapterContent(chaptersMd, this.deslopService)
  }

  private recommendGenres(strength: keyof typeof STRENGTH_LABELS): string {
    const map: Record<string, string[]> = {
      brain: ['系统文', '诸天流', '无限流'],
      writing: ['仙侠', '历史', '玄幻'],
      rhythm: ['都市爽文', '重生文'],
      experience: ['行业文', '都市日常', '种田文']
    }
    return (map[strength] ?? []).join('/')
  }
}

// 向后兼容：测试与外部直接导入这些纯函数
export { splitByChapterMarker, isSafeRelPath, parseMergedMarkdown }
