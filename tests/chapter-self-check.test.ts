import { describe, it, expect } from 'vitest'
import {
  evaluateChapterSelfCheck,
  extractKeywords,
  splitEventClauses,
  type SelfCheckForeshadowInput
} from '../src/main/data/chapter-self-check'

/** 真实细纲核心事件句：多子事件 + 括号枚举 + 伏笔编号 */
const MULTI_EVENT_SUMMARY =
  '邹英按军事习惯接管秩序，与邱北因「先救还是先取火」争执；旁白分层点出七女登船由头（团建/商务/安保/疗休/潜逃），埋FB-016。'

describe('extractKeywords', () => {
  it('抽出核心名词片段', () => {
    const kws = extractKeywords('林远当众击败赵乾，立下赌约')
    expect(kws.some((k) => k.includes('林远') || k.includes('赵乾') || k.includes('击败'))).toBe(
      true
    )
  })

  /**
   * 旧实现从句首滑窗、凑满 12 个就返回，关键词永远只覆盖开头十来个字，
   * 后半句在任何检查里都等于不存在。
   */
  it('关键词覆盖整句，不再只取句首', () => {
    const kws = extractKeywords(MULTI_EVENT_SUMMARY)
    expect(kws.some((k) => k.includes('接管') || k.includes('军事'))).toBe(true)
    expect(kws.some((k) => k.includes('取火') || k.includes('邱北'))).toBe(true)
    expect(kws.some((k) => k.includes('登船') || k.includes('七女'))).toBe(true)
  })
})

