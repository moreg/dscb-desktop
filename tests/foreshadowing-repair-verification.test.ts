import { describe, expect, it, vi } from 'vitest'
import { WriteFlowService } from '../src/main/data/write-flow-service'
import type { LlmService } from '../src/main/data/llm-service'

const inserted = '父亲竟然是被逐出皇宫的三皇子。'
const input = { original: '他拿起信封。\n门外有人敲门。', candidate: `他拿起信封。\n${inserted}\n门外有人敲门。`,
  inserted: [inserted], outline: '只埋信封线索，不揭晓父亲身份', tempContext: '本章父亲身份保密', partialChapter: true }

describe('只核验伏笔新增段落的语义', () => {
  it('passes explicit successful verification and includes author priority and original prose', async () => {
    const generateStream = vi.fn().mockResolvedValue('{"passed":true,"issues":[]}')
    const flow = new WriteFlowService({ generateStream } as unknown as LlmService)
    await expect(flow.verifyForeshadowingRepair(input)).resolves.toBeUndefined()
    const [prompt, opts] = generateStream.mock.calls[0]
    expect(prompt).toContain(input.original)
    expect(prompt).toContain('本章父亲身份保密')
    expect(prompt).toContain('不把原正文已有的问题当成本次补写造成的问题')
    expect(prompt).toContain('本轮尚未收尾')
    expect(opts.meta.feature).toBe('foreshadowRepairVerify')
  })

  it('rejects a new revelation even if general outline checking would return an empty difference list', async () => {
    const generateStream = vi.fn().mockResolvedValue(JSON.stringify({ passed: false,
      issues: [{ message: '提前揭晓父亲身份', evidence: inserted }] }))
    const flow = new WriteFlowService({ generateStream } as unknown as LlmService)
    await expect(flow.verifyForeshadowingRepair(input)).rejects.toThrow('新的剧情偏离：提前揭晓父亲身份')
  })

  it.each(['[]', '{}', '{"passed":true}', '{"passed":false,"issues":[]}',
    '{"passed":true,"issues":[{"message":"矛盾"}]}'])('does not treat malformed verification as a pass: %s', async (raw) => {
    const flow = new WriteFlowService({ generateStream: vi.fn().mockResolvedValue(raw) } as unknown as LlmService)
    await expect(flow.verifyForeshadowingRepair(input)).rejects.toThrow('未返回有效结论')
  })

  it('requires evidence from the inserted prose rather than a paraphrased existing problem', async () => {
    const flow = new WriteFlowService({ generateStream: vi.fn().mockResolvedValue(JSON.stringify({ passed: false,
      issues: [{ message: '原文已有问题', evidence: '他拿起信封。' }] })) } as unknown as LlmService)
    await expect(flow.verifyForeshadowingRepair(input)).rejects.toThrow('缺少新增正文证据')
  })
})
