import { describe, expect, it } from 'vitest'
import {
  normalizeMemoryEvidence,
  partitionMemoryCandidate,
  resolveMemoryEvidence,
  validateMemoryCandidate
} from '../src/main/data/memory-evidence-validator'
import { parseMemoryExtractionJson } from '../src/shared/parsers'

function candidate(evidence: string) {
  return parseMemoryExtractionJson(JSON.stringify({ newPlotPoints: [{ title: '行军', event: '全团绕城', evidence }],
    characterStateChanges: [], collectedForeshadowings: [] }), 1)
}

describe('记忆引用格式兼容', () => {
  it('识别叙述片段外额外添加的引号，并保存实际原文', () => {
    const content = '参谋长将行军路线改到河西，绕开县城。'
    const input = candidate('“将行军路线改到河西”')
    const normalized = normalizeMemoryEvidence(content, input)
    expect(normalized.newPlotPoints[0].evidence).toBe('将行军路线改到河西')
    expect(input.newPlotPoints[0].evidence).toBe('“将行军路线改到河西”')
    expect(validateMemoryCandidate(content, normalized)).toEqual([])
  })

  it('保留完整台词的原有引号，也识别台词中的连续片段', () => {
    const content = '“全团绕城，沿西河走，天黑前扎营。”'
    expect(resolveMemoryEvidence(content, content)).toBe(content)
    expect(resolveMemoryEvidence(content, '“全团绕城，沿西河走”')).toBe('全团绕城，沿西河走')
  })

  it('不接受改写、短词或不存在的证据', () => {
    const content = '参谋长将行军路线改到河西，绕开县城。'
    for (const evidence of ['“参谋长把行军路线改到河西”', '“参谋长”', '“全团已经安全进城”']) {
      expect(resolveMemoryEvidence(content, evidence)).toBeUndefined()
      expect(validateMemoryCandidate(content, candidate(evidence))[0]).toContain('正文原文依据')
    }
  })

  it('完整短台词不因字数不够 6 字被误杀（真实回归案例）', () => {
    // 从真实项目里抓到的两条：都是逐字精确命中原文的完整台词，都只有 4 个内容字符
    // （这张不兑 / 今日不送），旧的统一 6 字下限会把它们当成「只引了个名字」挡下——
    // 明明是模型精准摘录的完整小句，却被字数门槛误杀，害记忆同步一直卡在这条上。
    expect(resolveMemoryEvidence('顾景澜看人。“这张不兑。”顾景澜收回', '“这张不兑。”')).toBe(
      '“这张不兑。”'
    )
    expect(resolveMemoryEvidence('赵绾青想了想。“今日不送。”丫鬟应声', '“今日不送。”')).toBe(
      '“今日不送。”'
    )
    // 没有句末标点的裸碎片不享受短句豁免：4 个字但没有句读，仍按 6 字下限挡
    expect(resolveMemoryEvidence('赵安慈坐在廊中，佛珠压在掌下。', '赵安慈坐')).toBeUndefined()
  })

  it('标点差异不算改写：残缺引号、多余标点都按原文定位', () => {
    // 旧实现是 content.includes(quote) 的零容忍匹配，差一个引号就判「缺少依据」。
    // 实测连写 10 章时，每章十几条证据里必有失手的，记忆因此一条也进不去。
    // 忽略标点不等于放过改写——字符序列仍须逐字命中（见上一条用例）。
    const content = '参谋长将行军路线改到河西，绕开县城。'
    for (const evidence of ['“将行军路线改到河西', '将行军路线改到河西……']) {
      expect(resolveMemoryEvidence(content, evidence)).toBe('将行军路线改到河西')
      expect(validateMemoryCandidate(content, candidate(evidence))).toEqual([])
    }
    // 尾标点与正文对得上时并入，落库存的是正文真实切片
    expect(resolveMemoryEvidence(content, '将行军路线改到河西，')).toBe('将行军路线改到河西，')
  })

  it('去除引用包装后仍检查完整上下文中的否定和计划', () => {
    for (const content of ['参谋长没有将行军路线改到河西。', '参谋长打算将行军路线改到河西。']) {
      const result = validateMemoryCandidate(content, candidate('“将行军路线改到河西”'))
      expect(result[0]).toContain('否定、计划或不确定')
    }
  })

  it('区分已观察的物证与明确转入的后续猜测，不豁免证据内的否定', () => {
    const content = '两枚扣子的缺口朝向相同，这是唯一的物证，再往下猜，便没有凭据了。'
    expect(validateMemoryCandidate(content, candidate('“两枚扣子的缺口朝向相同”'))).toEqual([])
    expect(validateMemoryCandidate(content, candidate('再往下猜，便没有凭据了。'))[0]).toContain('不确定')
    const negated = '两枚扣子的缺口朝向并未相同，再往下猜，便没有凭据了。'
    expect(validateMemoryCandidate(negated, candidate('两枚扣子的缺口朝向并未相同'))[0]).toContain('否定')
    const qualified = '两枚扣子的缺口朝向相同，可能只是巧合。'
    expect(validateMemoryCandidate(qualified, candidate('两枚扣子的缺口朝向相同'))[0]).toContain('不确定')
  })
})

