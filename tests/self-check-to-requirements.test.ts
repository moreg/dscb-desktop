import { describe, it, expect } from 'vitest'
import {
  buildTempRequirementsFromSelfCheck,
  formatSelfCheckDelta,
  selfCheckHasActionableIssues
} from '../src/shared/self-check-to-requirements'
import type { ChapterSelfCheckReport } from '../src/shared/types'

function report(
  items: ChapterSelfCheckReport['items']
): ChapterSelfCheckReport {
  const counts = { pass: 0, fail: 0, warn: 0, skip: 0 }
  for (const i of items) counts[i.verdict]++
  return {
    schemaVersion: 1,
    chapterNumber: 5,
    generatedAt: new Date().toISOString(),
    counts,
    items,
    ok: counts.fail === 0,
    summary: counts.fail ? '未通过' : '通过'
  }
}

describe('buildTempRequirementsFromSelfCheck', () => {
  it('无问题项返回空串', () => {
    const r = report([
      {
        id: 'ending_form',
        category: 'structure',
        label: '章末形态',
        verdict: 'pass',
        detail: 'ok'
      }
    ])
    expect(buildTempRequirementsFromSelfCheck(r)).toBe('')
    expect(selfCheckHasActionableIssues(r)).toBe(false)
  })

  it('rewrite 模式包含必须项与改法', () => {
    const r = report([
      {
        id: 'ending_form',
        category: 'structure',
        label: '章末以对话或事件收束',
        verdict: 'fail',
        detail: '章末最后几段未见对话'
      },
      {
        id: 'due_fb_0',
        category: 'foreshadow',
        label: '到期伏笔回收迹象',
        verdict: 'fail',
        detail: '山本一夫的真正目的'
      },
      {
        id: 'power_bound',
        category: 'power',
        label: '金手指边界',
        verdict: 'warn',
        detail: '预知未来'
      }
    ])
    const text = buildTempRequirementsFromSelfCheck(r, { mode: 'rewrite' })
    expect(selfCheckHasActionableIssues(r)).toBe(true)
    expect(text).toContain('按写后自检修订第 5 章')
    expect(text).toContain('必须·结构')
    expect(text).toContain('章末')
    expect(text).toContain('改法：')
    expect(text).toContain('对话')
    expect(text).toContain('到期伏笔')
    expect(text).toContain('建议·金手指')
    expect(text).toContain('完整本章正文')
  })

  it('continue 模式文案不同且可 only fail', () => {
    const r = report([
      {
        id: 'core_plot',
        category: 'plot',
        label: '核心事件',
        verdict: 'fail',
        detail: '未覆盖'
      },
      {
        id: 'char_position',
        category: 'continuity',
        label: '位置',
        verdict: 'warn',
        detail: '瞬移'
      }
    ])
    const cont = buildTempRequirementsFromSelfCheck(r, { mode: 'continue' })
    expect(cont).toContain('补写要求')
    expect(cont).toContain('核心事件')

    const failOnly = buildTempRequirementsFromSelfCheck(r, {
      mode: 'rewrite',
      includeWarn: false
    })
    expect(failOnly).toContain('核心事件')
    expect(failOnly).not.toContain('位置')
  })

  it('null 安全', () => {
    expect(buildTempRequirementsFromSelfCheck(null)).toBe('')
    expect(selfCheckHasActionableIssues(undefined)).toBe(false)
  })
})

describe('formatSelfCheckDelta', () => {
  it('无 previous 时用 summary', () => {
    const next = report([])
    next.summary = '写后自检通过（3 项）'
    expect(formatSelfCheckDelta(null, next)).toBe('写后自检通过（3 项）')
  })

  it('失败清零时提示全部通过', () => {
    const prev = report([
      {
        id: 'a',
        category: 'structure',
        label: 'x',
        verdict: 'fail',
        detail: ''
      }
    ])
    const next = report([
      {
        id: 'a',
        category: 'structure',
        label: 'x',
        verdict: 'pass',
        detail: ''
      }
    ])
    next.summary = '写后自检通过（1 项）'
    expect(formatSelfCheckDelta(prev, next)).toMatch(/复检全部通过/)
    expect(formatSelfCheckDelta(prev, next)).toContain('失败 1')
  })

  it('数量下降提示有改善', () => {
    const prev = report([
      { id: 'a', category: 'plot', label: '1', verdict: 'fail', detail: '' },
      { id: 'b', category: 'plot', label: '2', verdict: 'fail', detail: '' },
      { id: 'c', category: 'power', label: '3', verdict: 'warn', detail: '' }
    ])
    const next = report([
      { id: 'a', category: 'plot', label: '1', verdict: 'fail', detail: '' },
      { id: 'c', category: 'power', label: '3', verdict: 'warn', detail: '' }
    ])
    expect(formatSelfCheckDelta(prev, next)).toMatch(/复检有改善/)
    expect(formatSelfCheckDelta(prev, next)).toContain('2→1')
  })
})
