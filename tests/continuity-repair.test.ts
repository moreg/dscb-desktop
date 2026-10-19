import { describe, expect, it, vi } from 'vitest'
import { applyContinuityReplacements, repairContinuity } from '../src/main/data/continuity-repair'

const prose = '林远留在门外。他把钥匙还给师父。师父接住钥匙，转身离开。'
const patch = (before: string, after: string) => JSON.stringify({ replacements: [{ before, after }] })

describe('continuity repair replacements', () => {
  it('changes only unique non-overlapping source passages, independent of replacement order', () => {
    const raw = JSON.stringify({ replacements: [
      { before: '师父接住钥匙', after: '师父收好钥匙' }, { before: '他把钥匙还给师父', after: '他在门外交还钥匙' }
    ] })
    expect(applyContinuityReplacements(prose, raw)).toBe('林远留在门外。他在门外交还钥匙。师父收好钥匙，转身离开。')
  })
  it.each([
    '{}', patch('不存在的原句', '新的正文'), patch('林远', ''), patch('林远', '林远'),
    JSON.stringify({ replacements: [{ before: '钥匙', after: '账册' }] }),
    JSON.stringify({ replacements: [{ before: '他把钥匙还给师父', after: '他没有钥匙' }, { before: '还给师父', after: '交给守门人' }] })
  ])('rejects invalid, ambiguous or overlapping patches: %s', raw => {
    expect(() => applyContinuityReplacements(prose, raw)).toThrow()
  })
  it('rejects wholesale scene replacement or excessive deletion', () => {
    const original = '林远留在门外。'.repeat(100) + '师父接住钥匙，转身离开。'
    expect(() => applyContinuityReplacements(original, patch(original, '林远回家了。'))).toThrow()
    expect(() => applyContinuityReplacements(prose, patch('他把钥匙还给师父。师父接住钥匙，转身离开。', '他走了。'))).toThrow()
  })
})

describe('automatic continuity repair', () => {
  const input = { chapterNumber: 2, content: prose, issue: '前文钥匙仍在林远手里，本章不能无故归还', context: '上章原文和本章细纲' }
  it('retries malformed replies and failed rechecks, returning only verified prose', async () => {
    const generate = vi.fn().mockResolvedValueOnce('{}').mockResolvedValue(patch('他把钥匙还给师父', '他把钥匙收进袖口'))
    const verify = vi.fn().mockRejectedValueOnce(new Error('尚未对齐前文')).mockResolvedValue(undefined)
    const check = vi.fn().mockResolvedValue('通过')
    const result = await repairContinuity(input, { generate, verify, check })
    expect(generate).toHaveBeenCalledTimes(3)
    expect(verify).toHaveBeenCalledTimes(2)
    expect(check).toHaveBeenCalledOnce()
    expect(result.content).toContain('他把钥匙收进袖口')
    expect(generate.mock.calls[2][0]).toContain('尚未对齐前文')
  })
  it('verifies the final prepared text rather than a pre-polish candidate', async () => {
    const prepared = prose.replace('门外', '院门外')
    const verify = vi.fn().mockResolvedValue(undefined)
    const check = vi.fn().mockResolvedValue('通过')
    const result = await repairContinuity(input, {
      generate: async () => patch('林远留在门外', '林远等在门外'), prepare: async () => prepared, verify, check
    })
    expect(verify).toHaveBeenCalledWith(prose, prepared)
    expect(check).toHaveBeenCalledWith(prepared)
    expect(result.content).toBe(prepared)
  })
  it('backs off and automatically proceeds past three rejected rounds without asking for a manual repair', async () => {
    vi.useFakeTimers()
    try {
      const generate = vi.fn().mockResolvedValue(patch('林远留在门外', '林远等在门外'))
      const verify = vi.fn().mockRejectedValueOnce(new Error('仍有矛盾')).mockRejectedValueOnce(new Error('仍有矛盾'))
        .mockRejectedValueOnce(new Error('仍有矛盾')).mockResolvedValue(undefined)
      const task = repairContinuity(input, { generate, verify, check: vi.fn().mockResolvedValue('通过') })
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(task).resolves.toMatchObject({ check: '通过' })
      expect(generate).toHaveBeenCalledTimes(4)
    } finally { vi.useRealTimers() }
  })

  it('never checks or accepts a cancelled repair', async () => {
    const controller = new AbortController()
    const verify = vi.fn()
    await expect(repairContinuity({ ...input, signal: controller.signal }, {
      generate: async () => { controller.abort(); return patch('林远留在门外', '林远等在门外') }, verify, check: vi.fn()
    })).rejects.toThrow('LLM_ABORTED')
    expect(verify).not.toHaveBeenCalled()
  })
})
