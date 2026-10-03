import { describe, expect, it, vi } from 'vitest'
import { autoDeslopProse } from '../src/main/data/auto-deslop'
import { formatChapterProse } from '../src/shared/format-chapter-prose'
import type { DeslopOptions, DeslopService } from '../src/main/data/deslop/deslop-service'
import type { GenerateOptions, LlmService } from '../src/main/data/llm-service'
import { countWords } from '../src/main/data/words'
import type { DeslopResult } from '../src/shared/types'

const ORIGINAL = [
  '林远缓缓推开院门，将账册放在守门人的桌上，等他核对印章。',
  '守门人翻到最后一页，用手指沿着红印的边缘摸了一圈，又从抽屉里取出旧账册，摊在同一张桌上。',
  '两本账册上的印章对得上，守门人便挪开挡门的木凳，将一把钥匙递给林远，让他自己开东屋的锁。',
  '林远收好钥匙，绕过院中央那堆尚未劈开的柴，走到东屋门前，先听了听里面的动静。'
].join('\n')
const CANDIDATE = ORIGINAL.replace('缓缓推开', '推开').replace('一把钥匙', '两把钥匙')
const FIXED = CANDIDATE.replace('两把钥匙', '一把钥匙')
const SECOND_FIXED = FIXED.replace('用手指沿着', '手指沿着')
const PASSED = JSON.stringify({ unchanged: true, issues: [] })
const DIFFERENCE = JSON.stringify({ unchanged: false, issues: ['钥匙数量从一把变成两把'] })
type Reply = string | Error

function result(text: string, patch: Partial<DeslopResult> = {}): DeslopResult {
  return {
    rewritten: text,
    processedGates: ['A'],
    beforeWords: countWords(ORIGINAL),
    afterWords: countWords(text),
    deleteRatio: 1 - countWords(text) / countWords(ORIGINAL),
    remainingFindings: [],
    changeSummary: ['删除重复程度副词'],
    ...patch
  }
}

function setup({
  original = ORIGINAL,
  verifyReplies = [PASSED],
  repairReplies = [JSON.stringify({ text: FIXED })],
  candidate = CANDIDATE
}: { original?: string; verifyReplies?: Reply[]; repairReplies?: Reply[]; candidate?: string } = {}) {
  const verificationQueue = [...verifyReplies]
  const repairQueue = [...repairReplies]
  const respond = (queue: Reply[], fallback: Reply): string => {
    const reply = queue.shift() ?? fallback
    if (reply instanceof Error) throw reply
    return reply
  }
  const generateStream = vi.fn(async (_prompt: string, options: GenerateOptions = {}) => {
    if (options.meta?.feature === 'deslop:verify') {
      return respond(verificationQueue, verifyReplies.at(-1) ?? PASSED)
    }
    if (options.meta?.feature === 'deslop:repair') {
      return respond(repairQueue, repairReplies.at(-1) ?? JSON.stringify({ text: FIXED }))
    }
    throw new Error(`UNEXPECTED_FEATURE:${String(options.meta?.feature)}`)
  })
  const deslop = vi.fn(async (text: string, _options?: DeslopOptions) => result(text))
    .mockResolvedValueOnce(result(candidate))
  const validateCandidate = vi.fn(async (_text: string) => {})
  const run = (options: DeslopOptions & { formatCandidate?: (text: string) => string } = {}) => autoDeslopProse(original, {
    service: { deslop } as unknown as DeslopService,
    llm: { generateStream } as unknown as LlmService,
    validateCandidate,
    ...options
  })
  const calls = (feature: 'deslop:verify' | 'deslop:repair') => generateStream.mock.calls
    .filter(([, options]) => options?.meta?.feature === feature)
  return { deslop, generateStream, validateCandidate, run, calls }
}

