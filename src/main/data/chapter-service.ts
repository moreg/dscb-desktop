import { join } from 'path'
import { ProjectService } from './project-service'
import { OutlineMdRepo } from './skill-format/outline-md-repo'
import { RhythmHtmlRepo } from './skill-format/rhythm-html-repo';
import { ProseRepo } from './skill-format/prose-repo'
import { ChapterProgressMdRepo } from './skill-format/chapter-progress-md-repo'
import { ChapterRhythmWriter } from './skill-format/chapter-rhythm-writer'
import { DetailedOutlineMdRepo } from './skill-format/detailed-outline-md-repo'
import { CharacterCardMdRepo } from './skill-format/character-card-md-repo'
import { countWords } from './words'
import type {
  ChapterMeta,
  ChapterContent,
  ChapterDetail,
  Character
} from '../../shared/types'
import type { RhythmEntry } from '../../shared/types'

/**
 * 章节读写服务。
 * - listChapters：逐章元信息来自「节奏图谱 + 章节进度笔记 + 细纲」三方合并——
 *   节奏图谱仍是 volume 的真相源；title/emotion/climax/synopsis/appearingCharacters
 *   以细纲为准（用户在「大纲」页改细纲后，列表立即反映），细纲为空才回退旧源。
 * - getChapter：同上，保证编辑器打开单章时也用细纲最新值。
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

  /**
   * 读取细纲并按章号建 Map。细纲是 title/emotion/climax/synopsis(核心事件)/
   * appearingCharacters 的真相源；为空时回退节奏图谱/章节进度笔记。
   */
  private async readDetailedMap(dir: string): Promise<Map<number, ChapterDetail>> {
    const list = await new DetailedOutlineMdRepo(dir).listAll()
    const map = new Map<number, ChapterDetail>()
    for (const d of list) map.set(d.chapterNumber, d)
    return map
  }

  /**
   * 读取角色卡并按姓名建 Map。细纲 charactersAppearing 存的是角色名，
   * ChapterMeta.appearingCharacters 需要角色 id（前端 charName(id) 反查名字），
   * 故需做「名字→id」映射；无匹配角色卡的名字跳过。
   */
  private async readCharacterNameToIdMap(dir: string): Promise<Map<string, string>> {
    const list = await new CharacterCardMdRepo(dir).list()
    const map = new Map<string, string>()
    for (const c of list) {
      if (c.name) map.set(c.name, c.id)
    }
    return map
  }

  /** 把细纲 charactersAppearing（角色名列表）映射成角色 id 列表，无匹配的跳过 */
  private mapCharactersToIds(
    names: string[] | undefined,
    nameToId: Map<string, string>
  ): string[] | undefined {
    if (!names || names.length === 0) return undefined
    const ids = names
      .map((n) => nameToId.get(n))
      .filter((id): id is string => Boolean(id))
    return ids.length > 0 ? ids : undefined
  }

  async listChapters(projectId: string): Promise<ChapterMeta[]> {
    const dir = await this.projectService.resolveDir(projectId)
    const rhythm = await this.readRhythm(dir)
    const prose = new ProseRepo(dir)
    const progress = await new ChapterProgressMdRepo(dir).read()
    const detailedMap = await this.readDetailedMap(dir)
    const nameToId = await this.readCharacterNameToIdMap(dir)
    const now = new Date().toISOString()
    const metas: ChapterMeta[] = []
    for (const e of rhythm) {
      const has = await prose.exists(e.chapter)
      const prog = progress.get(e.chapter)
      const det = detailedMap.get(e.chapter)
      // 合并规则：细纲优先（用户在大纲页编辑的最新意图），细纲为空才回退旧源
      metas.push({
        schemaVersion: 1,
        updatedAt: now,
        chapterNumber: e.chapter,
        title: det?.title || e.title,
        wordCount: prog?.wordCount ?? 0,
        status: has ? 'draft' : 'outline',
        // synopsis 改用细纲 plotSummary（核心事件），细纲为空回退章节进度笔记的备注
        synopsis: det?.plotSummary || prog?.note,
        volume: e.volume ?? det?.volume,
        // 细纲优先，空则回退节奏图谱
        emotion: det?.emotion ?? e.emotion,
        climax: det?.climax ?? e.climax,
        // 登场角色：细纲 charactersAppearing（角色名）→ 反查角色卡得 id
        appearingCharacters: this.mapCharactersToIds(det?.charactersAppearing, nameToId)
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
    const detailedMap = await this.readDetailedMap(dir)
    const nameToId = await this.readCharacterNameToIdMap(dir)
    const det = detailedMap.get(n)
    const meta: ChapterMeta = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      chapterNumber: n,
      title: det?.title || entry?.title || `第${n}章`,
      wordCount: content ? countWords(content) : prog?.wordCount ?? 0,
      status: content ? 'draft' : 'outline',
      synopsis: det?.plotSummary || prog?.note,
      volume: entry?.volume ?? det?.volume,
      emotion: det?.emotion ?? entry?.emotion,
      climax: det?.climax ?? entry?.climax,
      appearingCharacters: this.mapCharactersToIds(det?.charactersAppearing, nameToId)
    }
    return { meta, content }
  }

  async updateContent(projectId: string, n: number, content: string): Promise<ChapterMeta> {
    const dir = await this.projectService.resolveDir(projectId)
    // 先取章节标题（用于生成 `第NNN章 标题.md` 格式文件名）
    const before = await this.getChapter(projectId, n)
    await new ProseRepo(dir).write(n, content, before.meta.title)
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
