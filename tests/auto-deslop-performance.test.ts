import { describe, expect, it, vi } from 'vitest'
import { autoDeslopProse } from '../src/main/data/auto-deslop'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import { ensureDialogueQuality } from '../src/main/data/dialogue-quality'
import { contentRevision } from '../src/main/data/chapter-revision'
import { formatChapterProse } from '../src/shared/format-chapter-prose'
import type { GenerateOptions, LlmService } from '../src/main/data/llm-service'
import type { DeslopResult } from '../src/shared/types'

const prose = (spoken: number, narration: number): string => `“${'我'.repeat(spoken)}”\n${'他'.repeat(narration)}。`
const original = prose(65, 35)
const candidate = prose(70, 30)
const passed = { passed: true, factsUnchanged: true, issues: [], expressionFindings: [] }
const mockLlm = (reply: (prompt: string, opts: GenerateOptions) => string): LlmService =>
  ({ generateStream: vi.fn((prompt: string, opts: GenerateOptions) => opts.meta?.feature === 'deslop:scene-dialogue-review' ? JSON.stringify({ passed: true, assessment: '测试替身仅用于验证编排', reviewedPassages: [{ excerpt: prompt.split('【待审核稿】\n\n').at(-1), reason: '本次候选的连续段落已由测试替身明确确认' }], findings: [] }) : reply(prompt, opts)) }) as unknown as LlmService

