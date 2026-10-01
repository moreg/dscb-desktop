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
  it('章中的中文章号也算泄露，书中章节不算', () => {
    const leaked = evaluateChapterSelfCheck({
      chapterNumber: 12,
      content: '这一次取出的样本与第九章检测所用样本来自同一批封存物。'
    }).items.find((item) => item.id === 'meta_narration')
    expect(leaked?.verdict).toBe('warn')
    expect(leaked?.detail).toContain('第九章')

    const inWorld = evaluateChapterSelfCheck({
      chapterNumber: 12,
      content: '他翻开《验尸录》第九章，对照封存记录。'
    }).items.find((item) => item.id === 'meta_narration')
    expect(inWorld?.verdict).toBe('pass')
  })

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

  it('章末旁白说教模板只提醒核对，不把文风判断作为硬失败', () => {
    const r = evaluateChapterSelfCheck({
      chapterNumber: 1,
      content: '他想了很多。\n人生就是这样。\n或许这就是命运。\n他明白了一个道理。'
    })
    expect(r.ok).toBe(true)
    const ending = r.items.find((i) => i.id === 'ending_taboo')
    expect(ending?.verdict).toBe('warn')
    expect(ending?.detail).toContain('或许这就是')
  })

  it('正常对白中的「才刚开始」不误报章末说教', () => {
    for (const content of ['“比赛才刚开始，急什么？”林舟提剑迎了上去。', '"比赛才刚开始。"林舟提剑迎了上去。']) {
      const report = evaluateChapterSelfCheck({ chapterNumber: 1, content })
      expect(report.items.find((item) => item.id === 'ending_taboo')?.verdict).toBe('pass')
      expect(report.ok).toBe(true)
    }
  })

  it('单段长正文只检查末尾，长对白也不会把章中旁白带进检查范围', () => {
    for (const content of [
      '或许这就是命运。' + '林舟提剑追赶对手。'.repeat(100) + '门外传来急促的敲门声。',
      '或许这就是命运。“' + '林舟提剑追赶对手。'.repeat(100) + '”门外传来急促的敲门声。'
    ]) {
      expect(evaluateChapterSelfCheck({ chapterNumber: 1, content }).items
        .find((item) => item.id === 'ending_taboo')?.verdict).toBe('pass')
    }
  })

  it('到期伏笔无关键词只提醒安排，不强行回收', () => {
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
    expect(due?.verdict).toBe('warn')
    expect(r.ok).toBe(true)
  })

  /**
   * 核心事件按子事件逐条判定：
   * 旧实现整句一把抓、关键词只覆盖句首，导致「后半句一字未写」照样过、
   * 「前半句换同义说法」照样判死——用户按自检改完正文仍是同一条失败。
   */
  describe('punctuation_rule / ai_tells：写完即查', () => {
    const pick = (content: string, id: string) =>
      evaluateChapterSelfCheck({ chapterNumber: 2, content }).items.find((i) => i.id === id)
    const punct = (c: string) => pick(c, 'punctuation_rule')
    const tell = (c: string) => pick(c, 'ai_tells')

    it('干净正文两项都 pass', () => {
      const t = '林远走进山门。赵乾挡在面前。\n“你输了。”林远收剑。'
      expect(punct(t)?.verdict).toBe('pass')
      expect(tell(t)?.verdict).toBe('pass')
      expect(tell(t)?.category).toBe('ban')
    })

    // 标点归标点、痕迹归痕迹：破折号是「守则第 9 条没照做」，不是 AI 味判断，
    // 而且可确定性替换。混成一条时用户无从知道哪个能一键改、哪个要动笔。
    it('破折号进 punctuation_rule，不进 ai_tells', () => {
      const t = '第一行没问题。\n他想说什么——话到嘴边又咽了回去。'
      expect(punct(t)?.verdict).toBe('warn')
      expect(punct(t)?.detail).toContain('第 2 行')
      expect(punct(t)?.detail).toContain('确定性替换')
      expect(tell(t)?.verdict).toBe('pass')
    })

    it('省略号同样进 punctuation_rule', () => {
      expect(punct('他愣住了……半天没说话。')?.verdict).toBe('warn')
    })

    it('道具停止式进 ai_tells（全系统唯一 AI 多于真人的规则）', () => {
      const t = '账房先生抬起头。\n他手里的算盘停了。'
      expect(tell(t)?.verdict).toBe('warn')
      expect(tell(t)?.detail).toContain('第 2 行')
      expect(punct(t)?.verdict).toBe('pass')
    })

    it('两类同时出现时各报各的行号', () => {
      const t = '他手里的算盘停了。\n他想说什么——又忍住了。'
      expect(tell(t)?.detail).toContain('第 1 行')
      expect(punct(t)?.detail).toContain('第 2 行')
    })

    it('不误报真实停止与具体动作', () => {
      const t = '雨停了。车在门口停了下来。他一颗珠子拨过了头。'
      expect(tell(t)?.verdict).toBe('pass')
      expect(punct(t)?.verdict).toBe('pass')
    })

    // 这几条在语料上方向相反或无判别力，刻意不进自检——加进来会天天报在自己的稿子上。
    // 见 tests/fixtures/deslop-corpus/FINDINGS.md
    it('不查禁用词密度（AUC 0.097，真人用得比 AI 多）', () => {
      expect(tell('他缓缓走向前，微微皱眉，眼中闪过一丝无奈。')?.verdict).toBe('pass')
    })

    it('不查「不是A而是B」（AUC 0.428，反向）', () => {
      expect(tell('他不是冷漠，而是绝望。')?.verdict).toBe('pass')
    })
  })

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

    it('否定或只在计划中出现事件词，不能报告事件完成', () => {
      for (const content of [
        '林舟从未取得密室钥匙。他也没有救出被囚的妹妹。对寻找密室钥匙和救出妹妹的计划，他连想都没想过。',
        '林舟打算取得密室钥匙。他计划救出被囚妹妹。'
      ]) {
        const item = evaluateChapterSelfCheck({ chapterNumber: 2, content,
          plotSummary: '林舟取得密室钥匙；林舟救出被囚妹妹'
        }).items.find((i) => i.id === 'core_plot')
        expect(item?.verdict).toBe('warn')
        expect(item?.detail).toContain('不能判为已落实')
      }
    })

    it('有文字痕迹也明确区分与语义完成核验', () => {
      const item = evaluateChapterSelfCheck({ chapterNumber: 1, content: '林舟取得密室钥匙。',
        plotSummary: '林舟取得密室钥匙'
      }).items.find((i) => i.id === 'core_plot')
      expect(item?.verdict).toBe('pass')
      expect(item?.detail).toContain('关键词不能证明事件完成')
      expect(item?.label).toContain('非完成核验')
      expect(item?.repairKind).toBe('verify_plot')
    })

    it('已经完成的动作不受随后另一个动作的计划或否定污染', () => {
      for (const content of [
        '林舟取得密室钥匙，打算明天救人。',
        '林舟取得密室钥匙，没有惊动门外的守卫。',
        '林舟取得密室钥匙后没有停留。',
        '林舟取得密室钥匙。他打算把密室钥匙交给妹妹。',
        '林舟没有犹豫便取得密室钥匙。'
      ]) {
        const item = evaluateChapterSelfCheck({ chapterNumber: 2, content,
          plotSummary: '林舟取得密室钥匙'
        }).items.find((i) => i.id === 'core_plot')
        expect(item?.verdict).toBe('pass')
        expect(item?.missing ?? []).toEqual([])
      }
    })

    it('明确未完成之后，重复物品名不能把事件洗成通过', () => {
      for (const content of [
        '林舟没有取得密室钥匙。密室钥匙躺在守卫腰间。',
        '林舟未取得密室钥匙。林舟盯着密室钥匙。'
      ]) {
        const item = evaluateChapterSelfCheck({ chapterNumber: 2, content,
          plotSummary: '林舟取得密室钥匙'
        }).items.find((i) => i.id === 'core_plot')
        expect(item?.verdict).toBe('warn')
        expect(item?.missing).toEqual(['林舟取得密室钥匙'])
      }
    })

    it('先失败后实际取得的后续证据可以解除待核对状态', () => {
      const item = evaluateChapterSelfCheck({ chapterNumber: 2,
        content: '林舟没有取得密室钥匙。第二次潜入时，林舟终于取得了密室钥匙。',
        plotSummary: '林舟取得密室钥匙'
      }).items.find((i) => i.id === 'core_plot')
      expect(item?.verdict).toBe('pass')
    })

    it('后文明确否认同一动作时保留疑问，不能借前文肯定假通过', () => {
      const item = evaluateChapterSelfCheck({ chapterNumber: 2,
        content: '林舟取得密室钥匙。叙述者纠正道，林舟没有取得密室钥匙。',
        plotSummary: '林舟取得密室钥匙'
      }).items.find((i) => i.id === 'core_plot')
      expect(item?.verdict).toBe('warn')
    })

    it('疑问句不能冲掉明确未取得的证据', () => {
      for (const question of ['林舟取得密室钥匙了吗？', '林舟是否取得密室钥匙？']) {
        const item = evaluateChapterSelfCheck({ chapterNumber: 2,
          content: '林舟没有取得密室钥匙。' + question,
          plotSummary: '林舟取得密室钥匙'
        }).items.find((i) => i.id === 'core_plot')
        expect(item?.verdict).toBe('warn')
        expect(item?.detail).toContain('疑问')
      }
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

  describe('篇幅不进自检', () => {
    it('字数多少都不出 word_count 项', () => {
      for (const n of [500, 3000, 9000]) {
        const report = evaluateChapterSelfCheck({ chapterNumber: 1, content: '甲'.repeat(n) })
        expect(report.items.find((i) => i.id === 'word_count')).toBeUndefined()
      }
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
      expect(due?.repairKind).toBe('verify_foreshadow')
    })

    // 此前恒为 warn：正文怎么改都消不掉，「按自检改正文」只会反复空转
    it('回执自称回收且每个要点都有明确叙述 → 通过（仍提示通读）', () => {
      const r = evaluateChapterSelfCheck({
        chapterNumber: 5,
        content:
          '"山本一夫要找的从来不是宝物。"苏九把纸摊开，"他要找的是能改变国运的人。"',
        foreshadowings: [fb({ status: 'collected', actualCollect: 5, expectedCollect: 5 })]
      })
      const due = r.items.find((i) => i.id.startsWith('due_fb'))
      expect(due?.verdict).toBe('pass')
      expect(due?.detail).toContain('通读')
    })

    it('回执自称回收但只落实了部分要点 → 仍 warn 并列出缺的要点', () => {
      const r = evaluateChapterSelfCheck({
        chapterNumber: 5,
        content: '苏九撬开玉佩，玉佩之中藏着藏宝地图。',
        foreshadowings: [{
          content: '玉佩之中藏着藏宝地图；皇陵入口在北山断崖下',
          status: 'collected', actualCollect: 5, expectedCollect: 5
        }]
      })
      const due = r.items.find((i) => i.id.startsWith('due_fb'))
      expect(due?.verdict).toBe('warn')
      expect(due?.missing?.length).toBe(1)
    })

    it('正文只是顺带提了个人名，不算回收', () => {
      const r = evaluateChapterSelfCheck({
        chapterNumber: 5,
        content: '街口的告示是山本贴的。苏九看了一眼就走了，没多问一句。',
        foreshadowings: [fb({ status: 'planted', expectedCollect: 5 })]
      })
      expect(r.items.find((i) => i.id.startsWith('due_fb'))?.verdict).toBe('warn')
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

  it('人物互换地点不能借任一地点词通过，角色未出场也不假通过', () => {
    const prevEndingState = {
      chapterNumber: 1, characterPositions: [
        { name: '林舟', location: '书房', action: '站着' },
        { name: '苏月', location: '城门', action: '站着' }
      ], characterStates: [], timePoint: '夜里', unfinished: [], suspense: '', props: []
    }
    for (const content of ['林舟站在城门，苏月坐在书房。两人都没有离开过原地。', '林舟并不在书房，苏月也不在城门。']) {
      const item = evaluateChapterSelfCheck({ chapterNumber: 2, content, prevEndingState })
        .items.find((i) => i.id === 'char_position')
      expect(item?.verdict).toBe('warn')
      expect(item?.detail).toContain('无法确认')
      expect(item?.repairKind).toBe('char_position')
    }
    // 全员未出场：不假通过，也不当成问题逼着补镜头
    const absent = evaluateChapterSelfCheck({ chapterNumber: 2, content: '书房与城门都静悄悄的。', prevEndingState })
      .items.find((i) => i.id === 'char_position')
    expect(absent?.verdict).toBe('skip')
    expect(absent?.detail).toContain('均未出场')
    expect(evaluateChapterSelfCheck({ chapterNumber: 2, content: '林舟站在书房，苏月守在城门。', prevEndingState })
      .items.find((i) => i.id === 'char_position')?.verdict).toBe('pass')
  })

  it('上章同处一地的人物写进同一句，不因「同句有他人」全员判无法确认', () => {
    const prevEndingState = {
      chapterNumber: 19, characterPositions: [
        { name: '邵宁', location: '学校资助办公室', action: '核对' },
        { name: '贺川', location: '学校资助办公室', action: '核对' }
      ], characterStates: [], timePoint: '夜里', unfinished: [], suspense: '', props: []
    }
    const same = evaluateChapterSelfCheck({ chapterNumber: 20, prevEndingState,
      content: '邵宁和贺川还在资助办公室，把封存编号又核了一遍。' })
      .items.find((i) => i.id === 'char_position')
    expect(same?.verdict).toBe('pass')

    // 地点不同时仍不能互借
    const diff = evaluateChapterSelfCheck({ chapterNumber: 20, content: '邵宁和贺川还在资助办公室。',
      prevEndingState: { ...prevEndingState, characterPositions: [
        prevEndingState.characterPositions[0], { name: '贺川', location: '礼堂后场', action: '等' }
      ] } }).items.find((i) => i.id === 'char_position')
    expect(diff?.verdict).toBe('warn')
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
    expect(r.summary).toContain(`${r.counts.skip} 项未检查`)
    expect(r.summary).not.toContain('写后自检通过')
  })

  it('第 1 章不记 skip（本来就没有上一章）', () => {
    const r = evaluateChapterSelfCheck({ chapterNumber: 1, content: '开篇第一句。' })
    expect(r.items.find((i) => i.id === 'prev_state_missing')).toBeUndefined()
  })

  /**
   * 回归：prevEndingStateExtractionFailed 之前不存在，「这次提取真失败了」和
   * 「本来就没跑过」共用同一句「本次会话没写过本章正文」——提取明明失败过，
   * 提示却说得像没写过，容易让人误判该重写上一章而不是重跑一次自检。
   */
  it('提取真的失败过时，措辞与「没跑过」区分开', () => {
    const r = evaluateChapterSelfCheck({
      chapterNumber: 3,
      content: '他推开门走了进去。',
      prevTail: '上一章的结尾正文。',
      prevEndingStateExtractionFailed: true
    })
    const skipped = r.items.find((i) => i.id === 'prev_state_missing')
    expect(skipped?.verdict).toBe('skip')
    expect(skipped?.detail).toContain('提取失败')
    expect(skipped?.detail).not.toContain('没写过本章正文')
  })

  it('没有真的尝试过提取时，仍是原来「没跑过」的措辞', () => {
    const r = evaluateChapterSelfCheck({
      chapterNumber: 3,
      content: '他推开门走了进去。',
      prevTail: '上一章的结尾正文。',
      prevEndingStateExtractionFailed: false
    })
    const skipped = r.items.find((i) => i.id === 'prev_state_missing')
    expect(skipped?.detail).toContain('没写过本章正文')
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

  it('明确否定常见能力表述时不误报越权', () => {
    const report = evaluateChapterSelfCheck({ chapterNumber: 1,
      content: '林舟无法预知未来，更不可能改变命运。',
      powerBoundaryBullets: ['无法预知未来，不能改变命运']
    })
    expect(report.items.find((item) => item.id === 'power_bound')?.verdict).toBe('pass')
  })

  it('否定犹豫或人物身份不等于否定后续能力行为', () => {
    for (const content of ['林舟没有犹豫便控制天气。', '林舟并非凡人所以能够控制天气。']) {
      const report = evaluateChapterSelfCheck({ chapterNumber: 1, content,
        powerBoundaryBullets: ['不能控制天气']
      })
      expect(report.items.find((item) => item.id === 'power_bound')?.verdict).toBe('warn')
    }
  })

  it('直接否定能力及明确没有能力的表述仍不误报', () => {
    for (const content of ['林舟没有控制天气。', '林舟没有能力控制天气。', '林舟无法真正控制天气。']) {
      const report = evaluateChapterSelfCheck({ chapterNumber: 1, content,
        powerBoundaryBullets: ['不能控制天气']
      })
      expect(report.items.find((item) => item.id === 'power_bound')?.verdict).toBe('pass')
    }
  })

  it('前面遵守边界的否定不能豁免后面的越权，包括同句第二次施展', () => {
    for (const content of [
      '师父说他不能控制天气。林舟抬起手，成功控制天气，把暴雨化成晴空。',
      '师父说他不能控制天气但林舟最终控制天气。'
    ]) {
      const report = evaluateChapterSelfCheck({ chapterNumber: 1, content,
        powerBoundaryBullets: ['不能控制天气']
      })
      expect(report.items.find((item) => item.id === 'power_bound')?.verdict).toBe('warn')
    }
  })

  it('常见能力表述也逐次判断，首处否定不会遮住后续肯定', () => {
    const report = evaluateChapterSelfCheck({ chapterNumber: 1,
      content: '过去林舟无法预知未来。如今他能够预知未来。',
      powerBoundaryBullets: ['无法预知未来']
    })
    expect(report.items.find((item) => item.id === 'power_bound')?.verdict).toBe('warn')
  })

  it('到期伏笔全量检查，第七条虚假回收记录也必须被发现', () => {
    const report = evaluateChapterSelfCheck({ chapterNumber: 5, content: '林舟睡着了。',
      foreshadowings: [
        ...Array.from({ length: 6 }, (_,index) => ({
          content: `第${index}份密信藏着皇陵入口`, status: 'planted', expectedCollect: 5
        })),
        { content: '山本一夫的真正目的是寻找改变国运的奇人', status: 'collected', actualCollect: 5 }
      ]
    })
    expect(report.items.filter((item) => item.id.startsWith('due_fb_'))).toHaveLength(7)
    expect(report.items.find((item) => item.id === 'due_fb_6')?.verdict).toBe('fail')
    expect(report.ok).toBe(false)
    expect(report.summary).toContain('项未检查')
  })

  it('未到期伏笔和未完成事项超过五条时仍全部进入报告', () => {
    const report = evaluateChapterSelfCheck({ chapterNumber: 5,
      content: '玉佩之中藏着藏宝地图，藏宝地图标出皇陵入口。',
      foreshadowings: Array.from({ length: 6 }, () => ({
        content: '玉佩之中藏着藏宝地图，藏宝地图标出皇陵入口', status: 'planted', expectedCollect: 20
      })),
      prevEndingState: { chapterNumber: 4, characterPositions: [], characterStates: [],
        timePoint: '', unfinished: Array.from({ length: 6 }, (_, index) => `处理第${index}份投递事项`),
        suspense: '', props: [] }
    })
    expect(report.items.filter((item) => item.id.startsWith('early_fb_'))).toHaveLength(6)
    expect(report.items.find((item) => item.id === 'early_fb_5')?.verdict).toBe('warn')
    expect(report.items.filter((item) => item.id.startsWith('unfinished_'))).toHaveLength(6)
  })

  it('第九条卷内提示和第七条能力边界也参与核对', () => {
    const report = evaluateChapterSelfCheck({ chapterNumber: 1,
      content: '玉佩之中藏着藏宝地图，藏宝地图标出皇陵入口。林舟控制天气，把暴雨化成晴空。',
      doNotAdvanceHints: [...Array(8).fill('江边码头失火引来巡捕追查'), '玉佩之中藏着藏宝地图，藏宝地图标出皇陵入口'],
      powerBoundaryBullets: [...Array(6).fill('不能穿越墙壁'), '不能控制天气']
    })
    expect(report.items.find((item) => item.id === 'volume_spoiler')?.verdict).toBe('warn')
    expect(report.items.find((item) => item.id === 'power_bound')?.verdict).toBe('warn')
  })
})
