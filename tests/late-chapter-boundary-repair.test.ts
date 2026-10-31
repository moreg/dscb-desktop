import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { WriteService } from '../src/main/data/write-service'
import { WriteFlowService } from '../src/main/data/write-flow-service'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { readLongformReviewState } from '../src/main/data/longform-review-state'
import { trackChapterCall } from '../src/main/data/chapter-execution'
import { createWritingProject } from './helpers/writing-project'
import type { GenerateOptions, LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

const prefix = '陆安摸到药瓶的瓶口，把封蜡捏在指间。他听见母亲放下药箱，又搬来一把椅子，便顺着她的手坐下，掌心仍紧紧攥着瓶身。'
const badEnding = '他抬起头，终于看清母亲的面容。双眼已经彻底复明，体内的毒素也排得干干净净。'
const goodEnding = '他抬起头，眼前依旧漆黑。母亲握住他的手，让他留在椅子上等候，瓶口的封蜡还没拆开。'
const original = `${prefix}\n${badEnding}`
const candidate = `${prefix}\n${goodEnding}`
const clue = '母亲将半张借条塞进他的掌心，落款的笔迹与父亲留下的信一模一样。'
const violation = { type: 2, priority: 'P0', boundaryViolation: true, outline: '本章只能交药，下一章才能解毒复明。',
  actual: badEnding, suggestion: '退回交药后等待的阶段。' }
const omission = { type: 1, priority: 'P1', outline: 'FB-001：埋设借条笔迹与父亲相同', suggestion: '补写伏笔', boundaryViolation: false }
const cleared = JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item', 'boundary'], findings: [] })
let root: string, dir: string, id: string, service: WriteService, flow: WriteFlowService
let model: ReturnType<typeof vi.fn<(prompt: string, opts?: GenerateOptions) => Promise<string>>>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'late-boundary-'))
  const settings = { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository
  const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
  const project = await createWritingProject(projects, { name: '写后超纲修复', genre: '玄幻' })
  id = project.id; dir = project.path
  await writeFile(join(dir, '细纲', '细纲_第001章_交药.md'), '# 细纲\n\n## 第 1 章：交药\n\n- **核心事件**：本章只能交药，下一章才能解毒复明。\n- **伏笔铺设**：FB-001：埋设借条笔迹与父亲相同\n')
  await writeFile(join(dir, '细纲', '细纲_第002章_复明.md'), '# 细纲\n\n## 第 2 章：复明\n\n- **核心事件**：陆安解毒复明。')
  await new ProseRepo(dir).write(1, original)
  model = vi.fn(async (_prompt, opts) => {
    switch (opts?.meta?.feature) {
      case 'chapter': return original
      case 'continuityRepair': return JSON.stringify({ replacements: [{ before: badEnding, after: goodEnding }] })
      case 'continuityRepairVerify': return JSON.stringify({ passed: true, issues: [] })
      case 'longformGuard': return cleared
      case 'chapterForeshadowRepair': return JSON.stringify({ insertions: [{ after: 0, text: clue }] })
      default: throw new Error(`Unexpected feature ${opts?.meta?.feature}`)
    }
  })
  const llm = { generateStream: (prompt: string, opts?: GenerateOptions) => trackChapterCall(opts?.meta?.feature, () => model(prompt, opts)) } as LlmService
  service = new WriteService(projects, llm)
  flow = (service as unknown as { flow: WriteFlowService }).flow
  vi.spyOn(flow, 'checkOutlineStream').mockImplementation(async (_outline, text) => JSON.stringify(text.includes(badEnding) ? [violation] : []))
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

it('写后发现越界时自动局部修复并双重复核，只返回候选整章，不改细纲或提交记忆', async () => {
  const progress = vi.fn(), onAutoDeslopResult = vi.fn()
  const outlineFile = join(dir, '细纲', '细纲_第001章_交药.md')
  const outline = await readFile(outlineFile, 'utf8')
  const result = await service.repairChapterForeshadowings(id, 1, original, {
    partialChapter: true, tempContext: '本轮只交药，不揭底', onProgress: progress, onAutoDeslopResult
  })
  expect(result).toMatchObject({ content: candidate, report: { status: 'applied' } })
  expect(await new ProseRepo(dir).read(1)).toBe(original)
  expect(await readFile(outlineFile, 'utf8')).toBe(outline)
  expect(vi.mocked(flow.checkOutlineStream).mock.calls.every(call => call[3]?.partialChapter === true && call[3]?.tempContext === '本轮只交药，不揭底')).toBe(true)
  expect(model.mock.calls.map(([, opts]) => opts?.meta?.feature)).toEqual(['continuityRepair', 'continuityRepairVerify', 'longformGuard'])
  expect(progress.mock.calls.some(([event]) => event.detail?.includes('章节边界自动修复'))).toBe(true)
  expect(onAutoDeslopResult).toHaveBeenCalledWith(expect.objectContaining({ status: 'review_required' }))
})

it('同时缺少伏笔时先修越界，再补伏笔，不以删掉伏笔要求换取通过', async () => {
  vi.mocked(flow.checkOutlineStream).mockImplementation(async (_outline, text) => JSON.stringify([
    ...(text.includes(badEnding) ? [violation] : []), ...(text.includes(clue) ? [] : [omission])
  ]))
  vi.spyOn(flow, 'verifyForeshadowingRepair').mockResolvedValue(undefined)
  const result = await service.repairChapterForeshadowings(id, 1, original)
  expect(result.report.status).toBe('applied')
  expect(result.content).toBe(`${prefix}\n${clue}\n${goodEnding}`)
  expect(model.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'continuityRepair')).toHaveLength(1)
  expect(model.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'chapterForeshadowRepair')).toHaveLength(1)
})

