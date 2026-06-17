import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectRepository } from '../src/main/data/project-repository'
import type { ProjectData } from '../src/shared/types'

describe('ProjectRepository', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-proj-'))
  })

  it('returns null when project.json absent', async () => {
    const repo = new ProjectRepository(dir)
    expect(await repo.read()).toBeNull()
  })

  it('writes then reads project data', async () => {
    const repo = new ProjectRepository(dir)
    const data: ProjectData = {
      schemaVersion: 1,
      updatedAt: '2026-06-17T00:00:00.000Z',
      id: 'p1',
      name: '示范小说',
      genre: '玄幻',
      createdAt: '2026-06-17T00:00:00.000Z'
    }
    await repo.write(data)
    const read = await repo.read()
    expect(read).toEqual(data)
  })
})
