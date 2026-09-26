import { describe, it, expect } from 'vitest'
import { auditChapter } from '../src/main/data/chapter-audit'
import { DEFAULT_REVIEW_RULES, DEFAULT_REVIEW_THRESHOLDS } from '../src/main/data/skill-prompts'
import type { ReviewRulesConfig } from '../src/shared/types'
import { formatChapterProse } from '../src/shared/format-chapter-prose'

/** 拼一段合法的"中段+对话/事件结尾"正文（基线，避免触发 ending/word_count） */
function makeValidContent(ending = '"我不会让你——"她头也不回地冲了出去'): string {
  // 够长（>minWords 2300）避免 word_count 误报
  const filler = '林远握紧手中的剑，一言不发，屋里没人说话。'.repeat(80)
  return filler + '\n\n他盯着门外，脚步声渐近。\n\n' + ending
}

/** 构造开启全部审稿检查的配置 */
function reviewRulesOn(overrides: Partial<ReviewRulesConfig> = {}): ReviewRulesConfig {
  return {
    ...DEFAULT_REVIEW_RULES,
    thresholds: { ...DEFAULT_REVIEW_THRESHOLDS },
    wordLists: {
      metaBreak: [...DEFAULT_REVIEW_RULES.wordLists.metaBreak],
      sensitive: ['脑浆迸裂', '制作炸弹']
    },
    ...overrides
  }
}

describe('chapter-audit (正文审核 M2 — reviewRules 接入)', () => {
  it('reviewRules 缺省时不跑新增检查（向后兼容）', () => {
    const content = makeValidContent() + '\n\n弹幕飘过一片叫好声。'
    const report = auditChapter(content) // 不传 reviewRules
    const toxic = report.violations.filter((v) => v.category === 'toxic')
    expect(toxic).toEqual([])
  })

  it('reviewRules.enabled=false 时跳过新增检查', () => {
    const content = makeValidContent() + '\n\n弹幕飘过一片叫好声。'
    const rules = reviewRulesOn({ enabled: false })
    const report = auditChapter(content, { reviewRules: rules })
    expect(report.violations.filter((v) => v.category === 'toxic')).toEqual([])
  })
})

describe('chapter-audit (meta_break 打破第四面墙)', () => {
  it('命中字面词表 → error', () => {
    const content = makeValidContent() + '\n\n弹幕飘过一片叫好声。'
    const report = auditChapter(content, { reviewRules: reviewRulesOn() })
    const hit = report.violations.find(
      (v) => v.category === 'toxic' && v.ruleId === 'meta_break' && v.word === '弹幕'
    )
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('error')
    expect(hit?.offset).toBeGreaterThanOrEqual(0)
  })

  it('命中"第N卷"数字变体 → error', () => {
    const content = makeValidContent() + '\n\n这已经是第三卷的内容了。'
    const report = auditChapter(content, { reviewRules: reviewRulesOn() })
    const hit = report.violations.find(
      (v) => v.category === 'toxic' && v.ruleId === 'meta_break' && v.word?.includes('卷')
    )
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('error')
  })

  it('关闭 meta_break 开关后不报告', () => {
    const content = makeValidContent() + '\n\n弹幕飘过一片叫好声。'
    const rules = reviewRulesOn({ checks: { meta_break: false } })
    const report = auditChapter(content, { reviewRules: rules })
    expect(
      report.violations.find((v) => v.ruleId === 'meta_break')
    ).toBeUndefined()
  })

  /**
   * 元叙事词表是全局的，可「作者」「主角」「反派」在不少书里就是页内身份。
   * 回归：一本以「作者魂印／作者格」为金手指的书，10 章里 19 条 error 全是这一个词。
   */
  describe('项目设定里立过的词按世界观术语处理', () => {
    const content = () => makeValidContent() + '\n\n他的作者格空着，作者魂印仍亮。\n\n弹幕飘过一片叫好声。'

    it('设定文件名含该词时降为 info，并说明出处', () => {
      const report = auditChapter(content(), {
        reviewRules: reviewRulesOn(),
        worldTerms: ['作者魂印', '原作者阵营', '金手指']
      })
      const hits = report.violations.filter((v) => v.ruleId === 'meta_break' && v.word === '作者')
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.every((v) => v.severity === 'info')).toBe(true)
      expect(hits[0].message).toContain('作者魂印')
      expect(report.counts.error).toBe(
        report.violations.filter((v) => v.severity === 'error').length
      )
    })

    it('设定里没有的元叙事词照旧 error', () => {
      const report = auditChapter(content(), {
        reviewRules: reviewRulesOn(),
        worldTerms: ['作者魂印']
      })
      const danmu = report.violations.find((v) => v.ruleId === 'meta_break' && v.word === '弹幕')
      expect(danmu?.severity).toBe('error')
    })

    it('不传 worldTerms 时行为不变', () => {
      const report = auditChapter(content(), { reviewRules: reviewRulesOn() })
      const hit = report.violations.find((v) => v.ruleId === 'meta_break' && v.word === '作者')
      expect(hit?.severity).toBe('error')
    })
  })

  it('非穿书/系统题材保持 error（当前 genre 表无穿书 key，全题材默认 error）', () => {
    const content = makeValidContent() + '\n\n弹幕飘过一片叫好声。'
    const report = auditChapter(content, {
      genre: '现代都市',
      reviewRules: reviewRulesOn()
    })
    const hit = report.violations.find(
      (v) => v.ruleId === 'meta_break' && v.word === '弹幕'
    )
    // 现代都市不属于穿书/系统文，meta_break 应保持 error
    expect(hit?.severity).toBe('error')
  })
})

