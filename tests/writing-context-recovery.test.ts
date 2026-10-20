import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { WriteService } from '../src/main/data/write-service'
import { WriteFlowService } from '../src/main/data/write-flow-service'
import { OutlineRepository } from '../src/main/data/outline-repository'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { DetailedOutlineMdRepo } from '../src/main/data/skill-format/detailed-outline-md-repo'
import { DetailedOutlineWriter } from '../src/main/data/skill-format/detailed-outline-writer'
import { ChapterVersionRepository } from '../src/main/data/chapter-version-repository'
import { ChapterSummaryRepo } from '../src/main/data/memory/chapter-summary-repo'
import { TrackingMdRepo } from '../src/main/data/skill-format/tracking-md-repo'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

const previous = '师父把钥匙交给林远，让他守在山门。林远接住钥匙，留在门边等候。'
const ending = { chapterNumber: 1, characterPositions: [], characterStates: [], timePoint: '', unfinished: [], suspense: '', props: [] }
let root: string, dir: string, id: string, service: WriteService
let generate: ReturnType<typeof vi.fn>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'writing-context-recovery-'))
  const settings = { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository
  const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
  id = (await projects.create({ name: '自动补齐', genre: '玄幻' })).id
  dir = await projects.resolveDir(id)
  generate = vi.fn(async (_prompt, opts) => {
    if (opts?.meta?.feature === 'outline-generate') return JSON.stringify({ plotSummary: '林远依照师父嘱咐守门，核对来客的身份。', charactersAppearing: [], foreshadowings: [] })
    if (opts?.meta?.feature === 'chapterSummary') return JSON.stringify({ events: [{ text: '师父交出钥匙，林远守门。', evidence: previous }], stateChanges: [], openThreads: [], continuity: [] })
    return '林远抬起手，示意来客在门外等候。'
  })
  service = new WriteService(projects, { generateStream: generate } as unknown as LlmService)
  vi.spyOn(WriteFlowService.prototype, 'extractEndingState').mockResolvedValue(ending)
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

async function plan(number: number, summary = '林远核对来客') {
  await new OutlineRepository(dir).upsertDetailed({ chapterNumber: number, plotSummary: summary })
}
function chapterPrompt(): string { return generate.mock.calls.find(call => call[1]?.meta?.feature === 'chapter')![0] }

describe('automatic writing context recovery', () => {
  it('creates a missing outline and continues writing without a manual resume', async () => {
    await service.generateChapterStream(id, 1)
    expect((await new DetailedOutlineMdRepo(dir).readChapter(1))?.plotSummary).toContain('守门')
    expect(chapterPrompt()).toContain('守门')
    expect(generate.mock.calls.filter(call => call[1]?.meta?.feature === 'chapter')).toHaveLength(1)
  })

  it('uses a sourced writing plan when outline generation cannot return JSON', async () => {
    generate.mockImplementation(async (_prompt, opts) => opts?.meta?.feature === 'outline-generate' ? '不是 JSON' : '林远守在山门。')
    await service.generateChapterStream(id, 1)
    expect(chapterPrompt()).toContain('自动补齐写作安排')
    expect(generate.mock.calls.filter(call => call[1]?.meta?.feature === 'outline-generate')).toHaveLength(3)
    expect(generate.mock.calls.filter(call => call[1]?.meta?.feature === 'chapter')).toHaveLength(1)
  })

  it('loads both legacy outlines, restores prior prose from history and rebuilds dated memory before writing', async () => {
    await plan(1, '上一章交出钥匙')
    await plan(2, '本章核对来客')
    await new ChapterVersionRepository(dir).create(1, { source: 'manual', content: previous })
    await service.generateChapterStream(id, 2)
    expect(await new ProseRepo(dir).read(1)).toBe(previous)
    expect(chapterPrompt()).toContain(previous)
    expect(chapterPrompt()).toContain('上一章交出钥匙')
    expect(chapterPrompt()).toContain('本章核对来客')
    expect(await new ChapterSummaryRepo(dir).readCurrent(1, previous)).toMatchObject({ continuity: [] })
    expect(generate.mock.calls.findIndex(call => call[1]?.meta?.feature === 'chapterSummary'))
      .toBeLessThan(generate.mock.calls.findIndex(call => call[1]?.meta?.feature === 'chapter'))
    await new DetailedOutlineWriter(dir).update(2, { plotSummary: '更新后的旧格式细纲' })
    expect((await new DetailedOutlineMdRepo(dir).readChapter(2))?.plotSummary).toBe('更新后的旧格式细纲')
    expect((await new DetailedOutlineMdRepo(dir).listAll()).map(item => item.chapterNumber)).toEqual([1, 2])
  })

  it('rebuilds a missing previous outline from verified prose instead of inventing history', async () => {
    await plan(2)
    await new ProseRepo(dir).write(1, previous)
    await service.generateChapterStream(id, 2)
    expect((await new DetailedOutlineMdRepo(dir).readChapter(1))?.plotSummary).toContain('交出钥匙')
    expect(generate.mock.calls.some(call => call[1]?.meta?.feature === 'outline-generate')).toBe(false)
  })

  it('retries transient memory reads and then writes with the complete previous manuscript', async () => {
    await plan(1); await plan(2)
    await new ProseRepo(dir).write(1, previous)
    const read = vi.spyOn(TrackingMdRepo.prototype, 'read').mockRejectedValueOnce(new Error('文件暂时被占用')).mockResolvedValue(null)
    await service.generateChapterStream(id, 2)
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(chapterPrompt()).toContain(previous)
  })

  it('falls back to original evidence when summary and ending extraction fail, without fabricating facts or stopping', async () => {
    await plan(1); await plan(2)
    await new ProseRepo(dir).write(1, previous)
    generate.mockImplementation(async (_prompt, opts) => {
      if (opts?.meta?.feature === 'chapterSummary') throw new Error('提取暂时不可用')
      return '林远示意来客等候。'
    })
    vi.mocked(WriteFlowService.prototype.extractEndingState).mockRejectedValue(new Error('状态提取失败'))
    await service.generateChapterStream(id, 2)
    expect(chapterPrompt()).toContain(previous)
    const saved = await new ChapterSummaryRepo(dir).readCurrent(1, previous)
    expect(saved?.events.every(item => previous.includes(item.evidence))).toBe(true)
    expect(saved?.stateChanges).toEqual([])
    const check = await service.selfCheckChapter(id, 2, '林远示意来客等候。')
    expect(check.items.find(item => item.id === 'prev_state_fallback')?.verdict).toBe('warn')
    expect(WriteFlowService.prototype.extractEndingState).toHaveBeenCalledTimes(3)
  })

  it('continues with explicitly labelled planned context when no prior manuscript can be recovered', async () => {
    await plan(1, '计划由师父交出钥匙'); await plan(2)
    await service.generateChapterStream(id, 2)
    expect(chapterPrompt()).toContain('上一章自动补齐资料')
    expect(chapterPrompt()).toContain('细纲属于计划，不代表已发生')
    expect(chapterPrompt()).not.toContain('**上一章完整正文**')
    expect(await new ProseRepo(dir).read(1)).toBe('')
    expect(WriteFlowService.prototype.extractEndingState).not.toHaveBeenCalled()
  })

  it('preserves an unusually long previous manuscript and stops rather than bypassing full-chapter review', async () => {
    await plan(1); await plan(2)
    const long = '开篇事实。' + '林远在门外等候。'.repeat(6000) + '最后的衔接。'
    await new ProseRepo(dir).write(1, long)
    await expect(service.generateChapterStream(id, 2)).rejects.toThrow('40000')
    expect(await new ProseRepo(dir).read(1)).toBe(long)
    expect(generate.mock.calls.some(call => call[1]?.meta?.feature === 'chapter')).toBe(false)
  })
})
