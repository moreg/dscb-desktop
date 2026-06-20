import { join } from 'path'
import { readText, parseDoc, deterministicId } from './md-parser'
import { replaceH2Body, appendH2Section, deleteH2Section } from './md-writer'
import { writeTextAtomic } from '../atomic'
import type {
  MemoryEntity,
  CreateMemoryEntityInput,
  UpdateMemoryEntityInput
} from '../../../shared/types'

/**
 * 读取世界观设定。真相源：`记忆系统/世界观设定.md`。
 * 每个 `##` 节（力量体系 / 特殊体质 / 势力格局 / 社会规则 / 时代背景…）→ 一个实体。
 * notes 保留该节全文（含子节、表格），便于在 app 内整段阅读。
 */
export class WorldviewMdRepo {
  constructor(private readonly projectDir: string) {}

  async list(): Promise<MemoryEntity[]> {
    const text = await readText(join(this.projectDir, '记忆系统', '世界观设定.md'))
    if (!text) return []
    const doc = parseDoc(text)
    const now = new Date().toISOString()
    return doc.sections
      .filter((s) => s.title.trim())
      .map((section) => ({
        id: deterministicId('wv', section.title.trim()),
        name: section.title.trim(),
        notes: section.body.trim() || undefined,
        createdAt: now,
        updatedAt: now
      }))
  }

  // ===== Phase 3b 写入（## 节增删改） =====

  private async file(): Promise<{ path: string; text: string }> {
    const path = join(this.projectDir, '记忆系统', '世界观设定.md')
    return { path, text: await readText(path) }
  }

  async create(input: CreateMemoryEntityInput): Promise<MemoryEntity> {
    const { path, text } = await this.file()
    await writeTextAtomic(path, appendH2Section(text, input.name, input.notes ?? ''))
    const now = new Date().toISOString()
    return {
      id: deterministicId('wv', input.name),
      name: input.name,
      notes: input.notes,
      createdAt: now,
      updatedAt: now
    }
  }

  async update(oldName: string, patch: UpdateMemoryEntityInput): Promise<MemoryEntity | null> {
    const { path, text } = await this.file()
    const newName = patch.name ?? oldName
    const newNotes = patch.notes
    let next = text
    if (newName !== oldName) {
      // 改名：删旧节 + 追加新节
      next = deleteH2Section(next, oldName)
      next = appendH2Section(next, newName, newNotes ?? '')
    } else if (newNotes !== undefined) {
      next = replaceH2Body(next, oldName, newNotes)
    } else {
      return null
    }
    if (next === text) return null
    await writeTextAtomic(path, next)
    const now = new Date().toISOString()
    return { id: deterministicId('wv', newName), name: newName, notes: newNotes, createdAt: now, updatedAt: now }
  }

  async delete(name: string): Promise<void> {
    const { path, text } = await this.file()
    const next = deleteH2Section(text, name)
    if (next === text) return
    await writeTextAtomic(path, next)
  }
}