describe('chapter-audit (quote_count 引文字数一致性)', () => {
  it('字数描述与引文不符 → error', () => {
    // 引文"你做得不错"实为 5 字，描述说"三个字"
    const content = makeValidContent('"你做得不错。"她说这三个字的时候，眼神躲闪。')
    const report = auditChapter(content, { reviewRules: reviewRulesOn() })
    const hit = report.violations.find((v) => v.ruleId === 'quote_count')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('error')
    expect(hit?.message).toContain('5 字')
  })

  it('字数描述正确时不报', () => {
    const content = makeValidContent('"你做得不错。"她说这五个字的时候，眼神躲闪。')
    const report = auditChapter(content, { reviewRules: reviewRulesOn() })
    expect(report.violations.find((v) => v.ruleId === 'quote_count')).toBeUndefined()
  })

  it('关闭开关后不报', () => {
    const content = makeValidContent('"你做得不错。"她说这三个字的时候。')
    const rules = reviewRulesOn({ checks: { quote_count: false } })
    const report = auditChapter(content, { reviewRules: rules })
    expect(report.violations.find((v) => v.ruleId === 'quote_count')).toBeUndefined()
  })

  /**
   * 「这X个字」多半指引文里的一个词，而不是整句。
   * 旧实现只拿最近一条整句引文比对：「白裙，未开。」被说成「那两个字」就报 error，
   * 实测这是 quote_count 误报的全部来源。
   */
  it('标点切出的片段字数对得上时不报', () => {
    // 引文「白裙，未开。」两段各 2 字，说「那两个字」指的是其中一段
    const content = makeValidContent('"白裙，未开。"潘可确认那两个字没有改动。')
    const report = auditChapter(content, { reviewRules: reviewRulesOn() })
    expect(report.violations.find((v) => v.ruleId === 'quote_count')).toBeUndefined()
  })

  it('引文里反复出现的固定说法对得上时不报', () => {
    // 「主稿」是本章反复出现的术语，"这两个字"说的是它，而不是整句 5 字
    const content =
      makeValidContent('"主稿仍在列。"文真盯着这两个字。').replace(
        '他盯着门外，脚步声渐近。',
        '入库表上的主稿一栏空着，主稿的编号还没落下。'
      )
    const report = auditChapter(content, { reviewRules: reviewRulesOn() })
    expect(report.violations.find((v) => v.ruleId === 'quote_count')).toBeUndefined()
  })

  it('等长片段只在这一句里出现过，不算对得上', () => {
    // 「主稿」全章只出现在引文里，说不通就该报
    const content = makeValidContent('"主稿仍在列。"文真盯着这两个字。')
    const hit = auditChapter(content, { reviewRules: reviewRulesOn() }).violations.find(
      (v) => v.ruleId === 'quote_count'
    )
    expect(hit?.severity).toBe('error')
  })

  it('整句和片段都对不上才报', () => {
    // 引文片段为 2 字和 2 字，整句 4 字，说成"三个字"对不上任何一段
    const content = makeValidContent('"白裙，未开。"潘可确认这三个字没有改动。')
    const hit = auditChapter(content, { reviewRules: reviewRulesOn() }).violations.find(
      (v) => v.ruleId === 'quote_count'
    )
    expect(hit?.severity).toBe('error')
  })

  it('被数的字就写在同一句里（没加引号）时不报', () => {
    // 「共同避险，只到这四个字。」——"共同避险"正是 4 字
    const content = makeValidContent('"没答应。"\n\n"共同避险，只到这四个字。"')
    expect(
      auditChapter(content, { reviewRules: reviewRulesOn() }).violations.find(
        (v) => v.ruleId === 'quote_count'
      )
    ).toBeUndefined()
  })

  it('描述的是前几句里的引文时也算对得上', () => {
    // 「这两个字」说的是更早那句「作者？」，不是紧邻的那条引文
    const content = makeValidContent(
      '"作者？"他问。\n\n严阙没答话，只把笔按在纸面上，一直按到墨透。\n\n这两个字落进页口。'
    )
    expect(
      auditChapter(content, { reviewRules: reviewRulesOn() }).violations.find(
        (v) => v.ruleId === 'quote_count'
      )
    ).toBeUndefined()
  })
})

