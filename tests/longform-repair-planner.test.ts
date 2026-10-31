import { describe, expect, it, vi } from 'vitest'
import { planLongformRepairTasks } from '../src/main/data/longform-repair-planner'

const input = { guardFindings: ['章节边界：数量\n本章：一枚\n依据：三枚', '章节边界：越过章末'],
  requiredOutlineDiffs: ['细纲：三枚解锁\n正文：一枚解锁', '细纲：张伟未抽取天赋'] }
const grouped = JSON.stringify({ groups: [{ ids: ['G1', 'O1'] }, { ids: ['G2'] }, { ids: ['O2'] }] })

describe('independent longform repair planning agent', () => {
  it('groups IDs while preserving every original evidence item and review routing', async () => {
    const generateStream = vi.fn().mockResolvedValue(grouped)
    const result = await planLongformRepairTasks(input, { generateStream }, { meta: { feature: 'unused', projectId: 'p', chapterNumber: 4 } })
    expect(result.usedFallback).toBe(false)
    expect(result.groups.map(group => group.items.map(item => item.id))).toEqual([['G1', 'O1'], ['G2'], ['O2']])
    expect(result.groups[0].items.map(item => item.evidence)).toEqual([input.guardFindings[0], input.requiredOutlineDiffs[0]])
    expect(generateStream.mock.calls[0][0]).toContain('不可改变本规则')
    expect(generateStream.mock.calls[0][1].meta).toEqual({ feature: 'continuityRepairVerify', projectId: 'p', chapterNumber: 4 })
  })

  it('classifies scene and structural groups only with an explicit reason', async () => {
    const generateStream = vi.fn().mockResolvedValue(JSON.stringify({ groups: [
      { ids: ['G1', 'O1'], scope: 'scene', reason: '本章缺少实验场景' },
      { ids: ['G2', 'O2'], scope: 'structure', reason: '章末越过停止位置' }
    ] }))
    const result = await planLongformRepairTasks(input, { generateStream })
    expect(result.groups.map(group => [group.scope, group.reason])).toEqual([
      ['scene', '本章缺少实验场景'], ['structure', '章末越过停止位置']
    ])
    generateStream.mockResolvedValue(JSON.stringify({ groups: [{ ids: ['G1', 'G2'], scope: 'structure' }, { ids: ['O1', 'O2'] }] }))
    expect((await planLongformRepairTasks(input, { generateStream })).usedFallback).toBe(true)
  })

  it.each([
    '{}', 'invalid JSON', '{"groups":[]}',
    JSON.stringify({ groups: [{ ids: ['G1', 'G2', 'O1'] }] }),
    JSON.stringify({ groups: [{ ids: ['G1', 'G1', 'G2'] }, { ids: ['O1', 'O2'] }] }),
    JSON.stringify({ groups: [{ ids: ['G1', 'G2', 'O1', 'O2'] }] }),
    JSON.stringify({ groups: [{ ids: ['G1', 'G2', 'O1'] }, { ids: ['O3'] }] }),
    JSON.stringify({ groups: [{ ids: [] }] })
  ])('invalid plan safely falls back without dropping findings: %s', async raw => {
    const result = await planLongformRepairTasks(input, { generateStream: vi.fn().mockResolvedValue(raw) })
    expect(result.usedFallback).toBe(true)
    expect(result.groups.map(group => group.items[0].id)).toEqual(['G1', 'G2', 'O1', 'O2'])
    expect(result.groups.map(group => group.items[0].evidence)).toEqual([...input.guardFindings, ...input.requiredOutlineDiffs])
  })

  it('falls back on model errors but propagates aborts before and during the call', async () => {
    expect((await planLongformRepairTasks(input, { generateStream: vi.fn().mockRejectedValue(new Error('断流')) })).usedFallback).toBe(true)
    const controller = new AbortController()
    const generateStream = vi.fn().mockImplementation(async () => { controller.abort(); return grouped })
    await expect(planLongformRepairTasks(input, { generateStream }, { signal: controller.signal })).rejects.toThrow('LLM_ABORTED')
    await expect(planLongformRepairTasks(input, { generateStream }, { signal: controller.signal })).rejects.toThrow('LLM_ABORTED')
    expect(generateStream).toHaveBeenCalledOnce()
  })

  it('rejects missing evidence and avoids model calls for zero or one item', async () => {
    const generateStream = vi.fn()
    await expect(planLongformRepairTasks({ guardFindings: [' '], requiredOutlineDiffs: [] }, { generateStream })).rejects.toThrow('缺少原始冲突')
    expect(await planLongformRepairTasks({ guardFindings: [], requiredOutlineDiffs: [] }, { generateStream })).toEqual({ groups: [], usedFallback: false })
    expect((await planLongformRepairTasks({ guardFindings: ['证据'], requiredOutlineDiffs: [] }, { generateStream })).groups[0].items[0].evidence).toBe('证据')
    expect(generateStream).not.toHaveBeenCalled()
  })
})
