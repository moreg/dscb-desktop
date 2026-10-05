import { createWritingProject } from './helpers/writing-project'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { foreshadowingsBeforeChapter } from '../src/shared/foreshadowing-state'
import type { Foreshadowing } from '../src/shared/types'
import type { LlmService } from '../src/main/data/llm-service'
import { WriteFlowService } from '../src/main/data/write-flow-service'
import { WriteService } from '../src/main/data/write-service'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { SettingsRepository } from '../src/main/data/settings-repository'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { ForeshadowingMdRepo } from '../src/main/data/skill-format/foreshadowing-md-repo'

function foreshadowing(patch: Partial<Foreshadowing> = {}): Foreshadowing {
  return { id: 'FB-001', content: '铜铃为何在午夜响起？', status: 'planted', plantChapter: 2,
    createdAt: '', updatedAt: '', ...patch }
}

function ledgerFromPrompt(prompt: string): Array<Pick<Foreshadowing, 'id' | 'content' | 'status' | 'plantChapter'>> {
  const line = prompt.split('\n').find((part) => part.startsWith('[{"id"'))
  expect(line).toBeDefined()
  return JSON.parse(line!)
}

describe('伏笔记忆按章投影', () => {
  it.each([
    [2, 'pending', [], []],
    [3, 'planted', [], []],
    [20, 'planted', [], []],
    [21, 'reinforced', [20], []],
    [30, 'reinforced', [20], []],
    [31, 'partial', [20], [30]],
    [50, 'partial', [20], [30]],
    [51, 'collected', [20], [30]]
  ] as const)('第 %i 章只采用已经发生的强化、部分回收和完整回收', (chapter, status, reinforced, partial) => {
    const original = foreshadowing({ status: 'collected', actualCollect: 50,
      expectedCollect: 25, reinforcementChapters: [20], partialCollectChapters: [30] })
    const [projected] = foreshadowingsBeforeChapter([original], chapter)
    expect(projected.status).toBe(status)
    expect(projected.reinforcementChapters).toEqual(reinforced)
    expect(projected.partialCollectChapters).toEqual(partial)
    expect(projected.actualCollect).toBe(chapter > 50 ? 50 : undefined)
    expect(projected.plantChapter).toBe(chapter > 2 ? 2 : undefined)
    expect(original.actualCollect).toBe(50)
    expect(original.reinforcementChapters).toEqual([20])
    expect(original.partialCollectChapters).toEqual([30])
  })

  it('未来才埋设的条目不出现，本章埋设不能冒充章前已发生', () => {
    const items = [foreshadowing({ id: 'FB-001', plantChapter: 11 }),
      foreshadowing({ id: 'FB-002', plantChapter: 10 })]
    expect(foreshadowingsBeforeChapter(items, 10)).toEqual([
      expect.objectContaining({ id: 'FB-002', status: 'pending', plantChapter: undefined, actualCollect: undefined })
    ])
  })

  it('预计回收日期过期不会变成实际回收，未埋设的计划仍待定', () => {
    const planned = foreshadowing({ status: 'pending', plantChapter: undefined, expectedCollect: 5 })
    const planted = foreshadowing({ id: 'FB-002', status: 'planted', expectedCollect: 5 })
    const projected = foreshadowingsBeforeChapter([planned, planted], 100)
    expect(projected.map((f) => f.status)).toEqual(['pending', 'planted'])
    expect(projected.every((f) => f.actualCollect === undefined)).toBe(true)
    expect(projected[0].plantChapter).toBeUndefined()
  })

  it('只有未来阶段记录时恢复为已埋设，不沿用全书最新阶段', () => {
    const reinforced = foreshadowing({ status: 'reinforced', reinforcementChapters: [20] })
    const partial = foreshadowing({ id: 'FB-002', status: 'partial', partialCollectChapters: [30] })
    expect(foreshadowingsBeforeChapter([reinforced, partial], 10).map((f) => f.status)).toEqual(['planted', 'planted'])
  })
})

