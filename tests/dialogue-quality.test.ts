import { formatChapterProse } from '../src/shared/format-chapter-prose'
import { describe, expect, it, vi } from 'vitest'
import { applyExactDialoguePatches, ensureDialogueQuality, measureDialogue } from '../src/main/data/dialogue-quality'
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
    const llm = llmWith((_p,o) => o.meta?.feature==='deslop:dialogue-review' ? JSON.stringify({passed:false,factsUnchanged:true,issues:['需核对打断台词的表达'],expressionFindings:[]}) : '{}')
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
  it.each([0, 0.4, 0.9, 1])('占比%s仅为统计，表达与事实通过时不触发修复', async ratio => {
    const source=prose(ratio*100,100-ratio*100)
    const llm=llmWith(()=>passed)
    const result=await ensureDialogueQuality(source,source,llm,{mode:'write'})
    expect(result.text).toBe(source)
    expect(result.report).toMatchObject({passed:true,attempts:0,beforeRatio:ratio,afterRatio:ratio})
    expect(vi.mocked(llm.generateStream).mock.calls.some(([,o])=>o?.meta?.feature==='deslop:dialogue-repair')).toBe(false)
  })
  it('低对白占比的事实漂移仍须拒绝，不因取消比例要求而放行',async()=>{
    const source='陆安继续调查六号船，并去柳湾埠核账。'
    const draft='陆安只去柳湾埠核账，不再调查六号船。'
    const llm=llmWith(()=>JSON.stringify({passed:false,factsUnchanged:false,issues:['仍要调查六号船被改为不再调查'],expressionFindings:[]}))
    const result=await ensureDialogueQuality(source,draft,llm,{mode:'edit',maxRepairs:0})
    expect(result.text).toBe(source)
    expect(result.report.passed).toBe(false)
    expect(result.factsUnchanged).toBeUndefined()
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
  it('计量仅作展示，仍按实际台词字数统计',()=>{
    expect(measureDialogue(prose(40,60)).ratio).toBe(0.4)
    expect(measureDialogue(prose(90,10)).ratio).toBe(0.9)
  })
  it('修复提示不要求补足对白字数，也不以占比筛掉必要修复',async()=>{
    const source=prose(40,60),revised=source.replace('我','你')
    let reviews=0
    const llm=llmWith((_p,o)=>o.meta?.feature==='deslop:dialogue-review'
      ? ++reviews===1?JSON.stringify({passed:false,factsUnchanged:true,issues:['复述无用途'],expressionFindings:[]}):passed
      :JSON.stringify({patches:[{before:source,after:revised}]}))
    const result=await ensureDialogueQuality(source,source,llm,{mode:'write'})
    expect(result.report).toMatchObject({passed:true,attempts:1,afterRatio:0.4})
    const prompt=vi.mocked(llm.generateStream).mock.calls.find(([,o])=>o?.meta?.feature==='deslop:dialogue-repair')![0]
    expect(prompt).toContain('本次修复仅在事实与篇幅保真范围内改善表达')
    expect(prompt).not.toMatch(/目标70%|69%—71%|当前差额|合计至少覆盖/)
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
  it('两次修复仍未解决具体表达问题时保留原稿',async()=>{
    const source=prose(40,60)
    const llm=llmWith((_p,o)=>o.meta?.feature==='deslop:dialogue-review'
      ? JSON.stringify({passed:false,factsUnchanged:true,issues:['场景重复播报'],expressionFindings:[]})
      :JSON.stringify({text:source}))
    const result=await ensureDialogueQuality(source,source,llm,{mode:'write'})
    expect(result.report).toMatchObject({passed:false,attempts:2})
    expect(result.text).toBe(source)
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
    expect(vi.mocked(llm.generateStream).mock.calls.filter(([,opts]) => opts?.meta?.feature === 'deslop:dialogue-repair')).toHaveLength(0)
  })
  it('续写以完整章节验收，前部不进入替换正文', async () => {
    const prefix = prose(90, 10)
    const source = prose(40, 60)
    const replacement = prose(50, 50)
    const llm = llmWith((_p, o) => o.meta?.feature === 'deslop:dialogue-review' ? passed : JSON.stringify({ text: replacement }))
    const result = await ensureDialogueQuality(source, source, llm, { mode: 'write', existingText: prefix })
    expect(result.text).toBe(source)
    expect(measureDialogue(`${prefix}\n${result.text}`).ratio).toBe(0.65)
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
