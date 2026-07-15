import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, readFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import type { SettingsRepository } from '../src/main/data/settings-repository'

const mockSettings = { getProjectsRoot: async (fallback: string) => fallback } as unknown as SettingsRepository

describe('ProjectService', () => {
  let root: string
  let service: ProjectService
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-svc-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    service = new ProjectService(path.join(root, 'projects'), library, mockSettings)
  })

  it('create makes a project dir with 记忆/ 骨架 + project.json', async () => {
    const meta = await service.create({ name: '示范小说', genre: '玄幻' })
    const dirStat = await stat(meta.path)
    expect(dirStat.isDirectory()).toBe(true)
    // v4 骨架：记忆/ 子目录
    const memStat = await stat(path.join(meta.path, '记忆'))
    expect(memStat.isDirectory()).toBe(true)
    const charStat = await stat(path.join(meta.path, '记忆', '人物'))
    expect(charStat.isDirectory()).toBe(true)
    const pj = JSON.parse(await readFile(path.join(meta.path, 'project.json'), 'utf-8'))
    expect(pj.name).toBe('示范小说')
    expect(pj.genre).toBe('玄幻')
  })

  it('create 不再创建 chapters/ 或 记忆系统/（v3 老目录）', async () => {
    const meta = await service.create({ name: 'X' })
    await expect(stat(path.join(meta.path, 'chapters'))).rejects.toThrow()
    await expect(stat(path.join(meta.path, '记忆系统'))).rejects.toThrow()
  })

  it('create 生成 记忆/索引.md', async () => {
    const meta = await service.create({ name: 'X' })
    const indexText = await readFile(path.join(meta.path, '记忆', '索引.md'), 'utf-8')
    expect(indexText).toContain('# 记忆索引')
    expect(indexText).toContain('## 人物（0）')
  })

  it('create 生成 追踪/索引.md', async () => {
    const meta = await service.create({ name: 'X' })
    const indexText = await readFile(path.join(meta.path, '追踪', '索引.md'), 'utf-8')
    expect(indexText).toContain('# 追踪索引')
    expect(indexText).toContain('伏笔.md')
  })

  it('create 生成 设定/核心设定.md（细纲生成依赖）', async () => {
    const meta = await service.create({
      name: '核心设定书',
      genre: '都市',
      targetChapters: 200,
      chapterWordCount: 3000,
      description: '测试简介'
    })
    const text = await readFile(path.join(meta.path, '设定', '核心设定.md'), 'utf-8')
    expect(text).toContain('# 核心设定')
    expect(text).toContain('核心设定书')
    expect(text).toContain('都市')
    expect(text).toContain('200')
    expect(text).toContain('3000')
    expect(text).toContain('测试简介')
  })

  it('create 追踪文件含可 append 的表头骨架', async () => {
    const meta = await service.create({ name: '追踪骨架' })
    const checks: Array<{ file: string; headers: string[] }> = [
      {
        file: '伏笔.md',
        headers: ['伏笔编号', '伏笔内容', '伏笔类型', '埋设章节', '预计回收章节', '实际回收章节', '状态']
      },
      {
        file: '时间线.md',
        headers: ['章节', '事件名', '时间跨度', '涉及角色', '详细描述']
      },
      {
        file: '角色状态.md',
        headers: ['角色', '当前实力', '当前立场', '当前目标', '关键道具', '关系快照', '更新章节']
      },
      {
        file: '上下文.md',
        headers: ['日期', '章节', '进度摘要', '下一章目标', '阻塞点']
      },
      {
        file: '问题记录.md',
        headers: ['日期', '问题描述', '原因分析', '修正方案', '状态']
      }
    ]
    for (const { file, headers } of checks) {
      const text = await readFile(path.join(meta.path, '追踪', file), 'utf-8')
      expect(text, file).toMatch(/\|/)
      for (const h of headers) {
        expect(text, `${file} missing ${h}`).toContain(h)
      }
      // 至少有表头 + 分隔行
      const tableLines = text.split(/\r?\n/).filter((l) => l.trim().startsWith('|'))
      expect(tableLines.length, file).toBeGreaterThanOrEqual(2)
    }
  })

  it('create registers the project in library', async () => {
    const meta = await service.create({ name: 'X' })
    const list = await service['library'].list()
    expect(list.find((p) => p.id === meta.id)).toBeTruthy()
  })

  it('resolveDir throws for unknown project', async () => {
    await expect(service.resolveDir('nope')).rejects.toThrow(/not found/)
  })

  it('getProjectData returns the written project data', async () => {
    const meta = await service.create({ name: 'X', description: 'desc' })
    const data = await service.getProjectData(meta.id)
    expect(data.name).toBe('X')
    expect(data.description).toBe('desc')
  })

  it('keeps id consistent across project.json and library', async () => {
    const meta = await service.create({ name: 'X' })
    const data = await service.getProjectData(meta.id)
    expect(data.id).toBe(meta.id)
  })

  it('resolveDir caches directory across calls', async () => {
    const meta = await service.create({ name: 'X' })
    ;(service as unknown as { dirCache: Map<string, string> }).dirCache.delete(meta.id)
    const listSpy = vi.spyOn(service['library'], 'list')
    await service.resolveDir(meta.id)
    await service.resolveDir(meta.id)
    expect(listSpy).toHaveBeenCalledTimes(1)
  })
})
