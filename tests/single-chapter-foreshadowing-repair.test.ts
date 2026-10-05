import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { tmpdir } from 'os'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { WriteService } from '../src/main/data/write-service'
import { WriteFlowService } from '../src/main/data/write-flow-service'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { createWritingProject } from './helpers/writing-project'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

const prose = '林远把账册交给守门人。\n守门人核对了印章。\n门内忽然传来父亲的声音。'
const addition = '封皮夹着半张借条，落款的笔迹与父亲留下的信一模一样。'
const missing = JSON.stringify([{ type: 1, typeLabel: '漏写', outline: 'FB-001：埋设借条笔迹与父亲相同',
  actual: '没有伏笔线索', suggestion: '补写伏笔', priority: 'P1' }])
const patch = JSON.stringify({ insertions: [{ after: 1, text: addition }] })

describe('单章续写的交稿前伏笔补写', () => {
  let root: string
  let dir: string
  let projectId: string
  let service: WriteService
  let flow: WriteFlowService
  let generate: ReturnType<typeof vi.fn>
  let outlineFile: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'single-foreshadow-'))
    const settings = { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository
    const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
    projectId = (await createWritingProject(projects, { name: '交稿前伏笔', genre: '悬疑' })).id
    dir = await projects.resolveDir(projectId)
    outlineFile = join(dir, '细纲', '细纲_第001章_账册.md')
    await writeFile(outlineFile, '# 细纲\n\n## 第 1 章：账册\n\n- **核心事件**：林远交出账册。\n- **伏笔铺设**：FB-001：埋设借条笔迹与父亲相同\n')
    await new ProseRepo(dir).write(1, '磁盘中尚未采用的旧正文。')
    generate = vi.fn().mockResolvedValue(patch)
    service = new WriteService(projects, { generateStream: generate } as unknown as LlmService)
    flow = (service as unknown as { flow: WriteFlowService }).flow
    vi.spyOn(flow, 'verifyForeshadowingRepair').mockResolvedValue(undefined)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    expect(resolve(root).startsWith(resolve(tmpdir()) + sep + 'single-foreshadow-')).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  it('补写候选整章并复核原细纲；保存与记忆留给编辑器在采用之后执行', async () => {
    const check = vi.spyOn(flow, 'checkOutlineStream').mockResolvedValueOnce(missing).mockResolvedValue('[]')
    const sync = vi.spyOn(service, 'syncChapterAfterWrite')
    const before = await readFile(outlineFile, 'utf-8')
    const result = await service.repairChapterForeshadowings(projectId, 1, prose, { tempContext: '不揭晓父亲身份' })
    expect(result.report.status).toBe('applied')
    expect(result.content).toBe(prose.split('\n').slice(0, 2).join('\n') + '\n' + addition + '\n' + prose.split('\n')[2])
    expect(check.mock.calls[1][0]).toBe(check.mock.calls[0][0])
    expect(check.mock.calls[1][1]).toBe(result.content)
    expect(check.mock.calls.every((call) => call[3]?.tempContext === '不揭晓父亲身份')).toBe(true)
    expect(flow.verifyForeshadowingRepair).toHaveBeenCalledWith(expect.objectContaining({
      original: prose, candidate: result.content, inserted: [addition], tempContext: '不揭晓父亲身份'
    }), expect.anything())
    expect(generate.mock.calls[0][0]).toContain('不揭晓父亲身份')
    expect(generate.mock.calls[0][1].meta.feature).toBe('chapterForeshadowRepair')
    expect(await new ProseRepo(dir).read(1)).toBe('磁盘中尚未采用的旧正文。')
    expect(await readFile(outlineFile, 'utf-8')).toBe(before)
    expect(sync).not.toHaveBeenCalled()
  })

  it('本轮无遗漏时只核对、不调用补写模型', async () => {
    vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue('[]')
    const result = await service.repairChapterForeshadowings(projectId, 1, prose)
    expect(result).toMatchObject({ content: prose, report: { status: 'unchanged' } })
    expect(generate).not.toHaveBeenCalled()
  })

  it('专项核验失败时保留本轮正文，不将候选稿交给记忆同步', async () => {
    vi.spyOn(flow, 'checkOutlineStream').mockResolvedValueOnce(missing).mockResolvedValue('[]')
    vi.mocked(flow.verifyForeshadowingRepair).mockRejectedValue(new Error('伏笔补写专项核验缺少新增正文证据'))
    const result = await service.repairChapterForeshadowings(projectId, 1, prose)
    expect(result.content).toBe(prose)
    expect(result.report.status).toBe('failed')
  })

  it('分轮续写仍先检查，但只补已推进场景中的遗漏，复核使用相同范围', async () => {
    const check = vi.spyOn(flow, 'checkOutlineStream').mockResolvedValueOnce(missing).mockResolvedValue('[]')
    const result = await service.repairChapterForeshadowings(projectId, 1, prose, { partialChapter: true })
    expect(result.report.status).toBe('applied')
    expect(check.mock.calls.every((call) => call[3]?.partialChapter === true)).toBe(true)
    expect(generate.mock.calls[0][0]).toContain('禁止抢写尚未发生的后续情节点与伏笔')
  })

  it('补写两轮仍未通过时保留本轮正文，并返回阻止记忆同步的失败结论', async () => {
    vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue(missing)
    generate.mockResolvedValueOnce(patch).mockResolvedValueOnce(JSON.stringify({ insertions: [{ after: 1, text: '林远把借条收进父亲留给他的信封。' }] }))
    const result = await service.repairChapterForeshadowings(projectId, 1, prose)
    expect(result.content).toBe(prose)
    expect(result.report).toMatchObject({ status: 'failed' })
    expect(result.report.message).toContain('两轮后仍未通过')
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('无法核对时不把空差异当作无需补写', async () => {
    vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue('无法返回JSON')
    const result = await service.repairChapterForeshadowings(projectId, 1, prose)
    expect(result.content).toBe(prose)
    expect(result.report.status).toBe('failed')
    expect(generate).not.toHaveBeenCalled()
  })

  it('补写取消后不交付候选稿', async () => {
    vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue(missing)
    const controller = new AbortController()
    generate.mockImplementation(async (_prompt, opts) => {
      expect(opts.signal).toBe(controller.signal)
      controller.abort()
      return patch
    })
    await expect(service.repairChapterForeshadowings(projectId, 1, prose, { signal: controller.signal })).rejects.toThrow('LLM_ABORTED')
    expect(await new ProseRepo(dir).read(1)).toBe('磁盘中尚未采用的旧正文。')
  })

  it('缺少细纲时不编造伏笔', async () => {
    await rm(outlineFile)
    expect(await service.repairChapterForeshadowings(projectId, 1, prose)).toMatchObject({ content: prose, report: { status: 'skipped' } })
    expect(generate).not.toHaveBeenCalled()
  })
})

it('部分正文检查的提示不将后续场景当作遗漏，内部参数不传给provider', async () => {
  const generate = vi.fn().mockResolvedValue('[]')
  const flow = new WriteFlowService({ generateStream: generate } as unknown as LlmService)
  await flow.checkOutlineStream('先交账册、最后揭晓身份', prose, 1, { partialChapter: true, tempContext: '本轮禁止揭晓父亲身份' })
  expect(generate.mock.calls[0][0]).toContain('尚未写到的后续场景、回收和章末钩子不是遗漏')
  expect(generate.mock.calls[0][1]).not.toHaveProperty('partialChapter')
  expect(generate.mock.calls[0][0]).toContain('本轮禁止揭晓父亲身份')
  expect(generate.mock.calls[0][0]).toContain('明确暂缓、延期或限制揭示的内容不能误报为漏写')
  expect(generate.mock.calls[0][1]).not.toHaveProperty('tempContext')
})
