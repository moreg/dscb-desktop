import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { WriteService } from '../src/main/data/write-service'
import { ChapterDirectionService } from '../src/main/data/chapter-direction-service'
import { DetailedOutlineMdRepo } from '../src/main/data/skill-format/detailed-outline-md-repo'
import { ChapterSummaryRepo } from '../src/main/data/memory/chapter-summary-repo'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { OutlineRepository } from '../src/main/data/outline-repository'
import { ChapterService } from '../src/main/data/chapter-service'
import { writeJsonAtomic } from '../src/main/data/atomic'
import { hashProse } from '../src/main/data/memory/prose-memory-index'
import { markBatchReviewPending, markLongformPending, readLongformReviewState } from '../src/main/data/longform-review-state'
import { createWritingProject } from './helpers/writing-project'
import { withPassingLongformGuard } from './helpers/passing-longform'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { ChapterFlowResult } from '../src/shared/types'

describe('无细纲单章与一键十章的真实编排', () => {
  let root: string
  let dir: string
  let id: string
  let projects: ProjectService
  let writer: WriteService
  let generate: ReturnType<typeof vi.fn>
  let llm: LlmService
  const first = (n: number) => `林遥到达第${n}处渡口，船夫给她一张指向东岸仓库的纸条。`
  const last = '她收好纸条，沿河向仓库走去。'
  const prose = (n: number) => `${first(n)}\n\n${last}`
  const candidates = () => ({ directions: ['a', 'b', 'c', 'd', 'e'].map((key, i) => ({ id: key,
    title: `调查渠道${i + 1}`, connection: '从当前调查阶段开始。', conflict: '船夫担心泄露消息。',
    progression: `通过渠道${i + 1}从船夫处得到东岸仓库的线索。`, ending: '获得线索，尚未到达仓库。',
    hook: '仓库里可能藏有账本。', outlineReason: '先取得线索，暂不揭露幕后主使。'
  })), recommendedId: 'c', recommendationReason: '符合寻找账本的当前阶段。' })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'no-outline-flow-'))
    const settings = { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository
    projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
    const project = await createWritingProject(projects, { name: '失踪账本', genre: '悬疑' })
    id = project.id; dir = project.path
    await writeFile(join(dir, '大纲', '大纲.md'), '# 失踪账本\n\n## 主线剧情走向\n\n林遥寻找失踪账本，先到沿河渡口收集线索，再调查东岸仓库，之后逐步追查幕后主使。\n\n## 后续限制\n\n第十五章之前不揭露幕后主使，不写全书完结。')
    generate = vi.fn(async (_prompt, opts) => {
      const n = opts?.meta?.chapterNumber ?? 1
      const fact = { text: '林遥在渡口取得仓库线索。', evidence: first(n) }
      const end = { text: '林遥收好纸条前往仓库。', evidence: last }
      switch (opts?.meta?.feature) {
        case 'chapterDirections': return JSON.stringify(candidates())
        case 'chapter': return prose(n)
        case 'chapterDirectionReview': return JSON.stringify({ completed: true, passed: true, issues: [] })
        case 'chapterOutlineFromProse': return JSON.stringify({ events: [fact, end], hook: end, characters: [], foreshadowings: [] })
        case 'chapterSummary': return JSON.stringify({ events: [fact, end], stateChanges: [], openThreads: [], continuity: [] })
        case 'endingState': return JSON.stringify({ characterPositions: [], characterStates: [], timePoint: '', unfinished: [], suspense: '', props: [] })
        case 'memoryExtract': case 'autoMemorySync': case 'batchMemory':
          return JSON.stringify({ chapterNumber: n, newCharacters: [], newLocations: [], newItems: [], newForeshadowings: [],
            newPlotPoints: [{ title: '渡口线索', event: fact.text, evidence: first(n) }], characterStateChanges: [], collectedForeshadowings: [] })
        default: return '[]'
      }
    })
    llm = withPassingLongformGuard({ generateStream: generate } as unknown as LlmService)
    writer = new WriteService(projects, llm)
    // These unrelated lexical heuristics are independently covered; retain real generation, saves, direction/outline checks and memory writes.
    vi.spyOn(writer, 'selfCheckChapter').mockImplementation(async (_id, n) => ({ schemaVersion: 1, chapterNumber: n, generatedAt: '', items: [],
      counts: { pass: 0, fail: 0, warn: 0, skip: 0 }, ok: true, summary: '检查通过。' }))
    vi.spyOn(writer, 'auditChapter').mockResolvedValue({ schemaVersion: 1, wordCount: 1000,
      passed: { ending: true, forbiddenWords: true, wordCount: true }, counts: { error: 0, warn: 0, info: 0 }, violations: [] })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('只有大纲也可从指定章生成五个方向，采用后保存正文并同步概要与记忆（不写回细纲）', async () => {
    const directions = (await writer.generateChapterDirections(id, 5))!
    expect(directions.missingPreviousProse).toBe(true)
    expect(directions.directions).toHaveLength(5)
    expect(generate.mock.calls.find(([, opts]) => opts?.meta?.feature === 'chapterDirections')?.[0]).toContain('第十五章之前不揭露幕后主使')
    const result = await writer.deliverChapter(id, 5, null, { directionChoice: { token: directions.token, directionId: 'b' } })
    expect(result.ok).toBe(true)
    expect(result.directionSyncCompleted).toBe(true)
    expect(result.directionSync?.memory.applied.plotPoints).toBe(1)
    expect(await new ProseRepo(dir).read(5)).toBe(prose(5))
    expect(await new ProseRepo(dir).read(4)).toBe('')
    expect(await new DetailedOutlineMdRepo(dir).readChapter(5)).toBeNull()
    expect(await new DetailedOutlineMdRepo(dir).readChapter(4)).toBeNull()
    expect(generate.mock.calls.some(([, opts]) =>
      ['chapterOutlineFromProse', 'chapterDirectionReview', 'outlineCheck'].includes(opts?.meta?.feature ?? '')
    )).toBe(false)
    expect((await new ChapterSummaryRepo(dir).readCurrent(5, prose(5)))?.events).toHaveLength(2)
    expect((await new ChapterDirectionService(dir, 5, llm, id).read())?.completedHash).toBeTruthy()
    const actualPrompt = generate.mock.calls.find(([, opts]) => opts?.meta?.feature === 'chapter')?.[0]
    expect(actualPrompt).toContain('调查渠道2')
    expect(actualPrompt).not.toContain('方向：调查渠道3')
  })

  it('一键十章逐章使用推荐项，每章完成同步后才规划下一章，后章自动读取前章概要', async () => {
    const results: ChapterFlowResult[] = []
    const result = await writer.generateChaptersBatch(id, 5, 14, (_n, value) => { results.push(value) }, {}, {}, undefined, { autoContinue: true })
    expect(result.status).toBe('completed')
    expect(results).toHaveLength(10)
    expect(results.every(value => value.direction?.title === '调查渠道3' &&
      value.chapterSummary?.stale === false && value.outlineDiff.hasOutline === false)).toBe(true)
    expect(generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'chapterDirections')).toHaveLength(10)
    const sixthPlanning = generate.mock.calls.find(([, opts]) => opts?.meta?.feature === 'chapterDirections' && opts.meta.chapterNumber === 6)?.[0]
    expect(sixthPlanning).toContain(first(5))
    const sixthProsePrompt = generate.mock.calls.find(([, opts]) => opts?.meta?.feature === 'chapter' && opts.meta.chapterNumber === 6)?.[0]
    expect(sixthProsePrompt).toContain('**上一章概要**')
    expect(sixthProsePrompt).toContain('林遥在渡口取得仓库线索')
    expect(await new DetailedOutlineMdRepo(dir).readChapter(5)).toBeNull()
    expect(await new ProseRepo(dir).read(4)).toBe('')
  })

  it('全局自动记忆关闭时，无细纲单章仍执行必要同步', async () => {
    vi.spyOn(writer as unknown as { isAutoMemorySyncEnabled: () => Promise<boolean> }, 'isAutoMemorySyncEnabled').mockResolvedValue(false)
    const directions = (await writer.generateChapterDirections(id, 5))!
    const result = await writer.deliverChapter(id, 5, null, { directionChoice: { token: directions.token, directionId: 'c' } })
    expect(result.directionSyncCompleted).toBe(true)
    expect(generate.mock.calls.some(([, opts]) => opts?.meta?.feature === 'autoMemorySync')).toBe(true)
    expect((await new ChapterDirectionService(dir, 5, llm, id).read())?.completedHash).toBeTruthy()
  })

  it('已有细纲章直接按细纲写，缺纲章才生成推荐方向', async () => {
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 5, plotSummary: '林遥在第五处渡口收到纸条，向仓库走去。' })
    const result = await writer.generateChaptersBatch(id, 5, 6, () => {}, {}, {}, undefined, { autoContinue: true })
    expect(result.status).toBe('completed')
    expect(generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'chapterDirections').map(([, opts]) => opts.meta.chapterNumber)).toEqual([6])
  })

  it('章节概要失败后保留正文，恢复只补处理，不再次调用正文生成', async () => {
    const normal = generate.getMockImplementation()!
    let failSummary = true
    generate.mockImplementation(async (prompt, opts) => {
      if (failSummary && opts?.meta?.feature === 'chapterSummary') throw new Error('概要服务暂时不可用。')
      return normal(prompt, opts)
    })
    const stopped = await writer.generateChaptersBatch(id, 5, 6, () => {}, {}, {}, undefined, { autoContinue: true })
    expect(stopped.pendingPostProcessChapter).toBe(5)
    expect(await new ProseRepo(dir).read(5)).toBe(prose(5))
    expect(await new ProseRepo(dir).read(6)).toBe('')
    failSummary = false
    const resumed = await writer.generateChaptersBatch(id, 5, 6, () => {}, {}, {},
      { fromChapter: 5, total: 2, completed: stopped.completed, pendingPostProcessChapter: 5 }, { autoContinue: true })
    expect(resumed.status).toBe('completed')
    expect(await new DetailedOutlineMdRepo(dir).readChapter(5)).toBeNull()
    expect((await new ChapterSummaryRepo(dir).readCurrent(5, prose(5)))?.events).toHaveLength(2)
    expect(generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'chapter' && opts.meta.chapterNumber === 5)).toHaveLength(1)
  })

  it.each(['chapterSummary', 'autoMemorySync'])('单章 %s 失败后跨服务恢复，未达目标字数也须补完写后处理', async feature => {
    const normal = generate.getMockImplementation()!
    let fail = true
    generate.mockImplementation(async (prompt, opts) => {
      if (fail && opts?.meta?.feature === feature) throw new Error('写后服务暂时不可用。')
      return normal(prompt, opts)
    })
    const directions = (await writer.generateChapterDirections(id, 5))!
    await expect(writer.deliverChapter(id, 5, null, { directionChoice: { token: directions.token, directionId: 'c' } })).rejects.toThrow()
    const saved = await new ProseRepo(dir).read(5)
    expect(saved).toBe(prose(5))
    fail = false
    const restarted = new WriteService(projects, llm)
    vi.spyOn(restarted, 'selfCheckChapter').mockImplementation(writer.selfCheckChapter)
    vi.spyOn(restarted, 'auditChapter').mockImplementation(writer.auditChapter)
    const result = await restarted.deliverChapter(id, 5, null, { repairOnly: true, existingText: saved })
    expect(result.ok).toBe(true)
    expect(result.directionSyncCompleted).toBe(true)
    expect(result.directionSync).toBeDefined()
    expect(result.continueMode).toBe('finish')
    expect(await new DetailedOutlineMdRepo(dir).readChapter(5)).toBeNull()
    expect(await new ChapterSummaryRepo(dir).readCurrent(5, saved)).not.toBeNull()
    expect((await new ChapterDirectionService(dir, 5, llm, id).read())?.completedHash).toBeTruthy()
    expect(generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'chapter')).toHaveLength(1)
  })

  it('真正的分轮半稿修复后仍保持未完成，不提前生成概要或结单', async () => {
    const prefix = '林遥来到渡口。'
    await new ProseRepo(dir).write(5, prefix)
    const directions = (await writer.generateChapterDirections(id, 5, prefix))!
    const result = await writer.deliverChapter(id, 5, null, { existingText: prefix,
      directionChoice: { token: directions.token, directionId: 'c' } })
    expect(result.continueMode).toBe('extend')
    expect(result.directionSyncCompleted).toBeUndefined()
    const retried = await writer.deliverChapter(id, 5, null, { repairOnly: true, existingText: result.saved!.content })
    expect(retried.continueMode).toBe('extend')
    expect(retried.directionSyncCompleted).toBeUndefined()
    expect(await new DetailedOutlineMdRepo(dir).readChapter(5)).toBeNull()
    expect((await new ChapterDirectionService(dir, 5, llm, id).read())?.completedHash).toBeUndefined()
  })

  it('半稿续写达到目标字数时按完章自动完成概要与记忆同步', async () => {
    const prefix = '林遥来到渡口。'
    const continuation = `${first(5)}${'夜风吹过渡口长堤。'.repeat(260)}\n\n${last}`
    const fullExpected = `${prefix}\n\n${continuation}`
    const normal = generate.getMockImplementation()!
    generate.mockImplementation(async (prompt, opts) => {
      if (opts?.meta?.feature === 'chapter' && opts.meta.chapterNumber === 5) return continuation
      return normal(prompt, opts)
    })
    await new ProseRepo(dir).write(5, prefix)
    const directions = (await writer.generateChapterDirections(id, 5, prefix))!
    const result = await writer.deliverChapter(id, 5, null, {
      existingText: prefix,
      directionChoice: { token: directions.token, directionId: 'c' }
    })
    expect(result.ok).toBe(true)
    expect(result.continueMode).toBe('finish')
    expect(result.directionSyncCompleted).toBe(true)
    expect(result.directionSync?.memory.applied.plotPoints).toBe(1)
    expect(await new ChapterSummaryRepo(dir).readCurrent(5, fullExpected)).not.toBeNull()
    expect((await new ChapterDirectionService(dir, 5, llm, id).read())?.completedHash).toBeTruthy()
  })

  it('记忆服务失败时保留正文，恢复同步成功后才开始下一章', async () => {
    const normal = generate.getMockImplementation()!
    let failMemory = true
    generate.mockImplementation(async (prompt, opts) => {
      if (failMemory && ['autoMemorySync', 'batchMemory'].includes(opts?.meta?.feature)) throw new Error('记忆服务暂时不可用。')
      return normal(prompt, opts)
    })
    const stopped = await writer.generateChaptersBatch(id, 5, 6, () => {}, {}, {}, undefined, { autoContinue: true })
    expect(stopped.pendingPostProcessChapter).toBe(5)
    expect(await new ProseRepo(dir).read(5)).toBe(prose(5))
    expect(await new DetailedOutlineMdRepo(dir).readChapter(5)).toBeNull()
    expect(await new ProseRepo(dir).read(6)).toBe('')
    expect((await new ChapterDirectionService(dir, 5, llm, id).read())?.completedHash).toBeUndefined()
    failMemory = false
    const restarted = new WriteService(projects, llm)
    vi.spyOn(restarted, 'selfCheckChapter').mockImplementation(writer.selfCheckChapter)
    vi.spyOn(restarted, 'auditChapter').mockImplementation(writer.auditChapter)
    const resumed = await restarted.generateChaptersBatch(id, 5, 6, () => {}, {}, {},
      { fromChapter: 5, total: 2, completed: stopped.completed, pendingPostProcessChapter: 5 }, { autoContinue: true })
    expect(resumed.status).toBe('completed')
    expect(await new ChapterSummaryRepo(dir).readCurrent(5, prose(5))).not.toBeNull()
    expect(generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'chapter' && opts.meta.chapterNumber === 5)).toHaveLength(1)
  })

  it('无细纲批次中断后作者补入正式细纲，补跑按正式细纲结单，不再拿旧方向拒稿或卡死后章', async () => {
    const normal = generate.getMockImplementation()!
    let failMemory = true
    let failDirectionReview = false
    generate.mockImplementation(async (prompt, opts) => {
      if (failMemory && ['autoMemorySync', 'batchMemory'].includes(opts?.meta?.feature)) throw new Error('记忆服务暂时不可用。')
      if (failDirectionReview && opts?.meta?.feature === 'chapterDirectionReview' && opts?.meta?.chapterNumber === 5) {
        return JSON.stringify({ completed: true, passed: false, issues: ['旧方向要求改回原结尾'] })
      }
      return normal(prompt, opts)
    })
    const stopped = await writer.generateChaptersBatch(id, 5, 6, () => {}, {}, {}, undefined, { autoContinue: true })
    expect(stopped.pendingPostProcessChapter).toBe(5)
    // Author adds a formal outline for chapter 5 before resuming.
    await mkdir(join(dir, '细纲'), { recursive: true })
    await writeFile(join(dir, '细纲', '细纲_第005章_正式版.md'),
      '# 细纲_第005章_正式版.md\n\n## 第 5 章：正式版\n\n- **核心事件**：林遥在渡口拿到纸条后沿河前往仓库。\n- **章尾钩子**：纸条背面还有空白签署栏。\n')
    failMemory = false
    failDirectionReview = true
    const callsBeforeResume = generate.mock.calls.length
    const restarted = new WriteService(projects, llm)
    vi.spyOn(restarted, 'selfCheckChapter').mockImplementation(writer.selfCheckChapter)
    vi.spyOn(restarted, 'auditChapter').mockImplementation(writer.auditChapter)
    const resumed = await restarted.generateChaptersBatch(id, 5, 6, () => {}, {}, {},
      { fromChapter: 5, total: 2, completed: stopped.completed, pendingPostProcessChapter: 5 }, { autoContinue: true })
    expect(resumed.status).toBe('completed')
    const resumedCalls = generate.mock.calls.slice(callsBeforeResume)
    expect(resumedCalls.some(([, opts]) => opts?.meta?.feature === 'chapterDirectionReview' && opts?.meta?.chapterNumber === 5)).toBe(false)
    expect(await new ProseRepo(dir).read(6)).toBe(prose(6))
  })

  it('章节概要遇到 LLM_OUTPUT_TRUNCATED 时自动提高 maxTokens 并精简重提，不直接中断交稿', async () => {
    const normal = generate.getMockImplementation()!
    let summaryAttempts = 0
    generate.mockImplementation(async (prompt, opts) => {
      if (opts?.meta?.feature === 'chapterSummary') {
        summaryAttempts++
        if (summaryAttempts === 1) throw new Error('LLM_OUTPUT_TRUNCATED')
      }
      return normal(prompt, opts)
    })
    const directions = (await writer.generateChapterDirections(id, 5))!
    const result = await writer.deliverChapter(id, 5, null, { directionChoice: { token: directions.token, directionId: 'c' } })
    expect(result.ok).toBe(true)
    expect(result.directionSyncCompleted).toBe(true)
    const summaryCalls = generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'chapterSummary')
    expect(summaryCalls).toHaveLength(2)
    expect(summaryCalls[0][1]?.maxTokens).toBe(12288)
    expect(summaryCalls[1][1]?.maxTokens).toBe(16384)
    expect(summaryCalls[1][0]).toContain('精简')
  })

  it('混合模式：无细纲第 5 章写完生成概要后，有细纲第 6 章自动读取第 5 章概要', async () => {
    const directions = (await writer.generateChapterDirections(id, 5))!
    const ch5Result = await writer.deliverChapter(id, 5, null, { directionChoice: { token: directions.token, directionId: 'c' } })
    expect(ch5Result.directionSyncCompleted).toBe(true)
    expect(await new DetailedOutlineMdRepo(dir).readChapter(5)).toBeNull()

    await new OutlineRepository(dir).upsertDetailed({
      chapterNumber: 6,
      plotSummary: '林遥潜入东岸仓库核查账本。',
      hook: '铁箱内还有第二把钥匙。'
    })
    const ch6Batch = await writer.generateChaptersBatch(id, 6, 6, () => {}, {}, {}, undefined, { autoContinue: true })
    expect(ch6Batch.status).toBe('completed')
    const ch6Prompt = generate.mock.calls.find(([, opts]) => opts?.meta?.feature === 'chapter' && opts.meta.chapterNumber === 6)?.[0]
    expect(ch6Prompt).toContain('**上一章概要**')
    expect(ch6Prompt).toContain('林遥在渡口取得仓库线索')
    expect(ch6Prompt).not.toContain('**上一章细纲**')
  })

  it('单章方向交稿以正文为准放行非连贯自检失败并容忍单条 heldBack', async () => {
    vi.spyOn(writer, 'selfCheckChapter').mockResolvedValue({
      schemaVersion: 1, chapterNumber: 5, generatedAt: '', ok: false, summary: '章末钩子偏弱',
      counts: { pass: 0, fail: 1, warn: 0, skip: 0 },
      items: [{ id: 'hook_weak', category: 'structure', verdict: 'fail', label: '章末钩子偏弱', detail: '可加强悬念。' }]
    })
    const normal = generate.getMockImplementation()!
    generate.mockImplementation(async (prompt, opts) => {
      if (opts?.meta?.feature === 'autoMemorySync' || opts?.meta?.feature === 'memoryEvidenceRepair') {
        return JSON.stringify({
          chapterNumber: 5, newCharacters: [], newLocations: [], newItems: [], newForeshadowings: [],
          newPlotPoints: [
            { title: '渡口线索', event: '林遥在渡口取得仓库线索。', evidence: first(5) },
            { title: '虚构冲突', event: '林遥在桥头击败三名黑衣人。', evidence: '正文里根本不存在这段打斗原句。' }
          ],
          characterStateChanges: [], collectedForeshadowings: []
        })
      }
      return normal(prompt, opts)
    })
    const directions = (await writer.generateChapterDirections(id, 5))!
    const result = await writer.deliverChapter(id, 5, null, { directionChoice: { token: directions.token, directionId: 'c' } })
    expect(result.ok).toBe(true)
    expect(result.directionSyncCompleted).toBe(true)
    expect(result.directionSync?.memory.applied.plotPoints).toBe(1)
    expect(result.directionSync?.memory.heldBack).toHaveLength(1)
    expect(result.directionSync?.memory.heldBack?.[0]).toContain('虚构冲突')
    expect(await new ChapterSummaryRepo(dir).readCurrent(5, prose(5))).not.toBeNull()
    expect((await new ChapterDirectionService(dir, 5, llm, id).read())?.completedHash).toBeTruthy()
  })

  it('一键同步支持完全无细纲章与旧版未手改自动细纲章，容忍 heldBack 并完成方向结单', async () => {
    // 场景 A：完全无细纲 + 待结单方向 + 1 条 heldBack
    const directionsA = (await writer.generateChapterDirections(id, 5))!
    await new ChapterDirectionService(dir, 5, llm, id).select({ token: directionsA.token, directionId: 'c' }, '', '', 2500)
    await new ProseRepo(dir).write(5, prose(5))
    const normal = generate.getMockImplementation()!
    generate.mockImplementation(async (prompt, opts) => {
      if (opts?.meta?.feature === 'autoMemorySync' || opts?.meta?.feature === 'memoryEvidenceRepair') {
        return JSON.stringify({
          chapterNumber: 5, newCharacters: [], newLocations: [], newItems: [], newForeshadowings: [],
          newPlotPoints: [
            { title: '渡口线索', event: '林遥在渡口取得仓库线索。', evidence: first(5) },
            { title: '失真细节', event: '船夫其实认识林遥母亲。', evidence: '完全不存在的原句。' }
          ],
          characterStateChanges: [], collectedForeshadowings: []
        })
      }
      return normal(prompt, opts)
    })
    const syncA = await writer.syncChapterWorkflow(id, 5, prose(5), { requestId: 'sync-no-outline' })
    expect(syncA.error).toBeUndefined()
    expect(syncA.outline?.hasOutline).toBe(false)
    expect(syncA.memory?.memory.applied.plotPoints).toBe(1)
    expect(syncA.memory?.memory.heldBack).toHaveLength(1)
    expect(generate.mock.calls.some(([, opts]) => opts?.meta?.feature === 'outlineCheck')).toBe(false)
    expect(await new ChapterSummaryRepo(dir).readCurrent(5, prose(5))).not.toBeNull()
    expect((await new ChapterDirectionService(dir, 5, llm, id).read())?.completedHash).toBeTruthy()

    // 场景 B：存在旧版未修改自动细纲（generated.fileHash 与磁盘一致），应识别为无正式细纲并跳过细纲对照
    const directionsB = (await writer.generateChapterDirections(id, 6))!
    await new ChapterDirectionService(dir, 6, llm, id).select({ token: directionsB.token, directionId: 'c' }, '', '', 2500)
    await new ProseRepo(dir).write(6, prose(6))
    const legacyOutline = '# 细纲_第006章_第6章.md\n\n## 第 6 章：第6章\n\n- **核心事件**：林遥在渡口取得仓库线索。\n- **章末钩子**：林遥收好纸条前往仓库。\n'
    await mkdir(join(dir, '细纲'), { recursive: true })
    await writeFile(join(dir, '细纲', '细纲_第006章_第6章.md'), legacyOutline, 'utf-8')
    const dirService6 = new ChapterDirectionService(dir, 6, llm, id)
    const dirState6 = (await dirService6.read())!
    await writeJsonAtomic(join(dir, '.cache', 'chapter-directions', '6.json'), {
      ...dirState6,
      generated: { sourceHash: hashProse(prose(6)), fileName: '细纲_第006章_第6章.md', fileHash: hashProse(legacyOutline) }
    })
    generate.mockImplementation(normal)
    const callsBeforeB = generate.mock.calls.length
    const syncB = await writer.syncChapterWorkflow(id, 6, prose(6), { requestId: 'sync-legacy-generated' })
    expect(syncB.error).toBeUndefined()
    expect(syncB.outline?.hasOutline).toBe(false)
    expect(generate.mock.calls.slice(callsBeforeB).some(([, opts]) => opts?.meta?.feature === 'outlineCheck')).toBe(false)
    expect(await new ChapterSummaryRepo(dir).readCurrent(6, prose(6))).not.toBeNull()
  })

  it('记忆重跑自动剔除已强制确认的条目，不再重复列入 heldBack 或重复入库', async () => {
    await new ProseRepo(dir).write(5, prose(5))
    const normal = generate.getMockImplementation()!
    const dualExtraction = JSON.stringify({
      chapterNumber: 5, newCharacters: [], newLocations: [], newItems: [], newForeshadowings: [],
      newPlotPoints: [
        { title: '渡口线索', event: '林遥在渡口取得仓库线索。', evidence: first(5) },
        { title: '强行补录', event: '船夫悄悄记住林遥相貌。', evidence: '正文未直接写出的心理猜测。' }
      ],
      characterStateChanges: [], collectedForeshadowings: []
    })
    generate.mockImplementation(async (prompt, opts) => {
      if (['autoMemorySync', 'memoryEvidenceRepair'].includes(opts?.meta?.feature ?? '')) return dualExtraction
      return normal(prompt, opts)
    })

    const initial = await writer.syncChapterAfterWrite(id, 5, prose(5), { skipIfDisabled: false, proseFirst: true })
    expect(initial?.memory.applied.plotPoints).toBe(1)
    expect(initial?.memory.heldBack).toHaveLength(1)

    const forcedRes = await writer.forceApplyMemoryCandidateItems(id, 5, [{ kind: 'plotPoint', index: 1 }])
    expect(forcedRes.applied.applied.plotPoints).toBe(1)
    const beforeFiles = (await readdir(join(dir, '记忆', '剧情点'))).filter(f => f.includes('强行补录'))
    expect(beforeFiles).toHaveLength(1)

    const rerun = await writer.syncChapterAfterWrite(id, 5, prose(5), { skipIfDisabled: false, proseFirst: true })
    expect(rerun?.memory.heldBack).toBeUndefined()
    const afterFiles = (await readdir(join(dir, '记忆', '剧情点'))).filter(f => f.includes('强行补录'))
    expect(afterFiles).toHaveLength(1)
    expect((await writer.inspectMemoryCandidate(id, 5))?.items.find(i => i.label.includes('强行补录'))?.forced).toBe(true)
  })

  it('无细纲且无方向缓存的隔离章节可通过 repairQuarantinedChapters 恢复并生成概要', async () => {
    await new ProseRepo(dir).write(5, prose(5))
    await markLongformPending(dir, 5, hashProse(prose(5)))
    await markBatchReviewPending(dir, 5, hashProse(prose(5)))

    const repairedResults: ChapterFlowResult[] = []
    const repaired = await writer.repairQuarantinedChapters(id, (_ch, res) => { repairedResults.push(res) })
    expect(repaired.ok).toBe(true)
    expect(repaired.repaired).toEqual([5])
    expect(repairedResults).toHaveLength(1)
    expect(repairedResults[0].outlineOptional).toBe(true)
    expect(await new DetailedOutlineMdRepo(dir).readChapter(5)).toBeNull()
    expect(await new ChapterSummaryRepo(dir).readCurrent(5, prose(5))).not.toBeNull()
    const reviewState = await readLongformReviewState(dir)
    expect(reviewState.pending['5']).toBeUndefined()
    expect(reviewState.batchPending?.['5']).toBeUndefined()
  })

  it('ChapterService 无细纲时 synopsis 自动回退到当前正文的章节概要', async () => {
    await writeFile(
      join(dir, '图解', '节奏图谱.html'),
      `<script>\nconst rhythmData = [\n  { chapter: 5, title: '夜探渡口', emotion: 5, climax: 1, volume: 1, actualized: false }\n];\n</script>`,
      'utf-8'
    )
    const directions = (await writer.generateChapterDirections(id, 5))!
    await writer.deliverChapter(id, 5, null, { directionChoice: { token: directions.token, directionId: 'c' } })
    const chapterService = new ChapterService(projects)
    const metas = await chapterService.listChapters(id)
    const ch5Meta = metas.find(item => item.chapterNumber === 5)
    expect(ch5Meta?.synopsis).toContain('林遥在渡口取得仓库线索')
    const ch5 = await chapterService.getChapter(id, 5)
    expect(ch5.meta.synopsis).toContain('林遥在渡口取得仓库线索')
  })

  it('选择方向后主大纲被修改仍可顺利交稿同步，不再抛出 DIRECTION_CONTEXT_CHANGED', async () => {
    const directions = (await writer.generateChapterDirections(id, 5))!
    const selectedDirection = await new ChapterDirectionService(dir, 5, llm, id).select({ token: directions.token, directionId: 'c' }, '', '', 2500)
    await writeFile(
      join(dir, '大纲', '大纲.md'),
      '# 失踪账本\n\n## 主线剧情走向\n\n林遥先调查渡口线索，再追查仓库和总账簿。\n\n## 后续限制\n\n第十五章之前不揭露幕后主使，不写全书完结。',
      'utf-8'
    )
    const result = await writer.deliverChapter(id, 5, null, { selectedDirection })
    expect(result.ok).toBe(true)
    expect(result.directionSyncCompleted).toBe(true)
    expect(await new ChapterSummaryRepo(dir).readCurrent(5, prose(5))).not.toBeNull()
  })

  it('当前章残留未手改旧自动细纲时，写作上下文不泄漏旧细纲且 ChapterService 回退到最新章节概要', async () => {
    await writeFile(
      join(dir, '图解', '节奏图谱.html'),
      `<script>\nconst rhythmData = [\n  { chapter: 5, title: '夜探渡口', emotion: 5, climax: 1, volume: 1, actualized: false }\n];\n</script>`,
      'utf-8'
    )
    const legacyOutline = [
      '# 细纲_第005章_第5章.md',
      '',
      '## 第 5 章：第5章',
      '',
      '- **核心事件**：旧自动细纲里的过期事件。',
      '- **章末钩子**：旧自动细纲里的过期钩子。',
      '',
      '### 实际事件顺序',
      '',
      '1. 旧自动细纲里的分步动作。'
    ].join('\n')
    const directions = (await writer.generateChapterDirections(id, 5))!
    expect(directions.directions).toHaveLength(5)
    await new ChapterDirectionService(dir, 5, llm, id).select({ token: directions.token, directionId: 'c' }, '', '', 2500)
    await mkdir(join(dir, '细纲'), { recursive: true })
    await writeFile(join(dir, '细纲', '细纲_第005章_第5章.md'), legacyOutline, 'utf-8')
    const dirState = (await new ChapterDirectionService(dir, 5, llm, id).read())!
    await writeJsonAtomic(join(dir, '.cache', 'chapter-directions', '5.json'), {
      ...dirState,
      generated: { sourceHash: hashProse('旧版本正文。'), fileName: '细纲_第005章_第5章.md', fileHash: hashProse(legacyOutline) }
    })

    await new ProseRepo(dir).write(5, prose(5))
    await new ChapterSummaryRepo(dir).write({
      schemaVersion: 1,
      chapterNumber: 5,
      sourceHash: hashProse(prose(5)),
      generatedAt: new Date().toISOString(),
      events: [{ text: '林遥在渡口取得最新线索。', evidence: first(5) }],
      stateChanges: [],
      openThreads: [],
      continuity: []
    })

    const prompt = await writer.buildChapterPrompt(id, 5)
    expect(prompt.user).not.toContain('旧自动细纲里的过期事件')
    expect(prompt.user).not.toContain('旧自动细纲里的分步动作')

    const chapterService = new ChapterService(projects)
    const metas = await chapterService.listChapters(id)
    const ch5Meta = metas.find(item => item.chapterNumber === 5)
    expect(ch5Meta?.synopsis).toContain('林遥在渡口取得最新线索')
    expect(ch5Meta?.synopsis).not.toContain('旧自动细纲里的过期事件')
    const ch5 = await chapterService.getChapter(id, 5)
    expect(ch5.meta.synopsis).toContain('林遥在渡口取得最新线索')
    expect(ch5.meta.synopsis).not.toContain('旧自动细纲里的过期事件')
  })

  it('后处理中断后用户删短草稿再修复，因 postProcessing.sourceHash 不匹配保持 extend 不提前结单', async () => {
    const normal = generate.getMockImplementation()!
    let failSummary = true
    generate.mockImplementation(async (prompt, opts) => {
      if (failSummary && opts?.meta?.feature === 'chapterSummary') throw new Error('概要服务暂时不可用。')
      return normal(prompt, opts)
    })
    const directions = (await writer.generateChapterDirections(id, 5))!
    await expect(
      writer.deliverChapter(id, 5, null, { directionChoice: { token: directions.token, directionId: 'c' } })
    ).rejects.toThrow()
    const failedState = (await new ChapterDirectionService(dir, 5, llm, id).read())!
    expect(failedState.postProcessing?.sourceHash).toBe(hashProse(prose(5)))

    failSummary = false
    const shortPrefix = '林遥来到渡口。'
    await new ChapterService(projects).updateContent(id, 5, shortPrefix)
    const retried = await writer.deliverChapter(id, 5, null, { repairOnly: true, existingText: shortPrefix })
    expect(retried.continueMode).toBe('extend')
    expect(retried.directionSyncCompleted).toBeUndefined()
    expect((await new ChapterDirectionService(dir, 5, llm, id).read())?.completedHash).toBeUndefined()
  })
})
