import { describe, expect, it } from 'vitest'
import { normalizeMemoryEvidence, resolveMemoryEvidence, validateMemoryCandidate } from '../src/main/data/memory-evidence-validator'
import { parseMemoryExtractionJson } from '../src/shared/parsers'

function candidate(evidence: string) {
  return parseMemoryExtractionJson(JSON.stringify({ newPlotPoints: [{ title: '行军', event: '全团绕城', evidence }],
    characterStateChanges: [], collectedForeshadowings: [] }), 1)
}

describe('记忆引用格式兼容', () => {
  it('识别叙述片段外额外添加的引号，并保存实际原文', () => {
    const content = '参谋长将行军路线改到河西，绕开县城。'
    const input = candidate('“将行军路线改到河西”')
    const normalized = normalizeMemoryEvidence(content, input)
    expect(normalized.newPlotPoints[0].evidence).toBe('将行军路线改到河西')
    expect(input.newPlotPoints[0].evidence).toBe('“将行军路线改到河西”')
    expect(validateMemoryCandidate(content, normalized)).toEqual([])
  })

  it('保留完整台词的原有引号，也识别台词中的连续片段', () => {
    const content = '“全团绕城，沿西河走，天黑前扎营。”'
    expect(resolveMemoryEvidence(content, content)).toBe(content)
    expect(resolveMemoryEvidence(content, '“全团绕城，沿西河走”')).toBe('全团绕城，沿西河走')
  })

  it('不接受改写、短词、残缺引号或不存在的证据', () => {
    const content = '参谋长将行军路线改到河西，绕开县城。'
    for (const evidence of ['“参谋长把行军路线改到河西”', '“参谋长”', '“将行军路线改到河西', '“全团已经安全进城”']) {
      expect(resolveMemoryEvidence(content, evidence)).toBeUndefined()
      expect(validateMemoryCandidate(content, candidate(evidence))[0]).toContain('正文原文依据')
    }
  })

  it('去除引用包装后仍检查完整上下文中的否定和计划', () => {
    for (const content of ['参谋长没有将行军路线改到河西。', '参谋长打算将行军路线改到河西。']) {
      const result = validateMemoryCandidate(content, candidate('“将行军路线改到河西”'))
      expect(result[0]).toContain('否定、计划或不确定')
    }
  })

  it('区分已观察的物证与明确转入的后续猜测，不豁免证据内的否定', () => {
    const content = '两枚扣子的缺口朝向相同，这是唯一的物证，再往下猜，便没有凭据了。'
    expect(validateMemoryCandidate(content, candidate('“两枚扣子的缺口朝向相同”'))).toEqual([])
    expect(validateMemoryCandidate(content, candidate('再往下猜，便没有凭据了。'))[0]).toContain('不确定')
    const negated = '两枚扣子的缺口朝向并未相同，再往下猜，便没有凭据了。'
    expect(validateMemoryCandidate(negated, candidate('两枚扣子的缺口朝向并未相同'))[0]).toContain('否定')
    const qualified = '两枚扣子的缺口朝向相同，可能只是巧合。'
    expect(validateMemoryCandidate(qualified, candidate('两枚扣子的缺口朝向相同'))[0]).toContain('不确定')
  })
})
