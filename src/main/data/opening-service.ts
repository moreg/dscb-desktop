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
import { RHYTHM_HTML_TEMPLATE } from './skill-prompts/opening/rhythm-html-template'
import { parseDoc, findSection, parseTable, parseBoldFields } from './skill-format/md-parser'


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
    private readonly benchmarkResolver?: BenchmarkResolver
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
     Step 4：落盘（核心设定 + 卷级大纲 + 细纲）
     ========================================================= */

  async persistOpening(
    projectId: string,
    coreSettings: string,
    volumeOutline: string,
    chaptersMd?: string,
    fromChapter?: number
  ): Promise<{ settingsFile: string; outlineFile: string; chapterFiles: string[] }> {
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
      for (const [relPath, content] of Object.entries(settingsMap)) {
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
      for (const [relPath, content] of Object.entries(outlineMap)) {
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
        const key = Object.keys(outlineMap).find((k) => k.endsWith('大纲.md'))
        if (key) mainOutlineContent = outlineMap[key]
      }
    }

    const outlineRepo = new OutlineMdRepo(dir)
    const parsedOutline = await outlineRepo.read()
    const rhythmEntries = parsedOutline?.rhythmFallback ?? []
    const project = await this.projectService.getProjectData(projectId)
    const targetChapters = project.targetChapters ?? DEFAULT_TARGET_CHAPTERS

    let htmlContent = RHYTHM_HTML_TEMPLATE
      .replace(/__BOOK_NAME__/g, project.name ?? '未命名')
      .replace(/__CREATE_DATE__/g, today)
      .replace(/__TOTAL_CHAPTERS__/g, String(targetChapters))

    const innerEntries = rhythmEntries
      .map((e) => {
        // 用 JSON.stringify 安全注入字符串值，避免 `</script>` 提前闭合脚本块或 `$` 触发 replace 特殊语义
        return (
          '            { chapter: ' + e.chapter +
          ', title: ' + JSON.stringify(e.title) +
          ', emotion: ' + e.emotion +
          ', climax: ' + e.climax +
          ', volume: ' + e.volume +
          ', actualized: ' + e.actualized + ' }'
        )
      })
      .join(',\n')
    // 用函数形式替换，避免 innerEntries 中可能出现的 `$&`/`$1`/`$'` 被 String.replace 当作特殊模式
    htmlContent = htmlContent.replace('__RHYTHM_ENTRIES__', () => innerEntries)
    await fs.mkdir(join(dir, '图解'), { recursive: true })
    await writeTextAtomic(join(dir, '图解', '节奏图谱.html'), htmlContent)

    await fs.mkdir(join(dir, '追踪'), { recursive: true })
    await this.writeTrackingFiles(dir, today, mainOutlineContent, parsedOutline?.volumes ?? [], characterNames)

    // Compile and write files to 记忆系统
    await fs.mkdir(join(dir, '记忆系统'), { recursive: true })

    // 1. 世界观设定
    const wvSections: string[] = []
    for (const [relPath, content] of Object.entries(settingsMap)) {
      if (relPath.startsWith('设定/世界观/') && relPath.endsWith('.md') && relPath !== '设定/世界观/地理.md') {
        const name = relPath.replace('设定/世界观/', '').replace(/\.md$/, '')
        const body = cleanContent(content)
        wvSections.push(`## ${name}\n\n${body}`)
      }
    }
    const compiledWorldview = [
      `**版本**：v1.0（${today} 创建）`,
      `**修改记录**`,
      `- v1.0（${today}）：初版`,
      '',
      `# 世界观设定`,
      '',
      ...wvSections
    ].join('\n')
    await writeTextAtomic(join(dir, '记忆系统', '世界观设定.md'), compiledWorldview)

    // 2. 角色卡
    const protagonists: string[] = []
    const sideCharacters: string[] = []
    const villains: string[] = []

    for (const [relPath, content] of Object.entries(settingsMap)) {
      if (relPath.startsWith('设定/角色/') && relPath.endsWith('.md')) {
        const charName = relPath.replace('设定/角色/', '').replace(/\.md$/, '')
        const lines = content.split(/\r?\n/)
        const h1Line = lines.find(l => /^#\s+/.test(l))
        const heading = h1Line ? h1Line.replace(/^#\s+/, '').trim() : charName

        const { fields } = parseBoldFields(content)
        const zhenying = String(fields.get('阵营') || fields.get('角色类型') || '').trim()

        let category = '核心配角'
        if (zhenying.includes('主角')) category = '主角'
        else if (zhenying.includes('反派')) category = '核心反派'

        const body = cleanContent(content)
        const block = `### ${heading}\n\n${body}`

        if (category === '主角') protagonists.push(block)
        else if (category === '核心反派') villains.push(block)
        else sideCharacters.push(block)
      }
    }

    const relContent = settingsMap['设定/关系.md'] || ''
    const relDoc = parseDoc(relContent)
    const relLogSec = findSection(relDoc, '关系变更日志')
    const relLogTable = relLogSec ? `## 关系变更日志\n\n${relLogSec.body.trim()}` : ''

    const compiledCharacterCard = [
      `**版本**：v1.0（${today} 创建）`,
      `**修改记录**`,
      `- v1.0（${today}）：初版`,
      '',
      `# 角色卡`,
      '',
      `## 主角`,
      ...protagonists,
      '',
      `## 核心配角`,
      ...sideCharacters,
      '',
      `## 核心反派`,
      ...villains,
      '',
      relLogTable
    ].join('\n')
    await writeTextAtomic(join(dir, '记忆系统', '角色卡.md'), compiledCharacterCard)

    // 3. 地点档案
    const diliContent = settingsMap['设定/世界观/地理.md']
    if (diliContent) {
      const lines = diliContent.split(/\r?\n/)
      const h1Index = lines.findIndex(l => /^#\s+/.test(l))
      const cleanDili = h1Index >= 0
        ? [
            `**版本**：v1.0（${today} 创建）`,
            `**修改记录**`,
            `- v1.0（${today}）：初版`,
            '',
            `# 地点档案`,
            ...lines.slice(h1Index + 1)
          ].join('\n')
        : diliContent
      await writeTextAtomic(join(dir, '记忆系统', '地点档案.md'), cleanDili)
    }

    // 4. 核心情节
    const plotVolumes: string[] = []
    if (parsedOutline?.volumes) {
      const keys = Object.keys(outlineMap)
      for (const v of parsedOutline.volumes) {
        const volumeKey = keys.find(k => {
          const m = k.match(/第([一二三四五六七八九十百零〇两\d]+)卷/)
          if (!m) return false
          const val = parseVolumeToken(m[1])
          return val === v.number
        })
        if (volumeKey) {
          const content = cleanVolumeContent(outlineMap[volumeKey])
          if (content) {
            plotVolumes.push(`## 第${v.number}卷：${v.name}（第${v.chapterStart}-${v.chapterEnd}章）\n\n${content}`)
          }
        }
      }
    }

    if (plotVolumes.length > 0) {
      const compiledPlot = [
        `**版本**：v1.0（${today} 创建）`,
        `**修改记录**`,
        `- v1.0（${today}）：初版`,
        '',
        `# 核心情节`,
        '',
        ...plotVolumes
      ].join('\n')
      await writeTextAtomic(join(dir, '记忆系统', '核心情节.md'), compiledPlot)
    }

    let chapterFiles: string[] = []
    if (chaptersMd) {
      chapterFiles = await this.persistChapterOutlines(dir, chaptersMd, fromChapter ?? 1)
    }

    return { settingsFile: primarySettingsFile, outlineFile: '大纲/大纲.md', chapterFiles }
  }

  private async writeTrackingFiles(
    dir: string,
    today: string,
    mainOutlineContent: string,
    volumes: Array<{ number: number; name: string; chapterStart: number; chapterEnd: number }>,
    characterNames: string[]
  ): Promise<void> {
    const outlineDoc = mainOutlineContent ? parseDoc(mainOutlineContent) : null
    const fubiSection = outlineDoc ? findSection(outlineDoc, '伏笔清单') : null
    const fubiRows = fubiSection ? parseTable(fubiSection.body).rows : []
    let fubiContent = `**版本**：v1.0（${today} 创建）\n**修改记录**\n- v1.0（${today}）：初版\n\n# 伏笔追踪\n\n| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |\n|---|---|---|---|---|---|---|\n`
    for (const row of fubiRows) {
      const cols = [row[0] || 'FB-001', row[1] || '', row[2] || '设定', row[3] || '', row[4] || '', row[5] || '未回收', row[6] || '已埋设']
      fubiContent += `| ${cols.join(' | ')} |\n`
    }
    await writeTextAtomic(join(dir, '追踪', '伏笔.md'), fubiContent.trim() + '\n')
    await fs.mkdir(join(dir, '记忆系统'), { recursive: true })
    await writeTextAtomic(join(dir, '记忆系统', '伏笔追踪.md'), fubiContent.trim() + '\n')

    let timelineContent = `**版本**：v1.0（${today} 创建）\n**修改记录**\n- v1.0（${today}）：初版\n\n# 时间线\n\n| 章节 | 事件名 | 时间跨度 | 涉及角色 | 详细描述 |\n|---|---|---|---|---|\n`
    for (const v of volumes) {
      timelineContent += `| 第 ${v.chapterStart} 章 | 第 ${v.number} 卷开始 | 1 天 | 主角 | ${v.name} |\n`
    }
    await writeTextAtomic(join(dir, '追踪', '时间线.md'), timelineContent)

    const names = characterNames.length > 0 ? characterNames : ['主角', '配角', '反派']
    let statusContent = `**版本**：v1.0（${today} 创建）\n**修改记录**\n- v1.0（${today}）：初版\n\n# 角色状态快照\n\n| 角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 更新章节 |\n|---|---|---|---|---|---|---|\n`
    for (const name of names) {
      statusContent += `| ${name} | 初始 | 默认 | 默认 | 无 | 主角：待定 | 第 1 章 |\n`
    }
    await writeTextAtomic(join(dir, '追踪', '角色状态.md'), statusContent)

    const contextContent = `**版本**：v1.0（${today} 创建）\n**修改记录**\n- v1.0（${today}）：初版\n\n# 上下文（日更进度摘要）\n\n| 日期 | 章节 | 进度摘要 | 下一章目标 | 阻塞点 |\n|---|---|---|---|---|\n`
    await writeTextAtomic(join(dir, '追踪', '上下文.md'), contextContent)

    const issueContent = `**版本**：v1.0（${today} 创建）\n**修改记录**\n- v1.0（${today}）：初版\n\n# 问题记录\n\n| 日期 | 问题描述 | 原因分析 | 修正方案 | 状态 |\n|---|---|---|---|---|\n`
    await writeTextAtomic(join(dir, '追踪', '问题记录.md'), issueContent)
  }


  private async persistChapterOutlines(
    dir: string,
    md: string,
    fromChapter: number
  ): Promise<string[]> {
    const maxAllowed = fromChapter + 50
    let chapters = splitByChapterMarker(md)
    if (chapters.length === 0 && md.trim()) {
      const searchRe = /第\s*(\d+)\s*章/g
      let num = fromChapter
      let m: RegExpExecArray | null
      while ((m = searchRe.exec(md)) !== null) {
        const parsed = parseInt(m[1], 10)
        if (parsed >= 1 && parsed <= maxAllowed) {
          num = parsed
          break
        }
      }
      chapters = [{ chapterNumber: num, content: md }]
    }

    const files: string[] = []
    let volumeContent = '# 第 1 卷细纲\n\n'
    for (const ch of chapters) {
      if (!ch.chapterNumber || !ch.content.trim()) continue
      if (ch.chapterNumber < 1 || ch.chapterNumber > maxAllowed) {
        console.warn(`[opening-service] 跳过越界章号：第${ch.chapterNumber}章`)
        continue
      }
      const padded = String(ch.chapterNumber).padStart(3, '0')
      const relPath = `大纲/细纲_第${padded}章.md`
      await writeTextAtomic(join(dir, relPath), ch.content.trim())
      files.push(relPath)
      volumeContent += ch.content.trim().replace(/^###\s+第/gm, '## 第') + '\n\n'
    }

    if (files.length > 0) {
      await writeTextAtomic(join(dir, '细纲', '第01卷.md'), volumeContent.trim())
      await writeTextAtomic(join(dir, '大纲', '细纲_第01卷.md'), volumeContent.trim())
    }
    return files
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
import {
  splitByChapterMarker,
  normalizeOutlinePath,
  toChineseVolumeAlias,
  parseVolumeToken,
  toChineseNumber,
  fromChineseNumber,
  parseMergedMarkdown,
  isSafeRelPath,
  cleanContent,
  cleanVolumeContent
} from './opening-markdown'
// 向后兼容：测试与外部直接导入这些纯函数
export { splitByChapterMarker, isSafeRelPath, parseMergedMarkdown }
