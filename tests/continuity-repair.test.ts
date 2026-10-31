import { describe, expect, it, vi } from 'vitest'
import { applyContinuityReplacements, accumulatedRepairIsBroad, repairContinuity, splitLongformFindings } from '../src/main/data/continuity-repair'

const prose = '林远留在门外。他把钥匙还给师父。师父接住钥匙，转身离开。'
const patch = (before: string, after: string) => JSON.stringify({ replacements: [{ before, after }] })

describe('continuity repair replacements', () => {
  it('splits evidence-backed guard findings into independent repair tasks', () => {
    const issue = 'LONGFORM_CONFLICT: 发现冲突\n章节边界：碎片错误\n本章：碎片一枚\n依据：三枚解锁\n人物知情：提前知情\n本章：他知道了\n依据：下章才知道'
    expect(splitLongformFindings(issue)).toEqual(['章节边界：碎片错误\n本章：碎片一枚\n依据：三枚解锁', '人物知情：提前知情\n本章：他知道了\n依据：下章才知道'])
  })

  it('retains multiline quotations and falls back if any finding is incomplete', () => {
    const issue = 'LONGFORM_CONFLICT: 冲突\n章节边界：问题一\n本章：第一句\n\n第二句\n依据：原始要求\n主线：问题二\n本章：第三句\n依据：后续计划'
    expect(splitLongformFindings(issue)).toEqual(['章节边界：问题一\n本章：第一句\n\n第二句\n依据：原始要求', '主线：问题二\n本章：第三句\n依据：后续计划'])
    const bad = issue.replace('依据：后续计划', '缺失依据')
    expect(splitLongformFindings(bad)).toEqual([bad])
  })
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

  it('preserves every character outside two small, separated corrections', () => {
    const original = '开头保持。\r\n【奖励：权限碎片×10。】\r\n' + '中间场景和对白照旧。\n'.repeat(60) + '异常值超过80%也无须降档。\r\n原章末。'
    const raw = JSON.stringify({ replacements: [
      { before: '权限碎片×10', after: '权限碎片×1' },
      { before: '异常值超过80%也无须降档', after: '异常值超过80%就须降档' }
    ] })
    expect(applyContinuityReplacements(original, raw)).toBe(original
      .replace('权限碎片×10', '权限碎片×1').replace('异常值超过80%也无须降档', '异常值超过80%就须降档'))
  })

  it('marks accumulated small edits as broad when their combined size exceeds the limit', () => {
    const original = Array.from({ length: 12 }, (_, i) => `第${i}段${'甲'.repeat(90)}。`).join('\n')
    const candidate = original.replace('第0段', '第零段').replace('第4段', '第四段')
    expect(accumulatedRepairIsBroad(original, candidate)).toBe(false)
    const changed = original.replace('甲'.repeat(90), '乙'.repeat(90)).replace('甲'.repeat(90), '丙'.repeat(90))
      .replace('甲'.repeat(90), '丁'.repeat(90))
    expect(accumulatedRepairIsBroad(original, changed)).toBe(true)
  })

  it('rejects replacing 30% of a chapter even when split into individually small patches', () => {
    const chunks = ['甲', '乙', '丙', '丁'].map(char => char.repeat(100))
    const original = chunks.join('') + '原有背景。'.repeat(120)
    const raw = JSON.stringify({ replacements: chunks.slice(0, 3).map(before => ({ before, after: '修正。'.repeat(25) })) })
    expect(() => applyContinuityReplacements(original, raw)).toThrow('改动范围过大')
  })

  it('bounds both the old passage and the new prose to prevent expansion disguised as a tiny fix', () => {
    const original = '原有场景。'.repeat(200) + '唯一的问题句。' + '甲'.repeat(301)
    expect(() => applyContinuityReplacements(original, patch('甲'.repeat(301), '乙'.repeat(301)))).toThrow('单处范围过大')
    expect(() => applyContinuityReplacements(original, patch('唯一的问题句。', '新场景。'.repeat(101)))).toThrow('单处范围过大')
  })

  it('allows a bounded scene candidate only in the explicit scene scope', () => {
    const before = '甲'.repeat(500)
    const original = '开场。' + before + '结尾。' + '背景。'.repeat(400)
    const raw = patch(before, '乙'.repeat(500))
    expect(() => applyContinuityReplacements(original, raw)).toThrow('单处范围过大')
    expect(applyContinuityReplacements(original, raw, 'scene')).toBe(original.replace(before, '乙'.repeat(500)))
  })

  it('allows a chapter-boundary deletion only in the explicit structure scope', () => {
    const tail = '越界情节。'.repeat(200)
    const original = '本章正文与章末。' + tail
    const raw = patch(tail, '')
    expect(() => applyContinuityReplacements(original, raw)).toThrow()
    expect(() => applyContinuityReplacements(original, raw, 'scene')).toThrow()
    expect(applyContinuityReplacements(original, raw, 'structure')).toBe('本章正文与章末。')
  })

  it('accepts a long unique anchor when only a small interior span changes', () => {
    const before = '前文'.repeat(200) + '错误数量×10' + '后文'.repeat(200)
    const original = '开头。' + before + '结尾。' + '其他正文。'.repeat(200)
    const after = before.replace('错误数量×10', '正确数量×1')
    expect(applyContinuityReplacements(original, patch(before, after))).toBe(original.replace(before, after))
  })

  it('still rejects a large changed span between identical long anchors', () => {
    const before = '前文'.repeat(200) + '甲'.repeat(301) + '后文'.repeat(200)
    const original = before + '其他正文。'.repeat(200)
    const after = before.replace('甲'.repeat(301), '乙'.repeat(301))
    expect(() => applyContinuityReplacements(original, patch(before, after))).toThrow('实际改动原文 301/300')
  })

  it('rejects many scattered edits and caps cumulative new text', () => {
    const clauses = Array.from({ length: 7 }, (_, i) => `第${i}处原句。`)
    const original = clauses.join('\n') + '背景。'.repeat(300)
    expect(() => applyContinuityReplacements(original, JSON.stringify({ replacements:
      clauses.map(before => ({ before, after: '修改句。' })) }))).toThrow('超过 6 处')
    expect(() => applyContinuityReplacements(original, JSON.stringify({ replacements:
      clauses.slice(0, 3).map(before => ({ before, after: '新增场景。'.repeat(20) })) }))).toThrow('改动范围过大')
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

  it('feeds an oversized patch back for a smaller edit without sending it to verification', async () => {
    const block = '甲'.repeat(301)
    const original = prose + '背景。'.repeat(250) + block
    const generate = vi.fn().mockResolvedValueOnce(patch(block, '乙'.repeat(301)))
      .mockResolvedValueOnce(patch('林远留在门外', '林远等在门外'))
    const verify = vi.fn().mockResolvedValue(undefined)
    const result = await repairContinuity({ ...input, content: original, maxRounds: 2 }, {
      generate, verify, check: async () => '通过'
    })
    expect(result.content).toBe(original.replace('林远留在门外', '林远等在门外'))
    expect(generate.mock.calls[1][0]).toContain('单处范围过大')
    expect(verify).toHaveBeenCalledOnce()
  })
  it('verifies exactly the local replacement without a whole-chapter rewriting stage', async () => {
    const prepared = prose.replace('林远留在门外', '林远等在门外')
    const verify = vi.fn().mockResolvedValue(undefined)
    const check = vi.fn().mockResolvedValue('通过')
    const result = await repairContinuity(input, {
      generate: async () => patch('林远留在门外', '林远等在门外'), verify, check
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
