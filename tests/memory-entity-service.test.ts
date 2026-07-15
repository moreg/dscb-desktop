import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { MemoryEntityService } from '../src/main/data/memory-entity-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

const mockSettings = { getProjectsRoot: async (fallback: string) => fallback } as unknown as SettingsRepository

describe('MemoryEntityService', () => {
  let root: string
  let service: MemoryEntityService
  let projectId: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-me-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    const projectService = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    service = new MemoryEntityService(projectService)
    projectId = (await projectService.create({ name: 'X' })).id
  })

  it('list location 返回空（无 记忆/地点/，无 设定/世界观/地理.md）', async () => {
    expect(await service.list(projectId, 'location')).toEqual([])
  })

  it('list worldview 从 设定/世界观/*.md 枚举（含 3 个骨架空文件）', async () => {
    const wvs = await service.list(projectId, 'worldview')
    expect(wvs.length).toBeGreaterThanOrEqual(3)
    expect(wvs.some((w) => w.name === '力量体系')).toBe(true)
  })

  it('creates a location in 记忆/地点/', async () => {
    const e = await service.create(projectId, 'location', { name: '青云山', category: '山脉' })
    expect(e.id).toMatch(/.+/)
    const list = await service.list(projectId, 'location')
    expect(list.some((item) => item.name === '青云山')).toBe(true)
  })

  it('keeps different types in separate 记忆/ subdirectories', async () => {
    await service.create(projectId, 'location', { name: 'A' })
    await service.create(projectId, 'worldview', { name: 'B' })
    const loc = await service.list(projectId, 'location')
    const wv = await service.list(projectId, 'worldview')
    expect(loc.some((l) => l.name === 'A')).toBe(true)
    expect(wv.some((w) => w.name === 'B')).toBe(true)
  })

  it('updates a supported entity type', async () => {
    const e = await service.create(projectId, 'location', { name: '事件一' })
    const updated = await service.update(projectId, 'location', e.id, { notes: '细节' })
    expect(updated.notes).toBe('细节')
  })

  it('deletes a supported entity type', async () => {
    const e = await service.create(projectId, 'worldview', { name: '转折' })
    await service.delete(projectId, 'worldview', e.id)
    const wvs = await service.list(projectId, 'worldview')
    expect(wvs.some((w) => w.id === e.id)).toBe(false)
  })

  it('rejects unsupported entity mutations in the current phase', async () => {
    await expect(service.create(projectId, 'timeline', { name: '事件一' })).rejects.toThrow(/只读阶段/)
    await expect(service.delete(projectId, 'plot_point', 'plot-1')).rejects.toThrow(/只读阶段/)
  })
})
