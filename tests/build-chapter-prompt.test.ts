import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { OutlineRepository } from '../src/main/data/outline-repository'
import { CharacterRepository } from '../src/main/data/character-repository'
import { ChapterRepository } from '../src/main/data/chapter-repository'
import { ForeshadowingRepository } from '../src/main/data/foreshadowing-repository'
import { WriteService } from '../src/main/data/write-service'
import type { LlmService, GenerateOptions } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

function mockLlm(reply: string): LlmService {
  return {
    generateStream: vi.fn().mockResolvedValue(reply)
  } as unknown as LlmService
}

const mockSettings = {
  getProjectsRoot: async (fallback: string) => fallback
} as unknown as SettingsRepository

describe('buildChapterPrompt (new system+user format)', () => {
  let root: string
  let projectId: string
  let ps: ProjectService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-bcp-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '青云志', genre: '玄幻修真' })).id
  })

  it('returns { system, user } with system embedding skill rules', async () => {
    const service = new WriteService(ps, mockLlm('正文'))
    const out = await service.buildChapterPrompt(projectId, 1)
    expect(out).toHaveProperty('system')
    expect(out).toHaveProperty('user')
    expect(out.system).toContain('章末结尾硬性原则')
    expect(out.system).toContain('禁用高频词')
    expect(out.system).toContain('顺序铁律')
  })

  it('system prompt voice matches genre', async () => {
    const svc1 = new WriteService(ps, mockLlm('正文'))
    const out1 = await svc1.buildChapterPrompt(projectId, 1)
    // 玄幻修真 → fantasy voice
    expect(out1.system).toContain('玄幻/修仙')

    // 新建一个古风项目验证语感切换
    const id2 = (await ps.create({ name: '剑无名', genre: '古风仙侠' })).id
    const out2 = await new WriteService(ps, mockLlm('正文')).buildChapterPrompt(id2, 1)
    expect(out2.system).toContain('古风/仙侠')
    expect(out2.system).toContain('勾了勾唇')
    expect(out2.system).not.toContain('他心里直骂娘')
  })

  it('user prompt assembles project name, synopsis, chapter detail', async () => {
    const dir = await ps.resolveDir(projectId)
    await new OutlineRepository(dir).writeMain({
      schemaVersion: 1,
      updatedAt: 't',
      synopsis: '少年修仙主线'
    })
    await new OutlineRepository(dir).upsertDetailed({
      chapterNumber: 2,
      plotSummary: '林远首次突破筑基',
      coolPoint: '打脸宗门长老',
      hook: '门外传来脚步声',
      goldenLine: '我不入轮回，谁入轮回'
    })
    await new CharacterRepository(dir).create({
      name: '林远',
      role: '主角',
      personality: '坚毅'
    })

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 2)

    expect(user).toContain('青云志')
    expect(user).toContain('少年修仙主线')
    expect(user).toContain('林远首次突破筑基')
    expect(user).toContain('打脸宗门长老')
    expect(user).toContain('门外传来脚步声')
    expect(user).toContain('我不入轮回，谁入轮回')
    expect(user).toContain('林远')
    expect(user).toContain('约 2500 字')
  })

  it('user prompt includes prev chapter content tail when available', async () => {
    const dir = await ps.resolveDir(projectId)
    await new ChapterRepository(dir).create({ title: '第一章' })
    await new ChapterRepository(dir).create({ title: '第二章' })
    const longPrev = '开头无关内容。'.repeat(200) + '上一章末尾的关键悬念。'
    await new ChapterRepository(dir).updateContent(1, longPrev)

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 2)

    expect(user).toContain('上一章正文结尾')
    expect(user).toContain('上一章末尾的关键悬念')
    // 应当截尾，不会塞整段
    expect(user.length).toBeLessThan(longPrev.length + 5000)
  })

  it('gracefully degrades when no outline/prev chapter/foreshadowings present', async () => {
    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 1)
    expect(user).toContain('青云志')
    expect(user).toContain('（本章无细纲')
    expect(user).not.toContain('上一章正文结尾')
  })

  it('includes pending and due-now foreshadowings with section labels', async () => {
    const dir = await ps.resolveDir(projectId)
    await new ForeshadowingRepository(dir).create({
      content: '神秘玉佩的来历',
      expectedCollect: 5
    })
    const planted = await new ForeshadowingRepository(dir).create({
      content: '师父留下的字条',
      expectedCollect: 3
    })
    await new ForeshadowingRepository(dir).update(planted.id, {})
    // 模拟已埋设到第 1 章，预计第 3 章回收
    await new ForeshadowingRepository(dir).plant(planted.id, 1)

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 3)
    expect(user).toContain('师父留下的字条')
    expect(user).toContain('本章预计回收的伏笔')
    expect(user).toContain('神秘玉佩的来历')
    expect(user).toContain('等待埋设的伏笔')
  })

  it('splits characters into appearing vs other based on chapter detail', async () => {
    const dir = await ps.resolveDir(projectId)
    await new OutlineRepository(dir).upsertDetailed({
      chapterNumber: 2,
      plotSummary: '林远遇到苏怜',
      charactersAppearing: ['林远', '苏怜']
    })
    await new CharacterRepository(dir).create({ name: '林远', role: '主角', personality: '坚毅' })
    await new CharacterRepository(dir).create({ name: '苏怜', role: '女主', personality: '冷淡' })
    await new CharacterRepository(dir).create({ name: '赵乾', role: '反派', personality: '阴险' })

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 2)
    expect(user).toContain('本章出场角色')
    expect(user).toContain('其他已知角色')
    // 出场角色含人设细节，未出场只列名字
    const appearingIdx = user.indexOf('本章出场角色')
    const otherIdx = user.indexOf('其他已知角色')
    expect(appearingIdx).toBeGreaterThan(0)
    expect(otherIdx).toBeGreaterThan(appearingIdx)
    // 反派出现在"其他已知角色"区
    const otherSection = user.slice(otherIdx)
    expect(otherSection).toContain('赵乾')
  })
})

describe('generateChapterStream passes systemPrompt to llm', () => {
  let root: string
  let projectId: string
  let ps: ProjectService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-gcs-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '青云志', genre: '玄幻' })).id
  })

  it('calls llm.generateStream with systemPrompt option', async () => {
    const generateStream = vi.fn().mockResolvedValue('正文')
    const llm = { generateStream } as unknown as LlmService

    const service = new WriteService(ps, llm)
    await service.generateChapterStream(projectId, 1)

    expect(generateStream).toHaveBeenCalledTimes(1)
    const [userPrompt, opts] = (generateStream as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      GenerateOptions
    ]
    expect(userPrompt).toContain('青云志')
    expect(opts.systemPrompt).toBeDefined()
    expect(opts.systemPrompt).toContain('章末结尾硬性原则')
    expect(opts.meta?.feature).toBe('chapter')
  })
})
