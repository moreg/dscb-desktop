import { describe, it, expect } from 'vitest'
import {
  evaluateChapterSelfCheck,
  extractKeywords
} from '../src/main/data/chapter-self-check'

describe('extractKeywords', () => {
  it('抽出核心名词片段', () => {
    const kws = extractKeywords('林远当众击败赵乾，立下赌约')
    expect(kws.some((k) => k.includes('林远') || k.includes('赵乾') || k.includes('击败'))).toBe(
      true
    )
  })
})

describe('evaluateChapterSelfCheck', () => {
  it('空正文 fail', () => {
    const r = evaluateChapterSelfCheck({ chapterNumber: 1, content: '' })
    expect(r.ok).toBe(false)
    expect(r.counts.fail).toBeGreaterThan(0)
  })

  it('合格正文：对话章末 + 核心事件关键词', () => {
    const content = Array(5)
      .fill('林远走进山门，赵乾挡在面前。')
      .join('\n')
    const ending = `林远一剑挑开赵乾的长刀。\n赵乾惨叫一声跪倒在地。\n"你输了。"林远收剑。\n门外脚步声骤起。`
    const r = evaluateChapterSelfCheck({
      chapterNumber: 2,
      content: content + '\n' + ending,
      plotSummary: '林远当众击败赵乾，立下赌约',
      prevEndingState: {
        chapterNumber: 1,
        characterPositions: [{ name: '林远', location: '山门', action: '拔剑' }],
        characterStates: [],
        timePoint: '黄昏',
        unfinished: [],
        suspense: '山门阴影里站着谁',
        props: []
      }
    })
    expect(r.counts.fail).toBe(0)
    expect(r.ok).toBe(true)
    expect(r.summary).toMatch(/通过/)
  })

  it('章末无对话事件 → ending_form fail', () => {
    const r = evaluateChapterSelfCheck({
      chapterNumber: 1,
      content: '他想了很多。\n人生就是这样。\n或许这就是命运。\n他明白了一个道理。'
    })
    expect(r.ok).toBe(false)
    const ending = r.items.find((i) => i.id === 'ending_form' || i.id === 'ending_taboo')
    expect(ending?.verdict).toBe('fail')
  })

  it('到期伏笔无关键词 → fail', () => {
    const r = evaluateChapterSelfCheck({
      chapterNumber: 5,
      content:
        '苏九收了摊，回了沈家院子。\n"今天就到这儿。"\n他闩上门，靠在墙上睡着了。',
      foreshadowings: [
        {
          content: '山本一夫的真正目的是寻找改变国运的奇人',
          status: 'planted',
          expectedCollect: 5
        }
      ]
    })
    const due = r.items.find((i) => i.id.startsWith('due_fb'))
    expect(due?.verdict).toBe('fail')
    expect(r.ok).toBe(false)
  })

  it('能力越权套话 → warn', () => {
    const r = evaluateChapterSelfCheck({
      chapterNumber: 3,
      content:
        '苏九转动罗盘，顿时预知未来三年后的战局。\n"完了。"他说。\n门外突然传来脚步声。',
      powerBoundaryBullets: ['只能看到当日运势，无法看到长期命运']
    })
    const power = r.items.find((i) => i.id === 'power_bound')
    expect(power?.verdict).toBe('warn')
  })
})
