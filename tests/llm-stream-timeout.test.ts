import { describe, it, expect } from 'vitest'
import { resolveStreamTimeoutMs } from '../src/main/data/llm-service'

const TWO_MIN = 120_000
const TEN_MIN = 600_000

describe('resolveStreamTimeoutMs', () => {
  it('正文 feature 一律 10 分钟（含默认 maxTokens=8192 场景）', () => {
    expect(resolveStreamTimeoutMs({ meta: { feature: 'chapter' } })).toBe(TEN_MIN)
    expect(
      resolveStreamTimeoutMs({ meta: { feature: 'chapter' }, maxTokens: 8192 })
    ).toBe(TEN_MIN)
    expect(
      resolveStreamTimeoutMs({ meta: { feature: 'chapter-adjust' }, maxTokens: 4096 })
    ).toBe(TEN_MIN)
  })

  it('maxTokens 恰好 8192 走长超时（修复 > 8192 边界误杀）', () => {
    expect(resolveStreamTimeoutMs({ maxTokens: 8192 })).toBe(TEN_MIN)
    expect(resolveStreamTimeoutMs({ maxTokens: 8193 })).toBe(TEN_MIN)
  })

  it('细纲对照 / 审稿 / 追问等分析类走 10 分钟（避免 Kimi 等慢 API 2 分钟误杀）', () => {
    expect(resolveStreamTimeoutMs({ meta: { feature: 'outlineCheck' } })).toBe(TEN_MIN)
    expect(resolveStreamTimeoutMs({ meta: { feature: 'review' }, maxTokens: 2048 })).toBe(
      TEN_MIN
    )
    expect(resolveStreamTimeoutMs({ meta: { feature: 'ask' } })).toBe(TEN_MIN)
    expect(resolveStreamTimeoutMs({ meta: { feature: 'memoryExtract' } })).toBe(TEN_MIN)
    expect(resolveStreamTimeoutMs({ meta: { feature: 'deslop:cleanup:1' } })).toBe(TEN_MIN)
  })

  it('小请求仍 2 分钟', () => {
    expect(resolveStreamTimeoutMs({})).toBe(TWO_MIN)
    expect(resolveStreamTimeoutMs({ maxTokens: 1024 })).toBe(TWO_MIN)
    expect(resolveStreamTimeoutMs({ meta: { feature: 'styleExtract' } })).toBe(TWO_MIN)
  })
})
