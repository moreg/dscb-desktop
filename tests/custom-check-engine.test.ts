import { describe, it, expect } from 'vitest'
import { runCustomAlgorithmChecks } from '../src/main/data/custom-check-engine'
import type { AuditViolation, CustomReviewCheck } from '../src/shared/types'

describe('runCustomAlgorithmChecks', () => {
  it('keyword 类型：命中词表即报，带 offset/snippet', () => {
    const checks: CustomReviewCheck[] = [
      {
        id: 'custom_cliche',
        label: '我的禁用词',
        hint: '',
        severity: 'warn',
        type: 'keyword',
        group: 'toxic',
        keywords: ['居然', '竟然'],
        enabled: true
      }
    ]
    const out: AuditViolation[] = []
    runCustomAlgorithmChecks('他居然笑了，竟然哭了', checks, out)
    expect(out.length).toBe(2)
    expect(out[0].ruleId).toBe('custom_cliche')
    expect(out[0].category).toBe('toxic')
    expect(out[0].severity).toBe('warn')
    expect(out[0].word).toBe('居然')
    expect(out[0].offset).toBe(1)
    expect(out[0].snippet).toContain('居然')
  })

  it('keyword 类型：关闭（enabled=false）不跑', () => {
    const checks: CustomReviewCheck[] = [
      {
        id: 'custom_x',
        label: '',
        hint: '',
        severity: 'warn',
        type: 'keyword',
        group: 'toxic',
        keywords: ['a'],
        enabled: false
      }
    ]
    const out: AuditViolation[] = []
    runCustomAlgorithmChecks('aaa', checks, out)
    expect(out).toEqual([])
  })

  it('keyword 类型：同词多次命中上限 5 条', () => {
    const checks: CustomReviewCheck[] = [
      {
        id: 'custom_x',
        label: '',
        hint: '',
        severity: 'warn',
        type: 'keyword',
        group: 'toxic',
        keywords: ['哈'],
        enabled: true
      }
    ]
    const out: AuditViolation[] = []
    runCustomAlgorithmChecks('哈哈哈哈哈哈哈哈哈哈哈', checks, out)
    expect(out.length).toBeLessThanOrEqual(5)
  })

  it('regex 类型：命中正则即报', () => {
    const checks: CustomReviewCheck[] = [
      {
        id: 'custom_re',
        label: '',
        hint: '',
        severity: 'error',
        type: 'regex',
        group: 'quality',
        pattern: '——[一-龥]——',
        enabled: true
      }
    ]
    const out: AuditViolation[] = []
    runCustomAlgorithmChecks('他——啊——走了', checks, out)
    expect(out.length).toBe(1)
    expect(out[0].ruleId).toBe('custom_re')
    expect(out[0].severity).toBe('error')
  })

  it('regex 类型：非法正则跳过不抛错', () => {
    const checks: CustomReviewCheck[] = [
      {
        id: 'custom_bad',
        label: '',
        hint: '',
        severity: 'warn',
        type: 'regex',
        group: 'quality',
        pattern: '[unclosed',
        enabled: true
      }
    ]
    const out: AuditViolation[] = []
    expect(() => runCustomAlgorithmChecks('任意文本', checks, out)).not.toThrow()
    expect(out).toEqual([])
  })

  it('regex 类型：同匹配多次命中上限 5 条', () => {
    const checks: CustomReviewCheck[] = [
      {
        id: 'custom_re',
        label: '',
        hint: '',
        severity: 'info',
        type: 'regex',
        group: 'quality',
        pattern: '!',
        enabled: true
      }
    ]
    const out: AuditViolation[] = []
    runCustomAlgorithmChecks('!!!!!!!!!!', checks, out)
    expect(out.length).toBeLessThanOrEqual(5)
  })

  it('llm 类型项被算法引擎忽略（不在算法引擎跑）', () => {
    const checks: CustomReviewCheck[] = [
      {
        id: 'custom_llm',
        label: '',
        hint: '',
        severity: 'warn',
        type: 'llm',
        group: 'llm_review',
        prompt: '检查X',
        enabled: true
      }
    ]
    const out: AuditViolation[] = []
    runCustomAlgorithmChecks('任意文本', checks, out)
    expect(out).toEqual([])
  })

  it('空 checks / 空文本不报错', () => {
    const out: AuditViolation[] = []
    runCustomAlgorithmChecks('', [], out)
    expect(out).toEqual([])
  })
})
