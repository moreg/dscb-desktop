import { describe, expect, it, vi } from 'vitest'
import { repairMissingMemoryEvidence } from '../src/main/data/memory-evidence-repair'
import { parseMemoryExtractionJson } from '../src/shared/parsers'

const prose = '林远推开木门走进院子，放下行囊。'
function candidate() {
  return parseMemoryExtractionJson(JSON.stringify({
    collectedForeshadowings: [],
    newPlotPoints: [{ title: '进院', event: '林远走进院子', evidence: '林远进入了院子' }],
    characterStateChanges: [{ name: '林远', field: '位置', oldValue: '门外', newValue: '院子', evidence: '林远走到了院内' }]
  }), 1)
}

describe('缺失记忆引文定向修复', () => {
  it('只修改失败条目的证据，不改候选事实或已有效的条目', async () => {
    const input = candidate()
    input.newPlotPoints[0].evidence = '林远推开木门走进院子'
    const generate = vi.fn().mockResolvedValue(JSON.stringify([{ id: 0, supported: true, evidence: '林远推开木门走进院子' }]))
    const output = await repairMissingMemoryEvidence(prose, input, generate)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0][0]).not.toContain('"title":"进院"')
    expect(output.newPlotPoints).toEqual(input.newPlotPoints)
    expect(output.characterStateChanges[0]).toEqual({ ...input.characterStateChanges[0], evidence: '林远推开木门走进院子' })
    expect(input.characterStateChanges[0].evidence).toBe('林远走到了院内')
  })

  it.each([
    'bad json', '{}',
    '[{"id":0,"supported":false,"evidence":"林远推开木门走进院子"}]',
    '[{"id":0,"supported":true,"evidence":"林远大步进入了院子"}]',
    '[{"id":99,"supported":true,"evidence":"林远推开木门走进院子"}]',
    '[{"id":0,"supported":true,"evidence":"林远推开木门走进院子"},{"id":0,"supported":false}]'
  ])('无依据、改写或错误返回不得放行：%s', async (raw) => {
    const input = candidate()
    expect(await repairMissingMemoryEvidence(prose, input, async () => raw)).toEqual(input)
  })

  it('补找的原句仍需通过否定和计划检查', async () => {
    const input = candidate()
    const output = await repairMissingMemoryEvidence('林远打算推开木门走进院子。', input,
      async () => '[{"id":0,"supported":true,"evidence":"推开木门走进院子"}]')
    expect(output).toEqual(input)
  })

  it('证据齐全或已能定位但不确定时，不增加模型调用', async () => {
    const input = candidate()
    for (const v of [...input.newPlotPoints, ...input.characterStateChanges]) v.evidence = '林远推开木门走进院子'
    const generate = vi.fn()
    await repairMissingMemoryEvidence(prose, input, generate)
    await repairMissingMemoryEvidence('听说林远推开木门走进院子。', input, generate)
    expect(generate).not.toHaveBeenCalled()
  })

  it('网络失败保留候选，且仅尝试一次', async () => {
    const input = candidate()
    const generate = vi.fn().mockRejectedValue(new Error('timeout'))
    expect(await repairMissingMemoryEvidence(prose, input, generate)).toEqual(input)
    expect(generate).toHaveBeenCalledTimes(1)
  })
})
