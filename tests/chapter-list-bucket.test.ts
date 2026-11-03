import { describe, expect, it } from 'vitest'
import { chapterListBucket } from '../src/renderer/src/ChapterListPage'
import type { ChapterMeta } from '../src/shared/types'

function chapter(status: ChapterMeta['status'], wordCount: number): Pick<ChapterMeta, 'status' | 'wordCount'> {
  return { status, wordCount }
}

describe('章节列表分档', () => {
  it('草稿和润色都合进正文，定稿单独一档', () => {
    expect(chapterListBucket(chapter('draft', 1200))).toBe('prose')
    expect(chapterListBucket(chapter('reviewed', 800))).toBe('prose')
    expect(chapterListBucket(chapter('published', 900))).toBe('published')
  })

  it('没有正文，或正文文件是空的，都算待写', () => {
    expect(chapterListBucket(chapter('outline', 0))).toBe('pending')
    expect(chapterListBucket(chapter('draft', 0))).toBe('pending')
    expect(chapterListBucket(chapter('reviewed', 0))).toBe('pending')
    expect(chapterListBucket(chapter('published', 0))).toBe('pending')
  })
})
