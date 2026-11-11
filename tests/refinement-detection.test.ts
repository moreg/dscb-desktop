import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { ChapterService } from '../src/main/data/chapter-service'
import { ChapterRefinementService } from '../src/main/data/chapter-refinement-service'
import { contentRevision } from '../src/main/data/chapter-revision'
import { activeBatchProjects } from '../src/main/data/write-batch-lock'
import { detectionRanges, applyDetectionEdits } from '../src/shared/refinement-detection'
import type { RefinementInput } from '../src/shared/chapter-refinement'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

const first = '林远缓缓推开院门，将账册交给守门人。'
const last = '守门人仔细核对印章，然后侧过身让林远进门。'
const edits = [{ before: first, after: '林远推开院门，把账册递给守门人。' }, { before: last, after: '守门人核对了印章，侧身让林远进门。' }]
const original = `【保留的开头】\n\n${first}\n\n  中间这段保留原样，连空格也不改。\n\n${last}\n【保留的结尾】`
const rewritten = original.replace(first, edits[0].after).replace(last, edits[1].after)
const reply = () => JSON.stringify({ edits, changes: ['减少修饰和过程说明，保留交付、核对与放行。'] })
const verdict = (pass = true, count = 2) => JSON.stringify({ factsPreserved: pass, goalMet: true,
  assessment: '核对完整场景，交付与放行不变，减少了重复修饰。', issues: pass ? [] : ['人物认知被改变。'],
  evidence: edits.slice(0, count).map(edit => ({ ...edit, reason: '删除程度修饰，动作和结果不变。' })) })

