import { formatChapterProse } from '../src/shared/format-chapter-prose'
import { describe, expect, it, vi } from 'vitest'
import { applyDialoguePatches, applyExactDialoguePatches, dialogueRatioPassed, ensureDialogueQuality, measureDialogue } from '../src/main/data/dialogue-quality'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import type { GenerateOptions, LlmService } from '../src/main/data/llm-service'

const prose = (spoken: number, narration: number): string => `“${'我'.repeat(spoken)}”\n\n${'他'.repeat(narration)}。`
const llmWith = (fn: (prompt: string, opts: GenerateOptions) => string | Promise<string>): LlmService =>
  ({ generateStream: vi.fn((prompt: string, opts: GenerateOptions) => opts?.meta?.feature === 'deslop:scene-dialogue-review' ? JSON.stringify({ passed: true, assessment: '测试替身：仅供编排验证，不证明文本自然', reviewedPassages: [{ excerpt: prompt.split('【待审核稿】\n\n').at(-1), reason: '测试替身明确返回对本次候选的复核证据' }], findings: [] }) : fn(prompt, opts)) }) as unknown as LlmService
const passed = JSON.stringify({ passed: true, factsUnchanged: true, issues: [], expressionFindings: [] })

describe('对白计量与自动验收', () => {
  it('事实局部修复必须全部唯一命中，重叠或任一缺失时整组拒绝', () => {
    expect(applyExactDialoguePatches('甲乙丙丁', [{ before: '甲', after: '一' }, { before: '丁', after: '四' }])).toBe('一乙丙四')
    expect(applyExactDialoguePatches('甲乙丙丁', [{ before: '甲', after: '一' }, { before: '不存在', after: '四' }])).toBeNull()
    expect(applyExactDialoguePatches('甲乙丙丁', [{ before: '甲乙', after: '一' }, { before: '乙丙', after: '二' }])).toBeNull()
    expect(applyExactDialoguePatches('甲甲', [{ before: '甲', after: '一' }])).toBeNull()
    expect(applyExactDialoguePatches('甲乙丙丁', [{ before: '甲', after: '' }, { before: '丁', after: '四' }])).toBe('乙丙四')
    expect(applyExactDialoguePatches('甲乙', [{ before: '甲' }])).toBeNull()
  })
  it('整章修复保留被打断台词的原始语义，先交模型按功能改写而非机械改句号', async () => {
    const source = '“申会长，这份卷宗需要您——”\n金锡勋看见了车道贤，后半句没说出来。'
    const llm = llmWith(() => '{}')
    await new DeslopService(llm).deslop(source, { dialogueComposition: { mode: 'edit' } })
    const prompt = vi.mocked(llm.generateStream).mock.calls.find(([,opts]) => opts?.meta?.feature === 'deslop:dialogue-repair')![0]
    expect(prompt.split('【本次正文】').at(-1)).toContain('“申会长，这份卷宗需要您——”')
    expect(prompt).toContain('被下一句或动作打断')
  })
  it('保留有后续回应的句末打断标点，但仍进行语义审核', async () => {
    const source = `“${'我'.repeat(70)}——”\n${'他'.repeat(30)}。`
    const llm = llmWith((_prompt, opts) => opts?.meta?.feature === 'deslop:dialogue-review' ? passed : '{}')
    const result = await new DeslopService(llm).deslop(source, { dialogueComposition: { mode: 'edit' } })
    expect(result.rewritten).toBe(source)
    expect(result.dialogueQuality?.passed).toBe(true)
    expect(result.remainingFindings).toHaveLength(0)
    expect(vi.mocked(llm.generateStream).mock.calls.map(([, opts]) => opts?.meta?.feature)).toEqual(['deslop:dialogue-review', 'deslop:scene-dialogue-review'])
  })
  it('自动检查点恢复仍对照最初原稿，不能把恢复稿当作新的事实基线', async () => {
    const source = prose(40, 60)
    const draft = prose(70, 30)
    const llm = llmWith(() => passed)
    const result = await new DeslopService(llm).deslop(source, {
      dialogueComposition: { mode: 'write' }, initialDialogueDraft: draft
    })
    expect(result.dialogueQuality).toMatchObject({ passed: true, beforeRatio: 0.4, afterRatio: 0.7 })
    const prompt = vi.mocked(llm.generateStream).mock.calls[0][0]
    expect(prompt).toContain(`【原稿事实基线】\n\n${source}`)
    expect(prompt).toContain(`【待审核稿】\n\n${formatChapterProse(draft)}`)
  })
  it('只应用唯一匹配且朝目标改善的局部提案，拒绝伪匹配和反向改坏', () => {
    const source = prose(40, 60)
    expect(applyDialoguePatches(source, [{ before: source, after: prose(70, 30) }])).toBe(prose(70, 30))
    expect(applyDialoguePatches(source, [{ before: '没有这句话', after: prose(70, 30) }])).toBe(source)
    expect(applyDialoguePatches(source, [{ before: source, after: prose(20, 80) }])).toBe(source)
    expect(applyDialoguePatches(source, [{ before: '我', after: '他说' }])).toBe(source)
    expect(applyDialoguePatches(source, [{ before: source, after: prose(140, 60) }], '', { min: 85, max: 115 })).toBe(source)
    expect(applyDialoguePatches(source, [{ before: source, after: prose(70, 30) }], '', { min: 85, max: 115 })).toBe(prose(70, 30))
  })
  it('语义修复在比例合格范围内优先解决所有问题，不能只挑最靠近70%的修改', () => {
    const source = prose(70, 30)
    const patches = [{ before: `“${'我'.repeat(70)}”`, after: `“${'我'.repeat(69)}”` },
      { before: `${'他'.repeat(30)}。`, after: `${'他'.repeat(31)}。` }]
    const result = applyDialoguePatches(source, patches, '', { min: 85, max: 115, preferCoverage: true })
    expect(measureDialogue(result).ratio).toBe(0.69)
  })
  it('只算直接台词，不把文件名、心声、通知或标题当成对白', () => {
    const measured = measureDialogue('“别走！”\n他问：“去哪？”\n封面写着“加急”。\n【系统：“到账”】\n她心想：“回来”。')
    expect(measured.dialogue).toBe(4)
    expect(measured.total).toBeGreaterThan(4)
  })
  it('支持日式、英文与跨行对白，未闭合引号不算已完成台词', () => {
    expect(measureDialogue('「你好」\n"回来"\n“我\n们走”').dialogue).toBe(7)
    expect(measureDialogue('“还没说完').dialogue).toBe(0)
  })
  it('按字数而非段数验收，边界固定为69%到71%', () => {
    expect(measureDialogue(prose(70, 30)).ratio).toBe(0.7)
    expect(dialogueRatioPassed(0.69)).toBe(true)
    expect(dialogueRatioPassed(0.71)).toBe(true)
    expect(dialogueRatioPassed(0.6899)).toBe(false)
    expect(dialogueRatioPassed(0.7101)).toBe(false)
  })
  it('不足或过多均自动重写后实测，不相信模型宣称达标', async () => {
    for (const spoken of [40, 90]) {
      const source = prose(spoken, 100 - spoken)
      const llm = llmWith((_p, o) => o.meta?.feature === 'deslop:dialogue-review' ? passed : JSON.stringify({ text: prose(70, 30) }))
      const result = await ensureDialogueQuality(source, source, llm, { mode: 'write' })
      expect(result.report.passed).toBe(true)
      expect(measureDialogue(result.text).ratio).toBe(0.7)
      expect(result.report.attempts).toBe(1)
    }
  })
  it('比例已达标但机械同腔时仍自动修复并重新审稿', async () => {
    let reviews = 0
    const source = prose(70, 30)
    const llm = llmWith((_p, o) => o.meta?.feature === 'deslop:dialogue-review'
      ? ++reviews === 1 ? JSON.stringify({ passed: false, factsUnchanged: true, expressionFindings: [], issues: ['两人轮流宣读背景，没有回应对方的关注点。'] }) : passed
      : JSON.stringify({ text: source.replace('我', '你') }))
    const result = await ensureDialogueQuality(source, source, llm, { mode: 'edit' })
    expect(result.report.passed).toBe(true)
    expect(reviews).toBe(2)
    expect(result.report.attempts).toBe(1)
  })
  it('两次修复预算耗尽仍未达标时保留原稿', async () => {
    const source = prose(40, 60)
    const drafts = [prose(50, 50), prose(60, 40), prose(70, 30), prose(70, 30).replace('我', '你')]
    let reviewCount = 0
    const llm = llmWith((_p, o) => o.meta?.feature === 'deslop:dialogue-review'
      ? ++reviewCount === 1 ? JSON.stringify({ passed: false, factsUnchanged: true, expressionFindings: [], issues: ['新增了原稿未确定的人数比例。'] }) : passed
      : JSON.stringify({ text: drafts.shift() }))
    const result = await ensureDialogueQuality(source, source, llm, { mode: 'write' })
    expect(result.report.passed).toBe(false)
    expect(result.text).toBe(source)
    expect(result.report.attempts).toBe(2)
    expect(reviewCount).toBe(0)
  })
  it('事实审核不通过、无法解析或一直不达标时有界失败，保留原文', async () => {
    for (const review of [JSON.stringify({ passed: false, factsUnchanged: true, expressionFindings: [], issues: ['把妹妹获奖改成本人获奖。'] }), '不确定', JSON.stringify({ passed: true, factsUnchanged: false, expressionFindings: [], issues: ['还有事实差异'] })]) {
      const source = prose(70, 30)
      const llm = llmWith((_p, o) => o.meta?.feature === 'deslop:dialogue-review' ? review : JSON.stringify({ text: source }))
      const result = await ensureDialogueQuality(source, source, llm, { mode: 'edit' })
      expect(result.report.passed).toBe(false)
      expect(result.text).toBe(source)
      expect(result.report.attempts).toBe(review === '不确定' ? 0 : 2)
    }
    const source = prose(40, 60)
    const llm = llmWith(() => JSON.stringify({ text: source, ratio: 0.7 }))
    expect((await ensureDialogueQuality(source, source, llm, { mode: 'write' })).report.passed).toBe(false)
    expect(vi.mocked(llm.generateStream).mock.calls.filter(([,opts]) => opts?.meta?.feature === 'deslop:dialogue-repair')).toHaveLength(2)
  })
  it('续写以完整章节验收，前部不进入替换正文', async () => {
    const prefix = prose(90, 10)
    const source = prose(40, 60)
    const replacement = prose(50, 50)
    const llm = llmWith((_p, o) => o.meta?.feature === 'deslop:dialogue-review' ? passed : JSON.stringify({ text: replacement }))
    const result = await ensureDialogueQuality(source, source, llm, { mode: 'write', existingText: prefix })
    expect(result.text.replace(/\s/g, '')).toBe(formatChapterProse(replacement).replace(/\s/g, ''))
    expect(measureDialogue(`${prefix}\n${result.text}`).ratio).toBe(0.7)
    expect(result.report.beforeRatio).toBe(0.65)
  })
  it('排版和复扫之后再验收，复扫残留不能算通过', async () => {
    const source = prose(70, 30)
    let scans = 0
    const llm = llmWith((_p, o) => o.meta?.feature === 'deslop:dialogue-review' ? passed : JSON.stringify({ text: source }))
    const result = await ensureDialogueQuality(source, source, llm, { mode: 'edit', validate: async () => ++scans === 1 ? ['套话未清除'] : [] })
    expect(result.report.passed).toBe(true)
    expect(scans).toBe(2)
  })
  it('拒绝用扩写或大量删除凑比例', async () => {
    const source = prose(40, 60)
    const llm = llmWith(() => JSON.stringify({ text: prose(140, 60) }))
    const result = await ensureDialogueQuality(source, source, llm, { mode: 'edit' })
    expect(result.report.passed).toBe(false)
    expect(result.text).toBe(source)
  })
  it('取消审核与修复均传播取消，不返回伪通过稿', async () => {
    const controller = new AbortController()
    const source = prose(70, 30)
    const llm = llmWith(() => { controller.abort(); return passed })
    await expect(ensureDialogueQuality(source, source, llm, { mode: 'write', signal: controller.signal })).rejects.toThrow('LLM_ABORTED')
  })
  it('整章去AI味入口共享验收，失败有blocking报告', async () => {
    const source = prose(40, 60)
    const llm = llmWith(() => JSON.stringify({ text: source }))
    const result = await new DeslopService(llm).deslop(source, { dialogueComposition: { mode: 'edit' } })
    expect(result.dialogueQuality?.passed).toBe(false)
    expect(result.remainingFindings.some(f => f.type === 'dialogue-quality-incomplete' && f.severity === 'blocking')).toBe(true)
    expect(result.rewritten).toBe(source)
  })
})
