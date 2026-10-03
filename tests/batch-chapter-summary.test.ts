import { describe, expect, it } from 'vitest'
import {
  describeAutoDeslopCell,
  describeMemoryCell,
  describeOutlineCell,
  describeSelfCheckCell,
  hasChapterIssue,
  summarizeChapterResult
} from '../src/renderer/src/ChapterListPage'
import type {
  AuditViolation,
  ChapterFlowResult,
  ChapterSelfCheckReport,
  MemoryApplyResult,
  OutlineDiffItem
} from '../src/shared/types'

interface MakeOpts {
  violations?: AuditViolation[]
  diffs?: OutlineDiffItem[]
  hasOutline?: boolean
  checked?: boolean
  selfCheck?: ChapterSelfCheckReport | null
  memoryApply?: MemoryApplyResult
  /** 新角色：属于「待确认新增」，自动同步永远不写 */
  newCharacters?: number
  /** 情节点：属于自动写入的候选 */
  newPlotPoints?: number
}

function makeResult(chapter: number, content: string, opts: MakeOpts = {}): ChapterFlowResult {
  const violations = opts.violations ?? []
  const diffs = opts.diffs ?? []
  return {
    chapterNumber: chapter,
    content,
    audit: {
      schemaVersion: 1,
      wordCount: content.length,
      passed: { ending: true, forbiddenWords: violations.length === 0, wordCount: true },
      counts: {
        error: violations.filter((v) => v.severity === 'error').length,
        warn: violations.filter((v) => v.severity === 'warn').length,
        info: 0
      },
      violations
    },
    outlineDiff: {
      chapterNumber: chapter,
      diffs,
      passed: diffs.length === 0,
      hasOutline: opts.hasOutline,
      checked: opts.checked
    },
    memory: {
      chapterNumber: chapter,
      newCharacters: Array.from({ length: opts.newCharacters ?? 0 }, (_, i) => ({
        name: `角色${i}`,
        role: '配角',
        identity: '路人',
        personality: '沉默'
      })),
      newLocations: [],
      newItems: [],
      newForeshadowings: [],
      newPlotPoints: Array.from({ length: opts.newPlotPoints ?? 0 }, (_, i) => ({
        title: `情节${i}`,
        event: '发生了什么',
        evidence: '正文原句'
      })),
      characterStateChanges: [],
      collectedForeshadowings: []
    },
    memoryApply: opts.memoryApply,
    rhythm: null,
    figure: {
      chapterNumber: chapter,
      shouldGenerate: false,
      type: '',
      topic: '',
      fileName: '',
      html: '',
      reason: '未执行'
    },
    selfCheck: opts.selfCheck
  }
}

function forbidden(offset: number, word: string, severity: 'error' | 'warn'): AuditViolation {
  return { category: 'forbidden_word', severity, message: `禁用词：${word}`, offset, word }
}

function diff(priority: 'P0' | 'P1' | 'P2'): OutlineDiffItem {
  return { type: 1, typeLabel: '漏写', suggestion: '补写', priority }
}

function selfCheck(fail: number, warn: number, failedLabels: string[] = []): ChapterSelfCheckReport {
  return {
    schemaVersion: 1,
    chapterNumber: 1,
    generatedAt: '2026-09-13T00:00:00.000Z',
    counts: { pass: 5, fail, warn, skip: 0 },
    items: failedLabels.map((label, i) => ({
      id: `item-${i}`,
      category: 'continuity',
      label,
      verdict: 'fail' as const,
      detail: ''
    })),
    ok: fail === 0,
    summary: ''
  }
}

/** 自动写入计数：applyAutomatic 只会填 plotPoints / stateChanges / collected */
function applied(plotPoints: number, confirmedCharacters = 0): MemoryApplyResult['applied'] {
  return {
    characters: confirmedCharacters,
    locations: 0,
    items: 0,
    foreshadowings: 0,
    plotPoints,
    stateChanges: 0,
    collected: 0
  }
}