describe('朱雀手动反馈的定向精修', () => {
  let root: string, dir: string, input: RefinementInput, chapters: ChapterService, service: ChapterRefinementService
  const model = vi.fn()
  beforeEach(async () => {
    activeBatchProjects.clear(); model.mockReset()
    root = await mkdtemp(join(tmpdir(), 'refinement-detection-'))
    const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')),
      { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository)
    const project = await projects.create({ name: '标黄精修测试' })
    dir = await projects.resolveDir(project.id)
    chapters = new ChapterService(projects)
    await chapters.updateContent(project.id, 1, original)
    input = { projectId: project.id, chapterNumber: 1, content: original, goal: 'detection', instruction: '', detection: { excerpts: [first, last], score: 42 } }
    service = new ChapterRefinementService(projects, chapters, { generateStream: model } as unknown as LlmService, async () => '本章只是交账册后进门，不新增事件。')
    model.mockResolvedValueOnce(reply()).mockResolvedValueOnce(verdict())
  })
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

  it('仅替换授权片段，逐字保留全部范围外内容，且本地通过不等于检测通过', async () => {
    const record = await service.generate(input)
    expect(record.status).toBe('ready')
    expect(record.candidate).toBe(rewritten)
    expect(record.detectionCheck).toBeUndefined()
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe(original)
    expect(model).toHaveBeenCalledTimes(2)
    expect(model.mock.calls[0][0]).toContain('只整理已有事实')
    expect(model.mock.calls[1][0]).toContain('goalMet 只指表达目标')
    await service.commit(input.projectId, 1, record.id, original)
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe(rewritten)
    await service.commit(input.projectId, 1, record.id, rewritten, true)
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe(original)
  })

  it('核验漏掉一个片段时最多补救一次，不能只引用第一处就通过全部改动', async () => {
    model.mockReset().mockResolvedValueOnce(reply()).mockResolvedValueOnce(verdict(true, 1))
      .mockResolvedValueOnce(reply()).mockResolvedValueOnce(verdict(true, 1))
    const record = await service.generate(input)
    expect(record.status).toBe('rejected')
    expect(record.verdict?.issues.join('')).toContain('全部标黄片段')
    expect(model).toHaveBeenCalledTimes(3)
    await expect(service.commit(input.projectId, 1, record.id, original)).rejects.toThrow('尚未通过验收')
    await expect(service.commit(input.projectId, 1, record.id, original, false, 0)).rejects.toThrow('整体核验')
    await expect(service.rejectHunk(input.projectId, 1, record.id, original, 0)).rejects.toThrow('整体核验')
  })

  it('范围外替换、重复片段、重叠和过期标黄均不允许，不偷偷扩大到整章', async () => {
    expect(() => applyDetectionEdits(input, [...edits, { before: '中间这段保留原样', after: '偷改正文' }])).toThrow('全部标黄')
    expect(() => applyDetectionEdits(input, [{ before: '中间这段保留原样', after: '偷改正文' }, edits[1]])).toThrow('唯一匹配')
    expect(() => detectionRanges({ ...input, detection: { excerpts: [first, first] } })).toThrow('重复或重叠')
    expect(() => detectionRanges({ ...input, content: original + first })).toThrow('出现多次')
    expect(() => detectionRanges({ ...input, detection: { excerpts: ['这不是当前版本中的原文。'] } })).toThrow('不一致')
    await expect(service.generate({ ...input, selection: { start: 0, end: 12 } })).rejects.toThrow('取消选区')
    expect(model).not.toHaveBeenCalled()
  })

  it('模型伪造范围时不产生可采用候选，原稿不动', async () => {
    model.mockReset().mockResolvedValueOnce(JSON.stringify({ edits: [{ before: '中间这段保留原样', after: '偷改正文' }, edits[1]], changes: [] }))
    const record = await service.generate(input)
    expect(record.status).toBe('failed')
    expect(record.candidate).toBe('')
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe(original)
  })

  it('保存人工复测的原稿、候选及版本哈希；旧候选结果不能登记到新候选', async () => {
    const record = await service.generate(input)
    await expect(service.recordDetection(input.projectId, 1, record.id, original, { status: 'green', note: '' })).rejects.toThrow('不一致')
    const checked = await service.recordDetection(input.projectId, 1, record.id, rewritten, { status: 'green', score: 0, note: '完整候选已人工复测，全绿。' })
    expect(checked.detectionCheck).toMatchObject({ source: 'manual', status: 'green', contentHash: contentRevision(rewritten), score: 0 })
    const [file] = await readdir(join(dir, '.cache/refinement-detection-history'))
    expect(JSON.parse(await readFile(join(dir, '.cache/refinement-detection-history', file), 'utf8'))).toMatchObject({ original, candidate: rewritten, originalFeedback: { score: 42 }, check: { source: 'manual' } })
    model.mockResolvedValueOnce(reply()).mockResolvedValueOnce(verdict())
    const next = await service.generate(input)
    expect(next.detectionCheck).toBeUndefined()
    await expect(service.recordDetection(input.projectId, 1, record.id, rewritten, { status: 'green', note: '' })).rejects.toThrow('没有可登记')
  })

  it('如实记录分数回升，人工登记全绿不能绕过保真拒绝或稿件版本检查', async () => {
    model.mockReset().mockResolvedValueOnce(reply()).mockResolvedValueOnce(verdict(false)).mockResolvedValueOnce(reply()).mockResolvedValueOnce(verdict(false))
    const record = await service.generate(input)
    await service.recordDetection(input.projectId, 1, record.id, rewritten, { status: 'flagged', score: 55, note: '比原稿更高。' })
    const green = await service.recordDetection(input.projectId, 1, record.id, rewritten, { status: 'green', score: 0, note: '' })
    expect(green.status).toBe('rejected')
    await expect(service.commit(input.projectId, 1, record.id, original)).rejects.toThrow('尚未通过验收')
    await expect(service.recordDetection(input.projectId, 1, record.id, rewritten, { status: 'flagged', score: NaN, note: '' })).rejects.toThrow('格式无效')
  })
  it('候选文件发生改动后，旧核验及全绿记录不再适用', async () => {
    const record = await service.generate(input)
    await service.recordDetection(input.projectId, 1, record.id, rewritten, { status: 'green', score: 0, note: '' })
    const file = join(dir, '.cache/chapter-refinement/1.json')
    const stored = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(file, JSON.stringify({ ...stored, candidate: rewritten + '后续又改了文字。' }))
    const changed = await service.load(input.projectId, 1)
    expect(changed).toMatchObject({ status: 'failed' })
    expect(changed?.verdict).toBeUndefined()
    expect(changed?.detectionCheck).toBeUndefined()
    expect((await chapters.getChapter(input.projectId, 1)).content).toBe(original)
  })

})
