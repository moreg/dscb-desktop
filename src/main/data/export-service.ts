import { ChapterService } from './chapter-service'
import { OutlineService } from './outline-service'
import { ProjectService } from './project-service'
import { hashProse } from './memory/prose-memory-index'
import { markChaptersExported, readChapterExports } from './chapter-export-store'

/** 本次导出包含的一章：章号 + 导出时正文哈希，保存成功后据此标记已导出。 */
export interface ExportedChapter { chapterNumber: number; sourceHash: string }

export interface BuiltExport {
  text: string
  chapters: ExportedChapter[]
}

/**
 * 正文导出服务：把已写章节拼成一份 txt，卷标题 + 章标题 + 正文顺序排列。
 * volumeNumber 缺省导出全书，指定则只导出该卷；未写正文的章节（细纲占位）不导出。
 * onlyUnexported 只挑未导出过的章节：从未导出，或导出后正文又改过（哈希对不上）。
 */
export class ExportService {
  constructor(
    private readonly chapterService: ChapterService,
    private readonly outlineService: OutlineService,
    private readonly projectService: ProjectService
  ) {}

  async buildExport(
    projectId: string,
    opts: { volumeNumber?: number; onlyUnexported?: boolean } = {}
  ): Promise<BuiltExport> {
    const [{ metas, content }, volumes] = await Promise.all([
      this.chapterService.listChaptersWithContent(projectId),
      this.outlineService.getVolumes(projectId)
    ])
    const volumeNameMap = new Map(volumes.map((v) => [v.number, v.name]))
    const exported = opts.onlyUnexported
      ? await readChapterExports(await this.projectService.resolveDir(projectId))
      : undefined

    const picked: ExportedChapter[] = []
    const chapters = metas
      .filter((m) => opts.volumeNumber === undefined || (m.volume ?? 0) === opts.volumeNumber)
      .filter((m) => (content.get(m.chapterNumber) ?? '').trim())
      .sort((a, b) => a.chapterNumber - b.chapterNumber)
      .filter((m) => {
        const sourceHash = hashProse((content.get(m.chapterNumber) ?? '').trim())
        // 已导出且正文没再改过的章节跳过；其余（从未导出 / 改过）入选
        if (exported?.[String(m.chapterNumber)]?.sourceHash === sourceHash) return false
        picked.push({ chapterNumber: m.chapterNumber, sourceHash })
        return true
      })

    if (opts.onlyUnexported && picked.length === 0) throw new Error('没有未导出的章节')

    const lines: string[] = []
    // 卷号 0/undefined 统一视为「未分卷」（与 ChapterListPage 的 `c.volume ?? 0` 约定一致），
    // 只有卷号大于 0 才输出卷标题
    let currentVolume: number | undefined
    for (const m of chapters) {
      const vol = m.volume ?? 0
      if (vol !== currentVolume) {
        currentVolume = vol
        if (vol > 0) {
          const name = volumeNameMap.get(vol)
          lines.push(`第${vol}卷${name ? ' ' + name : ''}`)
          lines.push('')
        }
      }
      lines.push(`第${m.chapterNumber}章 ${m.title}`)
      lines.push('')
      lines.push((content.get(m.chapterNumber) ?? '').trim())
      lines.push('')
      lines.push('')
    }
    const text = lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n'
    return { text, chapters: picked }
  }

  /** 文件保存成功后把本次导出的章节标记为已导出；用户取消保存时不调用。 */
  async markExported(projectId: string, chapters: ExportedChapter[]): Promise<void> {
    await markChaptersExported(await this.projectService.resolveDir(projectId), chapters)
  }
}