describe('chapter-audit (dash_fragment 破折号碎片化)', () => {
  it('单字碎片 → error', () => {
    const content = makeValidContent() + '\n\n方辞野——在——掌——心——裂开。'
    const report = auditChapter(content, { reviewRules: reviewRulesOn() })
    const hit = report.violations.find((v) => v.ruleId === 'dash_fragment' && v.severity === 'error')
    expect(hit).toBeDefined()
  })

  it('密度超阈值 → warn', () => {
    // 一段里塞多个 —— 但不是单字碎片
    const para = '他走了——然后停下——回头看她——叹了口气——又走了——终于离开。'
    const content = makeValidContent() + '\n\n' + para
    const report = auditChapter(content, { reviewRules: reviewRulesOn() })
    const warn = report.violations.find((v) => v.ruleId === 'dash_fragment' && v.severity === 'warn')
    expect(warn).toBeDefined()
  })

  it('阈值调高后密度不再触发', () => {
    const para = '他走了——然后停下——回头看她——叹了口气。'
    const content = makeValidContent() + '\n\n' + para
    const rules = reviewRulesOn({
      thresholds: { ...DEFAULT_REVIEW_THRESHOLDS, dashDensityPer100: 100 }
    })
    const report = auditChapter(content, { reviewRules: rules })
    expect(
      report.violations.find((v) => v.ruleId === 'dash_fragment' && v.severity === 'warn')
    ).toBeUndefined()
  })
})

describe('chapter-audit (long_paragraph / long_sentence)', () => {
  it('段落超阈值 → warn', () => {
    // 单段 > 300 字
    const longPara = '他一直往前走着没有回头。'.repeat(40) // ~400 字
    const content = makeValidContent() + '\n\n' + longPara
    const report = auditChapter(content, { reviewRules: reviewRulesOn() })
    const hit = report.violations.find((v) => v.ruleId === 'long_paragraph')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('warn')
  })

  it('超长句（连续无句号）→ warn', () => {
    const longSentence = '他握紧剑冲向前方劈开障碍越过沟壑翻过院墙终于看到了那扇门'.repeat(3)
    const content = makeValidContent() + '\n\n' + longSentence + '。'
    const report = auditChapter(content, { reviewRules: reviewRulesOn() })
    const hit = report.violations.find((v) => v.ruleId === 'long_sentence')
    expect(hit).toBeDefined()
  })
})

