import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
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

  it('lists empty for each type', async () => {
    expect(await service.list(projectId, 'location')).toEqual([])
    expect(await service.list(projectId, 'worldview')).toEqual([])
  })

  it('creates a location in locations.json', async () => {
    const e = await service.create(projectId, 'location', { name: '青云山', category: '山脉' })
    expect(e.id).toMatch(/.+/)
    const raw = JSON.parse(
      await readFile(path.join(root, 'projects', projectId, 'memory', 'locations.json'), 'utf-8')
    )
    expect(raw.items[0].name).toBe('青云山')
  })

  it('keeps different types in separate files', async () => {
    await service.create(projectId, 'location', { name: 'A' })
    await service.create(projectId, 'worldview', { name: 'B' })
    const loc = await service.list(projectId, 'location')
    const wv = await service.list(projectId, 'worldview')
    expect(loc).toHaveLength(1)
    expect(wv).toHaveLength(1)
    expect(loc[0].name).toBe('A')
    expect(wv[0].name).toBe('B')
  })

  it('updates an entity', async () => {
    const e = await service.create(projectId, 'timeline', { name: '事件一' })
    const updated = await service.update(projectId, 'timeline', e.id, { notes: '细节' })
    expect(updated.notes).toBe('细节')
  })

  it('deletes an entity', async () => {
    const e = await service.create(projectId, 'plot_point', { name: '转折' })
    await service.delete(projectId, 'plot_point', e.id)
    expect(await service.list(projectId, 'plot_point')).toEqual([])
  })
})
