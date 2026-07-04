import { describe, it, expect } from 'vitest'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import type { LlmService, GenerateOptions } from '../src/main/data/llm-service'

// 测试文本设计：
// - "他不是冷漠，而是绝望" → not-is-comparison（★★★★★，blocking）
// - "他知道，这事没那么简单" → he_knows（★★★★，blocking）—— 用于验证二次清理处理 blocking 残留
// - "仿佛被抽空" → fangfo（★★★，advisory）—— advisory 不触发二次清理
const REAL_TEXT = '他不是冷漠，而是绝望。\n仿佛被抽空了力气，他缓缓坐下。'
// 第一次改写：去掉"不是A而是B"，但故意引入新的 blocking"他知道"（he_knows）
const PARTIAL_TEXT = '绝望先一步泄了出来。\n仿佛被抽空了力气，他缓缓坐下。他知道这件事没那么简单。'
// 第二次清理：去掉"他知道"（blocking）。advisory 的"仿佛"会一起被清掉（因为 LLM 看到也会改）
const CLEAN_TEXT = '绝望先一步泄了出来。\n力气像被抽干，他一屁股坐下。这事没那么简单。'

function makeMockLlm(responses: string[]): LlmService {
  let call = 0
  return {
    generateStream: async (_prompt: string, _opts: GenerateOptions = {}): Promise<string> => {
      const r = responses[Math.min(call, responses.length - 1)]
      call += 1
      return r
    }
  } as unknown as LlmService
}

describe('DeslopService.deslop 二次清理循环', () => {
  it('复扫无 blocking 时跳过二次清理', async () => {
    // 第一次改写直接清干净（无 blocking 残留）
    const cleanNoBlocking = '绝望先一步泄了出来。\n力气像被抽干，他一屁股坐下。'
    const mock = makeMockLlm([
      `【改写后】\n${cleanNoBlocking}\n\n【改动说明】\n- 第1行｜原句：他不是冷漠，而是绝望 → 改后：绝望先一步泄了出来 ｜理由：去掉"不是A而是B"套路`
    ])
    const svc = new DeslopService(mock)
    const result = await svc.deslop(REAL_TEXT)
    expect(result.remainingFindings.filter((f) => f.severity === 'blocking')).toHaveLength(0)
    expect(result.rewritten).toBe(cleanNoBlocking)
  })

  it('第一轮改写后仍剩 blocking 时触发二次清理', async () => {
    // 第一次改写：去掉"不是A而是B"，但引入了新的 blocking"他知道"（he_knows）
    // 第二次清理：把"他知道"也去掉
    const mock = makeMockLlm([
      `【改写后】\n${PARTIAL_TEXT}\n\n【改动说明】\n- 第1行｜原句：他不是冷漠，而是绝望 → 改后：绝望先一步泄了出来 ｜理由：去"不是A而是B"`,
      `【改写后】\n${CLEAN_TEXT}\n\n【改动说明】\n- 第3行｜原句：他知道这件事没那么简单 → 改后：这事没那么简单 ｜理由：去"他知道"告知式表达`
    ])
    const svc = new DeslopService(mock)
    const result = await svc.deslop(REAL_TEXT)
    // 二次清理后 blocking 应清零
    const blocking = result.remainingFindings.filter((f) => f.severity === 'blocking')
    expect(blocking).toHaveLength(0)
    // rewritten 应是二次清理后的文本
    expect(result.rewritten).toBe(CLEAN_TEXT)
  })
})