/**
 * 旧实现把否定/计划/推测拿去匹配引文所在的整句，还把回退句首只认「。」和换行。
 * 网文正文里「没有/可能/打算」密度极高、对话段又常以「？！」断句，于是一整段里
 * 出现一次「没有」，同段后面每条证据都被判「证据不足」——实测一章十几条能挡掉一半。
 */
describe('否定与推测的作用范围', () => {
  it('引文自带逗号时，后续小句的否定不应污染已发生动作', () => {
    const content = '参谋长将行军路线改到河西，没有进入县城。'
    for (const evidence of ['参谋长将行军路线改到河西', '参谋长将行军路线改到河西，']) {
      expect(validateMemoryCandidate(content, candidate(evidence))).toEqual([])
    }
    const uncertain = '参谋长将行军路线改到河西，可能只是传闻。'
    expect(validateMemoryCandidate(uncertain, candidate('参谋长将行军路线改到河西，'))[0]).toContain('不确定')
    const planned = '参谋长打算将行军路线改到河西，没有进入县城。'
    expect(validateMemoryCandidate(planned, candidate('将行军路线改到河西，'))[0]).toContain('不确定')
  })
  it('前一小句的否定管不到引文所在的小句', () => {
    const content = '林昭没有回头，反手一掌拍在石壁上，掌印深入三寸。'
    expect(validateMemoryCandidate(content, candidate('反手一掌拍在石壁上'))).toEqual([])
    expect(validateMemoryCandidate(content, candidate('掌印深入三寸'))).toEqual([])
    // 否定紧贴引文时照旧拦下
    expect(validateMemoryCandidate(content, candidate('回头，反手一掌拍在石壁上'))[0]).toContain('否定')
  })

  it('句子边界认全「？！…」，上下文不再跨句蔓延', () => {
    const content = '你要杀我？赵铁山退了一步，他没有带剑！林昭一掌拍出，将石壁震得粉碎。'
    expect(validateMemoryCandidate(content, candidate('林昭一掌拍出，将石壁震得粉碎'))).toEqual([])
    expect(validateMemoryCandidate(content, candidate('赵铁山退了一步'))).toEqual([])
    const ellipsis = '他终究没有拔刀……刀鞘扣回腰间，他转身走了。'
    expect(validateMemoryCandidate(ellipsis, candidate('刀鞘扣回腰间'))).toEqual([])
  })

  it('转述与计划仍笼罩同句后文，语气词仍削弱同句断言', () => {
    // 「听说/打算/如果」管到它之后的整句
    expect(validateMemoryCandidate('众人听说，林远已经死在山洞里。', candidate('林远已经死在山洞里'))[0])
      .toContain('不确定')
    expect(validateMemoryCandidate('他打算，明日便将玉牌交给林昭。', candidate('将玉牌交给林昭'))[0])
      .toContain('不确定')
    expect(validateMemoryCandidate('如果剑再快半寸，苏清月的左臂便断了。', candidate('苏清月的左臂便断了'))[0])
      .toContain('不确定')
    // 引文之后的语气词照旧算数（断言本身被削弱）
    expect(validateMemoryCandidate('他踏入了炼气七层，也许只是回光返照。', candidate('他踏入了炼气七层'))[0])
      .toContain('不确定')
  })

  /**
   * 闸门防的是「截掉否定词制造既成事实」。记忆本身记的就是否定事实时（「未流血」
   * 「许可缺失而不可用」），引文当然带否定词——提取提示词还专门要求保留否定词。
   * 旧实现一律拦下，实测这是「证据不足」的最大来源。
   */
  it('断言与引文同为否定时放行，断言是肯定的仍然拦下', () => {
    const content = '纸羽在她腕骨上磨出数道细口，伤处没有流血，只翻起几层发白的纸边。'
    const state = (newValue: string) =>
      parseMemoryExtractionJson(
        JSON.stringify({
          newPlotPoints: [],
          characterStateChanges: [
            { name: '芦小默', field: '伤势', oldValue: '右腕完好', newValue, evidence: '伤处没有流血' }
          ],
          collectedForeshadowings: []
        }),
        1
      )
    expect(validateMemoryCandidate(content, state('右腕磨出细口，未流血'))).toEqual([])
    expect(validateMemoryCandidate(content, state('右腕大量失血'))[0]).toContain('否定')
    // 旧值里的否定说的是变化之前，不能拿来豁免
    const oldOnly = parseMemoryExtractionJson(
      JSON.stringify({
        newPlotPoints: [],
        characterStateChanges: [
          { name: '芦小默', field: '伤势', oldValue: '未受伤', newValue: '右腕大量失血', evidence: '伤处没有流血' }
        ],
        collectedForeshadowings: []
      }),
      1
    )
    expect(validateMemoryCandidate(content, oldOnly)[0]).toContain('否定')
  })

  it('断言是否定式也挡不住转述与推测', () => {
    const hearsay = '众人听说，那道许可始终没有打开。'
    const extraction = parseMemoryExtractionJson(
      JSON.stringify({
        newPlotPoints: [],
        characterStateChanges: [
          { name: '文真', field: '能力', oldValue: '未知', newValue: '许可缺失，无法登台', evidence: '那道许可始终没有打开' }
        ],
        collectedForeshadowings: []
      }),
      1
    )
    expect(validateMemoryCandidate(hearsay, extraction)[0]).toContain('不确定')
  })

  it('同一小句内引文之后的否定仍然拦下', () => {
    const content = '参谋长将行军路线改到河西的计划没有实现。'
    expect(validateMemoryCandidate(content, candidate('将行军路线改到河西'))[0]).toContain('否定')
    // 但后一小句的否定说的是别的事，不该连坐
    expect(validateMemoryCandidate('林远把钥匙交给沈青，沈青没有说话。', candidate('林远把钥匙交给沈青'))).toEqual([])
  })
})

