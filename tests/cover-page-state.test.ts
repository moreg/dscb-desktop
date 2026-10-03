import { describe, expect, it } from 'vitest'
import { coverChannelFields, resolveCoverChannelComposition, coverCropObjectPosition, coverCustomTextConfirmationKey, coverTextSettingsKey, CoverPromptRequestGuard, describeCoverGenerationPhase, inspectCoverPromptText, isCoverGenerationActive } from '../src/renderer/src/cover-page-state'

describe('cover character channel requests', () => {
  it('leaves automatic inference unlocked and retains explicit gender in shared request fields', () => {
    expect(coverChannelFields('auto')).not.toHaveProperty('channel')
    expect(coverChannelFields('male')).toEqual({ channel: 'male' })
    expect(coverChannelFields('female')).toEqual({ channel: 'female' })
  })
  it('requires people for explicit channels without losing a two-person composition', () => {
    expect(resolveCoverChannelComposition('scene')).toBe('scene')
    for (const channel of ['male', 'female'] as const) {
      expect(resolveCoverChannelComposition('scene', channel)).toBe('closeup')
      expect(resolveCoverChannelComposition('duo', channel)).toBe('duo')
      expect(resolveCoverChannelComposition('fullbody', channel)).toBe('fullbody')
    }
  })
  it('rejects delayed extraction when the user selects a different channel', () => {
    const guard = new CoverPromptRequestGuard()
    const extraction = guard.begin()
    guard.invalidate()
    const selectedChannelTemplate = guard.begin()
    expect(guard.isCurrent(extraction)).toBe(false)
    expect(guard.isCurrent(selectedChannelTemplate)).toBe(true)
  })
})

describe('cover prompt request ownership', () => {
  it('ignores extraction and reset results after a later author edit', () => {
    const guard = new CoverPromptRequestGuard()
    const extract = guard.begin()
    guard.invalidate()
    expect(guard.isCurrent(extract)).toBe(false)
    const reset = guard.begin()
    guard.invalidate()
    expect(guard.isCurrent(reset)).toBe(false)
  })
  it('only permits the newest typography or template build to commit', () => {
    const guard = new CoverPromptRequestGuard()
    const first = guard.begin()
    const latest = guard.begin()
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(latest)).toBe(true)
  })
})

describe('cover title and byline verification', () => {
  const standard = "Title text '新书名' in bold type.\nAuthor byline: the author name '新作者' followed by 著.\nKeep the red umbrella."
  const chinese = "书名文字：'新书名'，使用醒目的现代字体。\n作者署名：作者名'新作者'，紧接小号的‘著’字。\n保留红伞。"
  it('verifies Chinese titles and bylines while detecting stale fields', () => {
    expect(inspectCoverPromptText(chinese, '新书名', '新作者')).toBe('matches')
    expect(inspectCoverPromptText(chinese, '旧书名', '新作者')).toBe('mismatch')
    expect(inspectCoverPromptText(chinese, '新书名', '旧作者')).toBe('mismatch')
    expect(inspectCoverPromptText(chinese, ' 新书名 ', ' 新作者 ')).toBe('matches')
  })
  it('requires manual verification for duplicate text layers across languages', () => {
    expect(inspectCoverPromptText(`${chinese}\n${standard}`, '新书名', '新作者')).toBe('custom')
    expect(inspectCoverPromptText(`${chinese}\nTitle text '新书名' in bold.`, '新书名', '新作者')).toBe('custom')
    expect(inspectCoverPromptText(`${standard}\n作者署名：作者名'新作者'，小字。`, '新书名', '新作者')).toBe('custom')
  })
  it('detects old titles and authors while permitting the updated standard text layer', () => {
    expect(inspectCoverPromptText(standard, '新书名', '新作者')).toBe('matches')
    expect(inspectCoverPromptText(standard, '另一本书', '新作者')).toBe('mismatch')
    expect(inspectCoverPromptText(standard, '新书名', '旧作者')).toBe('mismatch')
  })
  it('requires manual verification for missing or ambiguous custom text layers', () => {
    expect(inspectCoverPromptText('Draw a moon.', '新书名', '新作者')).toBe('custom')
    expect(inspectCoverPromptText(`${standard}\nTitle text '重复' in bold.`, '新书名', '新作者')).toBe('custom')
    expect(inspectCoverPromptText('', '新书名', '新作者')).toBe('empty')
  })
  it('invalidates custom confirmation when text content or typography changes', () => {
    const original = coverTextSettingsKey('新书名', '新作者', { titlePosition: 'top' })
    const confirmed = coverCustomTextConfirmationKey('Draw a moon.', original)
    expect(coverCustomTextConfirmationKey('Draw a star.', original)).not.toBe(confirmed)
    expect(coverCustomTextConfirmationKey('Draw a moon.', coverTextSettingsKey('另一书名', '新作者', { titlePosition: 'top' }))).not.toBe(confirmed)
    expect(coverCustomTextConfirmationKey('Draw a moon.', coverTextSettingsKey('新书名', '新作者', { titlePosition: 'center' }))).not.toBe(confirmed)
  })
})

describe('generation task recovery and crop preview', () => {
  it('blocks duplicate generation during all active phases and releases terminal tasks', () => {
    for (const phase of ['preparing', 'generating', 'saving']) expect(isCoverGenerationActive(phase)).toBe(true)
    for (const phase of ['completed', 'cancelled', 'failed', undefined]) expect(isCoverGenerationActive(phase)).toBe(false)
    expect(describeCoverGenerationPhase('generating')).not.toContain('30')
    expect(describeCoverGenerationPhase('saving')).toContain('保存')
  })
  it('uses normalized crop positions consistently and clamps invalid coordinates', () => {
    expect(coverCropObjectPosition(0.25, 0.75)).toBe('25% 75%')
    expect(coverCropObjectPosition(-1, 2)).toBe('0% 100%')
    expect(coverCropObjectPosition(NaN, Infinity)).toBe('50% 50%')
  })
})