describe('自动去 AI 味事实修复和核验重试', () => {
  it('排版将动作移到台词前时必须核验实际排版稿，事实未通过则原稿原样保留', async () => {
    const original = ORIGINAL + '\n“我先开门。”林远缓缓走到东屋前，“你别跟来。”'
    const candidate = original.replaceAll('缓缓', '')
    const formatted = formatChapterProse(candidate)
    const difference = JSON.stringify({ unchanged: false,
      issues: ['说话与走到屋前的先后顺序改变：原稿先说话再走，排版稿先走再说话'] })
    const context = setup({ original, candidate, verifyReplies: [difference], repairReplies: [JSON.stringify({ text: candidate })] })

    const output = await context.run({ formatCandidate: formatChapterProse })

    expect(formatted).not.toBe(candidate)
    expect(formatted).toContain('林远走到东屋前。\n“我先开门，你别跟来。”')
    expect(context.calls('deslop:verify')[0][0]).toContain(formatted)
    expect(context.calls('deslop:verify')[0][0]).toContain(original)
    expect(output.content).toBe(original)
    expect(output.report).toMatchObject({ status: 'review_required', repairAttempts: 2 })
  })

  it('正文护栏、事实核验和最终采用都使用格式后候选，格式器不传给润色服务', async () => {
    const unformatted = CANDIDATE.replaceAll('\n', '\n\n').replace('推开院门', '推开 院门')
    const unformattedRepair = FIXED.replaceAll('\n', '\n\n').replace('推开院门', '推开 院门')
    const context = setup({ candidate: unformatted, verifyReplies: [DIFFERENCE, PASSED],
      repairReplies: [JSON.stringify({ text: unformattedRepair })] })
    const formatCandidate = vi.fn(formatChapterProse)

    const output = await context.run({ formatCandidate })

    expect(context.validateCandidate.mock.calls.map(([text]) => text)).toContain(CANDIDATE)
    expect(context.validateCandidate.mock.calls.at(-1)?.[0]).toBe(FIXED)
    expect(context.calls('deslop:verify')[0][0]).toContain(CANDIDATE)
    expect(context.calls('deslop:verify')[0][0]).not.toContain(unformatted)
    expect(context.calls('deslop:verify')[1][0]).toContain(FIXED)
    expect(output.content).toBe(FIXED)
    expect(output.report.status).toBe('applied')
    expect(formatCandidate).toHaveBeenCalledTimes(2)
    for (const [, options] of context.deslop.mock.calls) expect(options).not.toHaveProperty('formatCandidate')
  })

  it('首次事实差异自动定向修复，复扫和再次核验后采用修复稿', async () => {
    const context = setup({ verifyReplies: [DIFFERENCE, PASSED] })

    const output = await context.run({ meta: { projectId: 'p1', chapterNumber: 3 }, isTail: false })

    expect(output.content).toBe(FIXED)
    expect(output.report).toMatchObject({ status: 'applied', repairAttempts: 1, verificationAttempts: 2 })
    expect(context.calls('deslop:repair')).toHaveLength(1)
    expect(context.calls('deslop:verify')).toHaveLength(2)
    expect(context.calls('deslop:repair')[0][0]).toContain('钥匙数量从一把变成两把')
    expect(context.calls('deslop:repair')[0][1]).toMatchObject({ meta: { projectId: 'p1', chapterNumber: 3 } })
    expect(context.deslop).toHaveBeenNthCalledWith(2, FIXED,
      expect.objectContaining({ levelOverride: 'mild', isTail: false }))
    // 修复原始输出与复扫后的最终输出都须通过正文护栏。
    expect(context.validateCandidate.mock.calls.map(([text]) => text)).toEqual([CANDIDATE, FIXED, FIXED])
  })

  it('连续两轮修复仍有差异时保留最初原稿并记录具体原因', async () => {
    const context = setup({ verifyReplies: [DIFFERENCE] })

    const output = await context.run()

    expect(output.content).toBe(ORIGINAL)
    expect(output.report).toMatchObject({ status: 'review_required', repairAttempts: 2, verificationAttempts: 3 })
    expect(output.report.issues).toContain('钥匙数量从一把变成两把')
    expect(context.calls('deslop:repair')).toHaveLength(2)
    expect(context.deslop).toHaveBeenCalledTimes(3)
  })

  it('每轮修复和核验都以最初原稿为事实基线，避免累计漂移', async () => {
    const context = setup({
      verifyReplies: [DIFFERENCE,
        JSON.stringify({ unchanged: false, issues: ['守门人的说话者发生变化'] }), PASSED],
      repairReplies: [JSON.stringify({ text: FIXED }), JSON.stringify({ text: SECOND_FIXED })]
    })

    const output = await context.run()

    expect(output.content).toBe(SECOND_FIXED)
    expect(output.report).toMatchObject({ status: 'applied', repairAttempts: 2, verificationAttempts: 3 })
    const allCalls = [...context.calls('deslop:repair'), ...context.calls('deslop:verify')]
    for (const [prompt] of allCalls) expect(prompt).toContain(ORIGINAL)
    const lastRepair = context.calls('deslop:repair')[1][0]
    expect(lastRepair).toContain(FIXED)
    expect(lastRepair).toContain('守门人的说话者发生变化')
    expect(context.calls('deslop:verify')[2][0]).toContain(SECOND_FIXED)
  })

  it('修复回到最初原稿时可直接保留并报告无需再改', async () => {
    const context = setup({
      verifyReplies: [DIFFERENCE], repairReplies: [JSON.stringify({ text: ORIGINAL })]
    })

    const output = await context.run()

    expect(output.content).toBe(ORIGINAL)
    expect(output.report).toMatchObject({ status: 'unchanged', repairAttempts: 1 })
    expect(context.calls('deslop:repair')).toHaveLength(1)
  })

  it.each([
    ['不是 JSON', '核验暂未生成有效结果'],
    ['缺失 issues', JSON.stringify({ unchanged: true })],
    ['unchanged 不是 boolean', JSON.stringify({ unchanged: 'true', issues: [] })],
    ['issues 不是数组', JSON.stringify({ unchanged: true, issues: '无差异' })],
    ['issues 含非字符串', JSON.stringify({ unchanged: false, issues: [12] })],
    ['issues 只有空白', JSON.stringify({ unchanged: true, issues: [' ', '\n'] })]
  ])('核验格式异常可重新核验同一候选：%s', async (_label, invalid) => {
    const context = setup({ verifyReplies: [invalid, PASSED] })

    const output = await context.run()

    expect(output.content).toBe(CANDIDATE)
    expect(output.report).toMatchObject({ status: 'applied', verificationAttempts: 2, repairAttempts: 0 })
    expect(context.calls('deslop:repair')).toHaveLength(0)
    expect(context.deslop).toHaveBeenCalledOnce()
    for (const [prompt] of context.calls('deslop:verify')) expect(prompt).toContain(CANDIDATE)
  })

  it('连续格式异常保留原稿，显示核验原因而非冒充事实差异', async () => {
    const context = setup({ verifyReplies: ['未返回 JSON'] })

    const output = await context.run()

    expect(output.content).toBe(ORIGINAL)
    expect(output.report).toMatchObject({ status: 'review_required', verificationAttempts: 2, repairAttempts: 0 })
    expect(output.report.issues?.length).toBeGreaterThan(0)
    expect(output.report.message).toMatch(/格式|JSON|核验/)
    expect(context.calls('deslop:repair')).toHaveLength(0)
  })

  it.each([{ issues: [] }, { issues: [' ', '\n'] }])('false 且无具体差异时补核验一次，不无目标重写：%j', async ({ issues }) => {
    const context = setup({ verifyReplies: [JSON.stringify({ unchanged: false, issues })] })

    const output = await context.run()

    expect(output.content).toBe(ORIGINAL)
    expect(output.report).toMatchObject({ status: 'review_required', verificationAttempts: 2, repairAttempts: 0 })
    expect(output.report.message + output.report.issues?.join('')).toMatch(/具体|未指出|格式/)
    expect(context.calls('deslop:repair')).toHaveLength(0)
  })

  it('unchanged=true 但存在具体差异时仍须修复，不能直接放行', async () => {
    const context = setup({
      verifyReplies: [JSON.stringify({ unchanged: true, issues: ['钥匙数量发生变化'] }), PASSED]
    })

    const output = await context.run()

    expect(output.content).toBe(FIXED)
    expect(context.calls('deslop:repair')).toHaveLength(1)
  })

  it('每轮核验的格式重试与内容修复分别计数', async () => {
    const context = setup({ verifyReplies: ['非 JSON', DIFFERENCE, '仍非 JSON', PASSED] })

    const output = await context.run()

    expect(output.content).toBe(FIXED)
    expect(output.report).toMatchObject({ repairAttempts: 1, verificationAttempts: 4 })
    expect(context.calls('deslop:repair')).toHaveLength(1)
  })

  it('修复输出为空或格式错误也计入两轮预算，最终保留原稿', async () => {
    const context = setup({ verifyReplies: [DIFFERENCE], repairReplies: ['不是 JSON', JSON.stringify({ text: '' })] })

    const output = await context.run()

    expect(output.content).toBe(ORIGINAL)
    expect(output.report).toMatchObject({ status: 'review_required', repairAttempts: 2 })
    expect(context.calls('deslop:repair')).toHaveLength(2)
    expect(context.deslop).toHaveBeenCalledOnce()
  })

  it('修复前后累计篇幅以最初原稿计算，不能逐轮突破 15%', async () => {
    const grown = FIXED + '\n' + '林远又沿着长廊走过三间空屋，抬头查看梁柱上的旧痕，回到门前把院里的木凳挪到一旁。'.repeat(3)
    const context = setup({ verifyReplies: [DIFFERENCE], repairReplies: [JSON.stringify({ text: grown })] })

    const output = await context.run()

    expect(countWords(grown)).toBeGreaterThan(countWords(ORIGINAL) * 1.15)
    expect(output.content).toBe(ORIGINAL)
    expect(output.report.status).toBe('review_required')
    expect(context.calls('deslop:verify')).toHaveLength(1)
  })

  it('单轮各删不足 15% 但累计超过预算时仍拒绝修复稿', async () => {
    const candidate = ORIGINAL.slice(0, Math.floor(ORIGINAL.length * 0.91))
    const repaired = ORIGINAL.slice(0, Math.floor(ORIGINAL.length * 0.82))
    const context = setup({ candidate, verifyReplies: [DIFFERENCE], repairReplies: [JSON.stringify({ text: repaired })] })
    const originalWords = countWords(ORIGINAL)
    const candidateWords = countWords(candidate)
    const repairedWords = countWords(repaired)
    expect(originalWords - candidateWords).toBeLessThan(originalWords * 0.15)
    expect(candidateWords - repairedWords).toBeLessThan(candidateWords * 0.15)
    expect(originalWords - repairedWords).toBeGreaterThan(originalWords * 0.15)

    const output = await context.run()

    expect(output.content).toBe(ORIGINAL)
    expect(output.report.status).toBe('review_required')
    expect(context.calls('deslop:verify')).toHaveLength(1)
    expect(context.deslop).toHaveBeenCalledOnce()
  })

  it('修复稿复扫又产生事实差异时，核验复扫后稿件并占用下一轮修复', async () => {
    const drifted = FIXED.replace('东屋', '西屋')
    const context = setup({ verifyReplies: [DIFFERENCE,
      JSON.stringify({ unchanged: false, issues: ['东屋改成西屋'] }), PASSED] })
    context.deslop.mockResolvedValueOnce(result(drifted))

    const output = await context.run()

    expect(output.content).toBe(FIXED)
    expect(output.report).toMatchObject({ repairAttempts: 2, verificationAttempts: 3 })
    expect(context.calls('deslop:verify')[1][0]).toContain(drifted)
    expect(context.calls('deslop:verify')[1][0]).toContain(ORIGINAL)
    expect(context.calls('deslop:repair')[1][0]).toContain('东屋改成西屋')
    expect(context.calls('deslop:repair')[1][0]).toContain(drifted)
  })

  it.each([
    { changeSummary: ['[需复核] 道具归属需要确认'] },
    { rewritten: FIXED + '\n[需确认]' },
    { remainingFindings: [{ gate: 'A', type: 'banned-word', line: 1, column: 1,
      severity: 'advisory', excerpt: '缓缓', message: '程度副词重复' }] }
  ] satisfies Partial<DeslopResult>[])('修复后复扫有标记或残余则保留原稿：%j', async (patch) => {
    const context = setup({ verifyReplies: [DIFFERENCE] })
    context.deslop.mockResolvedValueOnce(result(FIXED, patch))

    const output = await context.run()

    expect(output.content).toBe(ORIGINAL)
    expect(output.report.status).toBe('review_required')
    expect(context.calls('deslop:verify')).toHaveLength(1)
    expect(context.deslop).toHaveBeenCalledTimes(2)
  })

  it.each(['LLM_PROSE_FORMAT:混入流程说明', 'LLM_PROSE_COPY:复制已有前文'])('修复稿违反正文护栏时不能采用：%s', async (reason) => {
    const context = setup({ verifyReplies: [DIFFERENCE] })
    context.validateCandidate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error(reason))

    const output = await context.run()

    expect(output.content).toBe(ORIGINAL)
    expect(output.report.status).toBe('review_required')
    expect(context.calls('deslop:verify')).toHaveLength(1)
    expect(context.validateCandidate).toHaveBeenLastCalledWith(FIXED)
  })

  it('修复输出通过检查，但复扫后复制前文也须拒绝', async () => {
    const copied = FIXED.replace('东屋', '西屋')
    const context = setup({ verifyReplies: [DIFFERENCE] })
    context.deslop.mockResolvedValueOnce(result(copied))
    context.validateCandidate.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('LLM_PROSE_COPY:复制已有前文'))

    const output = await context.run()

    expect(output.content).toBe(ORIGINAL)
    expect(output.report.status).toBe('review_required')
    expect(context.validateCandidate).toHaveBeenLastCalledWith(copied)
    expect(context.calls('deslop:verify')).toHaveLength(1)
  })

  it('修复请求失败时保留原稿并报告失败原因', async () => {
    const context = setup({ verifyReplies: [DIFFERENCE], repairReplies: [new Error('LLM_TIMEOUT')] })

    const output = await context.run()

    expect(output.content).toBe(ORIGINAL)
    expect(output.report).toMatchObject({ status: 'failed', repairAttempts: 1 })
    expect(output.report.message).toContain('LLM_TIMEOUT')
  })

  it('修复稿再次润色失败时不应用未经复扫的候选', async () => {
    const context = setup({ verifyReplies: [DIFFERENCE] })
    context.deslop.mockRejectedValueOnce(new Error('复扫不可用'))

    const output = await context.run()

    expect(output.content).toBe(ORIGINAL)
    expect(output.report.status).toBe('failed')
    expect(output.report.message).toContain('复扫不可用')
  })

  it('取消前已完成的修复不会被后续采用', async () => {
    const controller = new AbortController()
    const context = setup({ verifyReplies: [DIFFERENCE] })
    context.deslop.mockImplementationOnce(async (text) => {
      controller.abort()
      return result(text)
    })

    await expect(context.run({ signal: controller.signal })).rejects.toThrow('LLM_ABORTED')
    expect(context.calls('deslop:verify')).toHaveLength(1)
  })

  it('开始前已取消时不发出润色或核验请求', async () => {
    const controller = new AbortController()
    controller.abort()
    const context = setup()

    await expect(context.run({ signal: controller.signal })).rejects.toThrow('LLM_ABORTED')
    expect(context.deslop).not.toHaveBeenCalled()
    expect(context.generateStream).not.toHaveBeenCalled()
  })

  it.each(['deslop:verify', 'deslop:repair'] as const)('%s 中取消后必须传播取消信号', async (feature) => {
    const controller = new AbortController()
    const context = setup({ verifyReplies: [DIFFERENCE] })
    context.generateStream.mockImplementation(async (_prompt, options = {}) => {
      if (options.meta?.feature !== feature) return DIFFERENCE
      expect(options.signal).toBe(controller.signal)
      controller.abort()
      return feature === 'deslop:verify' ? PASSED : JSON.stringify({ text: FIXED })
    })

    await expect(context.run({ signal: controller.signal })).rejects.toThrow('LLM_ABORTED')
  })

  it('正文护栏内取消也传播，不能当作可恢复的候选失败', async () => {
    const controller = new AbortController()
    const context = setup()
    context.validateCandidate.mockImplementation(async () => {
      controller.abort()
      throw new Error('已停止')
    })

    await expect(context.run({ signal: controller.signal })).rejects.toThrow('LLM_ABORTED')
    expect(context.generateStream).not.toHaveBeenCalled()
  })

  it('标准 AbortError 不被转成保留原稿报告', async () => {
    const abort = new Error('停止请求')
    abort.name = 'AbortError'
    const context = setup({ verifyReplies: [DIFFERENCE], repairReplies: [abort] })

    await expect(context.run()).rejects.toMatchObject({ name: 'AbortError' })
  })
})