describe('批量续写逐章小结', () => {
  it('违禁词按 offset 前缀重叠去重后再计数', () => {
    // 同一 offset 上「轰」被「轰然」覆盖，只该算一条，与质检面板展示一致
    const s = summarizeChapterResult(
      makeResult(3, '一'.repeat(2000), {
        violations: [forbidden(10, '轰', 'error'), forbidden(10, '轰然', 'error')]
      })
    )
    expect(s.chapter).toBe(3)
    expect(s.words).toBe(2000)
    expect(s.auditError).toBe(1)
    expect(s.auditWarn).toBe(0)
  })

  it('只数 P0 细纲差异，P1/P2 不计入', () => {
    const s = summarizeChapterResult(
      makeResult(4, '正文', {
        diffs: [diff('P0'), diff('P1'), diff('P2'), diff('P0')],
        hasOutline: true,
        checked: true
      })
    )
    expect(s.p0).toBe(2)
    expect(describeOutlineCell(s)).toBe('细纲 P0 2 项')
  })

  it.each(['failed', 'review_required'] as const)('自动去 AI 味 %s 的章节明确列入待处理小结', (status) => {
    const result = makeResult(5, '保留的生成原稿')
    result.autoDeslop = { status, message: '自动去 AI 味未采用候选，已保留生成原稿', remainingIssues: 2 }
    const summary = summarizeChapterResult(result)
    expect(summary.autoDeslop).toEqual(result.autoDeslop)
    expect(hasChapterIssue(summary)).toBe(true)
    expect(describeAutoDeslopCell(summary)).toBe(result.autoDeslop.message)
  })

  it('恢复写后检查不把缺少本次润色报告判为未执行或失败', () => {
    const summary = summarizeChapterResult(makeResult(5, '已精修正文'))
    expect(describeAutoDeslopCell(summary)).toBe('本次未重新润色')
    expect(hasChapterIssue(summary)).toBe(false)
  })

  it('error 或 P0 判为需返工，纯 warn 不算', () => {
    const warnOnly = summarizeChapterResult(
      makeResult(5, '正文', { violations: [forbidden(0, '仿佛', 'warn')] })
    )
    expect(warnOnly.auditWarn).toBe(1)
    expect(hasChapterIssue(warnOnly)).toBe(false)

    const withError = summarizeChapterResult(
      makeResult(6, '正文', { violations: [forbidden(0, '仿佛', 'error')] })
    )
    expect(hasChapterIssue(withError)).toBe(true)

    const withP0 = summarizeChapterResult(makeResult(7, '正文', { diffs: [diff('P0')] }))
    expect(hasChapterIssue(withP0)).toBe(true)

    const clean = summarizeChapterResult(makeResult(8, '正文', { diffs: [diff('P2')] }))
    expect(hasChapterIssue(clean)).toBe(false)
  })

  describe('细纲状态', () => {
    it('没细纲时说「无细纲可对照」，不说无 P0', () => {
      const s = summarizeChapterResult(makeResult(9, '正文', { hasOutline: false, checked: false }))
      expect(s.outline).toBe('none')
      expect(describeOutlineCell(s)).toBe('无细纲可对照')
      // 没得对照不算这一章写坏了，不进返工名单（只在抬头单独提示）
      expect(hasChapterIssue(s)).toBe(false)
    })

    it('有细纲但对照没跑成时说「未完成」', () => {
      const s = summarizeChapterResult(makeResult(10, '正文', { hasOutline: true, checked: false }))
      expect(s.outline).toBe('failed')
      expect(describeOutlineCell(s)).toBe('细纲对照未完成')
    })

    it('对照跑成且无 P0 才说「细纲无 P0」', () => {
      const s = summarizeChapterResult(makeResult(11, '正文', { hasOutline: true, checked: true }))
      expect(s.outline).toBe('checked')
      expect(describeOutlineCell(s)).toBe('细纲无 P0')
    })
  })

  describe('写后自检', () => {
    it('未执行与通过要分开说', () => {
      const none = summarizeChapterResult(makeResult(12, '正文'))
      expect(none.selfCheck).toBeNull()
      expect(describeSelfCheckCell(none)).toBe('自检未执行')

      const pass = summarizeChapterResult(makeResult(13, '正文', { selfCheck: selfCheck(0, 0) }))
      expect(describeSelfCheckCell(pass)).toBe('自检通过')
    })

    it('自检未过判为需返工，并带上未过项名称', () => {
      const s = summarizeChapterResult(
        makeResult(14, '正文', { selfCheck: selfCheck(2, 1, ['篇幅达标', '章末钩子']) })
      )
      expect(s.selfCheck?.failedItems).toEqual(['篇幅达标', '章末钩子'])
      expect(describeSelfCheckCell(s)).toBe('自检 2 项未过')
      expect(hasChapterIssue(s)).toBe(true)
    })

    it('只有提醒时不判返工', () => {
      const s = summarizeChapterResult(makeResult(15, '正文', { selfCheck: selfCheck(0, 3) }))
      expect(describeSelfCheckCell(s)).toBe('自检 3 项提醒')
      expect(hasChapterIssue(s)).toBe(false)
    })
  })

  describe('记忆同步', () => {
    it('实际写入失败不能当作无新记忆或同步通过', () => {
      const summary = summarizeChapterResult(makeResult(1, '正文', {
        memoryApply: { applied: applied(0), errors: ['记忆文件写入失败'] }
      }))
      expect(describeMemoryCell(summary)).toBe('记忆同步失败 1 项（已写入 0/0 条）')
      expect(hasChapterIssue(summary)).toBe(true)
    })

    it('设定同步失败进入需要处理的章节列表', () => {
      const result = makeResult(1, '正文')
      result.settingsApply = { applied: 0, skipped: 0, errors: ['设定文件写入失败'], appliedDiffs: [] }
      expect(hasChapterIssue(summarizeChapterResult(result))).toBe(true)
    })

    it('待核对时如实说「未写入」并判返工', () => {
      // 回归：面板此前显示的是提取到的候选数，用户会误以为已经进库
      const s = summarizeChapterResult(
        makeResult(16, '正文', {
          newPlotPoints: 2,
          memoryApply: { applied: applied(0), errors: [], reviewRequired: ['证据不足'] }
        })
      )
      expect(s.memory.candidates).toBe(2)
      expect(s.memory.applied).toBe(0)
      expect(describeMemoryCell(s)).toBe('整章记忆待核对 1 项，未写入')
      expect(hasChapterIssue(s)).toBe(true)
    })

    it('正文已变导致未写入时判返工', () => {
      const s = summarizeChapterResult(
        makeResult(17, '正文', {
          newPlotPoints: 1,
          memoryApply: { applied: applied(0), errors: [], superseded: true }
        })
      )
      expect(describeMemoryCell(s)).toBe('记忆未写入（正文已变）')
      expect(hasChapterIssue(s)).toBe(true)
    })

    it('写入成功时报「写入数/候选数」', () => {
      const s = summarizeChapterResult(
        makeResult(18, '正文', {
          newPlotPoints: 2,
          memoryApply: { applied: applied(2), errors: [] }
        })
      )
      expect(describeMemoryCell(s)).toBe('记忆写入 2/2 条')
      expect(hasChapterIssue(s)).toBe(false)
    })

    it('同步关闭（有候选但一条没写）与没有新记忆要分开说', () => {
      const disabled = summarizeChapterResult(
        makeResult(19, '正文', {
          newPlotPoints: 3,
          memoryApply: { applied: applied(0), errors: [] }
        })
      )
      expect(describeMemoryCell(disabled)).toBe('记忆提取 3 条，未写入')

      const nothing = summarizeChapterResult(
        makeResult(20, '正文', { memoryApply: { applied: applied(0), errors: [] } })
      )
      expect(describeMemoryCell(nothing)).toBe('无新记忆')

      const notRun = summarizeChapterResult(makeResult(21, '正文', { newPlotPoints: 1 }))
      expect(describeMemoryCell(notRun)).toBe('记忆同步未执行')
    })

    /**
     * 新角色/新地点/新道具/新伏笔按设计要作者确认，applyAutomatic 里这四项恒为 0。
     * 旧口径把它们算进分母，于是每章都显示成「记忆写入 6/18」——12 条看着像丢了，
     * 其实一半是待确认、根本没轮到写。
     */
    describe('待确认新增不算进写入分数', () => {
      it('分母只数自动可写的条目，新增实体单独报', () => {
        const s = summarizeChapterResult(
          makeResult(22, '正文', {
            newPlotPoints: 2,
            newCharacters: 3,
            memoryApply: { applied: applied(2), errors: [] }
          })
        )
        expect(s.memory.candidates).toBe(2)
        expect(s.memory.applied).toBe(2)
        expect(s.memory.pending).toBe(3)
        expect(describeMemoryCell(s)).toBe('记忆写入 2/2 条，待确认新增 3 项')
      })

      it('只有新增实体时不说「无新记忆」，也不说写入 0', () => {
        const s = summarizeChapterResult(
          makeResult(23, '正文', {
            newCharacters: 2,
            memoryApply: { applied: applied(0), errors: [] }
          })
        )
        expect(s.memory.candidates).toBe(0)
        expect(describeMemoryCell(s)).toBe('待确认新增 2 项')
        // 待确认不是返工理由
        expect(hasChapterIssue(s)).toBe(false)
      })

      it('已确认写入的新增实体从待办里扣掉并展示已入库实体数', () => {
        const s = summarizeChapterResult(
          makeResult(24, '正文', {
            newPlotPoints: 1,
            newCharacters: 2,
            memoryApply: { applied: applied(1, 2), errors: [] }
          })
        )
        expect(s.memory.pending).toBe(0)
        expect(s.memory.appliedEntities).toBe(2)
        expect(describeMemoryCell(s)).toBe('记忆写入 1/1 条，已自动入库 2 项新实体')
      })

      it('开启 autoStrength 时保留传入的 strengthSuggestion', () => {
        const suggestion = {
          effort: 'high' as const,
          tier: 'High' as const,
          temperature: 1.0,
          reason: '爽点 3 级大高潮，放开写'
        }
        const s = summarizeChapterResult(makeResult(26, '正文'), suggestion)
        expect(s.strengthSuggestion).toEqual(suggestion)
      })

      it('证据不足与待确认新增同时出现时分开说', () => {
        const s = summarizeChapterResult(
          makeResult(25, '正文', {
            newPlotPoints: 3,
            newCharacters: 1,
            memoryApply: { applied: applied(2), errors: [], heldBack: ['情节「虚构」：缺少可定位的正文原文依据'] }
          })
        )
        expect(describeMemoryCell(s)).toBe('记忆写入 2/3 条，1 项证据不足未写入，待确认新增 1 项')
      })
    })
  })
})