it('修复自评通过但细纲复核仍报越界时停止，不交付错误候选', async () => {
  vi.mocked(flow.checkOutlineStream).mockResolvedValue(JSON.stringify([violation]))
  await expect(service.repairChapterForeshadowings(id, 1, original)).rejects.toThrow('LONGFORM_CONFLICT')
  expect(model.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'continuityRepair')).toHaveLength(6)
  expect(await new ProseRepo(dir).read(1)).toBe(original)
  expect((await readLongformReviewState(dir)).pending['1']).toBeDefined()
})

it('越界修好后伏笔补写失败，也不能将原超纲稿作为成功结果返回', async () => {
  vi.mocked(flow.checkOutlineStream).mockImplementation(async (_outline, text) => JSON.stringify([
    ...(text.includes(badEnding) ? [violation] : []), omission
  ]))
  const implementation = model.getMockImplementation()!
  model.mockImplementation(async (prompt, opts) => opts?.meta?.feature === 'chapterForeshadowRepair'
    ? '无效补写输出' : implementation(prompt, opts))
  await expect(service.repairChapterForeshadowings(id, 1, original)).rejects.toThrow('LONGFORM_CONFLICT')
  expect(await new ProseRepo(dir).read(1)).toBe(original)
  expect((await readLongformReviewState(dir)).pending['1']).toBeDefined()
})

it.each([false, true])('正文生成和写后修复共享同一执行范围，表达与剧情预算分开（仍越界=%s）', async stillConflicts => {
  if (stillConflicts) vi.mocked(flow.checkOutlineStream).mockResolvedValue(JSON.stringify([violation]))
  const write = service.runChapterWrite(id, 1, async () => {
    await trackChapterCall('deslop:scene-repair', async () => '第一次表达修复')
    await trackChapterCall('deslop:scene-repair', async () => '第二次表达修复')
    const generated = await service.generateChapterStream(id, 1)
    return service.repairChapterForeshadowings(id, 1, generated)
  })
  if (stillConflicts) await expect(write).rejects.toThrow('LONGFORM_CONFLICT')
  else expect(await write).toMatchObject({ content: candidate, report: { status: 'applied' } })
  expect(model.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'continuityRepair')).toHaveLength(stillConflicts ? 6 : 1)
  const files = await readdir(join(dir, '.cache', 'chapter-runs'))
  expect(files).toHaveLength(1)
  const trace = JSON.parse(await readFile(join(dir, '.cache', 'chapter-runs', files[0]), 'utf8'))
  expect(trace.repairsByKind).toEqual({ content: stillConflicts ? 6 : 1, expression: 2 })
  expect(trace.calls.some((call: { outcome: string }) => call.outcome === 'budget_exhausted')).toBe(false)
})

