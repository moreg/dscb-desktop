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

  it('create makes a project dir with chapters/ and project.json', async () => {
    const meta = await service.create({ name: '示范小说', genre: '玄幻' })
    const dirStat = await stat(meta.path)
    expect(dirStat.isDirectory()).toBe(true)
    const chaptersStat = await stat(path.join(meta.path, 'chapters'))
    expect(chaptersStat.isDirectory()).toBe(true)
    const pj = JSON.parse(await readFile(path.join(meta.path, 'project.json'), 'utf-8'))
    expect(pj.name).toBe('示范小说')
    expect(pj.genre).toBe('玄幻')
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
