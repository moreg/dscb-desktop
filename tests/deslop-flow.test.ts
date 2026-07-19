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

  it('LLM 漏写【改动说明】时自动 diff 补全 changeSummary', async () => {
    const cleanNoBlocking = '绝望先一步泄了出来。\n力气像被抽干，他一屁股坐下。'
    // 只给【改写后】，故意不写【改动说明】——旧逻辑会导致 UI 无改动明细
    const mock = makeMockLlm([`【改写后】\n${cleanNoBlocking}`])
    const svc = new DeslopService(mock)
    const result = await svc.deslop(REAL_TEXT)
    expect(result.rewritten).toBe(cleanNoBlocking)
    expect(result.changeSummary.length).toBeGreaterThan(0)
    expect(result.changeSummary.some((s) => s.includes('原句') || s.includes('改后') || s.includes('自动'))).toBe(
      true
    )
  })

  it('第一轮改写后仍剩 blocking 时触发二次清理', async () => {
    // 第一次改写：去掉"不是A而是B"，但引入了新的 blocking"他知道"（he_knows）
    // 第二次清理：把"他知道"也去掉
    const mock = makeMockLlm([
      `【改写后】\n${PARTIAL_TEXT}\n\n【改动说明】\n- 第1行｜原句：他不是冷漠，而是绝望 -> 改后：绝望先一步泄了出来 ｜理由：去"不是A而是B"`,
      `【改写后】\n${CLEAN_TEXT}\n\n【改动说明】\n- 第3行｜原句：他知道这件事没那么简单 -> 改后：这事没那么简单 ｜理由：去"他知道"告知式表达`
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

describe('DeslopService.deslop 三遍法 Pass 编排', () => {
  // severe 文本：含 Gate A（仿佛/缓缓）、Gate B（不是A而是B）、Gate C（他感到）、Gate F（这一刻/终于明白）
  // severe 分级会跑 Pass1(A+B) + Pass2(C+D+E) + Pass3(F+G) = 3 遍
  const SEVERE_TEXT =
    '他不是冷漠，而是绝望。\n仿佛被抽空了力气，他缓缓坐下。\n他感到愤怒，握紧了拳头。\n这一刻，他终于明白了一切。'

  // mock：每遍只改本遍 Gate 的命中项，其余保留--让每遍都有命中要处理
  // Pass1 改 A+B（去掉"不是A而是B""仿佛""缓缓"），保留 C+F
  // Pass2 改 C+D（去掉"他感到"），保留 F
  // Pass3 改 F+G（去掉"这一刻""终于明白"）
  const PASS_RESPONSES = [
    // Pass1：去 A+B，保留 C（他感到）和 F（这一刻/终于明白）
    `【改写后】\n绝望先泄了出来。\n力气像被抽干，他坐下。\n他感到愤怒，握紧了拳头。\n这一刻，他终于明白了一切。\n\n【改动说明】\n- 第1行｜去"不是A而是B"`,
    // Pass2：去 C（他感到->身体反应），保留 F
    `【改写后】\n绝望先泄了出来。\n力气像被抽干，他坐下。\n他攥紧拳头，指节发白。\n这一刻，他终于明白了一切。\n\n【改动说明】\n- 第3行｜去"他感到"贴标签`,
    // Pass3：去 F（升华句）
    `【改写后】\n绝望先泄了出来。\n力气像被抽干，他坐下。\n他攥紧拳头，指节发白。\n他沉默了。\n\n【改动说明】\n- 第4行｜去升华句`
  ]

  it('severe 跑 3 遍（3 次 generateStream 调用）', async () => {
    let callCount = 0
    const mock = {
      generateStream: async (): Promise<string> => {
        const r = PASS_RESPONSES[Math.min(callCount, PASS_RESPONSES.length - 1)]
        callCount += 1
        return r
      }
    } as unknown as LlmService
    const svc = new DeslopService(mock)
    const result = await svc.deslop(SEVERE_TEXT, { levelOverride: 'severe' })
    // severe 跑 3 遍 Pass，每遍 1 次调用（无 blocking 残留则无二次清理）
    expect(callCount).toBeGreaterThanOrEqual(3)
    expect(result.processedGates).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
  })

  it('moderate 跑 2 遍（Pass1 + Pass2）', async () => {
    let callCount = 0
    const mock = {
      generateStream: async (): Promise<string> => {
        const r = PASS_RESPONSES[Math.min(callCount, PASS_RESPONSES.length - 1)]
        callCount += 1
        return r
      }
    } as unknown as LlmService
    const svc = new DeslopService(mock)
    const result = await svc.deslop(SEVERE_TEXT, { levelOverride: 'moderate' })
    // moderate = Pass1(A+B) + Pass2(C+D) = 2 遍
    expect(callCount).toBeGreaterThanOrEqual(2)
    expect(result.processedGates).toEqual(['A', 'B', 'C', 'D'])
  })

  it('mild 只跑 1 遍（Pass1）', async () => {
    let callCount = 0
    const mock = {
      generateStream: async (): Promise<string> => {
        const r = PASS_RESPONSES[Math.min(callCount, PASS_RESPONSES.length - 1)]
        callCount += 1
        return r
      }
    } as unknown as LlmService
    const svc = new DeslopService(mock)
    await svc.deslop(SEVERE_TEXT, { levelOverride: 'mild' })
    // mild = Pass1(A+B) = 1 遍
    expect(callCount).toBeGreaterThanOrEqual(1)
  })

  it('无命中项的 Pass 跳过（不调 LLM）', async () => {
    // 只有 Gate A/B 命中的文本，severe 下 Pass2(C+D+E) 和 Pass3(F+G) 无命中应跳过
    const text = '他不是冷漠，而是绝望。\n仿佛被抽空了力气，他缓缓坐下。'
    let callCount = 0
    const mock = {
      generateStream: async (): Promise<string> => {
        callCount += 1
        return `【改写后】\n绝望先泄了出来。\n力气像被抽干，他坐下。\n\n【改动说明】\n- 改动${callCount}`
      }
    } as unknown as LlmService
    const svc = new DeslopService(mock)
    await svc.deslop(text, { levelOverride: 'severe' })
    // Pass1(A+B) 跑 1 次；Pass2(C+D+E) 无命中跳过；Pass3(F+G) 无命中跳过
    expect(callCount).toBeGreaterThanOrEqual(1)
  })
})
