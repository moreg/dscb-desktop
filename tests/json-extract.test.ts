import { describe, expect, it } from 'vitest'
import { findJsonArray, findJsonObject } from '../src/shared/json-extract'
import { parseMemoryExtractionJson, parseRhythmEvaluationJson } from '../src/shared/parsers'

describe('findJson', () => {
  it('keeps the plain greedy behaviour for clean output', () => {
    expect(findJsonObject('{"a":{"b":1}}')).toEqual({ a: { b: 1 } })
    expect(findJsonArray('[1,[2]]')).toEqual([1, [2]])
  })

  it('skips think blocks, fences and bracketed prose around the JSON', () => {
    const raw = '<think>{草稿}</think>说明 {见下}：\n```json\n{"x":"含 } 的字符串"}\n```\n以上 {完}'
    expect(findJsonObject(raw)).toEqual({ x: '含 } 的字符串' })
    expect(findJsonArray('备注 [P0] 优先：[{"id":1}] 结束')).toEqual([{ id: 1 }])
  })

  it('returns undefined when nothing parses or the shape is wrong', () => {
    expect(findJsonObject('没有 JSON')).toBeUndefined()
    expect(findJsonObject('[1,2]')).toBeUndefined()
    expect(findJsonArray('{"a":1}')).toBeUndefined()
  })
})

describe('parsers tolerate chatty model output', () => {
  it('parses memory extraction wrapped in explanation', () => {
    const body = { newPlotPoints: [], characterStateChanges: [], collectedForeshadowings: [] }
    const raw = `好的，以下是提取结果（{注意}）：\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``
    expect(parseMemoryExtractionJson(raw, 3).parseError).toBeUndefined()
  })

  it('parses rhythm evaluation after a think block containing braces', () => {
    const raw = '<think>{"actualEmotion": "?"}</think>{"actualEmotion": 6, "reason": "对峙"}'
    expect(parseRhythmEvaluationJson(raw, 2, 6)).toMatchObject({ actualEmotion: 6, autoApply: true })
  })
})
