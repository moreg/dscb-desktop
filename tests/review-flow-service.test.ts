import { describe, it, expect, vi } from 'vitest'
import {
  ReviewFlowService,
  parseFindingsJson
} from '../src/main/data/review-flow-service'
import type { LlmService } from '../src/main/data/llm-service'
import type { ReviewCheckId } from '../src/shared/types'
import type { DeepReviewContext } from '../src/main/data/review-flow-service'

function mockLlm(reply: string): LlmService {
  return { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
}

/** mockLlm 变体：按 checkId 返回不同回复（靠 prompt 含 checkId 区分） */
function mockLlmByCheck(replies: Partial<Record<ReviewCheckId, string>>): LlmService {
  return {
    generateStream: vi.fn((prompt: string) => {
      const hit = (Object.keys(replies) as ReviewCheckId[]).find((c) =>
        prompt.includes(`"${c}"`)
      )
      return Promise.resolve(hit ? replies[hit]! : '{"findings":[]}')
    })
  } as unknown as LlmService
}

describe('parseFindingsJson', () => {
  it('parses valid findings array', () => {
    const raw = JSON.stringify({
      findings: [
        {
          checkId: 'logic_hole',
          severity: 'error',
          message: '时间线矛盾',
          snippet: '昨夜…今日清晨',
          offset: 120,
          suggestion: '补充时间过渡'
        }
      ]
    })
    const out = parseFindingsJson(raw, 'logic_hole')
    expect(out).toHaveLength(1)
    expect(out[0].checkId).toBe('logic_hole')
    expect(out[0].severity).toBe('error')
    expect(out[0].offset).toBe(120)
  })

  it('reports an incomplete review when not JSON', () => {
    expect(parseFindingsJson('这不是JSON', 'logic_hole')[0]).toMatchObject({
      checkId: 'review_incomplete:logic_hole', severity: 'warn'
    })
  })

  it('reports missing findings instead of pretending the review passed', () => {
    expect(parseFindingsJson('{"other":1}', 'logic_hole')[0].message).toContain('未完成')
    expect(parseFindingsJson('{"findings":[]}', 'logic_hole')).toEqual([])
  })

  it('normalizes invalid severity to warn', () => {
    const raw = JSON.stringify({
      findings: [{ checkId: 'logic_hole', severity: 'critical', message: '问题' }]
    })
    expect(parseFindingsJson(raw, 'logic_hole')[0].severity).toBe('warn')
  })

  it('drops findings without message', () => {
    const raw = JSON.stringify({
      findings: [
        { checkId: 'logic_hole', severity: 'warn', message: '' },
        { checkId: 'logic_hole', severity: 'warn', message: '有内容' }
      ]
    })
    const result = parseFindingsJson(raw, 'logic_hole')
    expect(result).toHaveLength(2)
    expect(result[0].message).toBe('有内容')
    expect(result[1].checkId).toBe('review_incomplete:logic_hole')
  })

  it('extracts JSON from surrounding markdown/noise', () => {
    const raw = '好的，以下是结果：\n```json\n{"findings":[{"checkId":"hook_grade","severity":"warn","message":"钩子弱"}]}\n```'
    expect(parseFindingsJson(raw, 'hook_grade')).toHaveLength(1)
  })
})

describe('ReviewFlowService.runDeepReview', () => {
  it('runs only enabled LLM checks and returns llm_review violations', async () => {
    const svc = new ReviewFlowService(
      mockLlmByCheck({
        logic_hole: JSON.stringify({
          findings: [
            { checkId: 'logic_hole', severity: 'error', message: '逻辑矛盾', offset: 50 }
          ]
        })
      })
    )
    const out = await svc.runDeepReview('正文…', {
      chapterNumber: 1,
      enabledChecks: ['logic_hole', 'character_breakdown']
    })
    expect(out).toHaveLength(1)
    expect(out[0].category).toBe('llm_review')
    expect(out[0].ruleId).toBe('logic_hole')
    expect(out[0].severity).toBe('error')
  })

  it('runs all LLM checks when enabledChecks empty/undefined', async () => {
    const llm = mockLlm(
      JSON.stringify({
        findings: [{ checkId: 'hook_grade', severity: 'info', message: '钩子强' }]
      })
    )
    const svc = new ReviewFlowService(llm)
    const out = await svc.runDeepReview('正文…', { chapterNumber: 1 })
    // 9 个 LLM 检查各调一次
    expect((llm.generateStream as ReturnType<typeof vi.fn>).mock.calls.length).toBe(9)
    expect(out.length).toBe(9)
    expect(out.every((v) => v.category === 'llm_review')).toBe(true)
  })

  it('checks premature reveals against the outline and prior reader knowledge', async () => {
    const llm = mockLlmByCheck({
      spoiler: JSON.stringify({ findings: [{
        checkId: 'spoiler', severity: 'error', message: '身份在揭晓节点前被说破', snippet: '他其实是魔王'
      }] })
    })
    const content = '他其实是魔王。门外有人敲门。'
    const out = await new ReviewFlowService(llm).runDeepReview(content, {
      chapterNumber: 2,
      enabledChecks: ['spoiler'],
      outline: '第 2 章末才揭晓身份。',
      continuityContext: '前章读者尚不知道他的真实身份。'
    })
    const prompt = vi.mocked(llm.generateStream).mock.calls[0][0]
    expect(prompt).toContain('第 2 章末才揭晓身份')
    expect(prompt).toContain('前章读者尚不知道他的真实身份')
    expect(out[0]).toMatchObject({ ruleId: 'spoiler', severity: 'error', offset: 0 })
  })

  it('filters out algorithm-class checkIds (only LLM checks run)', async () => {
    const svc = new ReviewFlowService(
      mockLlm('{"findings":[]}')
    )
    const out = await svc.runDeepReview('正文…', {
      chapterNumber: 1,
      enabledChecks: ['meta_break', 'dash_fragment', 'logic_hole'] as ReviewCheckId[]
    })
    // 只 logic_hole 是 LLM 类，应只调一次
    expect(out).toEqual([])
  })

  it('one check failure does not abort others', async () => {
    const llm = {
      generateStream: vi.fn((prompt: string) => {
        if (prompt.includes('"logic_hole"')) return Promise.reject(new Error('boom'))
        return Promise.resolve(
          JSON.stringify({
            findings: [
              { checkId: 'hook_grade', severity: 'warn', message: '钩子弱' }
            ]
          })
        )
      })
    } as unknown as LlmService
    const svc = new ReviewFlowService(llm)
    const out = await svc.runDeepReview('正文…', {
      chapterNumber: 1,
      enabledChecks: ['logic_hole', 'hook_grade']
    })
    expect(out).toHaveLength(2)
    expect(out[0].ruleId).toBe('review_incomplete:logic_hole')
    expect(out[0].suggestion).toContain('重试')
    expect(out[1].ruleId).toBe('hook_grade')
  })

  it('covers the whole chapter with overlap and restores offsets for findings after character 6000', async () => {
    const marker = '已经死亡的角色又站起来了'
    const content = '甲'.repeat(5700) + '边界证据。' + '乙'.repeat(800) + marker + '丙'.repeat(3000)
    const bodies: string[] = []
    const llm = { generateStream: vi.fn(async (prompt: string) => {
      const body = prompt.split('## 本章正文（本次送检片段）\n')[1]
      bodies.push(body)
      return JSON.stringify({ findings: body.includes(marker)
        ? [{ message: '人物状态前后冲突', snippet: marker, offset: body.indexOf(marker), severity: 'error' }]
        : [] })
    }) } as unknown as LlmService
    const out = await new ReviewFlowService(llm).runDeepReview(content, {
      chapterNumber: 2, enabledChecks: ['character_breakdown']
    })
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toContain('边界证据。')
    expect(bodies[1]).toContain('边界证据。')
    expect(bodies[1].endsWith('丙'.repeat(3000))).toBe(true)
    expect(out[0].offset).toBe(content.indexOf(marker))
  })

  it('reviews the real ending and injects continuity evidence plus the continuation boundary', async () => {
    const llm = mockLlm('{"findings":[]}')
    await new ReviewFlowService(llm).runDeepReview('开头标记' + '甲'.repeat(6500) + '真正的章末', {
      chapterNumber: 2, enabledChecks: ['hook_grade'], continuityContext: '上章林舟已受伤。', continuationStart: 6200
    })
    const prompt = vi.mocked(llm.generateStream).mock.calls[0][0]
    expect(prompt).toContain('真正的章末')
    expect(prompt).not.toContain('开头标记')
    expect(prompt).toContain('上章林舟已受伤。')
    expect(prompt).toContain('6200')
    expect(prompt).toContain('真实章末')
    expect(vi.mocked(llm.generateStream)).toHaveBeenCalledTimes(1)
  })

  it('deduplicates findings from overlapping review blocks by their source location', async () => {
    const marker = '重复的证据就在交界处'
    const content = '甲'.repeat(5500) + marker + '乙'.repeat(2000)
    const llm = mockLlm(JSON.stringify({ findings: [{ message: '冲突', snippet: marker, severity: 'warn' }] }))
    const result = await new ReviewFlowService(llm).runDeepReview(content, { chapterNumber: 1, enabledChecks: ['character_breakdown'] })
    expect(vi.mocked(llm.generateStream)).toHaveBeenCalledTimes(2)
    expect(result).toHaveLength(1)
    expect(result[0].offset).toBe(5500)
  })

  it('does not run disabled checks, and exposes malformed provider output', async () => {
    const llm = mockLlm('看起来没有问题')
    const svc = new ReviewFlowService(llm)
    expect(await svc.runDeepReview('正文。', { chapterNumber: 1, enabledChecks: [] })).toEqual([])
    expect(llm.generateStream).not.toHaveBeenCalled()
    const result = await svc.runDeepReview('正文。', { chapterNumber: 1, enabledChecks: ['logic_hole'] })
    expect(result[0].ruleId).toBe('review_incomplete:logic_hole')
  })

  it.each([9022, 40000])('compares distant facts in one complete consistency check at %i characters', async (length) => {
    const earlier = '林舟的左手已被斩断。'
    const later = '林舟用左手握紧长刀。'
    const content = earlier + '甲'.repeat(length - earlier.length - later.length) + later
    const llm = mockLlm(JSON.stringify({ findings: [{
      message: '断手后未交代恢复便用左手持刀', snippet: later, severity: 'error'
    }] }))
    const result = await new ReviewFlowService(llm).runDeepReview(content, {
      chapterNumber: 10, enabledChecks: ['logic_hole']
    })
    expect(llm.generateStream).toHaveBeenCalledTimes(1)
    const prompt = vi.mocked(llm.generateStream).mock.calls[0][0]
    expect(prompt).toContain(earlier)
    expect(prompt).toContain(later)
    expect(result[0].offset).toBe(content.indexOf(later))
  })

  it('discloses that cross-block consistency remains unverified above the full chapter limit', async () => {
    const llm = mockLlm('{"findings":[]}')
    const result = await new ReviewFlowService(llm).runDeepReview('甲'.repeat(40001), {
      chapterNumber: 10, enabledChecks: ['logic_hole']
    })
    expect(vi.mocked(llm.generateStream).mock.calls.length).toBeGreaterThan(1)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ ruleId: 'review_incomplete:cross_chunk', severity: 'warn' })
    expect(result[0].suggestion).toContain('不能视为全章一致性通过')
  })
})

