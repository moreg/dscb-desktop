import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { MemoryService } from '../src/main/data/memory-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

const mockSettings = { getProjectsRoot: async (fallback: string) => fallback } as unknown as SettingsRepository

describe('MemoryService', () => {
  let root: string
  let memory: MemoryService
  let projectId: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-mem-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    const projectService = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    memory = new MemoryService(projectService)
    const project = await projectService.create({ name: 'X' })
    projectId = project.id
  })

  it('createCharacter persists through the markdown-backed character store', async () => {
    const c = await memory.createCharacter(projectId, { name: '林远', role: '主角' })
    expect(c.id).toMatch(/.+/)
    const chars = await memory.listCharacters(projectId)
    expect(chars).toHaveLength(1)
    expect(chars[0].name).toBe('林远')
    const history = await memory.listHistory(projectId)
    expect(history).toEqual([])
  })

  it('deleteCharacter removes the item', async () => {
    const c = await memory.createCharacter(projectId, { name: '林远' })
    await memory.deleteCharacter(projectId, c.id)
    expect(await memory.listCharacters(projectId)).toEqual([])
    expect(await memory.listHistory(projectId)).toEqual([])
  })

  it('updateCharacter updates the character through the markdown-backed store', async () => {
    const c = await memory.createCharacter(projectId, { name: '林远' })
    const updated = await memory.updateCharacter(projectId, c.id, { name: '林远之' })
    expect(updated.name).toBe('林远之')
    expect(await memory.listHistory(projectId)).toEqual([])
  })
})
