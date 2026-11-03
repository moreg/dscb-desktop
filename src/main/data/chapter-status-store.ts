import { join } from 'path'
import { writeJsonAtomic } from './atomic'
import { withFileLock } from './file-lock'
import { memoryFileFingerprint, readMemoryText } from './memory/repository-cache'
import type { ChapterStatus } from '../../shared/types'

/**
 * 章节状态的持久层。draft/outline 是推导值（有没有正文），不落盘；
 * 这里只存「润色/定稿」这类超出推导值的标注，附带标注时的正文哈希——
 * 正文再改过就自动退回草稿，徽章不说谎。
 */
interface StoredChapterStatus { status: 'reviewed' | 'published'; sourceHash: string; updatedAt: string }
interface ChapterStatusFile { version: 1; chapters: Record<string, StoredChapterStatus> }
const fileFor = (dir: string) => join(dir, '追踪', '.chapter-status.json')

export async function readChapterStatuses(dir: string): Promise<Record<string, StoredChapterStatus>> {
  if (await memoryFileFingerprint(fileFor(dir)) === 'missing') return {}
  try {
    const value = JSON.parse(await readMemoryText(fileFor(dir))) as ChapterStatusFile
    if (value?.version !== 1 || !value.chapters || typeof value.chapters !== 'object' ||
      Array.isArray(value.chapters)) return {}
    return value.chapters
  } catch { return {} }
}

/** reviewed/published 记录哈希；draft/outline 清除标注，退回推导值。损坏的旧文件直接重建。 */
export async function setChapterStatus(dir: string, chapter: number, status: ChapterStatus, sourceHash: string): Promise<void> {
  const file = fileFor(dir)
  await withFileLock(file, async () => {
    let value: ChapterStatusFile = { version: 1, chapters: {} }
    try {
      if (await memoryFileFingerprint(file) !== 'missing') {
        const parsed = JSON.parse(await readMemoryText(file)) as ChapterStatusFile
        if (parsed?.version === 1 && parsed.chapters && typeof parsed.chapters === 'object' &&
          !Array.isArray(parsed.chapters)) value = parsed
      }
    } catch { /* 损坏时重建 */ }
    if (status === 'reviewed' || status === 'published') {
      value.chapters[String(chapter)] = { status, sourceHash, updatedAt: new Date().toISOString() }
    } else {
      delete value.chapters[String(chapter)]
    }
    await writeJsonAtomic(file, value)
  })
}
