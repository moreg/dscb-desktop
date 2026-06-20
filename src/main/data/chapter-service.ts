import { join } from 'path'
import { ProjectService } from './project-service'
import { OutlineMdRepo } from './skill-format/outline-md-repo'
import { RhythmHtmlRepo } from './skill-format/rhythm-html-repo';
import { ProseRepo } from './skill-format/prose-repo'
import { ChapterProgressMdRepo } from './skill-format/chapter-progress-md-repo'
import { ChapterRhythmWriter } from './skill-format/chapter-rhythm-writer'
import { countWords } from './words'
import type {
  ChapterMeta,
  ChapterContent,
  ChapterDetail
} from '../../shared/types'
import type { RhythmEntry } from '../../shared/types'

/**
 * 章节读写服务。Phase 1 实现：
 * - listChapters：从节奏图谱 rhythmData（或大纲逐章表回退）取逐章元信息；status 由正文是否存在判定。
 * - getChapter：正文走 ProseRepo（app 独占的 正文/第NNN章.md）；meta 从 rhythmData 补全。
 * - updateChapterContent：写正文（app 独占，Phase 1 即可用）。
 *
 * 其余 mutation（createChapter / deleteChapter / updateChapterMeta 改标题等）涉及 rhythmData +
 * 大纲表 + 细纲三处同步，留给 Phase 3 的 ChapterRhythmWriter。
 */
export class ChapterService {
  constructor(private readonly projectService: ProjectService) {}

  /** 取本项目的逐章节奏：优先节奏图谱 html，其次大纲逐章表回退 */
  private async readRhythm(dir: string): Promise<RhythmEntry[]> {
    const fromHtml = await new RhythmHtmlRepo(dir).read()
    if (fromHtml && fromHtml.length > 0) return fromHtml
    const outline = await new OutlineMdRepo(dir).read()
    return outline?.rhythmFallback ?? []
  }

  async listChapters(projectId: string): Promise<ChapterMeta[]> {
    const dir = await this.projectService.resolveDir(projectId)
    const rhythm = await this.readRhythm(dir)
    const prose = new ProseRepo(dir)
    const progress = await new ChapterProgressMdRepo(dir).read()
    const now = new Date().toISOString()
    const metas: ChapterMeta[] = []
    for (const e of rhythm) {
      const has = await prose.exists(e.chapter)
      const prog = progress.get(e.chapter)
      metas.push({
        schemaVersion: 1,
        updatedAt: now,
        chapterNumber: e.chapter,
        title: e.title,
        wordCount: prog?.wordCount ?? 0,
        status: has ? 'draft' : 'outline',
        synopsis: prog?.note,
        volume: e.volume,
        emotion: e.emotion,
        climax: e.climax
      })
    }
    return metas
  }

  async getChapter(projectId: string, n: number): Promise<ChapterContent> {
    const dir = await this.projectService.resolveDir(projectId)
    const rhythm = await this.readRhythm(dir)
    const entry = rhythm.find((e) => e.chapter === n)
    const content = await new ProseRepo(dir).read(n)
    const progress = await new ChapterProgressMdRepo(dir).read()
    const prog = progress.get(n)
    const meta: ChapterMeta = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      chapterNumber: n,
      title: entry?.title ?? `第${n}章`,
      wordCount: content ? countWords(content) : prog?.wordCount ?? 0,
      status: content ? 'draft' : 'outline',
      synopsis: prog?.note,
      volume: entry?.volume,
      emotion: entry?.emotion,
      climax: entry?.climax
    }
    return { meta, content }
  }

  async updateContent(projectId: string, n: number, content: string): Promise<ChapterMeta> {
    const dir = await this.projectService.resolveDir(projectId)
    await new ProseRepo(dir).write(n, content)
    // 正文写完 → rhythmData 标记 actualized=true（预测值转为实际值）
    await new ChapterRhythmWriter(dir).markActualized(n)
    return (await this.getChapter(projectId, n)).meta
  }

  /**
   * 更新章节 meta。Phase 3：title 走 ChapterRhythmWriter 三处同步（rhythmData + 大纲表 + 细纲）。
   * status/synopsis/hook/appearingCharacters 的回写（章节进度.md）留 Phase 3b。
   */
  async updateMeta(
    projectId: string,
    n: number,
    patch: { title?: string; status?: string; synopsis?: string; hook?: string }
  ): Promise<ChapterMeta> {
    const dir = await this.projectService.resolveDir(projectId)
    if (patch.title !== undefined) {
      await new ChapterRhythmWriter(dir).update(n, { title: patch.title })
    }
    return (await this.getChapter(projectId, n)).meta
  }
}

export type { ChapterDetail }
