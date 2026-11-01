import { join } from 'path'
import { writeJsonAtomic } from './atomic'
import { withFileLock } from './file-lock'
import { memoryFileFingerprint, readMemoryText } from './memory/repository-cache'

/**
 * 正文导出记录的持久层。记录每章导出时的正文哈希：
 * 从未导出、或导出后正文又改过的章节都算「未导出」，供增量导出挑选。
 */
export interface StoredChapterExport { sourceHash: string; exportedAt: string }
interface ChapterExportFile { version: 1; chapters: Record<string, StoredChapterExport> }
const fileFor = (dir: string) => join(dir, '追踪', '.chapter-export.json')

export async function readChapterExports(dir: string): Promise<Record<string, StoredChapterExport>> {
  if (await memoryFileFingerprint(fileFor(dir)) === 'missing') return {}
  try {
    const value = JSON.parse(await readMemoryText(fileFor(dir))) as ChapterExportFile
    if (value?.version !== 1 || !value.chapters || typeof value.chapters !== 'object' ||
      Array.isArray(value.chapters)) return {}
    return value.chapters
  } catch { return {} }
}

/** 批量写入导出记录；同章重复导出以最新一次为准。损坏的旧文件直接重建。 */
export async function markChaptersExported(
  dir: string,
  entries: { chapterNumber: number; sourceHash: string }[]
): Promise<void> {
  if (entries.length === 0) return
  const file = fileFor(dir)
  await withFileLock(file, async () => {
    let value: ChapterExportFile = { version: 1, chapters: {} }
    try {
      if (await memoryFileFingerprint(file) !== 'missing') {
        const parsed = JSON.parse(await readMemoryText(file)) as ChapterExportFile
        if (parsed?.version === 1 && parsed.chapters && typeof parsed.chapters === 'object' &&
          !Array.isArray(parsed.chapters)) value = parsed
      }
    } catch { /* 损坏时重建 */ }
    const now = new Date().toISOString()
    for (const e of entries) {
      value.chapters[String(e.chapterNumber)] = { sourceHash: e.sourceHash, exportedAt: now }
    }
    await writeJsonAtomic(file, value)
  })
}