it.each(['prose', 'outline'])('修复期间作者改动 %s 时丢弃候选，不覆盖作者改稿', async target => {
  const originalImplementation = model.getMockImplementation()!
  model.mockImplementation(async (prompt, opts) => {
    if (opts?.meta?.feature === 'continuityRepairVerify') {
      if (target === 'prose') await new ProseRepo(dir).write(1, '作者刚刚改过的正文。')
      else await writeFile(join(dir, '细纲', '细纲_第002章_复明.md'), '# 细纲\n\n## 第 2 章：复明\n\n- **核心事件**：改变后的未来计划。')
    }
    return originalImplementation(prompt, opts)
  })
  await expect(service.repairChapterForeshadowings(id, 1, original)).rejects.toThrow(/已变化|已改变/)
  expect(await new ProseRepo(dir).read(1)).toBe(target === 'prose' ? '作者刚刚改过的正文。' : original)
})

it('停止请求终止自动边界修复，不继续复核或交稿', async () => {
  const controller = new AbortController()
  model.mockImplementation(async (_prompt, opts) => {
    expect(opts?.signal).toBe(controller.signal)
    controller.abort()
    return JSON.stringify({ replacements: [{ before: badEnding, after: goodEnding }] })
  })
  await expect(service.repairChapterForeshadowings(id, 1, original, { signal: controller.signal })).rejects.toThrow('LLM_ABORTED')
  expect(model).toHaveBeenCalledTimes(1)
  expect(await new ProseRepo(dir).read(1)).toBe(original)
})

it.each(['foreshadow', 'polish'])('后续 %s 阶段才引入超纲时也局部修复，并保留已补好的伏笔', async source => {
  await new ProseRepo(dir).write(1, candidate)
  vi.mocked(flow.checkOutlineStream).mockImplementation(async (_outline, text) => JSON.stringify([
    ...(text.includes(badEnding) ? [violation] : []), ...(text.includes(clue) ? [] : [omission])
  ]))
  vi.spyOn(flow, 'verifyForeshadowingRepair').mockResolvedValue(undefined)
  const implementation = model.getMockImplementation()!
  model.mockImplementation(async (prompt, opts) => {
    if (source === 'foreshadow' && opts?.meta?.feature === 'chapterForeshadowRepair') {
      return JSON.stringify({ insertions: [{ after: 0, text: clue + badEnding }] })
    }
    if (source === 'foreshadow' && opts?.meta?.feature === 'continuityRepair') {
      return JSON.stringify({ replacements: [{ before: badEnding, after: '母亲扣好药箱，伸手护着瓶口，让他先别拆封。' }] })
    }
    return implementation(prompt, opts)
  })
  if (source === 'polish') {
    ;(service as unknown as { deslopService: object }).deslopService = {}
    vi.spyOn(service as unknown as { autoDeslopGeneratedProse: (pid: string, ch: number, text: string) => Promise<string> },
      'autoDeslopGeneratedProse').mockImplementation(async (_pid, _ch, text) => text.replace(goodEnding, badEnding))
  }
  const result = await service.repairChapterForeshadowings(id, 1, candidate)
  expect(result.report.status).toBe('applied')
  expect(result.content).toContain(clue)
  expect(result.content).not.toContain(badEnding)
  expect(result.content).toContain(goodEnding)
  expect(model.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'continuityRepair')).toHaveLength(1)
  expect(await new ProseRepo(dir).read(1)).toBe(candidate)
})