/**
 * 界面按 itemIssues.length 报「N 项证据不足未写入」。
 * 旧实现对原因字符串做 new Set 去重：两条不同的记忆给出同样的原因（同名情节、
 * 同一人物的同一字段）会被并成一条，5 条被挡只报 2 项；反过来一条条目有两个原因
 * 又会被算成 2 项。两头都对不上真实条目数。
 */
describe('被挡条目的计数口径', () => {
  it('原因相同的不同条目各算一项', () => {
    const content = '林远推开木门走进院子。'
    const extraction = parseMemoryExtractionJson(
      JSON.stringify({
        newPlotPoints: [],
        characterStateChanges: [
          { name: '林远', field: '伤势', oldValue: '', newValue: '重伤', evidence: '林远被砍成重伤' },
          { name: '林远', field: '伤势', oldValue: '', newValue: '濒死', evidence: '林远气息全无' }
        ],
        collectedForeshadowings: []
      }),
      1
    )
    const { itemIssues } = partitionMemoryCandidate(content, extraction)
    expect(itemIssues).toHaveLength(2)
    expect(itemIssues[0]).toBe(itemIssues[1])
  })

  it('一条条目的多个原因合并成一项', () => {
    const content = '林远推开木门走进院子。'
    const extraction = parseMemoryExtractionJson(
      JSON.stringify({
        newPlotPoints: [],
        characterStateChanges: [],
        // 引文定位不到 + 回收章节不是本章：两个原因，仍然只是一条被挡下的记忆
        collectedForeshadowings: [
          { foreshadowingId: 'F1', content: '行囊里装了什么', chapter: 2, evidence: '林远打开了行囊' }
        ]
      }),
      1
    )
    const { itemIssues } = partitionMemoryCandidate(content, extraction)
    expect(itemIssues).toHaveLength(1)
    expect(itemIssues[0]).toContain('正文原文依据')
    expect(itemIssues[0]).toContain('回收章节与当前章不符')
  })
})

