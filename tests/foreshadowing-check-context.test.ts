import { describe, expect, it } from 'vitest'
import { normalizeForeshadowCheckContext, resolveForeshadowCheckContext } from '../src/shared/foreshadowing-check-context'

const source = { projectId: 'p', chapterNumber: 1, content: '当前正文' }
describe('伏笔补跑继承原检查上下文', () => {
  it('keeps an explicitly complete check even when the current mode is unknown', () => {
    expect(resolveForeshadowCheckContext(source, { ...source,
      foreshadowContext: { partialChapter: false, tempContext: '暂不揭晓身份' } }))
      .toEqual({ partialChapter: false, tempContext: '暂不揭晓身份' })
  })

  it('recovers partial scope from persistent metadata after the current session is cleared', () => {
    expect(resolveForeshadowCheckContext(source, null, { ...source,
      foreshadowContext: { partialChapter: true, tempContext: '只补当前场景的借条线索' } }))
      .toEqual({ partialChapter: true, tempContext: '只补当前场景的借条线索' })
  })

  it.each([{ projectId: 'other' }, { chapterNumber: 2 }, { content: '另一份正文' }])('does not inherit context from another source: %j', (changed) => {
    expect(resolveForeshadowCheckContext(source, { ...source, ...changed,
      foreshadowContext: { partialChapter: true, tempContext: '错误的要求' } })).toEqual({ partialChapter: false })
  })

  it('uses a complete check for legacy entries, without treating null as partial', () => {
    expect(resolveForeshadowCheckContext(source, { ...source })).toEqual({ partialChapter: false })
  })

  it('takes a defensive copy of the valid context and rejects malformed metadata', () => {
    const original = { partialChapter: false, tempContext: '' }
    const copy = normalizeForeshadowCheckContext(original)!
    copy.partialChapter = true
    expect(original.partialChapter).toBe(false)
    expect(normalizeForeshadowCheckContext({ partialChapter: 'false' })).toBeUndefined()
  })
})