describe('chapter-audit (sensitive 敏感词提醒)', () => {
  it('命中敏感词 → info（仅提醒）', () => {
    const content = makeValidContent() + '\n\n那人的脑浆迸裂开来。'
    const report = auditChapter(content, { reviewRules: reviewRulesOn() })
    const hit = report.violations.find(
      (v) => v.ruleId === 'sensitive' && v.word === '脑浆迸裂'
    )
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('info')
  })

  it('关闭开关后不提醒', () => {
    const content = makeValidContent() + '\n\n脑浆迸裂。'
    const rules = reviewRulesOn({ checks: { sensitive: false } })
    const report = auditChapter(content, { reviewRules: rules })
    expect(report.violations.find((v) => v.ruleId === 'sensitive')).toBeUndefined()
  })
})

describe('chapter-audit (字数区间提醒已关闭)', () => {
  it('即使 minWords 很低也不再产出 word_count 违例', () => {
    const short = '他走了。'
    const rules = reviewRulesOn({
      thresholds: { ...DEFAULT_REVIEW_THRESHOLDS, minWords: 2000 }
    })
    const report = auditChapter(short, { reviewRules: rules })
    const wc = report.violations.find((v) => v.category === 'word_count')
    expect(wc).toBeUndefined()
    expect(report.passed.wordCount).toBe(true)
  })
})

describe('chapter-audit (新 error 级影响 counts.error，阻断 strict)', () => {
  it('meta_break error 计入 counts.error', () => {
    const content = makeValidContent() + '\n\n弹幕飘过一片叫好声。'
    const report = auditChapter(content, { reviewRules: reviewRulesOn() })
    expect(report.counts.error).toBeGreaterThan(0)
  })

  it('quote_count error 计入 counts.error', () => {
    const content = makeValidContent('"你做得不错。"她说这三个字的时候。')
    const report = auditChapter(content, { reviewRules: reviewRulesOn() })
    expect(report.counts.error).toBeGreaterThan(0)
  })

  it('dash_fragment error 计入 counts.error', () => {
    const content = makeValidContent() + '\n\n方——辞——野——在——掌——心。'
    const report = auditChapter(content, { reviewRules: reviewRulesOn() })
    expect(report.counts.error).toBeGreaterThan(0)
  })
})

/**
 * 算法层目录完整性：REVIEW_CHECK_SECTIONS 里每个算法类 checkId 都必须
 * (a) 在 chapter-audit.ts 里有对应的 isCheckOn 守卫（开关可控）
 * (b) 能被对应触发内容命中（不是死代码）
 * 防止新增 checkId 后忘了写检测函数、或改名后检测失效。
 */
describe('chapter-audit (算法层目录完整性)', () => {
  // 每个 checkId → 一段必命中的触发内容（开关全开时）
  const triggers: Record<string, string> = {
    meta_break: '弹幕飘过一片叫好声。',
    pov_mix:
      '我站在原地，他走过来，他看着我，他没有说话，他转身离开，他终究还是走了。',
    repetition: '他握紧了剑他握紧了剑他握紧了剑。',
    quote_count: '"你做得不错。"她说这三个字的时候，眼神躲闪。',
    dash_fragment: '方——辞——野——在——掌——心裂开。',
    long_sentence:
      '他握紧手中的剑猛然冲向前方一剑劈开面前的障碍随后越过那道沟壑翻过院墙终于看到了远处那扇紧闭的门却还是晚了半步只能眼睁睁看着那道黑影消失在茫茫夜色之中再也无法追上半分。',
    comma_stack:
      '她看到了他，然后走了过去，心里想着，也许这就是最后一次，所以她什么都没说，只是站着。',
    ellipsis_abuse: '她笑了……又哭了……最后什么都没说……转身离开。',
    long_paragraph: '他一直往前走着没有回头。'.repeat(40),
    dialogue_tag:
      '"你来。"他道。"我来了。"他道。"坐下。"他道。"喝茶。"他道。"走吧。"他道。',
    sensitive: '那人的脑浆迸裂开来。'
  }

  // 用 for...of 避免与 lint no-array-callback 关系
  for (const checkId of Object.keys(triggers)) {
    it(`${checkId}：开启时能命中 / 关闭时不报告`, () => {
      const base = makeValidContent() + '\n\n' + triggers[checkId]
      // 开启 → 应命中
      const onReport = auditChapter(base, { reviewRules: reviewRulesOn() })
      const hit = onReport.violations.some(
        (v) => v.ruleId === checkId || (checkId === 'sensitive' && v.category === 'sensitive')
      )
      expect(hit, `${checkId} 开启时应命中`).toBe(true)
      // 关闭 → 不应报告
      const offRules = reviewRulesOn({ checks: { [checkId]: false } as never })
      const offReport = auditChapter(base, { reviewRules: offRules })
      const stillThere = offReport.violations.some((v) => v.ruleId === checkId)
      expect(stillThere, `${checkId} 关闭后不应报告`).toBe(false)
    })
  }
})

