import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { ChapterService } from '../src/main/data/chapter-service'
import { ChapterVersionRepository } from '../src/main/data/chapter-version-repository'
import { ChapterRefinementService, parseRefinementVerdict } from '../src/main/data/chapter-refinement-service'
import { activeBatchProjects } from '../src/main/data/write-batch-lock'
import { createWritingProject } from './helpers/writing-project'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { LlmService } from '../src/main/data/llm-service'
import type { RefinementInput } from '../src/shared/chapter-refinement'

const original = '林远把账册交给守门人。守门人检查印章，让他进门。'
const candidate = '林远递过账册。守门人核对印章，侧身让他进门。'
const verdict = (before = original, after = candidate, pass = true) => JSON.stringify({ factsPreserved: pass, goalMet: true,
  assessment: pass ? '动作与结果保持一致，减少重复表达。' : '道具归属发生变化。', evidence: [{ before, after, reason: '核对交接动作及进门结果。' }], issues: pass ? [] : ['道具归属变化，请恢复原文事实。'] })
describe('independent chapter refinement', () => {
  let service: ChapterRefinementService
  let chapters: ChapterService
  let projects: ProjectService
  let input: RefinementInput
  let dir: string
  let context: string
  const call = vi.fn()
  const make = () => new ChapterRefinementService(projects, chapters, { generateStream: call } as unknown as LlmService, async () => context)
  beforeEach(async () => {
    activeBatchProjects.clear(); call.mockReset(); context = '人物与前章上下文'
    const root = await mkdtemp(join(tmpdir(), 'chapter-refinement-'))
    projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')),
      { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository)
    const project = await createWritingProject(projects, { name: '精修测试' })
    dir = await projects.resolveDir(project.id)
    chapters = new ChapterService(projects)
    await chapters.updateContent(project.id, 1, original)
    input = { projectId: project.id, chapterNumber: 1, content: original, goal: 'expression', instruction: '' }
    service = make()
    call.mockResolvedValueOnce(JSON.stringify({ text: candidate, changes: ['压缩重复动作说明。'] })).mockResolvedValueOnce(verdict())
  })
  it('persists a verified candidate without touching正文; a new service can adopt and undo it', async () => {
    const result = await service.generate(input)
    expect(result.status).toBe('ready')
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe(original)
    const restarted = make()
    expect((await restarted.load(input.projectId, 1))?.id).toBe(result.id)
    await restarted.commit(input.projectId, 1, result.id, original)
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe(candidate)
    expect((await new ChapterVersionRepository(dir).list(1)).some(v => v.content === original)).toBe(true)
    await restarted.commit(input.projectId, 1, result.id, candidate, true)
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe(original)
    expect((await restarted.load(input.projectId, 1))?.status).toBe('undone')
  })
  it('persists a declined hunk without changing正文 and excludes it from later adoption', async () => {
    const source = '甲段。\n\n乙段。\n\n丙段。'
    const rewritten = '甲段改。\n\n乙段。\n\n丙段改。'
    await chapters.updateContent(input.projectId, 1, source)
    input.content = source
    call.mockReset()
      .mockResolvedValueOnce(JSON.stringify({ text: rewritten, changes: ['改甲段。', '改丙段。'] }))
      .mockResolvedValueOnce(verdict('甲段。', '甲段改。'))
    const result = await service.generate(input)
    await expect(service.rejectHunk(input.projectId, 1, result.id, '过期正文', 0)).rejects.toThrow('编辑器正文已变化')
    await expect(service.rejectHunk(input.projectId, 1, result.id, source, 2)).rejects.toThrow('改动序号无效')
    const next = await service.rejectHunk(input.projectId, 1, result.id, source, 0)
    expect(next.id).not.toBe(result.id)
    await expect(service.commit(input.projectId, 1, result.id, source, false, 0)).rejects.toThrow('精修记录已更新')
    await expect(service.rejectHunk(input.projectId, 1, result.id, source, 0)).rejects.toThrow('精修记录已更新')
    expect(next.candidate).toBe('甲段。\n\n乙段。\n\n丙段改。')
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe(source)
    const restarted = make()
    expect((await restarted.load(input.projectId, 1))?.candidate).toBe(next.candidate)
    const adopted = await restarted.commit(input.projectId, 1, next.id, source)
    expect(adopted.content).toBe(next.candidate)
    await restarted.commit(input.projectId, 1, next.id, adopted.content, true)
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe(source)
  })
  it('retains the ability to undo adopted changes after declining the last remaining hunk', async () => {
    const source = '甲段。\n\n乙段。\n\n丙段。'
    await chapters.updateContent(input.projectId, 1, source)
    input.content = source
    call.mockReset()
      .mockResolvedValueOnce(JSON.stringify({ text: '甲段改。\n\n乙段。\n\n丙段改。', changes: [] }))
      .mockResolvedValueOnce(verdict('甲段。', '甲段改。'))
    const result = await service.generate(input)
    const first = await service.commit(input.projectId, 1, result.id, source, false, 0)
    const next = await service.rejectHunk(input.projectId, 1, result.id, first.content, 0)
    expect(next.candidate).toBe(first.content)
    expect(next.adoptedContent).toBe(first.content)
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe(first.content)
    const undone = await make().commit(input.projectId, 1, next.id, first.content, true)
    expect(undone.content).toBe(source)
  })
  it('edits only the selected range and validates quotes from that range', async () => {
    const prefix = '屋外下着雨。\n\n', suffix = '\n\n屋里无人说话。'
    await chapters.updateContent(input.projectId, 1, prefix + original + suffix)
    input.content = prefix + original + suffix
    input.selection = { start: prefix.length, end: prefix.length + original.length }
    const result = await service.generate(input)
    expect(result.candidate).toBe(prefix + candidate + suffix)
    expect(result.status).toBe('ready')
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe(input.content)
  })
  it('rejects stale editor, disk, context and candidate identifiers without overwriting work', async () => {
    const result = await service.generate(input)
    await expect(service.commit(input.projectId, 1, result.id, '作者新编辑')).rejects.toThrow('编辑器正文已变化')
    await expect(service.commit(input.projectId, 1, 'other-id', original)).rejects.toThrow('精修记录已更新')
    context = '人物关系已改变'
    await expect(service.commit(input.projectId, 1, result.id, original)).rejects.toThrow('上下文或规则已变化')
    context = '人物与前章上下文'
    await chapters.updateContent(input.projectId, 1, '另一窗口保存的正文')
    await expect(service.commit(input.projectId, 1, result.id, original)).rejects.toThrow('磁盘正文已变化')
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe('另一窗口保存的正文')
  })
  it('limits generation to one revision plus one repair and refuses adoption after failed verification', async () => {
    call.mockReset().mockImplementation(async (_prompt, options) => options.meta.feature === 'chapter-refine-verify'
      ? verdict(original, candidate, false) : JSON.stringify({ text: candidate, changes: ['修改对白'] }))
    const result = await service.generate(input)
    expect(result).toMatchObject({ attempts: 2, status: 'rejected' })
    expect(call).toHaveBeenCalledTimes(4)
    await expect(service.commit(input.projectId, 1, result.id, original)).rejects.toThrow('尚未通过验收')
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe(original)
    const picked = await service.commit(input.projectId, 1, result.id, original, false, 0)
    expect(picked.content).toBe(candidate)
    expect(picked.candidate?.status).toBe('accepted')
  })
  it('keeps an interrupted candidate recoverable but unadoptable and releases the project lock', async () => {
    const controller = new AbortController()
    call.mockReset().mockResolvedValueOnce(JSON.stringify({ text: candidate, changes: [] })).mockImplementationOnce(async () => {
      controller.abort(); throw new Error('LLM_ABORTED')
    })
    const result = await service.generate(input, controller.signal)
    expect(result).toMatchObject({ candidate, status: 'cancelled' })
    expect(activeBatchProjects.size).toBe(0)
    expect((await make().load(input.projectId, 1))?.candidate).toBe(candidate)
    await expect(service.commit(input.projectId, 1, result.id, original)).rejects.toThrow()
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe(original)
  })
  it('treats a completed write followed by bookkeeping failure as saved, not an untouched original', async () => {
    const result = await service.generate(input)
    const actual = chapters.updateContent.bind(chapters)
    vi.spyOn(chapters, 'updateContent').mockImplementation(async (...args) => { await actual(...args); throw new Error('metadata failed') })
    expect(await service.commit(input.projectId, 1, result.id, original)).toMatchObject({ content: candidate, warning: expect.any(String) })
    expect((await service.load(input.projectId, 1))?.status).toBe('accepted')
  })
  it('recovers a partial hunk write after a crash and keeps remaining candidate', async () => {
    const source = '甲段。\n\n乙段。\n\n丙段。'
    const rewritten = '甲段改。\n\n乙段。\n\n丙段改。'
    const mixed = '甲段改。\n\n乙段。\n\n丙段。'
    await chapters.updateContent(input.projectId, 1, source)
    input.content = source
    call.mockReset()
      .mockResolvedValueOnce(JSON.stringify({ text: rewritten, changes: ['改甲段。'] }))
      .mockResolvedValueOnce(verdict('甲段。', '甲段改。'))
    const result = await service.generate(input)
    const file = join(dir, '.cache/chapter-refinement/1.json')
    const record = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(file, JSON.stringify({ ...record, status: 'applying', applyingContent: mixed }))
    await chapters.updateContent(input.projectId, 1, mixed)
    expect(await make().load(input.projectId, 1)).toMatchObject({ status: 'ready', adoptedContent: mixed })
    const rest = await service.commit(input.projectId, 1, result.id, mixed)
    expect(rest.content).toBe(rewritten)
    expect(rest.candidate?.status).toBe('accepted')
  })
  it('recovers an adopted write after a crash and prevents stale undo', async () => {
    const result = await service.generate(input)
    const file = join(dir, '.cache/chapter-refinement/1.json')
    const record = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(file, JSON.stringify({ ...record, status: 'applying' }))
    await chapters.updateContent(input.projectId, 1, candidate)
    expect((await make().load(input.projectId, 1))?.status).toBe('accepted')
    await chapters.updateContent(input.projectId, 1, '后续编辑')
    await expect(service.commit(input.projectId, 1, result.id, candidate, true)).rejects.toThrow('磁盘正文已变化')
  })
  it('requires scene plans, rejects empty selections and shares the batch project lock', async () => {
    await expect(service.generate({ ...input, goal: 'scene' })).rejects.toThrow('修改方案')
    await expect(service.generate({ ...input, selection: { start: 4, end: 4 } })).rejects.toThrow('选区无效')
    activeBatchProjects.add(input.projectId)
    await expect(service.generate(input)).rejects.toThrow('BATCH_ALREADY_RUNNING')
    expect(call).not.toHaveBeenCalled()
  })
  it('refuses fabricated verifier evidence and malformed verdicts', () => {
    expect(() => parseRefinementVerdict(verdict('不存在的引文'), original, candidate)).toThrow('引文')
    expect(() => parseRefinementVerdict('{}', original, candidate)).toThrow('不完整')
  })
  it('adopts a single hunk, keeps remaining candidate, then adopts the rest or undoes', async () => {
    const source = '甲段。\n\n乙段。\n\n丙段。'
    const rewritten = '甲段改。\n\n乙段。\n\n丙段改。'
    await chapters.updateContent(input.projectId, 1, source)
    input.content = source
    call.mockReset()
      .mockResolvedValueOnce(JSON.stringify({ text: rewritten, changes: ['改甲段。', '改丙段。'] }))
      .mockResolvedValueOnce(verdict('甲段。', '甲段改。'))
    const result = await service.generate(input)
    const first = await service.commit(input.projectId, 1, result.id, source, false, 0)
    expect(first.content).toBe('甲段改。\n\n乙段。\n\n丙段。')
    expect(first.candidate).toMatchObject({ status: 'ready', adoptedContent: first.content })
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe(first.content)
    const remaining = await service.commit(input.projectId, 1, result.id, first.content, false, 0)
    expect(remaining.content).toBe(rewritten)
    expect(remaining.candidate?.status).toBe('accepted')
    await service.commit(input.projectId, 1, result.id, rewritten, true)
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe(source)
  })
  it('keeps a partial adoption ready so remaining hunks can still be picked or undone', async () => {
    const source = '甲段。\n\n乙段。\n\n丙段。'
    const rewritten = '甲段改。\n\n乙段。\n\n丙段改。'
    await chapters.updateContent(input.projectId, 1, source)
    input.content = source
    call.mockReset()
      .mockResolvedValueOnce(JSON.stringify({ text: rewritten, changes: ['改甲段。'] }))
      .mockResolvedValueOnce(verdict('甲段。', '甲段改。'))
    const result = await service.generate(input)
    const first = await service.commit(input.projectId, 1, result.id, source, false, 0)
    const undone = await service.commit(input.projectId, 1, result.id, first.content, true)
    expect(undone.content).toBe(source)
    expect(undone.candidate?.status).toBe('ready')
    expect(undone.candidate?.adoptedContent).toBeUndefined()
    const again = await service.commit(input.projectId, 1, result.id, source, false, 1)
    expect(again.content).toBe('甲段。\n\n乙段。\n\n丙段改。')
    const rest = await service.commit(input.projectId, 1, result.id, again.content)
    expect(rest.content).toBe(rewritten)
    expect(rest.candidate?.status).toBe('accepted')
  })
  it('keeps a rejected candidate rejected after a partial hunk and still allows picking more', async () => {
    const source = '甲段。\n\n乙段。\n\n丙段。'
    const rewritten = '甲段改。\n\n乙段。\n\n丙段改。'
    await chapters.updateContent(input.projectId, 1, source)
    input.content = source
    call.mockReset()
      .mockResolvedValueOnce(JSON.stringify({ text: rewritten, changes: ['改甲段。'] }))
      .mockResolvedValueOnce(verdict('甲段。', '甲段改。', false))
      .mockResolvedValueOnce(JSON.stringify({ text: rewritten, changes: ['改甲段。'] }))
      .mockResolvedValueOnce(verdict('甲段。', '甲段改。', false))
    const result = await service.generate(input)
    expect(result.status).toBe('rejected')
    const first = await service.commit(input.projectId, 1, result.id, source, false, 0)
    expect(first.content).toBe('甲段改。\n\n乙段。\n\n丙段。')
    expect(first.candidate).toMatchObject({ status: 'rejected', adoptedContent: first.content })
    await expect(service.commit(input.projectId, 1, result.id, first.content)).rejects.toThrow('尚未通过验收')
    const rest = await service.commit(input.projectId, 1, result.id, first.content, false, 0)
    expect(rest.content).toBe(rewritten)
    expect(rest.candidate?.status).toBe('accepted')
  })
})
