import { ProjectService } from './project-service'
import { OutlineMdRepo } from './skill-format/outline-md-repo'
import { RhythmHtmlRepo } from './skill-format/rhythm-html-repo'
import { DetailedOutlineMdRepo } from './skill-format/detailed-outline-md-repo'
import { readText } from './skill-format/md-parser'
import { writeTextAtomic } from './atomic'
import { join } from 'path'
import type { LlmService } from './llm-service'
import type { MainOutline, DetailedOutlineItem, RhythmEntry, Volume } from '../../shared/types'

const NOT_IMPLEMENTED = '该操作需 Phase 3b（LLM 生成输出 v3.2）支持，当前未实现。'

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
        plotSummary: d.plotSummary,
        coolPoint: d.coolPoint,
        hook: d.hook,
        charactersAppearing: d.charactersAppearing,
        foreshadowings: d.foreshadowings,
        wordEstimate: d.wordEstimate,
        goldenLine: d.goldenLine,
        volume: d.volume,
        emotion: d.emotion,
        climax: d.climax
      }))
    }
    const rhythm = await this.getRhythm(projectId)
    return rhythm.map((e) => ({
      chapterNumber: e.chapter,
      volume: e.volume,
      emotion: e.emotion,
      climax: e.climax,
      hook: ''
    }))
  }

  private async readOutline(projectId: string) {
    const dir = await this.projectService.resolveDir(projectId)
    return new OutlineMdRepo(dir).read()
  }

  /**
   * 返回 大纲.md 的完整结构化内容（所有 H2 节标题 + 原始 body），
   * 供渲染端按节展示（基本信息/力量体系/主线/逐章节奏/伏笔清单…）。
   */
  async getOutlineSections(projectId: string): Promise<{ h1Title: string; sections: { title: string; body: string }[] }> {
    const dir = await this.projectService.resolveDir(projectId)
    const { readText, parseDoc } = await import('./skill-format/md-parser')
    const text = await readText(join(dir, '大纲', '大纲.md'))
    if (!text) return { h1Title: '', sections: [] }
    const doc = parseDoc(text)
    return {
      h1Title: doc.h1Title,
      sections: doc.sections.map((s) => ({ title: s.title, body: s.body }))
    }
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
    throw new Error(NOT_IMPLEMENTED)
  }

  async generateDetailed(_projectId: string, _chapterNumber: number): Promise<DetailedOutlineItem> {
    throw new Error(NOT_IMPLEMENTED)
  }
}

/**
 * 替换 大纲.md `## 主线剧情走向` 节里首个 H3 之前的概要段。
 * 若该节原本无概要（直接进 H3），则在节标题后插入新概要。
 */
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