describe('ReviewFlowService memory cache', () => {
  const context: DeepReviewContext = { chapterNumber: 3, enabledChecks: ['logic_hole'], continuityContext: '钥匙已归还。' }
  function cacheableLlm(reply = '{"findings":[]}'): LlmService {
    return { generateStream: vi.fn().mockResolvedValue(reply), getCacheIdentity: vi.fn().mockResolvedValue('route-1') } as unknown as LlmService
  }

  it('reuses a completed review and returns copies so UI edits cannot mutate cached findings', async () => {
    const llm = cacheableLlm('{"findings":[{"message":"钥匙归属矛盾","severity":"warn"}]}')
    const service = new ReviewFlowService(llm)
    const first = await service.runDeepReview('钥匙仍在他手中。', context)
    first[0].message = '用户临时改动'
    first.push({ category: 'llm_review', severity: 'info', message: '临时增加' })
    const cached = await service.runDeepReview('钥匙仍在他手中。', context)
    expect(llm.generateStream).toHaveBeenCalledTimes(1)
    expect(cached).toHaveLength(1)
    expect(cached[0].message).toBe('钥匙归属矛盾')
  })

  it('binds complete prose, historical context, check instructions, options and model route', async () => {
    const llm = cacheableLlm()
    const service = new ReviewFlowService(llm)
    await service.runDeepReview('正文A', context)
    await service.runDeepReview('正文B', context)
    await service.runDeepReview('正文A', { ...context, continuityContext: '钥匙并未归还。' })
    await service.runDeepReview('正文A', { ...context, characterCards: '人物现在谨慎' })
    await service.runDeepReview('正文A', { ...context, continuationStart: 2 })
    await service.runDeepReview('正文A', { ...context, customLlmChecks: [
      { id: 'custom_test', type: 'llm', enabled: true, label: '检查所有权', hint: '', group: 'llm_review', severity: 'warn', prompt: '检查钥匙所有权' }
    ] })
    await service.runDeepReview('正文A', context, { systemPrompt: '只报有证据的问题', maxTokens: 999 })
    vi.mocked(llm.getCacheIdentity).mockResolvedValue('route-2')
    await service.runDeepReview('正文A', context)
    expect(llm.generateStream).toHaveBeenCalledTimes(9)
  })

  it('coalesces simultaneous identical reviews without sharing cancellation or token callbacks', async () => {
    const llm = cacheableLlm()
    let finish!: (value: string) => void
    vi.mocked(llm.generateStream).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const service = new ReviewFlowService(llm)
    const first = service.runDeepReview('正文。', context)
    const second = service.runDeepReview('正文。', context)
    await vi.waitFor(() => expect(llm.generateStream).toHaveBeenCalledTimes(1))
    finish('{"findings":[]}')
    expect(await first).toEqual([])
    expect(await second).toEqual([])
    const controller = new AbortController()
    await service.runDeepReview('正文。', context, { signal: controller.signal })
    await service.runDeepReview('正文。', context, { onToken: vi.fn() })
    expect(llm.generateStream).toHaveBeenCalledTimes(3)
  })

  it('does not cache malformed, failed, partial or unknown-route reviews', async () => {
    const llm = cacheableLlm('这不是JSON')
    const service = new ReviewFlowService(llm)
    await service.runDeepReview('正文。', context)
    await service.runDeepReview('正文。', context)
    expect(llm.generateStream).toHaveBeenCalledTimes(2)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.mocked(llm.generateStream).mockRejectedValueOnce(new Error('network'))
      await service.runDeepReview('正文。', context)
      vi.mocked(llm.generateStream).mockResolvedValue('{"findings":[]}')
      await service.runDeepReview('正文。', context)
      expect(llm.generateStream).toHaveBeenCalledTimes(4)
    } finally { warn.mockRestore() }
    vi.mocked(llm.getCacheIdentity).mockResolvedValue(null)
    await service.runDeepReview('正文。', context)
    await service.runDeepReview('正文。', context)
    expect(llm.generateStream).toHaveBeenCalledTimes(6)
  })

  it('expires after five minutes and evicts the least recently used entry beyond sixteen', async () => {
    let now = 1_000_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const llm = cacheableLlm()
      const service = new ReviewFlowService(llm)
      await service.runDeepReview('正文0', context)
      now += 300_001
      await service.runDeepReview('正文0', context)
      expect(llm.generateStream).toHaveBeenCalledTimes(2)
      for (let i = 1; i <= 16; i++) await service.runDeepReview(`正文${i}`, context)
      await service.runDeepReview('正文16', context)
      expect(llm.generateStream).toHaveBeenCalledTimes(18)
      await service.runDeepReview('正文0', context)
      expect(llm.generateStream).toHaveBeenCalledTimes(19)
    } finally { clock.mockRestore() }
  })

  it('does not save a result if the model route changed while the review was running', async () => {
    const llm = cacheableLlm()
    const route = vi.mocked(llm.getCacheIdentity)
    route.mockResolvedValueOnce('before').mockResolvedValueOnce('after').mockResolvedValue('before')
    const service = new ReviewFlowService(llm)
    await service.runDeepReview('正文。', context)
    await service.runDeepReview('正文。', context)
    expect(llm.generateStream).toHaveBeenCalledTimes(2)
  })
})