describe('splitEventClauses', () => {
  it('按分号/长句逗号切子事件，括号枚举不拆', () => {
    const clauses = splitEventClauses(MULTI_EVENT_SUMMARY)
    expect(clauses).toContain('邹英按军事习惯接管秩序')
    expect(clauses.some((c) => c.includes('先救还是先取火'))).toBe(true)
    expect(clauses.some((c) => c.includes('团建/商务/安保/疗休/潜逃'))).toBe(true)
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

  it('不再检查 ending_form（章末对话/事件形态已移除）', () => {
    // 纯心理收尾、无对话/事件词：不应再因 ending_form 失败
    const r = evaluateChapterSelfCheck({
      chapterNumber: 1,
      content: '他想了很多。\n窗外的雨渐渐小了。\n这一夜，他只是静静坐着。'
    })
    expect(r.items.find((i) => i.id === 'ending_form')).toBeUndefined()
    expect(r.ok).toBe(true)
  })

  it('章末说教模板 → ending_taboo fail', () => {
    const r = evaluateChapterSelfCheck({
      chapterNumber: 1,
      content: '他想了很多。\n人生就是这样。\n或许这就是命运。\n他明白了一个道理。'
    })
    expect(r.ok).toBe(false)
    const ending = r.items.find((i) => i.id === 'ending_taboo')
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

  /**
   * 核心事件按子事件逐条判定：
   * 旧实现整句一把抓、关键词只覆盖句首，导致「后半句一字未写」照样过、
   * 「前半句换同义说法」照样判死——用户按自检改完正文仍是同一条失败。
   */
  describe('core_plot 子事件覆盖率', () => {
    const corePlot = (content: string) =>
      evaluateChapterSelfCheck({
        chapterNumber: 3,
        content,
        plotSummary: MULTI_EVENT_SUMMARY
      }).items.find((i) => i.id === 'core_plot')

    it('子事件基本写到 → pass', () => {
      const item = corePlot(
        '邹英按部队里的规矩清点人数，秩序很快立住。\n' +
          '"先救人。"她说。邱北却坚持先取火，两人在滩上争执起来。\n' +
          '七个女人登船的由头各不相同：团建、商务、安保、疗休，还有一个说不清。'
      )
      expect(item?.verdict).toBe('pass')
    })

    it('只写了第一件事 → 不再是 pass，且点名缺哪几条', () => {
      const item = corePlot('邹英接管秩序，把人排成一列，清点、编号、分工。天亮之前没人再说话。')
      expect(item?.verdict).toBe('warn')
      expect(item?.missing?.some((m) => m.includes('取火'))).toBe(true)
      expect(item?.missing?.some((m) => m.includes('登船'))).toBe(true)
      expect(item?.detail).toContain('1/3')
    })

    it('全部子事件都没写 → fail', () => {
      const item = corePlot('他一个人靠在礁石上，想着很久以前的事。海浪一遍遍推上来。')
      expect(item?.verdict).toBe('fail')
      expect(item?.missing?.length).toBeGreaterThan(0)
    })

    it('伏笔编号这类元信息不计入分母（正文不可能出现 FB-016）', () => {
      const item = corePlot(
        '邹英按部队里的规矩清点人数，秩序很快立住。\n' +
          '邱北说要先取火，两人争执。\n' +
          '七女登船的由头分了层：团建、商务、安保、疗休、潜逃。'
      )
      expect(item?.verdict).toBe('pass')
      expect(item?.missing ?? []).toEqual([])
    })
  })

  /**
   * 细纲写「不超过 3000 字」时，写正文的 prompt 按上限口径下发，
   * 自检以前只认下限，把听话写少的章判死。
   */
  describe('字数上限口径（bound=about）', () => {
    const wordItem = (content: string, bound: 'min' | 'about') =>
      evaluateChapterSelfCheck({
        chapterNumber: 1,
        content,
        targetWords: 3000,
        targetFromOutline: true,
        targetBound: bound
      }).items.find((i) => i.id === 'word_count')

    it('上限口径下写不满不判问题', () => {
      expect(wordItem('甲'.repeat(2000), 'about')?.verdict).toBe('pass')
    })

    it('同样的字数在下限口径下仍判 fail', () => {
      expect(wordItem('甲'.repeat(2000), 'min')?.verdict).toBe('fail')
    })

    it('上限口径下超出较多 → warn', () => {
      expect(wordItem('甲'.repeat(3600), 'about')?.verdict).toBe('warn')
    })
  })

  /**
   * 伏笔回执把状态改成 collected 后，若自检只筛 planted，
   * 模型只要声称回收就能把检查它的这一项关掉。
   */
  describe('到期伏笔', () => {
    const fb = (extra: {
      status: string
      expectedCollect?: number
      actualCollect?: number
    }): SelfCheckForeshadowInput => ({
      content: '山本一夫的真正目的是寻找改变国运的奇人',
      ...extra
    })

    it('回执自称本章回收但正文没写 → 仍然 fail', () => {
      const r = evaluateChapterSelfCheck({
        chapterNumber: 5,
        content: '苏九收了摊，回了沈家院子。\n"今天就到这儿。"\n他闩上门，靠在墙上睡着了。',
        foreshadowings: [fb({ status: 'collected', actualCollect: 5, expectedCollect: 5 })]
      })
      const due = r.items.find((i) => i.id.startsWith('due_fb'))
      expect(due?.verdict).toBe('fail')
      expect(due?.detail).toContain('回执')
    })

    it('回执自称回收且正文有痕迹 → pass', () => {
      const r = evaluateChapterSelfCheck({
        chapterNumber: 5,
        content:
          '"山本一夫要找的从来不是宝物。"苏九把纸摊开，"他要找的是能改变国运的人。"',
        foreshadowings: [fb({ status: 'collected', actualCollect: 5, expectedCollect: 5 })]
      })
      expect(r.items.find((i) => i.id.startsWith('due_fb'))?.verdict).toBe('pass')
    })

    it('正文只是顺带提了个人名，不算回收', () => {
      const r = evaluateChapterSelfCheck({
        chapterNumber: 5,
        content: '街口的告示是山本贴的。苏九看了一眼就走了，没多问一句。',
        foreshadowings: [fb({ status: 'planted', expectedCollect: 5 })]
      })
      expect(r.items.find((i) => i.id.startsWith('due_fb'))?.verdict).toBe('fail')
    })
  })

  /**
   * 结尾状态里的 location 是 LLM 提取的带限定语串，整串 includes 永远匹配不上。
   */
  it('人物位置：带括号限定语的地点按核心地名匹配', () => {
    const prevEndingState = {
      chapterNumber: 2,
      characterPositions: [{ name: '邹英', location: '空沙滩（潮线附近）', action: '站着' }],
      characterStates: [],
      timePoint: '夜里',
      unfinished: [],
      suspense: '',
      props: []
    }
    const hit = evaluateChapterSelfCheck({
      chapterNumber: 3,
      content: '沙滩上还留着昨夜的脚印。邹英蹲下去，看了很久。',
      prevEndingState
    }).items.find((i) => i.id === 'char_position')
    expect(hit?.verdict).toBe('pass')

    const miss = evaluateChapterSelfCheck({
      chapterNumber: 3,
      content: '船舱里闷得厉害。邹英靠在舱壁上，一句话也没说。',
      prevEndingState
    }).items.find((i) => i.id === 'char_position')
    expect(miss?.verdict).toBe('warn')
  })

  /**
   * 结尾状态是只读缓存，拿不到时那三项整条不进报告——
   * counts/ok 在更小的集合上算，用户看不出有项没跑。
   */
  it('缺上章结尾状态时显式记一条 skip', () => {
    const r = evaluateChapterSelfCheck({
      chapterNumber: 3,
      content: '他推开门走了进去。\n"人呢？"\n屋里没有回答。',
      prevTail: '上一章的结尾正文。'
    })
    const skipped = r.items.find((i) => i.id === 'prev_state_missing')
    expect(skipped?.verdict).toBe('skip')
    expect(skipped?.detail).toContain('不等于通过')
    expect(r.counts.skip).toBeGreaterThan(0)
  })

  it('第 1 章不记 skip（本来就没有上一章）', () => {
    const r = evaluateChapterSelfCheck({ chapterNumber: 1, content: '开篇第一句。' })
    expect(r.items.find((i) => i.id === 'prev_state_missing')).toBeUndefined()
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
