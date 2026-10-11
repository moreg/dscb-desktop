import { describe, expect, it } from 'vitest'
import { buildNarrativeFlowPrompt, parseNarrativeFlowFindings } from '../src/main/data/deslop/narrative-flow'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import type { LlmService } from '../src/main/data/llm-service'

const passage = '许明远先搬开大石。\n他再清出碎料。\n最后封住岔道。'
const finding = JSON.stringify([{
  kind: 'procedure', line: 2, excerpt: '他再清出碎料', reason: '连续列出清障步骤，没有新的阻力或选择'
}])

describe('场景级流水账诊断', () => {
  it('首次扫描即使本地零命中仍调用场景诊断，合并证据和计数', async () => {
    let calls = 0
    const llm = { generateStream: async () => { calls++; return finding } } as unknown as LlmService
    const service = new DeslopService(llm)
    expect((await service.scan(passage, { isTail: false })).findings).toEqual([])
    const report = await service.scanWithNarrative(passage, { isTail: false })
    expect(calls).toBe(1)
    expect(report.narrative).toEqual({ status: 'completed', checkedChunks: 1, totalChunks: 1 })
    expect(report.counts.advisory).toBe(1)
    expect(report.findings[0].type).toBe('narrative-procedure')
  })

  it('场景检查失败保留本地结果，不能伪装成零问题通过', async () => {
    const llm = { generateStream: async () => { throw new Error('模型暂时不可用') } } as unknown as LlmService
    const report = await new DeslopService(llm).scanWithNarrative(passage, { isTail: false })
    expect(report.narrative).toMatchObject({ status: 'failed', checkedChunks: 0, error: '模型暂时不可用' })
    expect(report.wordCount).toBeGreaterThan(0)
  })

  it('有效空诊断与尚未检查有不同状态', async () => {
    const service = new DeslopService({ generateStream: async () => '[]' } as unknown as LlmService)
    expect((await service.scan(passage)).narrative).toBeUndefined()
    const report = await service.scanWithNarrative(passage)
    expect(report.narrative?.status).toBe('completed')
    expect(report.findings).toEqual([])
  })
  it.each(['reaction-roster', 'confirmation-loop', 'quip-chain', 'unmotivated-detail', 'dialogue-seam'])(
    '把 %s 的有效证据交给场景改写，并拒绝错配引文', (kind) => {
      const text = '“你就卖十块？”\n“你连金品都十块卖？”'
      const item = { kind, line: 2, excerpt: '你连金品都十块卖', reason: '连续确认价格，没有改变交易条件' }
      expect(parseNarrativeFlowFindings(JSON.stringify([item]), text)).toMatchObject([
        { type: `narrative-${kind}`, line: 2, gate: 'G', severity: 'advisory' }
      ])
      expect(parseNarrativeFlowFindings(JSON.stringify([{ ...item, line: 1 }]), text)).toBeNull()
    }
  )

  it('重复确认修好后重新诊断候选，不沿用原稿的问题', async () => {
    const original = '“你就卖十块？”\n“十块。”\n“真的只卖十块？”\n“十块。”'
    const revised = '“你就卖十块？”\n“十块。”'
    const calls: string[] = []
    const llm = { generateStream: async (prompt: string): Promise<string> => {
      calls.push(prompt)
      if (prompt.startsWith('检查以下小说正文')) {
        return prompt.includes('3|“真的只卖十块？”')
          ? JSON.stringify([{ kind: 'confirmation-loop', line: 3, excerpt: '真的只卖十块', reason: '前一轮已确认价格，再问没有改变条件' }])
          : '[]'
      }
      return `【改写后】\n${revised}\n【改动说明】\n合并重复的价格确认`
    } } as unknown as LlmService
    const result = await new DeslopService(llm).deslop(original, {
      isTail: false, polishNarrative: true, levelOverride: 'severe'
    })
    expect(calls.some((prompt) => prompt.includes('前一轮已确认价格'))).toBe(true)
    expect(calls.filter((prompt) => prompt.startsWith('检查以下小说正文'))).toHaveLength(2)
    expect(result.rewritten).toBe(revised)
    expect(result.remainingFindings.some((item) => item.type === 'narrative-confirmation-loop')).toBe(false)
  })

  it('要求逐字证据，并拒绝模型编造的引文或行号', () => {
    expect(buildNarrativeFlowPrompt(passage)).toContain('2|他再清出碎料。')
    expect(parseNarrativeFlowFindings(finding, passage)).toMatchObject([
      { line: 2, column: 1, type: 'narrative-procedure', gate: 'G' }
    ])
    expect(parseNarrativeFlowFindings(JSON.stringify([
      { kind: 'procedure', line: 2, excerpt: '他又搬走矿车', reason: '编造' },
      { kind: 'procedure', line: 99, excerpt: '最后封住岔道', reason: '越界' }
    ]), passage)).toBeNull()
    expect(parseNarrativeFlowFindings('[]', passage)).toEqual([])
    expect(parseNarrativeFlowFindings('诊断失败', passage)).toBeNull()
  })

  it('自动候选没有解决场景问题时保留残留项，普通润色不增加诊断调用', async () => {
    const calls: string[] = []
    const llm = { generateStream: async (prompt: string): Promise<string> => {
      calls.push(prompt)
      return prompt.startsWith('检查以下小说正文')
        ? finding
        : `【改写后】\n${passage}\n【改动说明】\n无需修改`
    } } as unknown as LlmService
    const service = new DeslopService(llm)

    await service.deslop(passage, { isTail: false })
    expect(calls).toHaveLength(0)

    const result = await service.deslop(passage, { isTail: false, polishNarrative: true })
    expect(calls.some((prompt) => prompt.includes('场景级流水账'))).toBe(true)
    expect(calls.some((prompt) => prompt.includes('Gate G：去解释腔'))).toBe(true)
    expect(result.remainingFindings.some((item) => item.type === 'narrative-procedure')).toBe(true)
    // 首遍和一次无变化的场景复修后立即停止，不继续耗费调用。
    expect(calls.filter((prompt) => prompt.includes('本轮专门修复场景残留'))).toHaveLength(1)
  })

  it('诊断格式异常只重试一次，仍异常则明确失败', async () => {
    let calls = 0
    const llm = { generateStream: async (): Promise<string> => {
      calls += 1
      return '这段我觉得没问题。'
    } } as unknown as LlmService
    await expect(new DeslopService(llm).deslop(passage, { isTail: false, polishNarrative: true }))
      .rejects.toThrow('两次返回格式不完整')
    expect(calls).toBe(2)
  })

  it('首遍只改词仍有问题时进行场景复修，修好后停止', async () => {
    const polished = passage.replace('先搬开', '先挪开')
    const fixed = '许明远搬开大石，清出碎料后封住岔道。'
    const features: string[] = []
    const llm = { generateStream: async (prompt: string, opts: { meta: { feature: string } }): Promise<string> => {
      features.push(opts.meta.feature)
      if (opts.meta.feature === 'deslop:narrative-flow') return prompt.includes('他再清出碎料') ? finding : '[]'
      const text = opts.meta.feature === 'deslop:narrative-repair' ? fixed : polished
      return `【改写后】\n${text}\n【改动说明】\n整理已有动作`
    } } as unknown as LlmService
    const result = await new DeslopService(llm).deslop(passage, { isTail: false, polishNarrative: true })
    expect(result.rewritten).toBe(fixed)
    expect(features.filter((feature) => feature === 'deslop:narrative-repair')).toHaveLength(1)
    expect(result.remainingFindings.filter((item) => item.type.startsWith('narrative-'))).toEqual([])
  })

  it('场景复修最多两轮，仍有问题则保留提示，不把换词当通过', async () => {
    let repairs = 0
    const llm = { generateStream: async (_prompt: string, opts: { meta: { feature: string } }): Promise<string> => {
      if (opts.meta.feature === 'deslop:narrative-flow') return finding
      if (opts.meta.feature === 'deslop:narrative-repair') repairs++
      const variants = ['先搬开', '先挪开', '先移开']
      return `【改写后】\n${passage.replace('先搬开', variants[repairs])}\n【改动说明】\n修改措辞`
    } } as unknown as LlmService
    const result = await new DeslopService(llm).deslop(passage, { isTail: false, polishNarrative: true })
    expect(repairs).toBe(2)
    expect(result.remainingFindings.some((item) => item.type === 'narrative-procedure')).toBe(true)
  })

  it('场景复修返回截断稿时保留上一稿', async () => {
    const llm = { generateStream: async (_prompt: string, opts: { meta: { feature: string } }): Promise<string> => {
      if (opts.meta.feature === 'deslop:narrative-flow') return finding
      return `【改写后】\n${opts.meta.feature === 'deslop:narrative-repair' ? '他走了。' : passage}\n【改动说明】\n整理`
    } } as unknown as LlmService
    const result = await new DeslopService(llm).deslop(passage, { isTail: false, polishNarrative: true })
    expect(result.rewritten).toBe(passage)
    expect(result.changeSummary.some((line) => line.includes('[已拒绝] 场景复修'))).toBe(true)
  })

  it('场景复修期间取消时停止，不返回部分候选', async () => {
    const controller = new AbortController()
    const llm = { generateStream: async (_prompt: string, opts: { meta: { feature: string } }): Promise<string> => {
      if (opts.meta.feature === 'deslop:narrative-flow') return finding
      if (opts.meta.feature === 'deslop:narrative-repair') controller.abort()
      return `【改写后】\n${passage}\n【改动说明】\n整理`
    } } as unknown as LlmService
    await expect(new DeslopService(llm).deslop(passage, {
      isTail: false, polishNarrative: true, signal: controller.signal
    })).rejects.toThrow('LLM_ABORTED')
  })
})
