import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CharacterRepo } from '../src/main/data/memory/character-repo'
import { LocationRepo } from '../src/main/data/memory/location-repo'
import { ItemRepo } from '../src/main/data/memory/item-repo'
import { WorldviewRepo } from '../src/main/data/memory/worldview-repo'
import { MemorySyncService } from '../src/main/data/memory/sync-service'
import { invalidateMemoryProject, readMemoryDocuments, readMemoryText } from '../src/main/data/memory/repository-cache'
import { writeTextAtomic } from '../src/main/data/atomic'
import { classifyChangeForTest } from '../src/main/data/project-file-watcher'
import { MemoryService } from '../src/main/data/memory-service'
import type { ProjectService } from '../src/main/data/project-service'

let projectDir: string
beforeEach(async () => {
  projectDir = await fs.mkdtemp(join(tmpdir(), 'memory-cache-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  invalidateMemoryProject(projectDir)
  await fs.rm(projectDir, { recursive: true, force: true })
})

describe('memory repository cache', () => {
  it('caches compact statistics and refreshes counts after internal and external changes', async () => {
    const projects = { resolveDir: async () => projectDir } as unknown as ProjectService
    const service = new MemoryService(projects)
    const characters = new CharacterRepo(projectDir)
    await characters.create({ name: '角色' })
    await new ItemRepo(projectDir).create({ name: '道具' })
    const statistics = await service.getStatistics('project')
    expect(statistics.counts.character).toBe(1)
    expect(statistics.counts.item).toBe(1)
    expect(statistics.pendingForeshadowing).toBe(0)
    const reads = vi.spyOn(fs, 'readFile')
    expect(await service.getStatistics('project')).toEqual(statistics)
    expect(reads).not.toHaveBeenCalled()
    await fs.writeFile(join(projectDir, '记忆', '人物', '第二个.md'), '# 第二个\n')
    expect((await service.getStatistics('project')).counts.character).toBe(2)
    const [character] = await characters.list()
    await characters.delete(character.id)
    expect((await service.getStatistics('project')).counts.character).toBe(1)
  })

  it('reuses parsed lists across repository instances without rereading unchanged cards', async () => {
    const repo = new CharacterRepo(projectDir)
    for (let index = 0; index < 30; index++) await repo.create({ name: `人物${index}`, identity: '原始身份' })
    const characters = await repo.list()
    const reads = vi.spyOn(fs, 'readFile')
    const next = new CharacterRepo(projectDir)
    expect((await next.get(characters[0].id))?.identity).toBe('原始身份')
    expect(await next.list()).toHaveLength(30)
    expect(reads).not.toHaveBeenCalled()
  })

  it('rereads only modified cards and notices edits even when mtime is restored', async () => {
    const repo = new CharacterRepo(projectDir)
    const created = await repo.create({ name: '角色', identity: '原始身份' })
    await repo.create({ name: '另一个', identity: '无关人物' })
    await repo.list()
    const file = join(projectDir, '记忆', '人物', '角色.md')
    const stat = await fs.stat(file)
    await fs.writeFile(file, '# 角色\n\n## 基本信息\n\n- **身份**：外部修改\n')
    await fs.utimes(file, stat.atime, stat.mtime)
    const reads = vi.spyOn(fs, 'readFile')
    expect((await repo.get(created.id))?.identity).toBe('外部修改')
    expect(reads).toHaveBeenCalledTimes(1)
  })

  it('observes primary additions, renames, deletion and fallback precedence', async () => {
    const fallback = join(projectDir, '设定', '角色')
    await fs.mkdir(fallback, { recursive: true })
    await fs.writeFile(join(fallback, '角色.md'), '# 角色\n\n## 基本信息\n\n- **身份**：底稿\n')
    const repo = new CharacterRepo(projectDir)
    const [character] = await repo.list()
    await repo.create({ name: '角色', identity: '主源' })
    expect((await repo.get(character.id))?.identity).toBe('主源')
    await repo.update(character.id, { name: '改名' })
    expect((await repo.list()).map(entry => entry.name).sort()).toEqual(['改名', '角色'])
    const renamed = (await repo.list()).find(entry => entry.name === '改名')!
    await repo.delete(renamed.id)
    expect(await repo.get(renamed.id)).toBeNull()
    expect((await repo.get(character.id))?.identity).toBe('底稿')
  })

  it('returns independent entities and parsed documents', async () => {
    const repo = new CharacterRepo(projectDir)
    await repo.create({ name: '角色', identity: '身份' })
    const [character] = await repo.list()
    character.identity = '修改返回值'
    expect((await repo.get(character.id))?.identity).toBe('身份')
    const root = join(projectDir, '记忆', '人物')
    const [document] = await readMemoryDocuments(root, ['角色.md'])
    document.doc.sections[0].body = '修改解析结果'
    expect((await readMemoryDocuments(root, ['角色.md']))[0].doc.sections[0].body).toContain('身份')
  })

  it('coalesces concurrent cold reads and invalidates atomic writes', async () => {
    const file = join(projectDir, 'card.md')
    await fs.writeFile(file, '原文')
    const reads = vi.spyOn(fs, 'readFile')
    expect(await Promise.all(Array.from({ length: 8 }, () => readMemoryText(file)))).toEqual(Array(8).fill('原文'))
    expect(reads).toHaveBeenCalledTimes(1)
    await writeTextAtomic(file, '更新')
    expect(await readMemoryText(file)).toBe('更新')
    expect(reads).toHaveBeenCalledTimes(2)
  })

  it('updates a batch without reading the entire library for each character', async () => {
    const repo = new CharacterRepo(projectDir)
    for (let index = 0; index < 30; index++) await repo.create({ name: `人物${index}`, identity: '原始身份' })
    const characters = await repo.list()
    const reads = vi.spyOn(fs, 'readFile')
    const updates = characters.slice(0, 10).map(character => ({ id: character.id, patch: { identity: '新身份' } }))
    expect(await repo.updateMany(updates, characters)).toHaveLength(10)
    expect(reads).not.toHaveBeenCalled()
    const refreshed = await repo.list()
    expect(refreshed.filter(character => character.identity === '新身份')).toHaveLength(10)
    expect(reads).toHaveBeenCalledTimes(10)
  })

  it('rejects a batch computed from cards edited by the author', async () => {
    const repo = new CharacterRepo(projectDir)
    await repo.create({ name: '角色', identity: '原始身份' })
    const baseline = await repo.list()
    await fs.writeFile(join(projectDir, '记忆', '人物', '角色.md'), '# 角色\n\n## 基本信息\n\n- **身份**：作者修改\n')
    await expect(repo.updateMany([{ id: baseline[0].id, patch: { identity: '自动更新' } }], baseline)).rejects.toThrow('人物卡已被修改')
    expect((await repo.get(baseline[0].id))?.identity).toBe('作者修改')
  })

  it.each([
    ['人物', CharacterRepo], ['地点', LocationRepo], ['道具', ItemRepo], ['世界观', WorldviewRepo]
  ] as const)('updates and deletes the indexed nested %s source', async (folder, Repository) => {
    const root = join(projectDir, '记忆', folder, '子目录')
    await fs.mkdir(root, { recursive: true })
    const file = join(root, '任意文件名.md')
    await fs.writeFile(file, '# 角色\n\n## 描述\n\n原文\n')
    const repo = new Repository(projectDir)
    const [entity] = await repo.list()
    await repo.update(entity.id, { name: '改名' })
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    const [renamed] = await repo.list()
    expect(renamed.name).toBe('改名')
    await repo.delete(renamed.id)
    expect(await repo.list()).toEqual([])
  })

  it('does not rewrite index files during an unchanged sync', async () => {
    const source = join(projectDir, '设定', '角色')
    await fs.mkdir(source, { recursive: true })
    await fs.writeFile(join(source, '角色.md'), '# 角色\n')
    const sync = new MemorySyncService(projectDir)
    await sync.syncAll()
    const writes = vi.spyOn(fs, 'writeFile')
    const report = await sync.syncAll()
    expect(report.errors).toEqual([])
    expect(report.updated).toBe(0)
    expect(writes).not.toHaveBeenCalled()
  })

  it('classifies current memory paths for external-edit refresh', () => {
    expect(classifyChangeForTest('记忆/人物/角色.md')).toBe('characters')
    expect(classifyChangeForTest('记忆/地点/地点.md')).toBe('memory')
    expect(classifyChangeForTest('追踪/角色状态.md')).toBe('memory')
    expect(classifyChangeForTest('设定/世界观/地理.md')).toBe('memory')
    expect(classifyChangeForTest('记忆/人物/角色.md.tmp')).toBeNull()
  })
})
