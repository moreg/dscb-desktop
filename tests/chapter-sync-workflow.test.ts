import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { WriteService } from '../src/main/data/write-service'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { OutlineDiffItem } from '../src/shared/types'
import { createWritingProject } from './helpers/writing-project'

describe('backend sync orchestration', () => {
  let root: string, dir: string, pid: string, service: WriteService, repo: ProseRepo
  const source = '林远把账册交给守门人。守门人核对印章。'
  const inspect = vi.fn()
  const summary = vi.fn()
  const sync = vi.fn()
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'backend-sync-'))
    const settings = { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository
    const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
    const project = await createWritingProject(projects, { name: '同步编排' })
    pid = project.id; dir = project.path; repo = new ProseRepo(dir)
    await repo.write(1, source)
    service = new WriteService(projects, {} as LlmService)
    const internal = service as unknown as {
      assertLongformConsistencyAutoRepaired: (p: string, c: number, text: string) => Promise<string>
      checkOutlineWithRetry: () => Promise<unknown>
    }
    vi.spyOn(internal, 'assertLongformConsistencyAutoRepaired').mockImplementation(async (_p, _c, text) => text)
    inspect.mockReset().mockResolvedValue({ chapterNumber: 1, checked: true, hasOutline: true, passed: true, diffs: [] })
    vi.spyOn(internal, 'checkOutlineWithRetry').mockImplementation(inspect)
    vi.spyOn(service, 'autoResolveOutlineDiffs').mockResolvedValue([])
    summary.mockReset().mockResolvedValue({ chapterNumber: 1, events: [], stateChanges: [], openThreads: [] })
    sync.mockReset().mockResolvedValue(null)
    vi.spyOn(service, 'generateChapterSummary').mockImplementation(summary)
    vi.spyOn(service, 'syncChapterAfterWrite').mockImplementation(sync)
  })
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
  const run = (signal?: AbortSignal) => service.syncChapterWorkflow(pid, 1, source, { requestId: 'sync' }, signal)

  it('synchronizes a saved snapshot without generating prose or polishing it', async () => {
    const generate = vi.spyOn(service, 'generateChapterStream')
    const polish = vi.spyOn(service, 'polishChapterDelivery')
    const result = await run()
    expect(result.error).toBeUndefined()
    expect(result.saved?.content).toBe(source)
    expect(result.steps.map(step => step.id)).toEqual(['index', 'outline', 'summary', 'memory'])
    expect(summary.mock.calls[0][2]).toBe(source)
    expect(sync.mock.calls[0][2]).toBe(source)
    expect(generate).not.toHaveBeenCalled(); expect(polish).not.toHaveBeenCalled()
  })
  it('does not analyze unsaved content or overwrite another author edit', async () => {
    await repo.write(1, '另一窗口的新正文。')
    const result = await run()
    expect(result.error).toContain('正文已变化')
    expect(result.saved).toBeUndefined()
    expect(inspect).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled()
    expect(await repo.read(1)).toBe('另一窗口的新正文。')
  })
  it('repairs seven findings in the backend and extracts memory only from the final version', async () => {
    let pending = 7, current = source
    inspect.mockImplementation(async () => ({ chapterNumber: 1, checked: true, hasOutline: true, diffs:
      Array.from({ length: pending }, (_, index): OutlineDiffItem => ({ type: 1, typeLabel: '漏写', priority: 'P1', outline: `事件${index}`, suggestion: '补写' })) }))
    const prepare = vi.spyOn(service, 'autoRepairOutlineDifference').mockImplementation(async () => ({
      status: 'candidate', token: 'candidate', target: 'prose', content: current + '补齐事件。', reason: '核验通过'
    }))
    vi.spyOn(service, 'commitOutlineLocalRepair').mockImplementation(async () => {
      current += '补齐事件。'; pending--; await repo.write(1, current)
    })
    const result = await run()
    expect(prepare).toHaveBeenCalledTimes(7)
    expect(result.error).toBeUndefined()
    expect(result.saved?.content).toBe(current)
    expect(sync).toHaveBeenCalledOnce()
    expect(sync.mock.calls[0][2]).toBe(current)
  })
  it('does not adopt or submit memory after cancellation during repair', async () => {
    const controller = new AbortController()
    inspect.mockResolvedValue({ chapterNumber: 1, checked: true, hasOutline: true, diffs: [{ type: 1, priority: 'P1' }] })
    vi.spyOn(service, 'autoRepairOutlineDifference').mockImplementation(async () => {
      controller.abort(); return { status: 'candidate', token: 'cancelled', target: 'prose', content: '不应采用的候选。', reason: '' }
    })
    const commit = vi.spyOn(service, 'commitOutlineLocalRepair')
    const result = await run(controller.signal)
    expect(result.error).toContain('LLM_ABORTED')
    expect(commit).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled(); expect(summary).not.toHaveBeenCalled()
    expect(result.saved?.content).toBe(source)
  })
  it('stops stalled repairs and retains their saved result without submitting unresolved facts', async () => {
    inspect.mockResolvedValue({ chapterNumber: 1, checked: true, hasOutline: true, diffs: [{ type: 1, priority: 'P1' }] })
    vi.spyOn(service, 'autoRepairOutlineDifference').mockResolvedValue({ status: 'candidate', token: 'same', target: 'outline', content: source, reason: '' })
    const commit = vi.spyOn(service, 'commitOutlineLocalRepair').mockResolvedValue(undefined)
    const result = await run()
    expect(commit).toHaveBeenCalledTimes(3)
    expect(result.error).toContain('关键差异')
    expect(sync).not.toHaveBeenCalled(); expect(summary).not.toHaveBeenCalled()
  })
  it('does not return an unrelated saved receipt if an external edit arrives during analysis', async () => {
    summary.mockImplementation(async () => { await repo.write(1, '作者改稿。'); return {} })
    const result = await run()
    expect(result.error).toContain('正文已变化')
    expect(result.saved).toBeUndefined()
    expect(await repo.read(1)).toBe('作者改稿。')
  })
})
