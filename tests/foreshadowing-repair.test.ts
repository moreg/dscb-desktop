import { describe, expect, it, vi } from 'vitest'
import { applyForeshadowingInsertions, ForeshadowingRepairRejectedError, missingForeshadowings, repairMissingForeshadowings as runRepairMissingForeshadowings } from '../src/main/data/foreshadowing-repair'
import type { OutlineDiffReport } from '../src/shared/types'

const prose = '林远把账册交给守门人。\n守门人翻开封皮，核对了印章。\n门内忽然传来父亲的声音。'
const addition = '封皮夹着半张借条，落款的笔迹与父亲留下的信一模一样。'
const report = (missing = true): OutlineDiffReport => ({
  chapterNumber: 1, hasOutline: true, checked: true, passed: !missing,
  diffs: missing ? [{ type: 1, typeLabel: '漏写', outline: 'FB-001：借条笔迹与父亲相同，只埋设不揭底',
    actual: '正文没有伏笔线索', suggestion: '补写伏笔', priority: 'P1' }] : []
})
const patch = (text = addition): string => JSON.stringify({ insertions: [{ after: 1, text }] })
const input = () => ({ chapterNumber: 1, content: prose, outline: '原始细纲', plans: [], report: report(), context: '人物只知道笔迹相同' })
const repairMissingForeshadowings = (input: Parameters<typeof runRepairMissingForeshadowings>[0],
  dependencies: Omit<Parameters<typeof runRepairMissingForeshadowings>[1], 'verify'> &
    Partial<Pick<Parameters<typeof runRepairMissingForeshadowings>[1], 'verify'>>) =>
  runRepairMissingForeshadowings(input, { verify: async () => {}, ...dependencies })

