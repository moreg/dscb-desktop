import { describe, expect, it, vi } from 'vitest'
import { applyForeshadowingInsertions, missingForeshadowings, repairMissingForeshadowings } from '../src/main/data/foreshadowing-repair'
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

describe('automatic foreshadowing repair', () => {
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
    generate.mockClear()
    await expect(repairMissingForeshadowings(input(), { generate, check })).rejects.toThrow('两轮后仍未通过')
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('rejects new early revelations reported by the semantic check', async () => {
    const changed = report(false)
    changed.diffs = [{ type: 4, typeLabel: '核心事件改', priority: 'P1', outline: '父亲身份保密', actual: '直接揭晓', suggestion: '提前揭底' }]
    await expect(repairMissingForeshadowings(input(), {
      generate: async () => patch(), check: async () => changed
    })).rejects.toThrow('新的剧情偏离')
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
