import { describe, it, expect } from 'vitest'
import {
  buildFallbackOutlinePatch,
  buildOutlinePatchFromDiff,
  canUpdateOutlineFromDiff,
  collectOutlinePatchesFromDiffs,
  defaultResolutionForType,
  formatOutlinePatchPreview,
  isRecommendedOutlineUpdate,
  mergeOutlinePatches,
  needsConfirmOutlineUpdate,
  recomputeOutlineDiffPassed,
  sanitizeOutlinePatch
} from '../src/shared/outline-diff-apply'
import type { OutlineDiffItem } from '../src/shared/types'
import { parseOutlineDiffJson } from '../src/shared/parsers'

function mk(partial: Partial<OutlineDiffItem> & Pick<OutlineDiffItem, 'type' | 'typeLabel'>): OutlineDiffItem {
  return {
    suggestion: '',
    priority: 'P2',
    ...partial
  }
}

describe('outline-diff-apply helpers', () => {
  it('type 1 cannot update outline; type 2/3 recommended', () => {
    const miss = mk({ type: 1, typeLabel: '漏写' })
    const extra = mk({ type: 2, typeLabel: '超纲增量', actual: '青云子' })
    const detail = mk({ type: 3, typeLabel: '细节调整', actual: '地点改成客栈' })
    expect(canUpdateOutlineFromDiff(miss)).toBe(false)
    expect(canUpdateOutlineFromDiff(extra)).toBe(true)
    expect(isRecommendedOutlineUpdate(extra)).toBe(true)
    expect(isRecommendedOutlineUpdate(detail)).toBe(true)
    expect(isRecommendedOutlineUpdate(miss)).toBe(false)
  })

  it('type 4/5 need confirm', () => {
    expect(needsConfirmOutlineUpdate(mk({ type: 4, typeLabel: '核心事件改' }))).toBe(true)
    expect(needsConfirmOutlineUpdate(mk({ type: 5, typeLabel: '结构性偏离' }))).toBe(true)
    expect(needsConfirmOutlineUpdate(mk({ type: 2, typeLabel: '超纲增量' }))).toBe(false)
  })

  it('defaultResolutionForType matches policy', () => {
    expect(defaultResolutionForType(1)).toBe('updateContent')
    expect(defaultResolutionForType(2)).toBe('updateOutline')
    expect(defaultResolutionForType(3)).toBe('either')
    expect(defaultResolutionForType(4)).toBe('review')
  })

  it('sanitizeOutlinePatch drops empty and normalizes lists', () => {
    expect(sanitizeOutlinePatch(null)).toBeUndefined()
    const p = sanitizeOutlinePatch({
      title: '  新标题  ',
      plotSummary: '',
      charactersAppearing: ['甲', '甲', ' 乙 '],
      foreshadowings: '伏笔A、伏笔B'
    })
    expect(p).toEqual({
      title: '新标题',
      charactersAppearing: ['甲', '乙'],
      foreshadowings: ['伏笔A', '伏笔B']
    })
  })

  it('type2 short pure name → characters; plot phrases → plotSummary', () => {
    expect(buildFallbackOutlinePatch(mk({ type: 2, typeLabel: '超纲增量', actual: '青云子' }))).toEqual({
      charactersAppearing: ['青云子']
    })
    expect(
      buildFallbackOutlinePatch(mk({ type: 2, typeLabel: '超纲增量', actual: '新角色：林远、赵乾' }))
    ).toEqual({ charactersAppearing: ['林远', '赵乾'] })

    // 短情节短语不得误判为角色
    expect(
      buildFallbackOutlinePatch(mk({ type: 2, typeLabel: '超纲增量', actual: '地点改成酒楼' }), {
        plotSummary: '进城'
      })
    ).toEqual({ plotSummary: '进城；另（正文增量）：地点改成酒楼' })
    expect(
      buildFallbackOutlinePatch(mk({ type: 2, typeLabel: '超纲增量', actual: '酒楼见故人' }), {
        plotSummary: '进城'
      })
    ).toEqual({ plotSummary: '进城；另（正文增量）：酒楼见故人' })
  })

  it('type3/4 short delta appends instead of clobbering plotSummary', () => {
    expect(
      buildFallbackOutlinePatch(
        mk({ type: 3, typeLabel: '细节调整', actual: '客栈→酒楼' }),
        { plotSummary: '主角在客栈遇见故人并获悉密信' }
      )
    ).toEqual({
      plotSummary: '主角在客栈遇见故人并获悉密信；正文调整：客栈→酒楼'
    })

    expect(
      buildFallbackOutlinePatch(
        mk({ type: 4, typeLabel: '核心事件改', actual: '反派先动手' }),
        { plotSummary: '主角在酒楼对峙反派并当众打脸' }
      )
    ).toEqual({
      plotSummary: '主角在酒楼对峙反派并当众打脸；正文调整：反派先动手'
    })

    // 无现有核心事件时可用 actual 作为全文
    expect(
      buildFallbackOutlinePatch(mk({ type: 4, typeLabel: '核心事件改', actual: '反派先动手' }))
    ).toEqual({ plotSummary: '反派先动手' })
  })

  it('buildOutlinePatchFromDiff prefers LLM patch and unions list fields', () => {
    const diff = mk({
      type: 2,
      typeLabel: '超纲增量',
      actual: '应被忽略的兜底',
      outlinePatch: { charactersAppearing: ['青云子'] }
    })
    const patch = buildOutlinePatchFromDiff(diff, {
      charactersAppearing: ['林远']
    })
    expect(patch).toEqual({ charactersAppearing: ['林远', '青云子'] })
  })

  it('mergeOutlinePatches: later string wins, lists union', () => {
    const merged = mergeOutlinePatches([
      { plotSummary: '旧', charactersAppearing: ['甲'] },
      { plotSummary: '新', charactersAppearing: ['乙'], hook: '钩子' }
    ])
    expect(merged).toEqual({
      plotSummary: '新',
      charactersAppearing: ['甲', '乙'],
      hook: '钩子'
    })
  })

  it('collectOutlinePatchesFromDiffs sequential plotSummary keeps both increments', () => {
    const items = [
      {
        index: 0,
        diff: mk({
          type: 2,
          typeLabel: '超纲增量',
          actual: '后山发现残破玉简'
        })
      },
      {
        index: 1,
        diff: mk({
          type: 2,
          typeLabel: '超纲增量',
          actual: '玉简上有古篆'
        })
      }
    ]
    const result = collectOutlinePatchesFromDiffs(items, { plotSummary: '进城' })
    expect(result.appliedIndexes).toEqual([0, 1])
    expect(result.skippedIndexes).toEqual([])
    expect(result.merged.plotSummary).toBe(
      '进城；另（正文增量）：后山发现残破玉简；另（正文增量）：玉简上有古篆'
    )
  })

  it('collectOutlinePatchesFromDiffs only marks indexes with patches', () => {
    const items = [
      {
        index: 0,
        diff: mk({ type: 2, typeLabel: '超纲增量', actual: '青云子' })
      },
      {
        index: 1,
        diff: mk({ type: 2, typeLabel: '超纲增量' }) // no actual, no patch
      },
      {
        index: 2,
        diff: mk({ type: 1, typeLabel: '漏写', outline: '漏了钩子' })
      }
    ]
    const result = collectOutlinePatchesFromDiffs(items, { charactersAppearing: ['林远'] })
    expect(result.appliedIndexes).toEqual([0])
    expect(result.skippedIndexes).toEqual([1, 2])
    expect(result.merged.charactersAppearing).toEqual(['林远', '青云子'])
  })

  it('formatOutlinePatchPreview shows before/after', () => {
    const text = formatOutlinePatchPreview(
      { plotSummary: '旧事件', charactersAppearing: ['甲'] },
      { plotSummary: '新事件', charactersAppearing: ['甲', '乙'] }
    )
    expect(text).toContain('核心事件')
    expect(text).toContain('前：旧事件')
    expect(text).toContain('后：新事件')
    expect(text).toContain('角色出场')
  })

  it('recomputeOutlineDiffPassed ignores resolved P0/P1', () => {
    const diffs: OutlineDiffItem[] = [
      mk({ type: 1, typeLabel: '漏写', priority: 'P0' }),
      mk({ type: 2, typeLabel: '超纲增量', priority: 'P2' })
    ]
    expect(recomputeOutlineDiffPassed(diffs, [])).toBe(false)
    expect(recomputeOutlineDiffPassed(diffs, [0])).toBe(true)
  })
})

