import { describe, expect, it, vi } from 'vitest'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import type { GenerateOptions, LlmService } from '../src/main/data/llm-service'

const source = '客人吃完第一碗饭。\n\n门边的内侍一直盯着饭碗。\n\n客人添了第二碗，内侍还在盯着。'
const finding = { kind: 'reaction-roster', line: 3, excerpt: '门边的内侍一直盯着饭碗。', reason: '两处观看重复烘托同一惊讶，没有新的认识或行动。' }

function makeService(narrative: string) {
  const generateStream = vi.fn(async (prompt: string, opts: GenerateOptions = {}) => {
    if (opts.meta?.feature === 'deslop:narrative-flow') return narrative
    if (opts.meta?.feature === 'deslop:scene-dialogue-review') {
      return JSON.stringify({ passed: true, assessment: '替身只核对对白，不代表叙事通过。',
        reviewedPassages: [{ excerpt: prompt.split('【待审核稿】\n\n').at(-1), reason: '当前连续段落。' }], findings: [] })
    }
    return JSON.stringify({ passed: true, factsUnchanged: true, issues: [], expressionFindings: [] })
  })
  const service = new DeslopService({ generateStream } as unknown as LlmService)
  vi.spyOn(service, 'scan').mockResolvedValue({ findings: [], counts: { blocking: 0, advisory: 0 },
    metrics: {} as never, wordCount: source.length, level: 'mild' })
  return { service, generateStream }
}

describe('整章对白分支的叙事覆盖', () => {
  it('对白审核通过也不能放行仍有重复旁白的章节', async () => {
    const { service, generateStream } = makeService(JSON.stringify([finding]))
    const result = await service.deslop(source, { polishNarrative: true, dialogueRepairLimit: 0,
      dialogueComposition: { mode: 'write' } })
    expect(result.dialogueQuality?.passed).toBe(false)
    expect(result.dialogueQuality?.issues.join('')).toContain(finding.reason)
    expect(result.remainingFindings.some(f => f.type === 'narrative-reaction-roster')).toBe(true)
    expect(generateStream.mock.calls.filter(([, o]) => o?.meta?.feature === 'deslop:narrative-flow')).toHaveLength(1)
  })

  it('叙事与对白均通过时，同一候选复扫复用一次叙事诊断', async () => {
    const { service, generateStream } = makeService('[]')
    const result = await service.deslop(source, { polishNarrative: true,
      dialogueComposition: { mode: 'write' } })
    expect(result.dialogueQuality?.passed).toBe(true)
    expect(result.remainingFindings).toEqual([])
    expect(generateStream.mock.calls.filter(([, o]) => o?.meta?.feature === 'deslop:narrative-flow')).toHaveLength(1)
  })

  it('续写直接写人物判断可进入语义审核，作者显式禁词及截断仍须处理', async () => {
    const { service, generateStream } = makeService('[]')
    vi.mocked(service.scan).mockRestore()
    const passage = '他知道阿姐不会赶夜船，河面还有一层冰，船夫一桨下去，先得等那块冰裂开。'
    const options = { polishNarrative: true, dialogueRepairLimit: 0, dialogueComposition: {
      mode: 'write' as const, existingText: '老钱把船篙横在膝上，问要等到几时。'
    } }
    // 控制组确认旧机械扫描确实会报这句，避免测试因词面未命中而空过。
    expect((await service.scan(passage)).findings.some(item => item.type === 'he_knows')).toBe(true)

    const accepted = await service.deslop(passage, options)
    expect(accepted.rewritten).toBe(passage)
    expect(accepted.dialogueQuality?.passed).toBe(true)
    expect(generateStream.mock.calls.some(([, opts]) => opts?.meta?.feature === 'deslop:dialogue-review')).toBe(true)

    const banned = await service.deslop(passage, { ...options, bannedWords: ['船夫'] })
    expect(banned.dialogueQuality?.passed).toBe(false)
    expect(banned.remainingFindings.some(item => item.type === 'banned-word' && item.word === '船夫')).toBe(true)

    const truncated = await service.deslop('船夫伸手去接', options)
    expect(truncated.dialogueQuality?.passed).toBe(false)
    expect(truncated.remainingFindings.some(item => item.type === 'truncation')).toBe(true)
  })

  it('叙事诊断连续返回无效证据时，不降级为空问题通过', async () => {
    const { service, generateStream } = makeService(JSON.stringify([{ ...finding, excerpt: '不存在的证据' }]))
    await expect(service.deslop(source, { polishNarrative: true,
      dialogueComposition: { mode: 'write' } })).rejects.toThrow('整章叙事检查未完成')
    expect(generateStream.mock.calls.filter(([, o]) => o?.meta?.feature === 'deslop:narrative-flow')).toHaveLength(2)
    expect(generateStream.mock.calls.some(([, o]) => o?.meta?.feature === 'deslop:dialogue-review')).toBe(false)
  })

  it('恢复候选改变文字后重新诊断，不能沿用原稿的叙事通过结果', async () => {
    const { service, generateStream } = makeService('[]')
    const draft = source.replace('还在盯着', '仍然盯着')
    const narrative = vi.spyOn(service, 'scanWithNarrative')
    await service.deslop(source, { polishNarrative: true, initialDialogueDraft: draft,
      dialogueComposition: { mode: 'write' } })
    expect(narrative.mock.calls.map(([text]) => text)).toEqual([source, draft])
    expect(generateStream.mock.calls.filter(([, o]) => o?.meta?.feature === 'deslop:narrative-flow')).toHaveLength(2)
  })
})
