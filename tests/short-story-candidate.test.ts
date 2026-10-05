import { describe, expect, it } from 'vitest'
import {
  adoptShortStoryCandidate,
  shortStoryCandidateSource,
  type ShortStoryCandidate
} from '../src/renderer/src/short-story-candidate'
import type { ShortStoryDocument } from '../src/shared/short-story'

function story(overrides: Partial<ShortStoryDocument> = {}): ShortStoryDocument {
  return {
    id: 'short-1', revision: 1, sourceFingerprint: 'a'.repeat(64),
    createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z',
    title: '迟到的信', kind: 'short', genre: '悬疑', brief: '一封信改变了选择。',
    requirements: '第三人称有限视角。', targetWords: 8000, sectionCount: 4,
    outline: '收到信，调查旧事，发现真相，解决误会。',
    sections: Array.from({ length: 4 }, (_, index) => ({
      number: index + 1, title: `原节标题${index + 1}`, content: `第${index + 1}节原稿。`
    })),
    review: '第2节的来信时间与前文冲突，请统一。',
    ...overrides
  }
}

function candidate(document: ShortStoryDocument, overrides: Partial<ShortStoryCandidate> = {}): ShortStoryCandidate {
  const task = overrides.task ?? 'revise'
  return {
    task, sectionNumber: 2, append: false, text: '第2节完整修订正文。', status: 'completed',
    source: shortStoryCandidateSource(document, task), ...overrides
  }
}

describe('short-story candidates', () => {
  it('replaces only the chosen section, clears its old review, and preserves the original document', () => {
    const document = story()
    const before = structuredClone(document)
    const result = adoptShortStoryCandidate(document, candidate(document))

    expect(result).toEqual({
      ...before, review: '',
      sections: before.sections.map(section => section.number === 2
        ? { ...section, content: '第2节完整修订正文。' }
        : section)
    })
    expect(document).toEqual(before)
    expect(result).not.toBe(document)
    expect(result.sections[1]).not.toBe(document.sections[1])
    expect(result.sections[0]).toBe(document.sections[0])
    expect(result.sections[2]).toBe(document.sections[2])
    expect(result.sections[3]).toBe(document.sections[3])
    expect(result.sections[1].title).toBe('原节标题2')
  })

  it('never appends a revision even if a recovered candidate has a damaged append flag', () => {
    const document = story()
    const result = adoptShortStoryCandidate(document, candidate(document, { append: true }))
    expect(result.sections[1].content).toBe('第2节完整修订正文。')
    expect(result.sections[1].content).not.toContain('第2节原稿。')
  })

  it('invalidates a revision when the report alone changes', () => {
    const document = story()
    const proposed = candidate(document)
    const changed = { ...document, review: '第2节只需修改对话格式。' }
    expect(shortStoryCandidateSource(changed, 'revise')).not.toBe(proposed.source)
    expect(() => adoptShortStoryCandidate(changed, proposed)).toThrow(/检查报告已变化/)
  })

  it('keeps ordinary writing candidates valid when only the report changes', () => {
    const document = story()
    const proposed = candidate(document, { task: 'section', append: true, text: '他走到门前。' })
    const changed = { ...document, review: '另一份检查报告。' }
    expect(shortStoryCandidateSource(changed, 'section')).toBe(proposed.source)
    expect(adoptShortStoryCandidate(changed, proposed).sections[1].content)
      .toBe('第2节原稿。\n他走到门前。')
  })

  it('rejects a revision after any original section has been edited', () => {
    const document = story()
    const proposed = candidate(document)
    const changed = {
      ...document,
      sections: document.sections.map(section => section.number === 3
        ? { ...section, content: '第3节已经修改。' }
        : section)
    }
    expect(() => adoptShortStoryCandidate(changed, proposed)).toThrow(/原稿/)
  })

  it.each(['generating', 'stopped', 'failed'] as const)('rejects a %s revision without changing the manuscript', status => {
    const document = story()
    const before = structuredClone(document)
    expect(() => adoptShortStoryCandidate(document, candidate(document, { status }))).toThrow(/修订尚未完成/)
    expect(document).toEqual(before)
  })

  it.each([undefined, 0, -1, 1.5, 5])('rejects an invalid revision target %s', sectionNumber => {
    const document = story()
    expect(() => adoptShortStoryCandidate(document, candidate(document, { sectionNumber }))).toThrow(/分节不存在/)
  })

  it.each(['', ' \n\t '])('rejects an empty revision %j', text => {
    const document = story()
    expect(() => adoptShortStoryCandidate(document, candidate(document, { text }))).toThrow(/为空/)
  })

  it('rejects a replacement beyond the single-section storage limit', () => {
    const document = story()
    const before = structuredClone(document)
    expect(() => adoptShortStoryCandidate(document, candidate(document, { text: '字'.repeat(40001) })))
      .toThrow(/40000/)
    expect(document).toEqual(before)
    expect(adoptShortStoryCandidate(document, candidate(document, { text: '字'.repeat(40000) }))
      .sections[1].content).toHaveLength(40000)
  })

  it('rejects a valid-size replacement if it would exceed the full manuscript storage limit', () => {
    const document = story({
      kind: 'medium', targetWords: 120000, sectionCount: 20,
      sections: Array.from({ length: 20 }, (_, index) => ({
        number: index + 1, title: `标题${index + 1}`, content: '字'.repeat(15000)
      }))
    })
    const before = structuredClone(document)
    expect(() => adoptShortStoryCandidate(document, candidate(document, { sectionNumber: 1, text: '修'.repeat(15001) })))
      .toThrow(/300000/)
    expect(document).toEqual(before)
    const atLimit = adoptShortStoryCandidate(document, candidate(document, { sectionNumber: 1, text: '修'.repeat(15000) }))
    expect(atLimit.sections.reduce((sum, section) => sum + section.content.length, 0)).toBe(300000)
  })

  it.each([
    ['他关上门。', '屋里终于安静了。', '他关上门。\n屋里终于安静了。'],
    ['他推开', '门，屋里无人。', '他推开门，屋里无人。']
  ])('preserves the ordinary continuation seam for %s', (base, addition, expected) => {
    const document = story()
    document.sections[1].content = base
    const result = adoptShortStoryCandidate(document, candidate(document, { task: 'section', append: true, text: addition }))
    expect(result.sections[1].content).toBe(expected)
    expect(result.review).toBe('')
    expect(document.sections[1].content).toBe(base)
  })

  it('adopts a new outline and invalidates the review without altering prose', () => {
    const document = story()
    const result = adoptShortStoryCandidate(document, candidate(document, { task: 'outline', text: '修订后的全文大纲。' }))
    expect(result).toEqual({ ...document, outline: '修订后的全文大纲。', review: '' })
    expect(result.sections).toBe(document.sections)
    expect(document.review).toBe('第2节的来信时间与前文冲突，请统一。')
  })

  it('adopts a review while preserving the manuscript and outline', () => {
    const document = story()
    const result = adoptShortStoryCandidate(document, candidate(document, { task: 'review', text: '新的全文检查结果。' }))
    expect(result).toEqual({ ...document, review: '新的全文检查结果。' })
    expect(result.sections).toBe(document.sections)
    expect(document.review).toBe('第2节的来信时间与前文冲突，请统一。')
  })
})
