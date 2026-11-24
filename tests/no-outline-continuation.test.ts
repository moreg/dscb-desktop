import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
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
import { createWritingProject } from './helpers/writing-project'
import { withPassingLongformGuard } from './helpers/passing-longform'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { ChapterFlowResult } from '../src/shared/types'

describe('无细纲单章与一键十章的真实编排', () => {
  let root: string
  let dir: string
  let id: string
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
    const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
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

  it('只有大纲也可从指定章生成五个方向，采用后保存正文、创建细纲、同步概要与记忆', async () => {
    const directions = (await writer.generateChapterDirections(id, 5))!
    expect(directions.missingPreviousProse).toBe(true)
    expect(directions.directions).toHaveLength(5)
    expect(generate.mock.calls.find(([, opts]) => opts?.meta?.feature === 'chapterDirections')?.[0]).toContain('第十五章之前不揭露幕后主使')
    const result = await writer.deliverChapter(id, 5, null, { directionChoice: { token: directions.token, directionId: 'b' } })
    expect(result.ok).toBe(true)
    expect(result.directionSyncCompleted).toBe(true)
    expect(await new ProseRepo(dir).read(5)).toBe(prose(5))
    expect(await new ProseRepo(dir).read(4)).toBe('')
    expect((await new DetailedOutlineMdRepo(dir).readChapter(5))?.plotSummary).toContain('渡口取得仓库线索')
    expect(await new DetailedOutlineMdRepo(dir).readChapter(4)).toBeNull()
    expect((await new ChapterSummaryRepo(dir).readCurrent(5, prose(5)))?.events).toHaveLength(2)
    expect((await new ChapterDirectionService(dir, 5, llm, id).read())?.completedHash).toBeTruthy()
    const actualPrompt = generate.mock.calls.find(([, opts]) => opts?.meta?.feature === 'chapter')?.[0]
    expect(actualPrompt).toContain('调查渠道2')
    expect(actualPrompt).not.toContain('方向：调查渠道3')
  })

  it('一键十章逐章使用推荐项，每章完成同步后才规划下一章', async () => {
    const results: ChapterFlowResult[] = []
    const result = await writer.generateChaptersBatch(id, 5, 14, (_n, value) => { results.push(value) }, {}, {}, undefined, { autoContinue: true })
    expect(result.status).toBe('completed')
    expect(results).toHaveLength(10)
    expect(results.every(value => value.direction?.title === '调查渠道3' && value.chapterSummary?.stale === false)).toBe(true)
    expect(generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'chapterDirections')).toHaveLength(10)
    const sixthPlanning = generate.mock.calls.find(([prompt, opts]) => opts?.meta?.feature === 'chapterDirections' && opts.meta.chapterNumber === 6)?.[0]
    expect(sixthPlanning).toContain(first(5))
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

  it('反向细纲失败后保留正文，恢复只补处理，不再次调用正文生成', async () => {
    const normal = generate.getMockImplementation()!
    let failOutline = true
    generate.mockImplementation(async (prompt, opts) => {
      if (failOutline && opts?.meta?.feature === 'chapterOutlineFromProse') throw new Error('细纲服务暂时不可用。')
      return normal(prompt, opts)
    })
    const stopped = await writer.generateChaptersBatch(id, 5, 6, () => {}, {}, {}, undefined, { autoContinue: true })
    expect(stopped.pendingPostProcessChapter).toBe(5)
    expect(await new ProseRepo(dir).read(5)).toBe(prose(5))
    expect(await new ProseRepo(dir).read(6)).toBe('')
    failOutline = false
    const resumed = await writer.generateChaptersBatch(id, 5, 6, () => {}, {}, {},
      { fromChapter: 5, total: 2, completed: stopped.completed, pendingPostProcessChapter: 5 }, { autoContinue: true })
    expect(resumed.status).toBe('completed')
    expect(generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'chapter' && opts.meta.chapterNumber === 5)).toHaveLength(1)
  })

  it.each(['chapterOutlineFromProse', 'autoMemorySync'])('单章 %s 失败后跨服务恢复，未达目标字数也须补完写后处理', async feature => {
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
    const restarted = new WriteService((writer as unknown as { projectService: ProjectService }).projectService, llm)
    vi.spyOn(restarted, 'selfCheckChapter').mockImplementation(writer.selfCheckChapter)
    vi.spyOn(restarted, 'auditChapter').mockImplementation(writer.auditChapter)
    const result = await restarted.deliverChapter(id, 5, null, { repairOnly: true, existingText: saved })
    expect(result.ok).toBe(true)
    expect(result.directionSyncCompleted).toBe(true)
    expect(result.continueMode).toBe('finish')
    expect(await new DetailedOutlineMdRepo(dir).readChapter(5)).not.toBeNull()
    expect(await new ChapterSummaryRepo(dir).readCurrent(5, saved)).not.toBeNull()
    expect((await new ChapterDirectionService(dir, 5, llm, id).read())?.completedHash).toBeTruthy()
    expect(generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'chapter')).toHaveLength(1)
  })

  it('真正的分轮半稿修复后仍保持未完成，不提前创建完整细纲', async () => {
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

  it('记忆服务失败时保留正文与细纲，恢复同步成功后才开始下一章', async () => {
    const normal = generate.getMockImplementation()!
    let failMemory = true
    generate.mockImplementation(async (prompt, opts) => {
      if (failMemory && ['autoMemorySync', 'batchMemory'].includes(opts?.meta?.feature)) throw new Error('记忆服务暂时不可用。')
      return normal(prompt, opts)
    })
    const stopped = await writer.generateChaptersBatch(id, 5, 6, () => {}, {}, {}, undefined, { autoContinue: true })
    expect(stopped.pendingPostProcessChapter).toBe(5)
    expect(await new ProseRepo(dir).read(5)).toBe(prose(5))
    expect(await new DetailedOutlineMdRepo(dir).readChapter(5)).not.toBeNull()
    expect(await new ProseRepo(dir).read(6)).toBe('')
    expect((await new ChapterDirectionService(dir, 5, llm, id).read())?.completedHash).toBeUndefined()
    failMemory = false
    const restarted = new WriteService((writer as unknown as { projectService: ProjectService }).projectService, llm)
    vi.spyOn(restarted, 'selfCheckChapter').mockImplementation(writer.selfCheckChapter)
    vi.spyOn(restarted, 'auditChapter').mockImplementation(writer.auditChapter)
    const resumed = await restarted.generateChaptersBatch(id, 5, 6, () => {}, {}, {},
      { fromChapter: 5, total: 2, completed: stopped.completed, pendingPostProcessChapter: 5 }, { autoContinue: true })
    expect(resumed.status).toBe('completed')
    expect(generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'chapter' && opts.meta.chapterNumber === 5)).toHaveLength(1)
  })

  it('无细纲批次中断后作者补入/改写正式细纲，补跑按正式细纲结单，不再拿旧方向拒稿或卡死后章', async () => {
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
    // Author replaces the auto-generated chapter 5 outline with a formal outline that diverges from the old direction.
    const raw = (await new DetailedOutlineMdRepo(dir).readRaw(5))!
    await writeFile(join(dir, '细纲', raw.fileName),
      '# 细纲_第005章_正式版.md\n\n## 第 5 章：正式版\n\n- **核心事件**：林遥在渡口拿到纸条后沿河前往仓库。\n- **章尾钩子**：纸条背面还有空白签署栏。\n')
    failMemory = false
    failDirectionReview = true
    const callsBeforeResume = generate.mock.calls.length
    const restarted = new WriteService((writer as unknown as { projectService: ProjectService }).projectService, llm)
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
})
