import { describe, it, expect, vi } from 'vitest'
import {
  WriteFlowService,
  parseEndingStateJson,
  parseOutlineDiffJson
} from '../src/main/data/write-flow-service'
import { parseRhythmEvaluationJson } from '../src/shared/parsers'
import type { LlmService } from '../src/main/data/llm-service'

function mockLlm(reply: string): LlmService {
  return { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
}

describe('WriteFlowService.extractEndingState', () => {
  it('parses structured ending state from LLM JSON', async () => {
    const json = JSON.stringify({
      characterPositions: [{ name: '林远', location: '客栈', action: '正在打坐' }],
      characterStates: [{ name: '林远', emotion: '警觉', body: '轻伤', items: '长剑' }],
      timePoint: '深夜',
      unfinished: ['门外脚步声未确认'],
      suspense: '门外传来脚步声',
      props: ['师父留下的玉佩']
    })
    const svc = new WriteFlowService(mockLlm(json))
    const state = await svc.extractEndingState('上一章末尾原文…', 5)
    expect(state.characterPositions[0].name).toBe('林远')
    expect(state.timePoint).toBe('深夜')
    expect(state.suspense).toBe('门外传来脚步声')
    expect(state.props).toContain('师父留下的玉佩')
  })

  it('falls back to rawTail when LLM output is not JSON', async () => {
    const svc = new WriteFlowService(mockLlm('这不是 JSON'))
    const state = await svc.extractEndingState('原文尾段', 3)
    expect(state.rawTail).toBe('原文尾段')
    expect(state.characterPositions).toEqual([])
  })

  it('returns empty state for empty prevTail', async () => {
    const svc = new WriteFlowService(mockLlm(''))
    const state = await svc.extractEndingState('', 1)
    expect(state.characterPositions).toEqual([])
    expect(state.suspense).toBe('')
  })
})

describe('parseEndingStateJson', () => {
  it('extracts JSON from markdown code block wrapper', () => {
    const raw = '```json\n{"timePoint":"清晨","suspense":"门开了"}\n```'
    const state = parseEndingStateJson(raw, 2, 'tail')
    expect(state.timePoint).toBe('清晨')
  })
})

describe('WriteFlowService.checkOutlineStream', () => {
  it('parses 5-type diff report from LLM JSON', async () => {
    const json = JSON.stringify([
      {
        type: 1,
        typeLabel: '漏写',
        outline: '主角与NPC对话',
        actual: undefined,
        suggestion: '补写对话',
        priority: 'P1'
      },
      {
        type: 2,
        typeLabel: '超纲增量',
        outline: undefined,
        actual: '新角色青云子',
        suggestion: '追加到角色卡',
        priority: 'P2'
      }
    ])
    const svc = new WriteFlowService(mockLlm(json))
    const raw = await svc.checkOutlineStream('细纲', '正文', 5)
    const report = parseOutlineDiffJson(raw, 5)
    expect(report.diffs).toHaveLength(2)
    expect(report.diffs[0].type).toBe(1)
    expect(report.diffs[0].typeLabel).toBe('漏写')
    expect(report.diffs[1].type).toBe(2)
    expect(report.passed).toBe(false)
  })

  it('returns passed=true for empty array', () => {
    const report = parseOutlineDiffJson('[]', 3)
    expect(report.passed).toBe(true)
    expect(report.diffs).toEqual([])
  })

  it('returns passed=true when only P2 diffs', () => {
    const raw = JSON.stringify([
      { type: 3, typeLabel: '细节调整', suggestion: '可保留', priority: 'P2' }
    ])
    const report = parseOutlineDiffJson(raw, 7)
    expect(report.diffs).toHaveLength(1)
    expect(report.passed).toBe(true)
  })

  it('falls back to empty diffs on parse failure', () => {
    const report = parseOutlineDiffJson('not json', 9)
    expect(report.diffs).toEqual([])
    expect(report.passed).toBe(true)
  })

  it('normalizes invalid priority to P2', () => {
    const raw = JSON.stringify([
      { type: 4, typeLabel: '核心事件改', suggestion: '重写', priority: 'P9' }
    ])
    const report = parseOutlineDiffJson(raw, 4)
    expect(report.diffs[0].priority).toBe('P2')
  })

  it('parses outlinePatch for update-outline path', () => {
    const raw = JSON.stringify([
      {
        type: 3,
        typeLabel: '细节调整',
        outline: '客栈',
        actual: '酒楼',
        suggestion: '以正文更新细纲',
        priority: 'P2',
        resolution: 'either',
        outlinePatch: { plotSummary: '主角在酒楼遇见故人' }
      }
    ])
    const report = parseOutlineDiffJson(raw, 2)
    expect(report.diffs[0].resolution).toBe('either')
    expect(report.diffs[0].outlinePatch?.plotSummary).toBe('主角在酒楼遇见故人')
  })
})

describe('WriteFlowService.evaluateRhythmStream', () => {
  it('parses rhythm evaluation with expected+actual emotion', async () => {
    const json = JSON.stringify({
      expectedEmotion: 7,
      actualEmotion: 7.5,
      reason: '打斗场面紧凑，主角反败为胜'
    })
    const svc = new WriteFlowService(mockLlm(json))
    const raw = await svc.evaluateRhythmStream('正文…', 5, 7)
    const eval_ = parseRhythmEvaluationJson(raw, 5, 7)
    expect(eval_).not.toBeNull()
    expect(eval_!.actualEmotion).toBe(7.5)
    expect(eval_!.expectedEmotion).toBe(7)
    expect(eval_!.diff).toBeCloseTo(0.5, 1)
    expect(eval_!.autoApply).toBe(true) // diff ≤ 1
  })

  it('marks autoApply=false when diff > 1', () => {
    const raw = JSON.stringify({
      expectedEmotion: 8,
      actualEmotion: 5,
      reason: '节奏平淡'
    })
    const eval_ = parseRhythmEvaluationJson(raw, 3, 8)
    expect(eval_).not.toBeNull()
    expect(eval_!.diff).toBe(3)
    expect(eval_!.autoApply).toBe(false)
  })

  it('clamps actualEmotion to 0-10', () => {
    const raw = JSON.stringify({
      expectedEmotion: 5,
      actualEmotion: 15,
      reason: '超高分'
    })
    const eval_ = parseRhythmEvaluationJson(raw, 1, 5)
    expect(eval_!.actualEmotion).toBe(10)
  })

  it('uses fallback expectedEmotion when LLM omits it', () => {
    const raw = JSON.stringify({
      actualEmotion: 6,
      reason: '一般'
    })
    const eval_ = parseRhythmEvaluationJson(raw, 2, 5)
    expect(eval_!.expectedEmotion).toBe(5)
    expect(eval_!.diff).toBe(1)
    expect(eval_!.autoApply).toBe(true)
  })

  it('returns null on parse failure', () => {
    expect(parseRhythmEvaluationJson('not json', 1, 5)).toBeNull()
  })

  it('returns null when actualEmotion missing', () => {
    const raw = JSON.stringify({ expectedEmotion: 5, reason: '无实际值' })
    expect(parseRhythmEvaluationJson(raw, 1, 5)).toBeNull()
  })
})
