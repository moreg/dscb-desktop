import { describe, it, expect } from 'vitest'
import {
  buildTempRequirementsFromSelfCheck,
  formatSelfCheckDelta,
  selfCheckHasActionableIssues
} from '../src/shared/self-check-to-requirements'
import { evaluateChapterSelfCheck } from '../src/main/data/chapter-self-check'
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
    expect(text).toContain('不强行改成对话或突然动作')
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

  /**
   * 自检是字面比对：只说「核心事件没落地」模型无从下手，
   * 必须把「正文里找不到的子事件」原样列出来。
   */
  it('把未命中的子事件列为待核对，允许已有同义表达', () => {
    const r = report([
      {
        id: 'core_plot',
        category: 'plot',
        label: '本章核心事件有落地',
        verdict: 'fail',
        detail: '核心事件要点只覆盖 1/3',
        missing: ['与邱北因先救还是先取火争执', '旁白分层点出七女登船由头']
      }
    ])
    const text = buildTempRequirementsFromSelfCheck(r, { mode: 'rewrite' })
    expect(text).toContain('待核对的要点')
    expect(text).toContain('可能已有同义表达')
    expect(text).not.toContain('逐条补写')
    expect(text).toContain('「与邱北因先救还是先取火争执」')
    expect(text).toContain('「旁白分层点出七女登船由头」')
  })

  it('无 missing 字段时不多输出一行', () => {
    const r = report([
      {
        id: 'ending_taboo',
        category: 'structure',
        label: '章末无说教',
        verdict: 'fail',
        detail: '章末 AI 味抒怀'
      }
    ])
    expect(buildTempRequirementsFromSelfCheck(r)).not.toContain('正文里找不到这些要点')
  })

  it('null 安全', () => {
    expect(buildTempRequirementsFromSelfCheck(null)).toBe('')
    expect(selfCheckHasActionableIssues(undefined)).toBe(false)
  })

  it('执行失败不应生成修改正文的要求，混合报告只处理正文提示', () => {
    const execution = {
      id: 'self_check_error', category: 'structure' as const, label: '自检执行',
      verdict: 'fail' as const, detail: '读取细纲失败'
    }
    expect(buildTempRequirementsFromSelfCheck(report([execution]))).toBe('')
    expect(selfCheckHasActionableIssues(report([execution]))).toBe(false)
    const mixed = report([execution, {
      id: 'punctuation_rule', category: 'ban', label: '标点守则', verdict: 'warn', detail: '第 1 行有省略号'
    }])
    const text = buildTempRequirementsFromSelfCheck(mixed)
    expect(text).not.toContain('读取细纲失败')
    expect(text).toContain('一键替换标点')
    expect(text).not.toContain('删除抢写')
  })

  it('旧版超限报告仍应压缩，无法确定口径的旧报告先核对完整性', () => {
    const over = report([{
      id: 'word_count', category: 'structure', label: '篇幅符合细纲上限',
      verdict: 'warn', detail: '实际 3600 字，超出细纲上限 3000 字'
    }])
    expect(buildTempRequirementsFromSelfCheck(over)).toContain('压缩重复叙述')
    const old = report([{
      id: 'word_count', category: 'structure', label: '字数参考', verdict: 'warn', detail: '篇幅需要核对'
    }])
    expect(buildTempRequirementsFromSelfCheck(old)).toContain('完整则保留现有长度')
  })

  /**
   * 分轮续写（extend）中间轮：整章本就没写完，完成度项失败是正常状态。
   * 原样灌成「必须」会逼模型下一轮硬收尾——正是分轮续写要避免的。
   */
  describe('partialChapter：本章仍在分轮续写中', () => {
    const partialReport = report([
      {
        id: 'core_plot',
        category: 'plot',
        label: '核心事件已完成',
        verdict: 'fail',
        detail: '未覆盖'
      },
      {
        id: 'due_fb_0',
        category: 'foreshadow',
        label: '到期伏笔回收迹象',
        verdict: 'fail',
        detail: '山本的目的'
      },
      {
        id: 'prev_suspense',
        category: 'continuity',
        label: '上章悬念已回应',
        verdict: 'fail',
        detail: '他到底走不走'
      }
    ])

    it('完成度项降级为「后续」，衔接类仍是「必须」', () => {
      const text = buildTempRequirementsFromSelfCheck(partialReport, {
        mode: 'continue',
        partialChapter: true
      })
      expect(text).toContain('后续·剧情')
      expect(text).toContain('后续·伏笔')
      expect(text).toContain('必须·衔接')
      expect(text).toContain('本章尚未写完')
      expect(text).toContain('不要为了勾掉它们而把本章硬收尾')
    })

    it('完成度项排到最后，本次要落实的项优先占名额', () => {
      const text = buildTempRequirementsFromSelfCheck(partialReport, {
        mode: 'continue',
        partialChapter: true
      })
      expect(text.indexOf('上章悬念已回应')).toBeLessThan(text.indexOf('核心事件已完成'))

      // maxItems 卡到 1 条时留下的是衔接项，不是完成度项
      const only = buildTempRequirementsFromSelfCheck(partialReport, {
        mode: 'continue',
        partialChapter: true,
        maxItems: 1
      })
      expect(only).toContain('上章悬念已回应')
      expect(only).not.toContain('核心事件已完成')
    })

    it('不传 partialChapter 时维持原行为：完成度项仍是「必须」', () => {
      const text = buildTempRequirementsFromSelfCheck(partialReport, { mode: 'continue' })
      expect(text).toContain('必须·剧情')
      expect(text).not.toContain('后续·')
      expect(text).not.toContain('本章尚未写完')
    })
  })
})