describe('续写格式化后的正文质量回归', () => {
  it('单换行与空行稿采用相同段落口径，短段不会被焊成全章超长段', () => {
    const text = Array.from({ length: 10 }, (_, i) => String.fromCharCode(0x4e00 + i).repeat(40) + '。').join('\n\n')
    for (const content of [text, formatChapterProse(text)]) {
      expect(auditChapter(content, { reviewRules: reviewRulesOn() }).violations
        .some((v) => v.ruleId === 'long_paragraph')).toBe(false)
    }
  })

  it('开篇的突发事件不能替真实章末通过钩子检查', () => {
    const text = ['他突然推开门。', '桌上有一本旧册。', '窗外的雨停了。', '灯下的纸张发黄。', '夜已经深了。'].join('\n\n')
    for (const content of [text, formatChapterProse(text)]) {
      const findings = auditChapter(content, { reviewRules: reviewRulesOn() }).violations
      expect(findings.some((v) => v.category === 'ending')).toBe(true)
      expect(findings.some((v) => v.ruleId === 'hook_strength')).toBe(true)
      expect(findings.find((v) => v.category === 'ending')?.offset).toBe(content.indexOf('窗外'))
    }
  })

  it('正常中文弯引号台词能被章末检测识别', () => {
    const report = auditChapter('“别问了。”', { reviewRules: reviewRulesOn() })
    expect(report.violations.some((v) => v.category === 'ending' || v.ruleId === 'hook_strength')).toBe(false)
  })

  it('跨段重复叙述会被定位到再次出现处，单换行与双换行一致', () => {
    const para = '林舟摸着那枚生锈的铜钥匙，反复琢磨它到底能打开哪一道门。'
    for (const separator of ['\n', '\n\n']) {
      const text = [para, '窗边的灯还亮着。', para].join(separator)
      const hit = auditChapter(text, { reviewRules: reviewRulesOn() }).violations
        .find((v) => v.ruleId === 'repetition' && v.message.includes('跨段'))
      expect(hit?.offset).toBe(text.lastIndexOf(para))
    }
  })

  it('提示足够长的高度相似段落，短对白与短排比不算水文', () => {
    const para = '林舟摸着那枚生锈的铜钥匙，反复琢磨它到底能打开哪一道门。他把钥匙搁在掌心，又拿到灯下细看，钥匙上的花纹仍然无法辨认。'
    const variant = para.replace('生锈', '陈旧').replace('灯下', '窗边')
    expect(auditChapter(`${para}\n${variant}`, { reviewRules: reviewRulesOn() }).violations
      .some((v) => v.ruleId === 'repetition' && v.message.includes('高度相似'))).toBe(true)
    const short = '“走吧。”\n“走吧。”\n他不服。\n他不甘。\n他不退。'
    expect(auditChapter(short, { reviewRules: reviewRulesOn() }).violations
      .some((v) => v.ruleId === 'repetition')).toBe(false)
  })
})

