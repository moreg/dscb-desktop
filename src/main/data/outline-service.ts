import { ProjectService } from './project-service'
import { OutlineMdRepo } from './skill-format/outline-md-repo'
import { RhythmHtmlRepo } from './skill-format/rhythm-html-repo'
import { DetailedOutlineMdRepo } from './skill-format/detailed-outline-md-repo'
import { DetailedOutlineWriter, type DetailedOutlinePatch } from './skill-format/detailed-outline-writer'
import { readText } from './skill-format/md-parser'
import { writeTextAtomic } from './atomic'
import { join } from 'path'
import { promises as fs } from 'fs'
import type { LlmService } from './llm-service'
import type { MainOutline, DetailedOutlineItem, RhythmEntry, Volume, VolumeOutline } from '../../shared/types'
import { composeWritingRequirements } from '../../shared/writing-requirement-templates'


/**
 * 大纲服务。Phase 1 只读：
 * - getMain / listDetailed 从 大纲.md / 细纲/第NN卷.md / 节奏图谱.html 读取。
 * - 卷结构（getVolumes）与逐章节奏（getRhythm）新增能力。
 * - updateMain / generateMain / generateDetailed 写入路径留 Phase 3。
 */
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
   * 更新指定章节的细纲。
   * 写入 细纲/第NN卷.md，更新后重新读取返回最新值。
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

  async generateMain(_projectId: string): Promise<MainOutline> {
    throw new Error('该操作需 Phase 3b（LLM 生成输出 v3.2）支持，当前未实现。')
  }

  private async getVolumeNumberForChapter(dir: string, chapterNumber: number): Promise<number> {
    try {
      const read = await new OutlineMdRepo(dir).read()
      if (read && read.volumes.length > 0) {
        const vol = read.volumes.find((v) => chapterNumber >= v.chapterStart && chapterNumber <= v.chapterEnd)
        if (vol) return vol.number
      }
    } catch (err) {
      console.warn('[getVolumeNumberForChapter] Failed to read volumes:', err)
    }
    return 1
  }

  private async ensureChapterSectionExists(dir: string, chapterNumber: number): Promise<void> {
    const volNum = await this.getVolumeNumberForChapter(dir, chapterNumber)
    const padded = String(volNum).padStart(2, '0')
    const folder = join(dir, '细纲')
    await fs.mkdir(folder, { recursive: true })
    const file = join(folder, `第${padded}卷.md`)
    let text = ''
    try {
      text = await fs.readFile(file, 'utf-8')
    } catch (err) {
      text = `# 第 ${volNum} 卷细纲\n\n`
    }

    const { parseDoc, parseChapterNumber } = await import('./skill-format/md-parser')
    const doc = parseDoc(text)
    const chSec = doc.sections.find((s) => parseChapterNumber(s.title) === chapterNumber)
    if (!chSec) {
      // Append a new section for this chapter
      const appendText = `\n\n## 第 ${chapterNumber} 章：未命名\n- **核心事件**：\n`
      text = text.trim() + appendText
      await writeTextAtomic(file, text)
    }
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
    const prompt = buildChapterOutlinePrompt(
      coreSettings,
      volumeOutline,
      fromChapter,
      count,
      chapterWordCount,
      isGolden
    )

    // 5. 调用大语言模型生成细纲
    const md = await this.llm.generateStream(prompt, {
      systemPrompt: OPENING_SYSTEM_PROMPT,
      maxTokens: 8192,
      meta: { feature: 'outline-generate', projectId }
    })

    // 6. 解析生成的细纲文本
    const { splitByChapterMarker } = await import('./opening-markdown')
    const chapters = splitByChapterMarker(md)

    // 容错：如果只生成 1 章且未识别到分隔符，则全文作为一个章节
    let parsedChapters = chapters
    if (parsedChapters.length === 0 && count === 1 && md.trim()) {
      parsedChapters = [{ chapterNumber: fromChapter, content: md }]
    }

    const { parseChapterBlock } = await import('./skill-format/detailed-outline-md-repo')
    const writer = new DetailedOutlineWriter(dir)

    for (const ch of parsedChapters) {
      if (!ch.chapterNumber || !ch.content.trim()) continue

      const lines = ch.content.trim().split(/\r?\n/)
      let heading = `## 第 ${ch.chapterNumber} 章`
      let body = ch.content
      const firstLine = lines[0]?.trim() ?? ''
      if (firstLine.startsWith('#') || firstLine.includes(`第${ch.chapterNumber}章`)) {
        heading = lines[0]
        body = lines.slice(1).join('\n')
      }

      const parsed = parseChapterBlock(heading, body)
      if (!parsed) continue

      // 7. 确保章节在 细纲/第01卷.md 中存在节点
      await this.ensureChapterSectionExists(dir, ch.chapterNumber)

      // 8. 写入文件
      const patch: DetailedOutlinePatch = {
        title: parsed.title,
        plotSummary: parsed.plotSummary,
        coolPoint: parsed.coolPoint,
        hook: parsed.hook,
        charactersAppearing: parsed.charactersAppearing,
        foreshadowings: parsed.foreshadowings,
        wordEstimate: parsed.wordEstimate,
        goldenLine: parsed.goldenLine,
        emotion: parsed.emotion,
        climax: parsed.climax,
        writingRequirements: parsed.writingRequirements,
        writingRequirementTemplateId: parsed.writingRequirementTemplateId,
        writingRequirementCustomText: parsed.writingRequirementCustomText
      }
      await writer.update(ch.chapterNumber, patch)
    }

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