describe('parseOutlineDiffJson outlinePatch/resolution', () => {
  it('parses resolution and outlinePatch via sanitize', () => {
    const raw = JSON.stringify([
      {
        type: 2,
        typeLabel: '超纲增量',
        actual: '青云子',
        suggestion: '以正文更新细纲',
        priority: 'P2',
        resolution: 'updateOutline',
        outlinePatch: {
          charactersAppearing: ['青云子', '青云子'],
          plotSummary: '见青云子'
        }
      }
    ])
    const report = parseOutlineDiffJson(raw, 3)
    expect(report.diffs).toHaveLength(1)
    expect(report.diffs[0].resolution).toBe('updateOutline')
    expect(report.diffs[0].outlinePatch).toEqual({
      charactersAppearing: ['青云子'],
      plotSummary: '见青云子'
    })
  })

  it('fills default resolution when invalid or missing', () => {
    const raw = JSON.stringify([
      { type: 3, typeLabel: '细节调整', suggestion: 'x', priority: 'P2', resolution: 'nope' },
      { type: 1, typeLabel: '漏写', suggestion: '补', priority: 'P1' }
    ])
    const report = parseOutlineDiffJson(raw, 1)
    expect(report.diffs[0].resolution).toBe('either')
    expect(report.diffs[1].resolution).toBe('updateContent')
  })
})
