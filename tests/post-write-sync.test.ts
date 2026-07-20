import { describe, it, expect } from 'vitest'
import {
  summarizePostWriteSync,
  countPendingConfirms,
  formatSyncErrorHint
} from '../src/shared/post-write-sync'

const emptyApplied = {
  stateChanges: 0,
  plotPoints: 0,
  collected: 0,
  characters: 0,
  locations: 0,
  items: 0,
  foreshadowings: 0
}

describe('summarizePostWriteSync', () => {
  it('ok with auto writes and pending confirms', () => {
    const s = summarizePostWriteSync({
      memory: {
        applied: { ...emptyApplied, stateChanges: 2, plotPoints: 1 },
        errors: []
      },
      settings: { applied: 1, errors: [] },
      extraction: {
        newCharacters: [{ name: '赵乾' }],
        newLocations: [],
        newItems: [],
        newForeshadowings: [],
        settingsPatches: [{ confidence: 'high' }, { confidence: 'medium' }],
        settingsSuggestions: [{ topic: '题材' }]
      }
    })
    expect(s.phase).toBe('ok')
    expect(s.message).toContain('状态 2')
    expect(s.message).toContain('情节 1')
    expect(s.message).toContain('设定 1')
    expect(s.message).toContain('新角色 1')
    expect(s.message).toContain('设定待确认 1')
    expect(s.hasAutoWrites).toBe(true)
    expect(s.hasPendingConfirms).toBe(true)
  })

  it('ok with nothing new', () => {
    const s = summarizePostWriteSync({
      memory: { applied: emptyApplied, errors: [] },
      settings: { applied: 0, errors: [] },
      extraction: {}
    })
    expect(s.phase).toBe('ok')
    expect(s.message).toContain('无新增')
  })

  it('failed when only errors and no writes', () => {
    const s = summarizePostWriteSync({
      memory: { applied: emptyApplied, errors: ['LLM 超时'] },
      settings: { applied: 0, errors: [] },
      extraction: {}
    })
    expect(s.phase).toBe('failed')
    expect(s.message).toMatch(/同步失败/)
    expect(s.message).toContain('LLM 超时')
    expect(s.errors).toEqual(['LLM 超时'])
  })

  it('partial when some writes and errors', () => {
    const s = summarizePostWriteSync({
      memory: {
        applied: { ...emptyApplied, stateChanges: 1 },
        errors: ['角色卡不存在：赵乾']
      },
      settings: { applied: 0, errors: ['路径非法'] },
      extraction: {}
    })
    expect(s.phase).toBe('partial')
    expect(s.message).toContain('部分同步')
    expect(s.message).toContain('状态 1')
    expect(s.errors.length).toBe(2)
  })

  it('appends self-check summary without elevating sync phase when self-check fails', () => {
    const s = summarizePostWriteSync({
      memory: { applied: { ...emptyApplied, plotPoints: 1 }, errors: [] },
      settings: { applied: 0, errors: [] },
      extraction: {},
      selfCheck: {
        ok: false,
        summary: '写后自检未通过：1 项失败（到期伏笔回收迹象）',
        counts: { fail: 1, warn: 0, pass: 3 }
      }
    })
    // 同步本身成功 → phase 仍为 ok；自检结果仅附加在 message
    expect(s.phase).toBe('ok')
    expect(s.message).toContain('情节 1')
    expect(s.message).toContain('写后自检未通过')
  })

  it('keeps ok when self-check passes with warnings', () => {
    const s = summarizePostWriteSync({
      memory: { applied: emptyApplied, errors: [] },
      settings: { applied: 0, errors: [] },
      extraction: {},
      selfCheck: {
        ok: true,
        summary: '写后自检通过（2 项需留意）',
        counts: { fail: 0, warn: 2, pass: 4 }
      }
    })
    expect(s.phase).toBe('ok')
    expect(s.message).toContain('写后自检通过')
  })

  it('ok extract-only pending without auto writes', () => {
    const s = summarizePostWriteSync({
      memory: { applied: emptyApplied, errors: [] },
      settings: { applied: 0, errors: [] },
      extraction: {
        newCharacters: [{ name: 'A' }, { name: 'B' }]
      }
    })
    expect(s.phase).toBe('ok')
    expect(s.message).toMatch(/待确认/)
    expect(s.message).toContain('新角色 2')
  })
})

describe('countPendingConfirms', () => {
  it('counts non-high settings patches as confirm', () => {
    const p = countPendingConfirms({
      settingsPatches: [
        { confidence: 'high' },
        { confidence: 'low' },
        { confidence: 'medium' },
        {}
      ],
      newItems: [{}, {}]
    })
    expect(p.settingsConfirm).toBe(3)
    expect(p.items).toBe(2)
  })
})

describe('formatSyncErrorHint', () => {
  it('joins and truncates', () => {
    expect(formatSyncErrorHint(['a', 'b', 'c'], 2)).toContain('等 3 条')
    expect(formatSyncErrorHint(['x'.repeat(100)], 1).endsWith('…')).toBe(true)
  })
})
