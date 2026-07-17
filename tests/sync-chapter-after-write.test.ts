import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { WriteService } from '../src/main/data/write-service'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import { SettingsRepository as SettingsRepo } from '../src/main/data/settings-repository'

function mockLlm(reply: string): LlmService {
  return { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
}

const FIXED_EXTRACTION = JSON.stringify({
  newPlotPoints: [{ title: '初露锋芒', event: '林远击败赵乾', coolPoint: '打脸' }],
  characterStateChanges: [{ name: '林远', field: '伤势', oldValue: '无', newValue: '轻伤' }],
  newCharacters: [],
  newLocations: [],
  newItems: [],
  newForeshadowings: [],
  collectedForeshadowings: [],
  settingsPatches: [
    {
      target: 'world',
      fileName: '地理.md',
      op: 'append_section',
      sectionTitle: '青云山',
      content: '云雾缭绕的山脉',
      confidence: 'high',
      reason: '正文出现'
    }
  ],
  settingsSuggestions: []
})

describe('WriteService.syncChapterAfterWrite', () => {
  let root: string
  let projectId: string
  let ps: ProjectService
  let settingsFile: string
  let settings: SettingsRepo

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-sync-ch-'))
    settingsFile = path.join(root, 'settings.json')
    settings = new SettingsRepo(settingsFile)
    const library = new LibraryRepository(path.join(root, 'library.json'))
    const mockPsSettings = {
      getProjectsRoot: async (fallback: string) => fallback
    } as unknown as SettingsRepository
    ps = new ProjectService(path.join(root, 'projects'), library, mockPsSettings)
    projectId = (await ps.create({ name: '青云志', genre: '玄幻' })).id

    // seed 角色卡，便于状态变化写入
    const dir = await ps.resolveDir(projectId)
    const { mkdir, writeFile } = await import('fs/promises')
    await mkdir(path.join(dir, '设定', '角色'), { recursive: true })
    await mkdir(path.join(dir, '记忆', '人物'), { recursive: true })
    await writeFile(
      path.join(dir, '设定', '角色', '林远.md'),
      `# 林远\n\n## 基本信息\n\n- **身份**：剑修\n`,
      'utf-8'
    )
  })

  it('extracts and writes context/character state when autoMemorySync enabled', async () => {
    await settings.update({ autoMemorySync: true, settingsEvolution: 'auto_high' })
    const llm = mockLlm('')
    const service = new WriteService(ps, llm, undefined, undefined, undefined, settings)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = (service as unknown as { flow: any }).flow
    const memSpy = vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(FIXED_EXTRACTION)

    const result = await service.syncChapterAfterWrite(
      projectId,
      5,
      '林远在青云山击败了赵乾，受了轻伤。'
    )

    expect(result).not.toBeNull()
    expect(result!.extraction.chapterNumber).toBe(5)
    expect(result!.extraction.newPlotPoints.length).toBe(1)
    expect(result!.memory.errors).toEqual([])
    expect(memSpy).toHaveBeenCalledWith(
      '林远在青云山击败了赵乾，受了轻伤。',
      5,
      expect.any(Array),
      expect.any(Object)
    )

    const dir = await ps.resolveDir(projectId)
    const ctx = await readFile(path.join(dir, '追踪', '上下文.md'), 'utf-8')
    expect(ctx).toContain('第 5 章')
    expect(ctx).toMatch(/初露锋芒|林远击败赵乾/)

    const charState = await readFile(path.join(dir, '追踪', '角色状态.md'), 'utf-8')
    expect(charState).toContain('林远')

    const timeline = await readFile(path.join(dir, '追踪', '时间线.md'), 'utf-8')
    expect(timeline).toContain('第 5 章')

    memSpy.mockRestore()
  })

  it('returns null and does not write when autoMemorySync is false', async () => {
    await settings.update({ autoMemorySync: false })
    const llm = mockLlm('')
    const service = new WriteService(ps, llm, undefined, undefined, undefined, settings)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = (service as unknown as { flow: any }).flow
    const memSpy = vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(FIXED_EXTRACTION)

    const result = await service.syncChapterAfterWrite(
      projectId,
      5,
      '林远在青云山击败了赵乾。'
    )

    expect(result).toBeNull()
    expect(memSpy).not.toHaveBeenCalled()

    const dir = await ps.resolveDir(projectId)
    // 项目骨架可能已有空上下文表；关键是不能新增本章行
    try {
      const ctx = await readFile(path.join(dir, '追踪', '上下文.md'), 'utf-8')
      expect(ctx).not.toContain('第 5 章')
    } catch {
      // 文件不存在亦可
    }

    memSpy.mockRestore()
  })

  it('does not write settings when settingsEvolution is off', async () => {
    await settings.update({ autoMemorySync: true, settingsEvolution: 'off' })
    const llm = mockLlm('')
    const service = new WriteService(ps, llm, undefined, undefined, undefined, settings)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = (service as unknown as { flow: any }).flow
    vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(FIXED_EXTRACTION)

    const result = await service.syncChapterAfterWrite(
      projectId,
      5,
      '林远在青云山击败了赵乾。'
    )

    expect(result).not.toBeNull()
    expect(result!.settings.applied).toBe(0)

    // 上下文仍应写入（记忆同步与设定独立）
    const dir = await ps.resolveDir(projectId)
    const ctx = await readFile(path.join(dir, '追踪', '上下文.md'), 'utf-8')
    expect(ctx).toContain('第 5 章')
  })

  it('extract failure returns errors without throwing', async () => {
    await settings.update({ autoMemorySync: true })
    const llm = mockLlm('')
    const service = new WriteService(ps, llm, undefined, undefined, undefined, settings)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = (service as unknown as { flow: any }).flow
    vi.spyOn(flow, 'extractMemoryStream').mockRejectedValue(new Error('LLM 超时'))

    const result = await service.syncChapterAfterWrite(projectId, 1, '一些正文')
    expect(result).not.toBeNull()
    expect(result!.memory.errors.some((e) => e.includes('超时'))).toBe(true)
  })
})

describe('SettingsRepository.autoMemorySync', () => {
  it('defaults to true and persists false', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-ams-'))
    const repo = new SettingsRepo(path.join(dir, 'settings.json'))
    const all = await repo.get()
    expect(all.autoMemorySync).toBe(true)

    await repo.update({ autoMemorySync: false })
    expect((await repo.get()).autoMemorySync).toBe(false)

    await repo.update({ autoMemorySync: true })
    expect((await repo.get()).autoMemorySync).toBe(true)
  })
})
