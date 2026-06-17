import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { MemoryService } from '../src/main/data/memory-service'

describe('MemoryService', () => {
  let root: string
  let memory: MemoryService
  let projectId: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-mem-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    const projectService = new ProjectService(path.join(root, 'projects'), library)
    memory = new MemoryService(projectService)
    const project = await projectService.create({ name: 'X' })
    projectId = project.id
  })

  it('createCharacter writes characters.json and appends history', async () => {
    const c = await memory.createCharacter(projectId, { name: '林远', role: '主角' })
    expect(c.id).toMatch(/.+/)
    const chars = JSON.parse(
      await readFile(path.join(root, 'projects', projectId, 'memory', 'characters.json'), 'utf-8')
    )
    expect(chars.items).toHaveLength(1)
    const history = await memory.listHistory(projectId)
    expect(history).toHaveLength(1)
    expect(history[0].action).toBe('create')
    expect(history[0].summary).toBe('林远')
  })

  it('deleteCharacter removes item and logs', async () => {
    const c = await memory.createCharacter(projectId, { name: '林远' })
    await memory.deleteCharacter(projectId, c.id)
    expect(await memory.listCharacters(projectId)).toEqual([])
    const actions = (await memory.listHistory(projectId)).map((h) => h.action)
    expect(actions).toEqual(['create', 'delete'])
  })

  it('updateCharacter writes history with new summary', async () => {
    const c = await memory.createCharacter(projectId, { name: '林远' })
    await memory.updateCharacter(projectId, c.id, { name: '林远之' })
    const actions = (await memory.listHistory(projectId)).map((h) => h.action)
    expect(actions).toEqual(['create', 'update'])
  })
})
