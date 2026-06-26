import { describe, it, expect, vi } from 'vitest'
import {
  ReviewFlowService,
  parseFindingsJson
} from '../src/main/data/review-flow-service'
import type { LlmService } from '../src/main/data/llm-service'
import type { ReviewCheckId } from '../src/shared/types'

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

  it('falls back to empty array when not JSON', () => {
    expect(parseFindingsJson('这不是JSON', 'logic_hole')).toEqual([])
  })

  it('falls back to empty array when findings missing', () => {
    expect(parseFindingsJson('{"other":1}', 'logic_hole')).toEqual([])
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
    expect(parseFindingsJson(raw, 'logic_hole')).toHaveLength(1)
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
    // 8 个 LLM 检查各调一次
    expect((llm.generateStream as ReturnType<typeof vi.fn>).mock.calls.length).toBe(8)
    expect(out.length).toBe(8)
    expect(out.every((v) => v.category === 'llm_review')).toBe(true)
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
    // logic_hole 失败兜底空，hook_grade 成功
    expect(out).toHaveLength(1)
    expect(out[0].ruleId).toBe('hook_grade')
  })
})