describe('自动润色性能与核验复用', () => {
  it('缺少整章表达验收结果时不能仅凭正文护栏和事实检查采用',async()=>{
    const llm=mockLlm(()=>JSON.stringify({unchanged:true,issues:[]}))
    const output=await autoDeslopProse(original,{llm,validateCandidate:async()=>{},dialogueComposition:{mode:'write'},
      service:{deslop:async()=>({rewritten:candidate,beforeWords:100,afterWords:100,deleteRatio:0,
        processedGates:[],remainingFindings:[],changeSummary:[]})} as unknown as DeslopService})
    expect(output.content).toBe(original)
    expect(output.report.status).toBe('review_required')
    expect(llm.generateStream).not.toHaveBeenCalled()
  })
  it('对白归并叙述只减少标点时不误判篇幅超限，仍独立核对事实',async()=>{
    const source=Array(10).fill('“我记住了。”').join('\n')
    const draft=Array(10).fill('我记住了。').join('\n')
    const llm=mockLlm(()=>JSON.stringify({unchanged:true,issues:[]}))
    const output=await autoDeslopProse(source,{llm,validateCandidate:async()=>{},dialogueComposition:{mode:'write'},
      service:{deslop:async()=>({rewritten:draft,beforeWords:70,afterWords:50,deleteRatio:0,
        processedGates:[],remainingFindings:[],changeSummary:[],
        dialogueQuality:{passed:true,beforeRatio:1,afterRatio:0,attempts:0,issues:[]}})} as unknown as DeslopService})
    expect(output.report.status).toBe('applied')
    expect(output.content).toBe(draft)
    expect(llm.generateStream).toHaveBeenCalledOnce()
  })
  it('只改小数点也必须核对事实，不能当纯标点放行数值变化', async () => {
    const baseline='他交出1.5两银子。', rewritten='他交出15两银子。'
    const llm=mockLlm((_prompt,opts)=>JSON.stringify(opts.meta?.feature==='deslop:verify'
      ? {unchanged:false,issues:['原稿1.5两，候选15两，金额改变']} : {patches:[]}))
    const output=await autoDeslopProse(baseline,{
      service:{deslop:async()=>({rewritten,beforeWords:10,afterWords:10,deleteRatio:0,
        processedGates:[],remainingFindings:[],changeSummary:[]})} as unknown as DeslopService,
      llm,validateCandidate:async()=>{}
    })
    expect(output.content).toBe(baseline)
    expect(output.report.status).toBe('review_required')
    expect(output.report.verificationAttempts).toBe(1)
  })
  it('结构化验收失败不能靠遗漏提示文字或空复扫冒充通过', async () => {
    const rejected: DeslopResult={rewritten:candidate,beforeWords:100,afterWords:100,deleteRatio:0,
      processedGates:[],remainingFindings:[],changeSummary:[],
      dialogueQuality:{passed:false,beforeRatio:.65,afterRatio:.7,attempts:1,issues:['调查方向被删改']}}
    const llm=mockLlm(()=>JSON.stringify({unchanged:true,issues:[]}))
    const output=await autoDeslopProse(original,{service:{deslop:async()=>rejected} as unknown as DeslopService,
      llm,validateCandidate:async()=>{},dialogueComposition:{mode:'write'}})
    expect(output.content).toBe(original)
    expect(output.report.status).toBe('review_required')
    expect(output.report.issues).toContain('调查方向被删改')
    expect(llm.generateStream).toHaveBeenCalledOnce()
    expect(vi.mocked(llm.generateStream).mock.calls[0][1]?.meta?.feature).toBe('deslop:repair-plan')
  })
  it('真实编排中一次修复、事实对照与独立场景复核后交稿，扫描与正文护栏不重复', async () => {
    let reviews=0
    const llm = mockLlm((_prompt, opts) => opts.meta?.feature === 'deslop:repair-plan'
      ? JSON.stringify({facts:[{quote:original.split('\n')[0],keep:'保留原有发言'}],scenePlan:'合并重复表达'})
      : opts.meta?.feature === 'deslop:scene-repair'
      ? JSON.stringify({text:candidate,coverage:[{id:1,quote:candidate.split('\n')[0]}]})
      : opts.meta?.feature === 'deslop:dialogue-repair'
      ? JSON.stringify({ patches: [{ before: original, after: candidate }] })
      : opts.meta?.feature === 'deslop:verify' ? JSON.stringify({ unchanged: true, issues: [] })
      : JSON.stringify(++reviews===1 ? {passed:false,factsUnchanged:true,issues:['原稿重复说明，应整理表达'],expressionFindings:[]} : passed))
    const service = new DeslopService(llm)
    const scan = vi.spyOn(service, 'scan')
    const validateCandidate = vi.fn(async () => {})
    const output = await autoDeslopProse(original, {
      service, llm, validateCandidate, formatCandidate: formatChapterProse,
      dialogueComposition: { mode: 'write' }
    })
    expect(output.content).toBe(candidate)
    expect(output.report.status).toBe('applied')
    expect(vi.mocked(llm.generateStream).mock.calls.map(([, opts]) => opts?.meta?.feature))
      .toEqual(['deslop:dialogue-review', 'deslop:repair-plan', 'deslop:scene-repair', 'deslop:verify', 'deslop:dialogue-review', 'deslop:scene-dialogue-review'])
    expect(scan.mock.calls.map(([text]) => text)).toEqual([original, candidate])
    expect(validateCandidate).toHaveBeenCalledOnce()
    expect(validateCandidate).toHaveBeenCalledWith(candidate)
    const prompt = vi.mocked(llm.generateStream).mock.calls[4][0]
    expect(prompt).toContain('操作流水账')
    expect(prompt).toContain('配角轮流同义震惊')
    expect(prompt).toContain('必须给待审核稿逐字存在的原句及原因')
  })

  it('旧格式未明确确认事实与表达检查时直接待复核，不能靠额外事实检查放行', async () => {
    const llm = mockLlm((_prompt, opts) => opts.meta?.feature === 'deslop:dialogue-repair'
      ? JSON.stringify({ patches: [{ before: original, after: candidate }] })
      : opts.meta?.feature === 'deslop:verify' ? JSON.stringify({ unchanged: true, issues: [] })
        : JSON.stringify({ passed: true, issues: [] }))
    const output = await autoDeslopProse(original, {
      service: new DeslopService(llm), llm, validateCandidate: async () => {},
      dialogueComposition: { mode: 'write' }
    })
    expect(output.report.status).toBe('review_required')
    expect(output.report.dialogueQuality?.passed).toBe(false)
    expect(llm.generateStream).toHaveBeenCalledTimes(1)
  })

  it('无效修复未改变稿件时只审核一次，并将匹配失败反馈交给下一次修复', async () => {
    const llm = mockLlm((_prompt, opts) => opts.meta?.feature === 'deslop:dialogue-review'
      ? JSON.stringify({ passed: false, factsUnchanged: true, expressionFindings: [], issues: ['台词重复，未回应对方诉求'] })
      : JSON.stringify({ patches: [{ before: '没有这段原文', after: '不能应用的提案' }] }))
    const output = await ensureDialogueQuality(candidate, candidate, llm, { mode: 'write' })
    expect(output.text).toBe(candidate)
    expect(output.report).toMatchObject({ passed: false, attempts: 2 })
    const calls = vi.mocked(llm.generateStream).mock.calls
    expect(calls.filter(([, opts]) => opts?.meta?.feature === 'deslop:dialogue-review')).toHaveLength(1)
    expect(calls.filter(([, opts]) => opts?.meta?.feature === 'deslop:dialogue-repair')).toHaveLength(2)
    expect(calls.at(-1)?.[0]).toContain('上轮提案没有应用，原问题仍在')
  })

  it('有逐字证据的场景表达问题可以局部修复，事实一致不能掩盖表达不通过', async () => {
    const repaired = candidate.replace('我', '你')
    let reviews = 0
    const llm = mockLlm((_prompt, opts) => opts.meta?.feature === 'deslop:dialogue-review'
      ? JSON.stringify(++reviews === 1 ? {
        passed: false, factsUnchanged: true, issues: [], expressionFindings: [{
          excerpt: candidate.split('\n')[0], reason: '同义复述没有改变当前诉求，需保留对话接续'
        }]
      } : passed)
      : JSON.stringify({ patches: [{ before: candidate.split('\n')[0], after: repaired.split('\n')[0] }] }))
    const output = await ensureDialogueQuality(candidate, candidate, llm, { mode: 'write' })
    expect(output.text).toBe(repaired)
    expect(output.report).toMatchObject({ passed: true, attempts: 1 })
    expect(output.factsUnchanged).toBe(true)
    const repair = vi.mocked(llm.generateStream).mock.calls[1][0]
    expect(repair).toContain('同义复述没有改变当前诉求')
    expect(reviews).toBe(2)
  })

  it.each([
    '不是 JSON',
    JSON.stringify({ passed: true, factsUnchanged: false, issues: [] }),
    JSON.stringify({ passed: true, factsUnchanged: 'true', issues: [] }),
    JSON.stringify({ passed: false, factsUnchanged: true, issues: [],
      expressionFindings: [{ excerpt: '正文里没有这个句子', reason: '不能凭空诊断' }] }),
    JSON.stringify({ passed: true, factsUnchanged: true, issues: [], expressionFindings: '不是数组' }),
    JSON.stringify({ passed: false, factsUnchanged: true, issues: [' '] })
  ])('核验格式错误或缺乏证据时保留原稿，不能盲目修复：%s', async raw => {
    const llm = mockLlm(() => raw)
    const output = await ensureDialogueQuality(candidate, candidate, llm, { mode: 'write' })
    expect(output).toMatchObject({ text: candidate, report: { passed: false, attempts: 0 } })
    expect(output.factsUnchanged).toBeUndefined()
    expect(llm.generateStream).toHaveBeenCalledOnce()
  })

  const receipt = (text: string): DeslopResult => ({
    rewritten: text, beforeWords: 100, afterWords: 100, deleteRatio: 0, processedGates: ['E'],
    remainingFindings: [], changeSummary: [],
    dialogueQuality: { passed: true, beforeRatio: .65, afterRatio: .7, attempts: 1, issues: [] },
    semanticVerification: {
      scope: 'full_chapter_facts_and_expression', originalRevision: contentRevision(original),
      candidateRevision: contentRevision(text), prefixRevision: contentRevision('')
    }
  })

  it('联合事实凭据完整匹配也不能绕过独立事实审核', async () => {
    const llm = mockLlm((_prompt, opts) => opts.meta?.feature === 'deslop:verify'
      ? JSON.stringify({ unchanged: false, issues: ['原稿保留推断边界，候选省去该限制'] })
      : JSON.stringify({ patches: [] }))
    const output = await autoDeslopProse(original, {
      service: { deslop: async () => receipt(candidate) } as unknown as DeslopService, llm,
      validateCandidate: async () => {}, dialogueComposition: { mode: 'write' }
    })
    expect(output.content).toBe(original)
    expect(output.report.status).toBe('review_required')
    expect(output.report.verificationAttempts).toBe(1)
    expect(output.report.issues).toContain('原稿保留推断边界，候选省去该限制')
  })

  it.each(['originalRevision', 'candidateRevision', 'prefixRevision'] as const)(
    '凭据的 %s 与本次文本不一致时必须重新核验', async key => {
      const result = receipt(candidate)
      result.semanticVerification![key] = contentRevision('不同的稿件')
      const llm = mockLlm(() => JSON.stringify({ unchanged: true, issues: [] }))
      const output = await autoDeslopProse(original, {
        service: { deslop: async () => result } as unknown as DeslopService, llm,
        validateCandidate: async () => {}, dialogueComposition: { mode: 'write' }
      })
      expect(output.content).toBe(candidate)
      expect(llm.generateStream).toHaveBeenCalledOnce()
    })

  it('凭据生成后排版改变文本时重新核验最终稿，不能用旧字节凭据放行', async () => {
    const unformatted = candidate.replace('\n', '\n\n')
    const llm = mockLlm(() => JSON.stringify({ unchanged: true, issues: [] }))
    const output = await autoDeslopProse(original, {
      service: { deslop: async () => receipt(unformatted) } as unknown as DeslopService, llm,
      validateCandidate: async () => {}, formatCandidate: formatChapterProse,
      dialogueComposition: { mode: 'write' }
    })
    expect(output.content).toBe(candidate)
    expect(llm.generateStream).toHaveBeenCalledOnce()
    expect(vi.mocked(llm.generateStream).mock.calls[0][0]).toContain(candidate)
  })

  it('仅复核事实修复稿时，原稿仍是最初基线且预算不重新开始', async () => {
    const llm = mockLlm(() => JSON.stringify(passed))
    const output = await new DeslopService(llm).deslop(candidate, {
      factBaseline: original, dialogueComposition: { mode: 'write' }, dialogueRepairLimit: 0
    })
    expect(output.semanticVerification?.originalRevision).toBe(contentRevision(original))
    const prompt = vi.mocked(llm.generateStream).mock.calls[0][0]
    expect(prompt).toContain(`【原稿事实基线】\n\n${original}`)
    expect(prompt).toContain(`【待审核稿】\n\n${candidate}`)
    expect(output.dialogueQuality?.attempts).toBe(0)
  })

  it('候选稿未变时省掉提示词中的重复全文，仍检查旁白和对白', async () => {
    const llm = mockLlm(() => JSON.stringify(passed))
    await ensureDialogueQuality(candidate, candidate, llm, { mode: 'write' })
    const prompt = vi.mocked(llm.generateStream).mock.calls[0][0]
    expect(prompt.split(candidate)).toHaveLength(2)
    expect(prompt).toContain('仍须检查表达')
  })

  it('独立核验前响应停止信号，不采用半成品', async () => {
    const controller = new AbortController()
    const llm = mockLlm(() => { throw new Error('不应新增模型调用') })
    await expect(autoDeslopProse(original, {
      service: { deslop: async () => receipt(candidate) } as unknown as DeslopService, llm,
      validateCandidate: async () => {}, dialogueComposition: { mode: 'write' }, signal: controller.signal,
      onProgress: message => { if (message.includes('事实核对')) controller.abort() }
    })).rejects.toThrow('LLM_ABORTED')
    expect(llm.generateStream).not.toHaveBeenCalled()
  })

  it('场景审核缺少有效证据时不把格式失败当作正文缺陷盲目改写', async () => {
    const llm=mockLlm(()=>{throw new Error('不应盲目改写')})
    const rejected=receipt(candidate)
    rejected.dialogueQuality={passed:false,beforeRatio:0,afterRatio:0,attempts:0,
      issues:['整场对白复核缺少有效的连续回合证据或结论，保留待复核。']}
    const output=await autoDeslopProse(original,{
      service:{deslop:async()=>rejected} as unknown as DeslopService,llm,
      validateCandidate:async()=>{},dialogueComposition:{mode:'write'}
    })
    expect(output.report.status).toBe('review_required')
    expect(output.content).toBe(original)
    expect(llm.generateStream).not.toHaveBeenCalled()
  })
})
