import { describe, expect, it } from 'vitest'
import type { ChapterMeta, Foreshadowing } from '../src/shared/types'
import {
  buildForeshadowingEditPatch, buildForeshadowingStagePatch, isForeshadowingOverdue,
  latestWrittenChapter, validateForeshadowingEventChapter, writtenChapters
} from '../src/renderer/src/foreshadowingBoardState'

const chapter = (chapterNumber: number, wordCount = 0): ChapterMeta => ({
  schemaVersion: 1, updatedAt: '', title: `第${chapterNumber}章`, chapterNumber, wordCount,
  status: wordCount > 0 ? 'draft' : 'outline'
})
const item: Foreshadowing = { id: 'FB-001', content: '古井中的铜镜', status: 'planted',
  plantChapter: 5, expectedCollect: 50, createdAt: '', updatedAt: '' }

describe('foreshadowing board progress and explicit dates', () => {
  it('uses the highest chapter containing prose, not the number of planned or noncontiguous chapters', () => {
    const chapters = [...Array.from({ length: 100 }, (_, index) => chapter(index + 1)), chapter(143, 1200)]
    expect(latestWrittenChapter(chapters)).toBe(143)
    expect(latestWrittenChapter(chapters.slice(0, 100))).toBe(0)
    expect(writtenChapters(chapters).map((entry) => entry.chapterNumber)).toEqual([143])
    expect(isForeshadowingOverdue(item, 10)).toBe(false)
    expect(isForeshadowingOverdue(item, 51)).toBe(true)
    expect(isForeshadowingOverdue({ ...item, status: 'deferred' }, 100)).toBe(false)
    expect(isForeshadowingOverdue({ ...item, status: 'partial' }, 100)).toBe(true)
  })

  it('never substitutes the planned date when an actual chapter has not been chosen', () => {
    const chapters = [chapter(5, 100), chapter(43, 1200), chapter(50)]
    expect(() => validateForeshadowingEventChapter(item, 'collect', '', chapters)).toThrow('请选择实际发生章节')
    expect(validateForeshadowingEventChapter(item, 'collect', '43', chapters)).toBe(43)
    expect(() => validateForeshadowingEventChapter(item, 'collect', '50', chapters)).toThrow('已有正文')
    expect(() => validateForeshadowingEventChapter(item, 'collect', '4', [...chapters, chapter(4, 900)])).toThrow('不能早于')
    expect(() => validateForeshadowingEventChapter({ ...item, plantChapter: undefined }, 'partial', '43', chapters)).toThrow('先记录实际埋设')
  })

  it('records multiple reinforcement/partial chapters without marking full collection', () => {
    expect(buildForeshadowingStagePatch({ ...item, reinforcementChapters: [10, 20] }, 'reinforce', 10))
      .toEqual({ status: 'reinforced', reinforcementChapters: [10, 20] })
    const partial = buildForeshadowingStagePatch({ ...item, partialCollectChapters: [20] }, 'partial', 30)
    expect(partial).toEqual({ status: 'partial', partialCollectChapters: [20, 30] })
    expect(partial).not.toHaveProperty('actualCollect')
    expect(buildForeshadowingStagePatch(item, 'defer', 80)).toEqual({ status: 'deferred', expectedCollect: 80 })
    expect(() => validateForeshadowingEventChapter(item, 'defer', '30', [chapter(43, 800)])).toThrow('晚于当前写作进度')
  })

  it('uses explicit null to clear a planned date and note while leaving event history untouched', () => {
    expect(buildForeshadowingEditPatch(' 铜镜 ', '', ' ')).toEqual({ content: '铜镜', expectedCollect: null, note: null })
    expect(buildForeshadowingEditPatch('铜镜', '70', '  留给下卷  '))
      .toEqual({ content: '铜镜', expectedCollect: 70, note: '留给下卷' })
    expect(() => buildForeshadowingEditPatch('铜镜', '3.5', '')).toThrow('正整数')
    expect(() => buildForeshadowingEditPatch('铜镜', '-1', '')).toThrow('正整数')
  })
})
