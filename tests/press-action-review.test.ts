import { describe, it, expect } from 'vitest'
import { pressActionReviewFindings } from '../src/main/data/deslop/press-action-review'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import { buildSystemPrompt, buildHumanizerPrompt } from '../src/main/data/skill-prompts'
import { PRESS_ACTION_RULES } from '../src/main/data/skill-prompts/action-precision'
import type { LlmService } from '../src/main/data/llm-service'

describe('press action context review', () => {
  it.each([undefined, 'extend', 'finish'] as const)('shares rules with writing in %s mode', (mode) => {
    expect(buildSystemPrompt(undefined, null, undefined, null, mode)).toContain(PRESS_ACTION_RULES)
    expect(buildHumanizerPrompt(undefined, '动作表达', '江述把欠款单压在签名栏上。')).toContain(PRESS_ACTION_RULES)
  })
  it('reviews unclear signature placement and repeated action verbs', () => {
    expect(pressActionReviewFindings('江述把欠款单压在签名栏上。')).toHaveLength(1)
    expect(pressActionReviewFindings('他压住纸。\n她压下声音。\n他把杯子压在桌上。')).toHaveLength(3)
    expect(pressActionReviewFindings('屋里的压力很大，血压需要测量，文件已经压缩。')).toHaveLength(0)
    expect(pressActionReviewFindings('他用石头压住纸，免得被风吹走。')).toHaveLength(0)
  })
  it('does not treat distant actions as one repeated scene', () => {
    const prose = ['他压住纸。', ...Array.from({ length: 20 }, () => '他走到了门外。'), '她压下声音。', ...Array.from({ length: 20 }, () => '她走进院子。'), '他压住信。'].join('\n')
    expect(pressActionReviewFindings(prose)).toHaveLength(0)
  })
  it('runs targeted editing even without banned words, allowing legitimate uses to remain', async () => {
    const source = '江述把欠款单压在责任书的签名栏上。'
    const prompts: string[] = []
    const service = new DeslopService({ generateStream: async (prompt: string) => {
      prompts.push(prompt)
      return `【改写后】\n${source}\n\n【改动说明】\n无需修改`
    } } as unknown as LlmService)
    const result = await service.deslop(source, { isTail: false })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(PRESS_ACTION_RULES)
    expect(prompts[0]).toContain(source)
    expect(result.rewritten).toBe(source)
    expect(result.remainingFindings).toHaveLength(0)
    expect(result.processedGates).toContain('C')
  })
})