describe('记忆候选分级：条目级问题不连坐整章', () => {
  const content = '林远推开木门走进院子，放下行囊。'

  function mixed() {
    return parseMemoryExtractionJson(
      JSON.stringify({
        // 新角色/地点/物品/伏笔本来就不要求证据，不该被别人的失败带走
        newCharacters: [{ name: '林远', role: '主角', identity: '游侠', personality: '寡言' }],
        newLocations: [{ name: '院子' }],
        newForeshadowings: [{ content: '行囊里装了什么' }],
        newPlotPoints: [
          { title: '进院', event: '林远进院', evidence: '林远推开木门走进院子' },
          { title: '虚构', event: '林远拔刀', evidence: '林远拔刀砍翻了三个人' }
        ],
        characterStateChanges: [],
        collectedForeshadowings: []
      }),
      1
    )
  }

  it('坏条目被剔除，好条目与免证据条目照常保留', () => {
    const { chapterIssues, itemIssues, verified } = partitionMemoryCandidate(content, mixed())
    expect(chapterIssues).toEqual([])
    expect(itemIssues).toHaveLength(1)
    expect(itemIssues[0]).toContain('虚构')
    // 关键回归：旧实现下这一条会让整章 6 条记忆全部不入库
    expect(verified.newPlotPoints.map((p) => p.title)).toEqual(['进院'])
    expect(verified.newCharacters).toHaveLength(1)
    expect(verified.newLocations).toHaveLength(1)
    expect(verified.newForeshadowings).toHaveLength(1)
  })

  it('正文本身可疑（自检未过 / 审稿报错 / 解析失败）仍然一票否决整章', () => {
    const failedSelfCheck = {
      schemaVersion: 1 as const,
      chapterNumber: 1,
      generatedAt: '',
      counts: { pass: 0, warn: 0, fail: 1, skip: 0 },
      items: [
        { id: 'x', category: 'continuity' as const, label: '前后衔接', verdict: 'fail' as const, detail: '断了' }
      ],
      ok: false,
      summary: ''
    }
    const bySelfCheck = partitionMemoryCandidate(content, mixed(), [], failedSelfCheck)
    expect(bySelfCheck.chapterIssues.join('')).toContain('正文自检待核对')

    const byReview = partitionMemoryCandidate(content, mixed(), [
      { category: 'llm_review', severity: 'error', message: '角色崩坏' }
    ])
    expect(byReview.chapterIssues.join('')).toContain('审稿待核对')

    const broken = parseMemoryExtractionJson('不是 JSON', 1)
    expect(partitionMemoryCandidate(content, broken).chapterIssues).toHaveLength(1)
  })
})

/**
 * 真实项目（连写十章）里被挡下的条目，二十条全是误伤：
 * 多句引文里一句带「如果/可能」就整条作废；性格/关系这类「克制型」断言
 * （不追问、不替她选）的引文天然带「没有」。
 */
describe('多句引文与克制型断言（真实回归案例）', () => {
  function state(newValue: string, evidence: string) {
    return parseMemoryExtractionJson(
      JSON.stringify({
        newPlotPoints: [],
        characterStateChanges: [{ name: '乔晚', field: '关系', oldValue: '', newValue, evidence }],
        collectedForeshadowings: []
      }),
      1
    )
  }

  it('多句引文里只要有一句是既成事实就放行', () => {
    const content = '许宴停在玄关。\n“合作名单上有我前任，陆恺。他在这次展会里，周六可能碰见。”\n她把话说完。'
    const evidence = '“合作名单上有我前任，陆恺。他在这次展会里，周六可能碰见。”'
    expect(validateMemoryCandidate(content, state('陆恺是乔晚的前任', evidence))).toEqual([])
    // 每一句都被推测笼罩时照旧拦下
    const allHedged = '他可能是我前任。周六也许碰见。'
    expect(validateMemoryCandidate(allHedged, state('陆恺是乔晚的前任', allHedged))[0]).toContain('不确定')
  })

  it('引文自己开头写着的否定不算截断，引文落在后面已发生的动作上', () => {
    const content = '许宴没有替她选，只在她腾不开手时帮忙托着文件夹。'
    expect(validateMemoryCandidate(content, state('只在需要时提供辅助', content))).toEqual([])
    // 截掉否定词制造的既成事实仍然拦下
    expect(validateMemoryCandidate(content, state('替乔晚挑选材料', '替她选，只在她腾不开手时帮忙托着文件夹'))[0])
      .toContain('否定')
  })

  it('断言本身是「不做某事」时，与引文里的「没有」对得上', () => {
    const content = '他没有问分手的事，也没有追问陆恺到底会说什么。'
    expect(validateMemoryCandidate(content, state('克制，不追问乔晚的私事', content))).toEqual([])
    expect(validateMemoryCandidate(content, state('追问了分手原因', content))[0]).toContain('否定')
  })
})
