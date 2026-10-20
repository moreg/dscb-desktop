import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { ChapterSummaryRepo } from '../src/main/data/memory/chapter-summary-repo'
import { hashProse, listProseSources } from '../src/main/data/memory/prose-memory-index'
import { buildContinuityContext, parseContinuityFacts, assertSummaryKnowledgeCoverage } from '../src/main/data/memory/continuity-context'
import type { ContinuityFact } from '../src/shared/types'

describe('长期连续性记忆', () => {
  it('真实提取回归：不知情写在未结线索中也必须进入逐人台账', () => {
    const fact = { text: '陆宁仍在南关，尚未收到消息，仍不知道内应身份。', evidence: '陆宁此时仍在远处的南关，没有收到消息，仍不知道内应是谁。' }
    const summary = { schemaVersion: 1 as const, chapterNumber: 640, sourceHash: '', generatedAt: '',
      events: [], stateChanges: [], openThreads: [fact], continuity: [] as ContinuityFact[] }
    const vocabulary = ['- [人物认知 · 最近可核实记录，不等于完整现状] 陆宁 → 内应身份 · 知情程度：不知']
    expect(() => assertSummaryKnowledgeCoverage(summary, vocabulary)).toThrow('陆宁的知情事实缺少对应连续性台账')
    summary.continuity.push({ kind: 'knowledge', subject: '陆宁', object: '内应身份', aspect: '知情程度', value: '仍不知', evidence: fact.evidence })
    expect(() => assertSummaryKnowledgeCoverage(summary, vocabulary)).not.toThrow()
    // Merely naming someone in another person's discovery does not assert their knowledge.
    summary.openThreads = [{ text: '陆安得知陆宁的行踪。', evidence: '陆安得知陆宁的行踪。' }]
    expect(() => assertSummaryKnowledgeCoverage(summary, vocabulary)).not.toThrow()
  })
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'continuity-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
  async function save(chapter: number, prose: string, facts: ContinuityFact[]) {
    await new ProseRepo(dir).write(chapter, prose)
    await new ChapterSummaryRepo(dir).write({ schemaVersion: 1, chapterNumber: chapter,
      sourceHash: hashProse(prose), generatedAt: '', events: [], stateChanges: [], openThreads: [], continuity: facts })
  }
  const item = (value: string, evidence: string, subject = '青铜钥匙'): ContinuityFact => ({
    kind: 'item', subject, object: '', aspect: '持有者', value, evidence
  })
  const query = { text: '陆安要寻找青铜钥匙', characters: ['陆安'], aliases: [], props: [] }
  const context = async (chapter = 100) => (await buildContinuityContext(dir, chapter, query)).join('\n')

  it('跨几十章追踪转交链，最后持有人不出场也能带入，最新记录先于旧记录', async () => {
    await save(3, '陆安把青铜钥匙收进内袋。', [item('陆安', '陆安把青铜钥匙收进内袋。')])
    await save(8, '陆安把青铜钥匙交给妹妹陆宁保管。', [item('陆宁（保管，所有权未变）', '陆安把青铜钥匙交给妹妹陆宁保管。')])
    await save(65, '陆宁把青铜钥匙交还给守门人赵伯。', [item('赵伯', '陆宁把青铜钥匙交还给守门人赵伯。')])
    const text = await context()
    const ledger = text.split('## 历史正文专项证据')[0]
    expect(ledger).toContain('持有者：赵伯')
    expect(ledger).toContain('第 65 章')
    expect(ledger.indexOf('持有者：赵伯')).toBeLessThan(ledger.indexOf('持有者：陆宁'))
    expect(text).toContain('持有者不等于所有者')
  })

  it('区分单向关系及知情/误信，不自动合并不同人物的认知', async () => {
    const prose = '陆安信任陆宁，陆宁却仍怀疑陆安。陆安看清密信，得知赵伯就是内应。陆宁误以为内应是船夫。'
    await save(5, prose, [
      { kind: 'relationship', subject: '陆安', object: '陆宁', aspect: '信任', value: '信任', evidence: '陆安信任陆宁，陆宁却仍怀疑陆安。' },
      { kind: 'relationship', subject: '陆宁', object: '陆安', aspect: '信任', value: '仍怀疑', evidence: '陆安信任陆宁，陆宁却仍怀疑陆安。' },
      { kind: 'knowledge', subject: '陆安', object: '内应身份', aspect: '知情程度', value: '已知赵伯是内应，来源密信', evidence: '陆安看清密信，得知赵伯就是内应。' },
      { kind: 'knowledge', subject: '陆宁', object: '内应身份', aspect: '知情程度', value: '误信船夫是内应', evidence: '陆宁误以为内应是船夫。' }
    ])
    const text = await context()
    expect(text).toContain('陆安 → 陆宁 · 信任：信任')
    expect(text).toContain('陆宁 → 陆安 · 信任：仍怀疑')
    expect(text).toContain('陆安 → 内应身份 · 知情程度：已知赵伯')
    expect(text).toContain('陆宁 → 内应身份 · 知情程度：误信船夫')
    expect(text).toContain('一个人知道不代表其他人知道')
  })

  it('写回旧章不读未来变化，改写和删除的正文使旧记录失效', async () => {
    await save(3, '陆安把青铜钥匙收进内袋。', [item('陆安', '陆安把青铜钥匙收进内袋。')])
    await save(65, '陆宁把青铜钥匙交给赵伯。', [item('赵伯', '陆宁把青铜钥匙交给赵伯。')])
    expect(await context(30)).not.toContain('赵伯')
    await new ProseRepo(dir).write(65, '陆宁推开院门，望向空荡的街道。')
    expect(await context()).not.toContain('赵伯')
    const source = (await listProseSources(dir)).find((s) => s.chapterNumber === 3)!
    await rm(join(dir, source.sourcePath))
    expect(await context()).not.toContain('持有者：陆安')
  })

  it('一个人从误信转为已知时保留变化依据，其他人的认知不被覆盖', async () => {
    const first = '陆安误以为内应是船夫，陆宁却早知道内应就是赵伯。'
    const belief: ContinuityFact = { kind: 'knowledge', subject: '陆安', object: '内应身份', aspect: '知情程度', value: '误信船夫是内应', evidence: first }
    await save(3, first, [belief, { ...belief, subject: '陆宁', value: '已知赵伯是内应' }])
    const later = '陆安看清密信，终于知道赵伯才是内应。'
    await save(60, later, [{ ...belief, value: '已知赵伯是内应，来源密信', evidence: later }])
    const text = (await context()).split('## 历史正文专项证据')[0]
    expect(text).toContain('陆宁 → 内应身份 · 知情程度：已知赵伯是内应')
    expect(text.indexOf('知情程度：已知赵伯是内应，来源密信')).toBeLessThan(text.indexOf('知情程度：误信船夫是内应'))
    expect(await context(30)).not.toContain('终于知道赵伯')
  })

  it('旧书没有结构化概要时，专项检索独立保留早期转交和后续状态，不被重复战斗淹没', async () => {
    await new ProseRepo(dir).write(3, '陆安把青铜钥匙交给妹妹保管，自己空着手离开。')
    for (let n = 10; n <= 70; n++) await new ProseRepo(dir).write(n, `陆安调查青铜钥匙的线索，第${n}次挥刀逼退敌人。`)
    await new ProseRepo(dir).write(75, '妹妹把青铜钥匙交给船夫，船夫把它藏在舱底。')
    const text = await context()
    expect(text).toContain('交给妹妹保管')
    expect(text).toContain('船夫把它藏在舱底')
    expect(text).toContain('旧章缺少有效结构化连续性记录')
  })

  it('记录超出预算时优先明确提到的古老道具，并明确提示覆盖不足', async () => {
    await save(3, '陆安把青铜钥匙交给妹妹陆宁。', [item('陆宁', '陆安把青铜钥匙交给妹妹陆宁。')])
    for (let n = 10; n <= 90; n++) {
      const prose = `陆安把第${n}件兵器交给守门人保管。`
      await save(n, prose, [item(`守门人，陆安此前曾持有。${'归属详情'.repeat(35)}`, prose, `兵器${n}`)])
    }
    const text = await context()
    expect(text).toContain('青铜钥匙 · 持有者：陆宁')
    expect(text).toMatch(/[1-9]\d* 组相关记录超出本次预算/)
    expect(text.length).toBeLessThan(14_000)
  })

  it('不接受无原文依据、错误主体结构和不完整条目', () => {
    const prose = '陆安把青铜钥匙交给妹妹陆宁。'
    expect(parseContinuityFacts([item('陆宁', prose)], prose)).toHaveLength(1)
    expect(() => parseContinuityFacts([item('陆宁', '钥匙被赵伯夺走了。')], prose)).toThrow('依据')
    expect(() => parseContinuityFacts([{ ...item('陆宁', prose), object: '陆宁' }], prose)).toThrow('object')
    expect(() => parseContinuityFacts([{ ...item('陆宁', prose), evidence: '钥匙' }], prose)).toThrow('依据')
    expect(() => parseContinuityFacts([{ kind: 'knowledge' }], prose)).toThrow('字段')
  })

  it('主线核对使用最近实际进展，排除未来、旧版本和伪造引句', async () => {
    for (const n of [3, 80, 90, 100]) {
      const prose = `陆安在第${n}站找到母亲留下的信件，继续循线寻找。`
      await save(n, prose, [])
      const repo = new ChapterSummaryRepo(dir)
      const summary = (await repo.read(n))!
      await repo.write({ ...summary, events: [
        { text: `第${n}站找到信件`, evidence: prose },
        { text: '伪造已经放弃寻找', evidence: '陆安宣布不再寻找母亲，转而卖画。' }
      ] })
    }
    const trajectory = (await buildContinuityContext(dir, 100, { ...query, includeTrajectory: true })).join('\n')
    expect(trajectory).toContain('最近阶段实际进展')
    expect(trajectory).toContain('第90站找到信件')
    expect(trajectory).not.toContain('第100站找到信件')
    expect(trajectory).not.toContain('伪造已经放弃寻找')
    await new ProseRepo(dir).write(90, '陆安到了驿站，却没有找到任何信件。')
    expect((await buildContinuityContext(dir, 100, { ...query, includeTrajectory: true })).join('\n')).not.toContain('第90站找到信件')
  })

  it('知情别名归一后以最近记录为准，独立预算不被主角大量道具挤掉', async () => {
    const first = '夜鸦误以为内应就是船夫，苏绫却不知道内应是谁。'
    const known = '陆安读完密信，终于得知赵伯才是内应。'
    await save(3, first, [
      { kind: 'knowledge', subject: '夜鸦', object: '内应身份', aspect: '知情程度', value: '误信船夫是内应', evidence: first },
      { kind: 'knowledge', subject: '苏绫', object: '内应身份', aspect: '知情程度', value: '不知道内应身份', evidence: first }
    ])
    await save(70, known, [{ kind: 'knowledge', subject: '陆安', object: '内应身份', aspect: '知情程度', value: '已知赵伯是内应', evidence: known }])
    for (let n = 80; n < 100; n++) {
      const prose = `陆安将第${n}件兵器交给守门人保管。`
      await save(n, prose, [item('守门人保管', prose, `兵器${n}`)])
    }
    const text = (await buildContinuityContext(dir, 101, { text: '夜鸦与苏绫谈话', characters: ['陆安', '苏绫'],
      aliases: [{ name: '陆安', aliases: ['夜鸦'] }], props: [] })).join('\n')
    const matrix = text.split('## 本章人物知情边界')[1].split('- [')[0]
    expect(matrix).toContain('已知赵伯是内应')
    expect(matrix).toContain('苏绫 → 内应身份：不知道内应身份')
    expect(matrix).not.toContain('误信船夫是内应')
  })
})