describe('伏笔提取与旧回执的事实边界', () => {
  it('记忆提取携带原编号与原问题，排除未来埋设和已提前回收的条目', async () => {
    const generateStream = vi.fn().mockResolvedValue('{}')
    const flow = new WriteFlowService({ generateStream } as unknown as LlmService)
    const known = [
      foreshadowing(),
      foreshadowing({ id: 'FB-002', content: '铁盒中藏着谁的姓名？', status: 'collected', actualCollect: 30,
        reinforcementChapters: [5], partialCollectChapters: [8, 20] }),
      foreshadowing({ id: 'FB-003', content: '尚未登场的雪山密令', plantChapter: 12 }),
      foreshadowing({ id: 'FB-004', content: '前章已经解开的井底身份', status: 'collected', actualCollect: 8 })
    ]
    await flow.extractMemoryStream('林远再次听见铜铃响，仍未找到声音的来源。', 10, ['林远'], {}, known)

    const prompt = generateStream.mock.calls[0][0] as string
    expect(ledgerFromPrompt(prompt)).toEqual([
      { id: 'FB-001', content: '铜铃为何在午夜响起？', status: 'planted', plantChapter: 2 },
      { id: 'FB-002', content: '铁盒中藏着谁的姓名？', status: 'partial', plantChapter: 2 }
    ])
    expect(prompt).not.toContain('尚未登场的雪山密令')
    expect(prompt).not.toContain('前章已经解开的井底身份')
    expect(prompt).toContain('foreshadowingId')
    expect(prompt).toContain('evidence')
    expect(prompt).toContain('chapter 必须为 10')
    expect(prompt).toContain('细纲的计划回收都不能标成完整回收')
  })

  let root: string, dir: string, projectId: string
  let service: WriteService, generateStream: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'foreshadowing-boundary-'))
    const settings = new SettingsRepository(join(root, 'settings.json'))
    const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
    projectId = (await createWritingProject(projects, { name: '伏笔事实边界', genre: '悬疑' })).id
    dir = await projects.resolveDir(projectId)
    generateStream = vi.fn().mockResolvedValue('{}')
    service = new WriteService(projects, { generateStream } as unknown as LlmService)
    await writeFile(join(dir, '追踪', '伏笔.md'), '# 伏笔追踪\n\n| 伏笔编号 | 伏笔内容 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |\n|---|---|---|---|---|---|\n| FB-001 | 铜铃为何在午夜响起？ | 第 2 章 | 第 10 章 | 未回收 | 已埋设 |\n| FB-002 | 铁盒中藏着谁的姓名？ | 第 12 章 | 第 20 章 | 未回收 | 已埋设 |\n| FB-003 | 井底人的身份 | 第 1 章 | 第 8 章 | 第 8 章 | 已回收 |\n')
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('公开提取入口读取本地伏笔台账并将有效条目交给模型', async () => {
    const prose = '铜铃又响了三声，林远沿墙根绕到院后。'
    await new ProseRepo(dir).write(10, prose)
    await service.extractMemoryStream(projectId, 10)
    expect(generateStream).toHaveBeenCalledOnce()
    const prompt = generateStream.mock.calls[0][0] as string
    expect(ledgerFromPrompt(prompt)).toEqual([
      { id: 'FB-001', content: '铜铃为何在午夜响起？', status: 'planted', plantChapter: 2 }
    ])
    expect(prompt).toContain(prose)
  })

  it('字符串回执无论用编号还是原内容，都不能写入实际埋设或回收状态', async () => {
    const file = join(dir, '追踪', '伏笔.md')
    const before = await readFile(file, 'utf8')
    const result = await service.applyForeshadowReceipt(projectId, 10, {
      planted: ['FB-002', '铁盒中藏着谁的姓名？'],
      collected: ['FB-001', '铜铃为何在午夜响起？']
    })
    expect(result).toMatchObject({ planted: 0, collected: 0 })
    expect(result.skipped).toHaveLength(4)
    expect(result.skipped.every((message) => message.includes('缺少正文依据'))).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(before)
    expect((await new ForeshadowingMdRepo(dir).list()).find((f) => f.id === 'FB-001')).toMatchObject({ status: 'planted', actualCollect: undefined })
    expect(generateStream).not.toHaveBeenCalled()
  })
})
