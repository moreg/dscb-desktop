import { describe, expect, it, vi } from 'vitest'
import { WriteFlowService } from '../src/main/data/write-flow-service'
import type { LlmService } from '../src/main/data/llm-service'

const added = '信封上有一道蓝色划痕。'
const input = { chapterNumber: 1, original: '他拿起信封。\n门外响起敲门声。',
  candidate: `他拿起信封。\n${added}\n门外响起敲门声。`, inserted: [added],
  outline: '埋设信封划痕，不揭晓寄信者身份', partialChapter: true, tempContext: '寄信者身份保密' }
const pass = { diffs: [], verification: { passed: true, issues: [] } }

describe('伏笔联合复核保留两套完整判定', () => {
  it('一轮请求完成完整细纲检查与新增内容核验，不再额外通读一次', async () => {
    const generateStream = vi.fn().mockResolvedValue(JSON.stringify(pass))
    const flow = new WriteFlowService({ generateStream } as unknown as LlmService)
    expect(await flow.reviewForeshadowingRepair(input)).toMatchObject({ checked: true, hasOutline: true, diffs: [] })
    expect(generateStream).toHaveBeenCalledTimes(1)
    const [prompt, opts] = generateStream.mock.calls[0]
    for (const rule of ['5 种差异类型', '伏笔必须逐条对照', '因果、人物认知、时间地点、设定',
      '尚未写到的后续场景', input.original, input.candidate, input.outline, input.tempContext]) expect(prompt).toContain(rule)
    expect(opts).not.toHaveProperty('repairVerification')
    expect(opts).not.toHaveProperty('partialChapter')
  })

  it('细纲无差异也不能覆盖新增内容核验失败，且不通过重试绕过失败结论', async () => {
    const generateStream = vi.fn().mockResolvedValue(JSON.stringify({ diffs: [], verification: {
      passed: false, issues: [{ message: '新增线索与既有设定冲突', evidence: added }]
    } }))
    const flow = new WriteFlowService({ generateStream } as unknown as LlmService)
    await expect(flow.reviewForeshadowingRepair(input)).rejects.toThrow('新增线索与既有设定冲突')
    expect(generateStream).toHaveBeenCalledTimes(1)
  })

  it('专项核验通过仍保留全章的遗漏及偏离报告，供下一轮处理', async () => {
    const diff = { type: 1, priority: 'P1', outline: '另一条伏笔', actual: '尚未写入', suggestion: '补写伏笔' }
    const generateStream = vi.fn().mockResolvedValue(JSON.stringify({ ...pass, diffs: [diff] }))
    const flow = new WriteFlowService({ generateStream } as unknown as LlmService)
    expect((await flow.reviewForeshadowingRepair(input)).diffs).toMatchObject([diff])
    expect(generateStream).toHaveBeenCalledTimes(1)
  })

  it.each([
    { diffs: [] }, { verification: pass.verification },
    { diffs: [], verification: { passed: true, issues: [{ message: '冲突' }] } },
    { diffs: [{ type: 9 }], verification: pass.verification }
  ])('联合结果不完整时回退，两次独立检查均通过才交付：%j', async raw => {
    const generateStream = vi.fn().mockResolvedValueOnce(JSON.stringify(raw))
      .mockResolvedValueOnce('[]').mockResolvedValueOnce(JSON.stringify(pass.verification))
    const fallback = vi.fn()
    const flow = new WriteFlowService({ generateStream } as unknown as LlmService)
    expect(await flow.reviewForeshadowingRepair(input, {}, fallback)).toMatchObject({ checked: true, diffs: [] })
    expect(fallback.mock.calls).toEqual([['outline'], ['verify']])
    expect(generateStream).toHaveBeenCalledTimes(3)
  })

  it('独立回退的核验失败同样阻断候选稿', async () => {
    const generateStream = vi.fn().mockResolvedValueOnce('{"diffs":[]}').mockResolvedValueOnce('[]')
      .mockResolvedValueOnce('{"passed":false,"issues":[]}')
    const flow = new WriteFlowService({ generateStream } as unknown as LlmService)
    await expect(flow.reviewForeshadowingRepair(input)).rejects.toThrow('未返回有效结论')
  })

  it('细纲输出损坏时也不能重试绕过已经给出的新增内容否决', async () => {
    const generateStream = vi.fn().mockResolvedValue(JSON.stringify({ diffs: '坏输出', verification: {
      passed: false, issues: [{ message: '新增线索矛盾', evidence: added }]
    } }))
    const flow = new WriteFlowService({ generateStream } as unknown as LlmService)
    await expect(flow.reviewForeshadowingRepair(input)).rejects.toThrow('新增线索矛盾')
    expect(generateStream).toHaveBeenCalledTimes(1)
  })

  it('取消之后不回退、不采用已返回的成功结果', async () => {
    const controller = new AbortController()
    const generateStream = vi.fn().mockImplementation(async () => {
      controller.abort()
      return JSON.stringify(pass)
    })
    const flow = new WriteFlowService({ generateStream } as unknown as LlmService)
    await expect(flow.reviewForeshadowingRepair(input, { signal: controller.signal })).rejects.toThrow('LLM_ABORTED')
    expect(generateStream).toHaveBeenCalledTimes(1)
  })
})
