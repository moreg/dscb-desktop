import { ChapterService } from './chapter-service'
import { OutlineService } from './outline-service'

/**
 * 正文导出服务：把已写章节拼成一份 txt，卷标题 + 章标题 + 正文顺序排列。
 * volumeNumber 缺省导出全书，指定则只导出该卷；未写正文的章节（细纲占位）不导出。
 */
export class ExportService {
  constructor(
    private readonly chapterService: ChapterService,
    private readonly outlineService: OutlineService
  ) {}

  async buildText(projectId: string, volumeNumber?: number): Promise<string> {
    const [{ metas, content }, volumes] = await Promise.all([
      this.chapterService.listChaptersWithContent(projectId),
      this.outlineService.getVolumes(projectId)
    ])
    const volumeNameMap = new Map(volumes.map((v) => [v.number, v.name]))

    const chapters = metas
      .filter((m) => volumeNumber === undefined || (m.volume ?? 0) === volumeNumber)
      .filter((m) => (content.get(m.chapterNumber) ?? '').trim())
      .sort((a, b) => a.chapterNumber - b.chapterNumber)

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
    return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n'
  }
}
