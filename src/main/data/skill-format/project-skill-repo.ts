import { join } from 'path'
import { readText, parseDoc, findSection, parseBoldFields, type FieldValue } from './md-parser'
import type { ProjectData } from '../../../shared/types'

/**
 * 读取项目元信息。真相源：`大纲/大纲.md`。
 * - H1 `# 《书名》大纲` → 书名
 * - `## 基本信息` 的 `- **字段**：值` → genre / targetChapters / chapterWordCount
 *
 * 注意：返回的 ProjectData.id 为空串，由 ProjectService 填充实际 projectId。
 */
export class ProjectSkillRepo {
  constructor(private readonly projectDir: string) {}

  async read(): Promise<ProjectData | null> {
    const file = join(this.projectDir, '大纲', '大纲.md')
    const text = await readText(file)
    if (!text) return null
    const doc = parseDoc(text)

    const name = extractBookName(doc.h1Title)
    const sec = findSection(doc, '基本信息')
    let genre: string | undefined
    let targetChapters: number | undefined
    let chapterWordCount: number | undefined
    let description: string | undefined
    if (sec) {
      const { fields } = parseBoldFields(sec.body)
      genre = toStr(fields.get('题材'))
      targetChapters = toNum(fields.get('预计章节数'))
      chapterWordCount = toNum(fields.get('每章字数')) ?? toNum(fields.get('每章标准字数'))
      description = toStr(fields.get('简介')) ?? toStr(fields.get('作品简介'))
    }
    const now = new Date().toISOString()
    return {
      schemaVersion: 1,
      updatedAt: now,
      id: '',
      name,
      genre,
      description,
      targetChapters,
      chapterWordCount,
      status: 'outline',
      createdAt: now
    }
  }
}

export function extractBookName(h1Title: string): string {
  if (!h1Title) return ''
  const m = h1Title.match(/《(.+?)》/)
  if (m) return m[1]
  return h1Title.replace(/大纲$/, '').trim()
}

function toStr(v: FieldValue | undefined): string | undefined {
  if (v == null || v === '') return undefined
  return Array.isArray(v) ? v.join('；') : v
}

function toNum(v: FieldValue | undefined): number | undefined {
  if (v == null) return undefined
  const s = Array.isArray(v) ? v.join('') : v
  const m = s.match(/(\d+)/)
  return m ? parseInt(m[1], 10) : undefined
}