describe('自检到修订要求的方向一致性', () => {
  it.each(['rewrite', 'continue'] as const)('到期伏笔可延期，%s 不把提及等同完整回收', (mode) => {
    const r = evaluateChapterSelfCheck({
      chapterNumber: 5, content: '林舟关上房门，吹灭了灯。',
      foreshadowings: [{ content: '玉佩背面的暗纹藏着失踪王子的身份', status: 'planted', expectedCollect: 5 }]
    })
    expect(r.items.find((i) => i.id === 'due_fb_0')?.detail).toContain('合理延期')
    const text = buildTempRequirementsFromSelfCheck(r, { mode })
    expect(text).toContain('因果条件不足可合理延期')
    expect(text).toContain('不能为迎合记录编造回收情节')
    expect(text).not.toContain('不要拖到下章')
    expect(text).not.toContain('到期必收')
  })

  it('核心事件提示核验同义表达，不为匹配词语重写已完成的情节', () => {
    const r = evaluateChapterSelfCheck({ chapterNumber: 1, content: '天色暗了。', plotSummary: '林舟取得密室钥匙' })
    const text = buildTempRequirementsFromSelfCheck(r)
    expect(text).toContain('先核对同义表述')
    expect(text).not.toContain('别整句换成同义说法')
    expect(text).not.toContain('逐条补写')
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
      { id: 'b', category: 'plot', label: '2', verdict: 'pass', detail: '' },
      { id: 'c', category: 'power', label: '3', verdict: 'warn', detail: '' }
    ])
    expect(formatSelfCheckDelta(prev, next)).toMatch(/复检有改善/)
    expect(formatSelfCheckDelta(prev, next)).toContain('2→1')
  })

  it('旧问题被跳过或未再检查，不可报修复成功', () => {
    const prev = report([{ id: 'core_plot', category: 'plot', label: '剧情', verdict: 'fail', detail: '' }])
    const skipped = report([{ id: 'core_plot', category: 'plot', label: '剧情', verdict: 'skip', detail: '细纲缺失' }])
    for (const next of [skipped, report([])]) {
      const text = formatSelfCheckDelta(prev, next)
      expect(text).toContain('此前 1 项问题本次未核验')
      expect(text).not.toContain('复检全部通过')
      expect(text).not.toContain('复检有改善')
    }
  })
})