describe('automatic foreshadowing repair', () => {
  it.each(['joint', 'separate'])('rebuilds rejected additions from the verified draft with evidence feedback (%s)', async mode => {
    const bad = '他想起刚才父亲已经承认自己就是三皇子。'
    const rejection = new ForeshadowingRepairRejectedError([{ message: '虚构此前谈话并提前揭底', evidence: bad }])
    const generate = vi.fn().mockResolvedValueOnce(patch(bad)).mockResolvedValueOnce(patch())
    const check = vi.fn().mockResolvedValue(report(false))
    const verify = vi.fn().mockRejectedValueOnce(rejection).mockResolvedValue(undefined)
    const review = vi.fn().mockRejectedValueOnce(rejection).mockResolvedValue(report(false))
    const result = await repairMissingForeshadowings(input(), {
      generate, check, verify, ...(mode === 'joint' ? { review } : {})
    })
    expect(generate).toHaveBeenCalledTimes(2)
    const retryPrompt = generate.mock.calls[1][0] as string
    expect(retryPrompt).toContain(rejection.issues[0].message)
    expect(retryPrompt).toContain(bad)
    expect(retryPrompt.split('当前完整正文（编号只用于定位）')[1]).not.toContain(bad)
    expect(retryPrompt).toContain('FB-001')
    expect(result.content).toContain(addition)
    expect(result.content).not.toContain(bad)
    expect(mode === 'joint' ? review : verify).toHaveBeenLastCalledWith(prose, result.content, [addition])
  })

  it('does not re-review an unchanged rejected candidate to obtain a different verdict', async () => {
    const rejection = new ForeshadowingRepairRejectedError([{ message: '提前揭底', evidence: addition }])
    const generate = vi.fn().mockResolvedValue(patch())
    const review = vi.fn().mockRejectedValueOnce(rejection).mockResolvedValue(report(false))
    await expect(repairMissingForeshadowings(input(), { generate, check: vi.fn(), review })).rejects.toBe(rejection)
    expect(generate).toHaveBeenCalledTimes(2)
    expect(review).toHaveBeenCalledOnce()
  })

  it('stops after two rejected candidates and preserves the final failure', async () => {
    const first = new ForeshadowingRepairRejectedError([{ message: '虚构对话', evidence: addition }])
    const last = new ForeshadowingRepairRejectedError([{ message: '错置时序', evidence: '他回到宿舍。' }])
    const generate = vi.fn().mockResolvedValueOnce(patch()).mockResolvedValueOnce(patch('他回到宿舍。'))
    const review = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(last)
    await expect(repairMissingForeshadowings(input(), { generate, check: vi.fn(), review })).rejects.toBe(last)
    expect(generate).toHaveBeenCalledTimes(2)
    expect(review).toHaveBeenCalledTimes(2)
  })

  it('does not regenerate when review is unavailable or cancelled', async () => {
    const generate = vi.fn().mockResolvedValue(patch())
    const unavailable = new Error('伏笔补写专项核验缺少新增正文证据')
    await expect(repairMissingForeshadowings(input(), {
      generate, check: vi.fn(), review: vi.fn().mockRejectedValue(unavailable)
    })).rejects.toBe(unavailable)
    expect(generate).toHaveBeenCalledOnce()
    generate.mockClear()
    const controller = new AbortController()
    await expect(repairMissingForeshadowings({ ...input(), signal: controller.signal }, {
      generate, check: vi.fn(), review: async () => {
        controller.abort()
        throw new ForeshadowingRepairRejectedError([{ message: '提前揭底', evidence: addition }])
      }
    })).rejects.toThrow('LLM_ABORTED')
    expect(generate).toHaveBeenCalledOnce()
  })

  it('联合复核不重复调用原来的两次检查，并报告轮次和实际阶段', async () => {
    const onProgress = vi.fn()
    const check = vi.fn()
    const verify = vi.fn()
    const review = vi.fn().mockResolvedValue(report(false))
    const result = await repairMissingForeshadowings({ ...input(), onProgress }, {
      generate: async () => patch(), check, verify, review
    })
    expect(result.content).toContain(addition)
    expect(review).toHaveBeenCalledWith(prose, result.content, [addition])
    expect(check).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { stage: 'generate', round: 1 }, { stage: 'review', round: 1 }
    ])
  })
  it('inserts only new prose and keeps every existing paragraph and the original ending', () => {
    expect(applyForeshadowingInsertions(prose, patch())).toBe(prose.split('\n').slice(0, 2).join('\n') + '\n' + addition + '\n' + prose.split('\n')[2])
  })

  it.each([
    ['invalid JSON', '[]'],
    ['no additions', '{"insertions":[]}'],
    ['ending append', JSON.stringify({ insertions: [{ after: 2, text: addition }] })],
    ['bad position', JSON.stringify({ insertions: [{ after: '1', text: addition }] })],
    ['duplicate positions', JSON.stringify({ insertions: [{ after: 1, text: addition }, { after: 1, text: addition }] })],
    ['empty prose', patch('')],
    ['process narration', patch('我会调用 story-long-write 技能补写伏笔。')],
    ['Markdown', patch('# 新的章节')],
    ['receipt', patch('【本章伏笔回执】{"planted":[]}')],
    ['tracking ID', patch('借条上写着 FB-001。')],
    ['excessive addition', patch('字'.repeat(1801))]
  ])('rejects %s without producing a replacement chapter', (_label, raw) => {
    expect(() => applyForeshadowingInsertions(prose, raw)).toThrow()
  })

  it('matches an omitted original plan even when the difference omits the word foreshadowing', () => {
    const r = report()
    r.diffs[0] = { ...r.diffs[0], outline: '借条笔迹与父亲相同', actual: '没写', suggestion: '补上借条' }
    expect(missingForeshadowings(r, ['只让林远发现借条笔迹与父亲相同，不揭晓父亲身份'])).toHaveLength(1)
    expect(missingForeshadowings(r)).toHaveLength(0)
    r.diffs[0].type = 3
    expect(missingForeshadowings(r, ['借条笔迹与父亲相同'])).toHaveLength(0)
  })

  it('checks repaired prose against the original task and skips generation when there is no omission', async () => {
    const generate = vi.fn().mockResolvedValue(patch())
    const check = vi.fn().mockResolvedValue(report(false))
    const result = await repairMissingForeshadowings(input(), { generate, check })
    expect(result.content).toContain(addition)
    expect(generate.mock.calls[0][0]).toContain('原始细纲')
    expect(generate.mock.calls[0][0]).toContain('只埋设不揭底')
    expect(check).toHaveBeenCalledWith(result.content)
    generate.mockClear()
    check.mockClear()
    expect(await repairMissingForeshadowings({ ...input(), report: report(false) }, { generate, check })).toMatchObject({ content: prose })
    expect(generate).not.toHaveBeenCalled()
    expect(check).not.toHaveBeenCalled()
  })

  it('retries remaining omissions at most twice, using the first addition in the second check', async () => {
    const generate = vi.fn().mockResolvedValueOnce(patch()).mockResolvedValueOnce(patch('林远把借条折好，收进父亲留给他的信封。'))
    const check = vi.fn().mockResolvedValueOnce(report()).mockResolvedValueOnce(report(false))
    const result = await repairMissingForeshadowings(input(), { generate, check })
    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate.mock.calls[1][0]).toContain(addition)
    expect(result.content).toContain(addition)
    expect(result.content).toContain('收进父亲留给他的信封')
  })

  it('does not return an unchecked or still missing candidate', async () => {
    const generate = vi.fn().mockResolvedValue(patch())
    const check = vi.fn().mockResolvedValue({ ...report(false), checked: false, error: '断网' })
    await expect(repairMissingForeshadowings(input(), { generate, check })).rejects.toThrow('复核未完成')
    check.mockResolvedValue(report())
    generate.mockReset().mockResolvedValueOnce(patch()).mockResolvedValueOnce(patch('林远把借条收进父亲留给他的信封。'))
    await expect(repairMissingForeshadowings(input(), { generate, check })).rejects.toThrow('两轮后仍未通过')
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('rejects new early revelations reported by the semantic check', async () => {
    const changed = report(false)
    changed.diffs = [{ type: 4, typeLabel: '核心事件改', priority: 'P1', outline: '父亲身份保密', actual: '直接揭晓', suggestion: '提前揭底' }]
    await expect(repairMissingForeshadowings(input(), {
      generate: async () => patch(), check: async () => changed,
      verify: async () => { throw new Error('伏笔补写引入新的剧情偏离：提前揭底') }
    })).rejects.toThrow('新的剧情偏离')
  })

  it('accepts paraphrased descriptions of an existing deviation after verifying only the additions', async () => {
    const before = input()
    const old = { type: 4 as const, typeLabel: '核心事件改' as const, priority: 'P1' as const,
      outline: '林远留在院内', actual: '林远提前离开院子', suggestion: '校准细纲' }
    before.report.diffs.push(old)
    const checked = { ...report(false), diffs: [{ ...old, outline: '林远应留在院子里', actual: '林远已提前出了院子' }] }
    const verify = vi.fn().mockResolvedValue(undefined)
    const result = await repairMissingForeshadowings(before, { generate: async () => patch(), check: async () => checked, verify })
    expect(result.content).toContain(addition)
    expect(verify).toHaveBeenCalledWith(prose, result.content, [addition])
  })

  it('rejects identical short clues across rounds and across insertion positions', async () => {
    const short = '信封角上有一道蓝色划痕。'
    const first = applyForeshadowingInsertions(prose, patch(short))
    expect(() => applyForeshadowingInsertions(first, patch('信封角上有一道蓝色划痕！'))).toThrow('重复段落')
    expect(() => applyForeshadowingInsertions(prose, JSON.stringify({ insertions: [
      { after: -1, text: short }, { after: 1, text: short }
    ] }))).toThrow('重复段落')
  })

  it('blocks duplicate paragraphs within a multi-paragraph insertion without banning tiny replies', () => {
    expect(() => applyForeshadowingInsertions(prose, patch(addition + '\n' + addition))).toThrow('重复段落')
    expect(() => applyForeshadowingInsertions(prose, patch('“好。”\n“好。”'))).not.toThrow()
  })

  it('stops before further checks when cancellation occurs during the model call', async () => {
    const controller = new AbortController()
    const check = vi.fn()
    await expect(repairMissingForeshadowings({ ...input(), signal: controller.signal }, {
      generate: async () => { controller.abort(); return patch() }, check
    })).rejects.toThrow('LLM_ABORTED')
    expect(check).not.toHaveBeenCalled()
  })
})
