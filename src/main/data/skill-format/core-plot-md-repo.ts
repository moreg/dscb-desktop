import { join } from 'path'
import {
  readText,
  parseDoc,
  parseSubsections,
  parseBoldFields,
  parseChapterNumber,
  titleAfterColon,
  fieldToStr,
  fieldsToRaw,
  deterministicId
} from './md-parser'
import type { MemoryEntity } from '../../../shared/types'

/**
 * 读取核心情节。真相源：`记忆系统/核心情节.md`。
 * 结构：`## 第N卷：...` 下 `### 第N章：标题`，每章含 核心事件/爽点·打脸/角色变动/伏笔。
 *
 * 映射到 plot_point 实体：每章一个实体（name=「第N章 标题」，notes=核心事件），
 * 让侧边栏「剧情点」页有内容可展示。Phase 1 该页为空，Phase 2 接通。
 */
export class CorePlotMdRepo {
  constructor(private readonly projectDir: string) {}

  async list(): Promise<MemoryEntity[]> {
    const text = await readText(join(this.projectDir, '记忆系统', '核心情节.md'))
    if (!text) return []
    const doc = parseDoc(text)
    const now = new Date().toISOString()
    const entities: MemoryEntity[] = []
    for (const volume of doc.sections) {
      for (const ch of parseSubsections(volume.body)) {
        const chapterNumber = parseChapterNumber(ch.title)
        if (chapterNumber == null) continue
        const title = titleAfterColon(ch.title)
        const { fields, order } = parseBoldFields(ch.body)
        entities.push({
          id: deterministicId('plot', String(chapterNumber)),
          name: `第${chapterNumber}章 ${title}`,
          category: '核心情节',
          notes:
            fieldToStr(fields.get('核心事件')) ??
            fieldToStr(fields.get('爽点/打脸')),
          rawFields: fieldsToRaw(fields, order),
          createdAt: now,
          updatedAt: now
        })
      }
    }
    return entities
  }
}
