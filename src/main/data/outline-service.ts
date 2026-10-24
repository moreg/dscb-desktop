import { ProjectService } from './project-service'
import { OutlineMdRepo } from './skill-format/outline-md-repo'
import { buildAdoptedOpeningDirections, buildAdoptedIdeaDevelopment } from '../../shared/fanqie-project'
import { RhythmHtmlRepo } from './skill-format/rhythm-html-repo'
import { DetailedOutlineMdRepo } from './skill-format/detailed-outline-md-repo'
import { DetailedOutlineWriter, type DetailedOutlinePatch } from './skill-format/detailed-outline-writer'
import { readText } from './skill-format/md-parser'
import { writeTextAtomic } from './atomic'
import { join } from 'path'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { buildMainOutlinePrompt } from './skill-prompts/opening/main-outline'
import type { LlmService } from './llm-service'
import type {
  MainOutline,
  DetailedOutlineItem,
  DetailedOutlineRaw,
  RhythmEntry,
  Volume,
  VolumeOutline
} from '../../shared/types'
import { readWritingPlatformConfig } from './writing-platform'
import { sanitizeTitleForFilename } from './opening-markdown'
import { composeWritingRequirements } from '../../shared/writing-requirement-templates'


/** 大纲与细纲的读取、编辑和生成；兼容卷级旧稿，优先读取逐章细纲。 */
export class OutlineService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly llm: LlmService
  ) {}

  async getMain(projectId: string): Promise<MainOutline | null> {
    return (await this.readOutline(projectId))?.main ?? null
  }

  async getVolumes(projectId: string): Promise<Volume[]> {
    return (await this.readOutline(projectId))?.volumes ?? []
  }

  /** 逐章节奏：优先节奏图谱 html，回退大纲逐章表 */
  async getRhythm(projectId: string): Promise<RhythmEntry[]> {
    const dir = await this.projectService.resolveDir(projectId)
    const fromHtml = await new RhythmHtmlRepo(dir).read()
    if (fromHtml && fromHtml.length > 0) return fromHtml
    return (await new OutlineMdRepo(dir).read())?.rhythmFallback ?? []
  }

  async listDetailed(projectId: string): Promise<DetailedOutlineItem[]> {
    const dir = await this.projectService.resolveDir(projectId)
    // 优先细纲富字段，无细纲则从节奏图谱取基础逐章项
    const details = await new DetailedOutlineMdRepo(dir).listAll()
    if (details.length > 0) {
      return details.map((d) => ({
        chapterNumber: d.chapterNumber,
        title: d.title,
        plotSummary: d.plotSummary,
        coolPoint: d.coolPoint,
        hook: d.hook,
        charactersAppearing: d.charactersAppearing,
        foreshadowings: d.foreshadowings,
        wordEstimate: d.wordEstimate,
        goldenLine: d.goldenLine,
        volume: d.volume,
        emotion: d.emotion,
        climax: d.climax,
        writingRequirements: composeWritingRequirements(
          d.writingRequirementTemplateId,
          d.writingRequirementCustomText,
          d.writingRequirements
        ),
        writingRequirementTemplateId: d.writingRequirementTemplateId,
        writingRequirementCustomText: d.writingRequirementCustomText
      }))
    }
    const rhythm = await this.getRhythm(projectId)
    return rhythm.map((e) => ({
      chapterNumber: e.chapter,
      title: e.title,
      volume: e.volume,
      emotion: e.emotion,
      climax: e.climax,
      hook: ''
    }))
  }

  /**
   * 读取指定章细纲的磁盘原文。
   * `listDetailed` 只回传字段白名单，纯段落节看不到；此接口给渲染端展示完整内容。
   */
  async getDetailedRaw(projectId: string, chapterNumber: number): Promise<DetailedOutlineRaw | null> {
    const dir = await this.projectService.resolveDir(projectId)
    return new DetailedOutlineMdRepo(dir).readRaw(chapterNumber)
  }

  /**
   * 更新指定章节的细纲。
   * 优先更新逐章细纲，兼容卷级旧稿，更新后重新读取返回最新值。
   */
  async updateDetailed(
    projectId: string,
    chapterNumber: number,
    patch: Partial<DetailedOutlineItem>
  ): Promise<DetailedOutlineItem> {
    const dir = await this.projectService.resolveDir(projectId)
    const writer = new DetailedOutlineWriter(dir)

    // 将 DetailedOutlineItem 的字段映射为 DetailedOutlinePatch
    const patchForWriter: DetailedOutlinePatch = {
      title: patch.title,
      plotSummary: patch.plotSummary,
      coolPoint: patch.coolPoint,
      hook: patch.hook,
      charactersAppearing: patch.charactersAppearing,
      foreshadowings: patch.foreshadowings,
      wordEstimate: patch.wordEstimate,
      goldenLine: patch.goldenLine,
      emotion: patch.emotion,
      climax: patch.climax,
      writingRequirements: patch.writingRequirements,
      writingRequirementTemplateId: patch.writingRequirementTemplateId,
      writingRequirementCustomText: patch.writingRequirementCustomText
    }

    await writer.update(chapterNumber, patchForWriter)

    // 重新读取返回最新值
    const items = await new DetailedOutlineMdRepo(dir).listAll()
    const updated = items.find((d) => d.chapterNumber === chapterNumber)
    if (!updated) {
      throw new Error(`DETAILED_NOT_FOUND: 更新后找不到第 ${chapterNumber} 章的细纲`)
    }

    return {
      chapterNumber: updated.chapterNumber,
      title: updated.title,
      plotSummary: updated.plotSummary,
      coolPoint: updated.coolPoint,
      hook: updated.hook,
      charactersAppearing: updated.charactersAppearing,
      foreshadowings: updated.foreshadowings,
      wordEstimate: updated.wordEstimate,
      goldenLine: updated.goldenLine,
      volume: updated.volume,
      emotion: updated.emotion,
      climax: updated.climax,
      writingRequirements: updated.writingRequirements,
      writingRequirementTemplateId: updated.writingRequirementTemplateId,
      writingRequirementCustomText: updated.writingRequirementCustomText
    }
  }

  private async readOutline(projectId: string) {
    const dir = await this.projectService.resolveDir(projectId)
    return new OutlineMdRepo(dir).read()
  }

  /**
   * 返回 大纲.md 的完整结构化内容（所有 H2 节标题 + 原始 body），
   * 供渲染端按节展示（基本信息/力量体系/主线/逐章节奏/伏笔清单…）。
   *
   * 兼容：当 大纲.md 没有 H2 节（如技能标准格式只有 H1 + 节奏标注表），
   * 把 H1 后的全部 body 作为一个「全文」节返回，确保页面能看到内容。
   */
  async getOutlineSections(projectId: string): Promise<{ h1Title: string; sections: { title: string; body: string }[] }> {
    const dir = await this.projectService.resolveDir(projectId)
    const { readText, parseDoc } = await import('./skill-format/md-parser')
    const text = await readText(join(dir, '大纲', '大纲.md'))
    if (!text) return { h1Title: '', sections: [] }
    const doc = parseDoc(text)
    const sections = doc.sections.map((s) => ({ title: s.title, body: s.body }))
    // 如果没有 H2 节，但有 body 内容（表格/文本），作为「全文」节返回
    if (sections.length === 0 && doc.body.trim()) {
      sections.push({ title: '全文', body: doc.body })
    }
    return {
      h1Title: doc.h1Title,
      sections
    }
  }

  /**
   * 读取所有卷纲文件（大纲/第N卷_卷名.md）。
   * 每文件解析 H1 + H2 节，返回结构化内容供渲染端展示。
   */
  async getVolumeOutlines(projectId: string): Promise<VolumeOutline[]> {
    const dir = await this.projectService.resolveDir(projectId)
    const outlineDir = join(dir, '大纲')
    const { readText, parseDoc } = await import('./skill-format/md-parser')
    let files: string[]
    try {
      files = await fs.readdir(outlineDir)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      throw err
    }
    const volumes: VolumeOutline[] = []
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      // 只匹配 第N卷_卷名.md 格式（排除 大纲.md）
      const nameMatch = f.match(/^第(\d+)卷[_\s]*(.+?)\.md$/)
      if (!nameMatch) continue
      const number = parseInt(nameMatch[1], 10)
      const name = nameMatch[2].trim()
      const text = await readText(join(outlineDir, f))
      if (!text) continue
      const doc = parseDoc(text)
      volumes.push({
        number,
        name,
        h1Title: doc.h1Title,
        fileName: f,
        sections: doc.sections.map((s) => ({ title: s.title, body: s.body }))
      })
    }
    // 按卷号数字排序
    volumes.sort((a, b) => a.number - b.number)
    return volumes
  }

  async updateMain(projectId: string, patch: Partial<MainOutline>): Promise<MainOutline> {
    const dir = await this.projectService.resolveDir(projectId)
    const file = join(dir, '大纲', '大纲.md')
    const text = await readText(file)
    if (!text) throw new Error('大纲.md 不存在')
    let next = text
    if (patch.synopsis !== undefined) {
      next = replaceMainLineIntro(next, patch.synopsis)
    }
    // theme / mainLine 在 v3.2 无独立字段（mainLine 由各卷标题派生），编辑忽略
    if (next !== text) await writeTextAtomic(file, next)
    const read = await new OutlineMdRepo(dir).read()
    if (!read) throw new Error('大纲.md 解析失败')
    return { ...read.main, theme: patch.theme ?? read.main.theme }
  }

  async generateMain(projectId: string): Promise<MainOutline> {
    const dir = await this.projectService.resolveDir(projectId)
    const meta = await this.projectService.getProjectData(projectId)
    const file = join(dir, '大纲', '大纲.md')
    const before = await readText(file)
    const coreSettings = await readText(join(dir, '设定', '核心设定.md'))
      || await readText(join(dir, '设定', '题材定位.md')) || ''
    if (!coreSettings.trim() && !meta.description?.trim()) throw new Error('请先提供作品脑洞或核心设定，再生成大纲')
    const prompt = buildMainOutlinePrompt({ ...meta, coreSettings, previousOutline: before ?? undefined,
      platform: await readWritingPlatformConfig(dir) }) + buildAdoptedIdeaDevelopment(meta.ideaDevelopment)
    const raw = await this.llm.generateStream(prompt, { maxTokens: 16384,
      meta: { feature: 'outline-generate', projectId } })
    const content = raw.trim().replace(/^```(?:markdown|md)?\s*\n/, '').replace(/\n```$/, '')
    if (!/^#\s+[^\n]+/m.test(content) || !/^## 主线剧情走向\s*$/m.test(content)) {
      throw new Error('模型未返回可读取的大纲结构，原文件未修改')
    }
    if ((await readText(file)) !== before) throw new Error('生成期间大纲已被修改，请检查后重试')
    if (before?.trim()) await writeTextAtomic(join(dir, '大纲', '_基线', `大纲_${randomUUID()}.md`), before)
    await writeTextAtomic(file, content + '\n')
    const result = await new OutlineMdRepo(dir).read()
    if (!result) throw new Error('生成的大纲无法读取')
    return result.main
  }

  async generateDetailed(projectId: string, chapterNumber: number): Promise<DetailedOutlineItem> {
    const list = await this.generateDetailedRange(projectId, chapterNumber, 1)
    const item = list.find(x => x.chapterNumber === chapterNumber)
    if (!item) {
      throw new Error(`生成细纲失败：未能在返回列表中找到第 ${chapterNumber} 章`)
    }
    return item
  }

  async generateDetailedRange(projectId: string, fromChapter: number, count: number): Promise<DetailedOutlineItem[]> {
    // 边界校验（IPC 层已做 zod 校验，此处兜底防直接调用）
    if (!Number.isInteger(fromChapter) || fromChapter < 1) {
      throw new Error('起始章号必须为正整数')
    }
    if (!Number.isInteger(count) || count < 1 || count > 30) {
      throw new Error('生成数量必须为 1-30 之间的整数')
    }
    const dir = await this.projectService.resolveDir(projectId)

    // 1. 读取核心设定
    const coreSettings = await readText(join(dir, '设定', '核心设定.md'))
      || await readText(join(dir, '设定', '题材定位.md'))
    if (!coreSettings) throw new Error('核心设定文件不存在，请先在「设定/核心设定.md」中创建')

    // 2. 读取卷级大纲
    const volumeOutline = await readText(join(dir, '大纲', '大纲.md'))
    if (!volumeOutline) throw new Error('大纲文件不存在，请先在「大纲/大纲.md」中创建')

    // 3. 获取每章目标字数
    const meta = await this.projectService.getProjectData(projectId)
    const chapterWordCount = meta.chapterWordCount ?? 2500

    // 4. 构建 Prompt
    const { buildChapterOutlinePrompt } = await import('./skill-prompts/opening/chapter-outline')
    const { OPENING_SYSTEM_PROMPT } = await import('./skill-prompts/opening/topic-routing')
    const isGolden = fromChapter <= 3
    let prompt = buildChapterOutlinePrompt(
      coreSettings,
      volumeOutline,
      fromChapter,
      count,
      chapterWordCount,
      isGolden,
      await readWritingPlatformConfig(dir)
    )
    const contextPaths = ['设定/关系.md', '追踪/角色状态.md', '追踪/伏笔.md', '追踪/时间线.md', '追踪/上下文.md', '追踪/细纲规划.md']
    const context = await Promise.all(contextPaths.map(async file => {
      const text = await readText(join(dir, file))
      return text?.trim() ? `### ${file}（只读来源，计划不是已发生事实）\n${text}` : ''
    }))
    const volumeContext = await this.getVolumeOutlines(projectId)
    prompt += `\n\n### 所在卷规划\n${volumeContext.map(v => JSON.stringify(v)).join('\n')}`
    prompt += `\n\n### 事实基线与跨章计划\n${context.filter(Boolean).join('\n\n')}`
    const rhythm = await this.getRhythm(projectId)
    prompt += `\n\n### 逐章既定标题与节奏来源\n${JSON.stringify(rhythm.filter(r => r.chapter >= fromChapter && r.chapter < fromChapter + count))}\n未回填的是预测，已回填的是实际值，不能据 false 认定正文未成稿。`
    const description = meta.description?.trim()
    prompt += buildAdoptedOpeningDirections(meta.openingChapters, fromChapter, count)
    prompt += buildAdoptedIdeaDevelopment(meta.ideaDevelopment)
    if (description) {
      prompt += `\n\n### 最新作品简介（额外构思参考）\n${description}\n\n作品简介可能包含新采用的脑洞，仅用于补充创意和卖点。具体人物事实、世界观规则和卷级事件仍以以上正式核心设定与大纲为准；存在冲突时遵循正式规划，不擅自改写既有设定或已安排的剧情。`
    }

    // 5. 调用大语言模型生成细纲
    const md = await this.llm.generateStream(prompt, {
      systemPrompt: OPENING_SYSTEM_PROMPT,
      maxTokens: Math.min(32768, 8192 * count),
      meta: { feature: 'outline-generate', projectId }
    })

    // 6. 解析生成的细纲文本
    const { splitByChapterMarker } = await import('./opening-markdown')
    const markers = [...md.matchAll(/^={2,}\s*第\s*(\d+)\s*章\s*={2,}\s*$/gm)]
    const chapters = markers.length ? markers.map((m, i) => ({
      chapterNumber: Number(m[1]),
      content: md.slice(m.index! + m[0].length, markers[i + 1]?.index ?? md.length).trim()
    })) : splitByChapterMarker(md).filter(ch => ch.content.trim())

    // 容错：如果只生成 1 章且未识别到分隔符，则全文作为一个章节
    let parsedChapters = chapters
    if (parsedChapters.length === 0 && count === 1 && md.trim()) {
      parsedChapters = [{ chapterNumber: fromChapter, content: md }]
    }

    const { parseChapterBlock } = await import('./skill-format/detailed-outline-md-repo')
    const seen = new Set<number>()
    const plans: Array<{ file: string; text: string }> = []
    const repo = new DetailedOutlineMdRepo(dir)
    for (const ch of parsedChapters) {
      if (!Number.isInteger(ch.chapterNumber) || ch.chapterNumber < fromChapter || ch.chapterNumber >= fromChapter + count || seen.has(ch.chapterNumber)) {
        throw new Error('生成细纲的章号越界或重复，尚未保存，请重试')
      }
      seen.add(ch.chapterNumber)
      const heading = ch.content.match(/^#{1,3}\s*第\s*\d+\s*章[^\n]*/m)?.[0]
      const parsed = heading ? parseChapterBlock(heading.replace(/^#+\s*/, ''), ch.content) : null
      const title = parsed?.title?.trim()
      if (!title || sanitizeTitleForFilename(title) !== title) {
        throw new Error(`第 ${ch.chapterNumber} 章缺少有效标题或含文件名非法字符，尚未保存`)
      }
      const previous = await repo.readRaw(ch.chapterNumber)
      const fileName = `细纲_第${String(ch.chapterNumber).padStart(3, '0')}章_${title}.md`
      if (previous && /^细纲_第\d+章/.test(previous.fileName) && previous.fileName !== fileName) {
        throw new Error(`第 ${ch.chapterNumber} 章标题与已有细纲不一致，尚未保存；请先统一章名`)
      }
      // 保存完整细纲，不将情节点、预算、禁区等扩展内容压成字段补丁。
      const content = ch.content.trim().replace(/^#(?!#)[^\n]*\n+/, '')
      plans.push({ file: join(dir, '细纲', fileName), text: `# ${fileName}\n\n${content}\n` })
    }
    if (seen.size !== count) throw new Error(`模型只返回 ${seen.size}/${count} 章细纲，尚未保存，请缩小范围重试`)
    // 全批次章号和标题检查通过后才开始落盘；实际记忆与图谱始终只读。
    for (const plan of plans) await writeTextAtomic(plan.file, plan.text)

    // 9. 读取最新值并返回
    const items = await this.listDetailed(projectId)
    const targetChapters = Array.from({ length: count }, (_, i) => fromChapter + i)
    return items.filter((d) => targetChapters.includes(d.chapterNumber))
  }
}

function replaceMainLineIntro(text: string, synopsis: string): string {
  const lines = text.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^## 主线剧情走向\s*$/.test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return text
  let end = lines.length
  let firstH3 = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]) && !/^###/.test(lines[i])) {
      end = i
      break
    }
    if (firstH3 < 0 && /^### /.test(lines[i])) firstH3 = i
  }
  const introEnd = firstH3 >= 0 ? firstH3 : end
  // 保留节标题行，替换 [start+1, introEnd) 为新概要
  const newIntro = synopsis.trim() ? ['', synopsis.trim(), ''] : ['']
  const next = [...lines.slice(0, start + 1), ...newIntro, ...lines.slice(introEnd)]
  return next.join('\n')
}
