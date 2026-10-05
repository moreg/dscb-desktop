import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cp, mkdtemp, readFile, readdir, rename, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import { createWritingProject } from './helpers/writing-project'

const mockSettings = { getProjectsRoot: async (fallback: string) => fallback } as unknown as SettingsRepository

describe('ProjectService', () => {
  let root: string
  let service: ProjectService
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-svc-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    service = new ProjectService(path.join(root, 'projects'), library, mockSettings)
  })

  it('create 只建立项目目录和作品信息，不生成规划模板', async () => {
    const meta = await service.create({ name: '示范小说', genre: '玄幻' })
    expect((await stat(meta.path)).isDirectory()).toBe(true)
    expect(await readdir(meta.path)).toEqual(['project.json'])
    const pj = JSON.parse(await readFile(path.join(meta.path, 'project.json'), 'utf-8'))
    expect(pj).toMatchObject({ id: meta.id, name: '示范小说', genre: '玄幻' })
  })

  it('create 不创建大纲、细纲、设定、记忆、追踪或正文目录', async () => {
    const meta = await service.create({ name: 'X' })
    for (const dir of ['大纲', '细纲', '设定', '记忆', '追踪', '正文', '图解', 'chapters', '记忆系统']) {
      await expect(stat(path.join(meta.path, dir))).rejects.toThrow()
    }
  })

  it('没有大纲时仍能读取作品信息，读取不会补写规划模板', async () => {
    const meta = await service.create({ name: '脑洞新书', description: '每次救人都听见患者未来的遗言' })
    expect(await service.getProjectData(meta.id)).toMatchObject({
      id: meta.id, name: '脑洞新书', description: '每次救人都听见患者未来的遗言'
    })
    expect(await readdir(meta.path)).toEqual(['project.json'])
  })

  it('重启后仍列出和读取只有作品信息的项目，不生成额外文件', async () => {
    const meta = await service.create({ name: '尚未规划的故事', genre: '都市', description: '新脑洞' })
    const restarted = new ProjectService(path.join(root, 'projects'), new LibraryRepository(path.join(root, 'library.json')), mockSettings)
    expect(await restarted.listProjects()).toEqual([expect.objectContaining({ id: meta.id, name: meta.name })])
    expect(await restarted.getProjectData(meta.id)).toMatchObject({ id: meta.id, genre: '都市', description: '新脑洞' })
    expect(await readdir(meta.path)).toEqual(['project.json'])
  })

  it('create 将题材、简介和篇幅目标保存到作品信息', async () => {
    const meta = await service.create({
      name: '脑洞参考书', genre: '都市', targetChapters: 200, chapterWordCount: 3000, description: '测试简介'
    })
    expect(await service.getProjectData(meta.id)).toMatchObject({
      id: meta.id, name: '脑洞参考书', genre: '都市', targetChapters: 200, chapterWordCount: 3000, description: '测试简介'
    })
    expect(await readdir(meta.path)).toEqual(['project.json'])
  })

  it('保存书名和脑洞简介后仍只有作品信息，不创建规划目录', async () => {
    const meta = await service.create({ name: '脑洞草稿', description: '原始方向' })
    const updated = await service.updateProjectInfo(meta.id, { name: '遗言药师', description: '新脑洞：救人换来未来记忆' })
    const dir = await service.resolveDir(meta.id)
    expect(updated).toMatchObject({ id: meta.id, name: '遗言药师', description: '新脑洞：救人换来未来记忆' })
    expect(await readdir(dir)).toEqual(['project.json'])
    expect(await service.listProjects()).toEqual([expect.objectContaining({ id: meta.id, name: '遗言药师', path: dir })])
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

  it('updates novel name and description in project data and library metadata', async () => {
    const meta = await createWritingProject(service, { name: '旧书名', description: '旧简介' })
    const updated = await service.updateProjectInfo(meta.id, {
      name: '抽到的新书名',
      description: '抽到的新简介'
    })
    const nextDir = path.join(path.dirname(meta.path), '抽到的新书名')
    expect(updated).toMatchObject({ name: '抽到的新书名', description: '抽到的新简介' })
    expect(await service.resolveDir(meta.id)).toBe(nextDir)
    await expect(stat(meta.path)).rejects.toThrow()
    expect((await service.listProjects())[0]).toMatchObject({
      name: '抽到的新书名',
      description: '抽到的新简介',
      path: nextDir
    })
    expect((await service['library'].list())[0]).toMatchObject({
      name: '抽到的新书名',
      description: '抽到的新简介',
      path: nextDir
    })
    const outline = await readFile(path.join(nextDir, '大纲', '大纲.md'), 'utf-8')
    expect(outline).toContain('《抽到的新书名》大纲')
    expect(outline).not.toContain('旧书名')
    const core = await readFile(path.join(nextDir, '设定', '核心设定.md'), 'utf-8')
    expect(core).toContain('- **书名**：抽到的新书名')
  })

  it('只改简介时，文件夹已经是书名就不再改名', async () => {
    const meta = await service.create({ name: '旧书名', description: '旧简介' })
    await service.updateProjectInfo(meta.id, { name: '已对齐的书名', description: '旧简介' })
    const aligned = await service.resolveDir(meta.id)
    const updated = await service.updateProjectInfo(meta.id, {
      name: '已对齐的书名',
      description: '只改简介'
    })
    expect(updated.description).toBe('只改简介')
    expect(await service.resolveDir(meta.id)).toBe(aligned)
  })

  it('书名里的 Windows 非法符号换成全角后再当文件夹名', async () => {
    const meta = await service.create({ name: '旧书名' })
    const updated = await service.updateProjectInfo(meta.id, { name: '书名?' })
    expect(updated.name).toBe('书名？')
    expect(path.basename(await service.resolveDir(meta.id))).toBe('书名？')
  })

  it('同级已经有这个文件夹时不改名也不改书名', async () => {
    const first = await service.create({ name: '甲书' })
    const second = await service.create({ name: '乙书' })
    await service.updateProjectInfo(first.id, { name: '甲书' })
    await expect(service.updateProjectInfo(second.id, { name: '甲书' })).rejects.toThrow(/同名文件夹/)
    expect(await service.resolveDir(second.id)).toBe(second.path)
    expect((await service.getProjectData(second.id)).name).toBe('乙书')
  })

  it('CON 这类保留名不能用作文件夹', async () => {
    const meta = await service.create({ name: '旧书名' })
    await expect(service.updateProjectInfo(meta.id, { name: 'CON' })).rejects.toThrow(/不能用作文件夹名/)
    expect(await service.resolveDir(meta.id)).toBe(meta.path)
  })

  it('keeps title candidates without changing the current name, deduped and removable', async () => {
    const meta = await service.create({ name: '原书名', description: '原简介' })
    await service.addTitleCandidate(meta.id, { name: '候选一', description: '简介一', seed: '强悬念' })
    await service.addTitleCandidate(meta.id, { name: '候选二', description: '简介二' })
    const list = await service.addTitleCandidate(meta.id, { name: '候选一', description: '简介一' })
    expect(list.map((item) => item.name)).toEqual(['候选二', '候选一'])

    const data = await service.getProjectData(meta.id)
    expect(data).toMatchObject({ name: '原书名', description: '原简介' })
    expect(data.titleCandidates).toHaveLength(2)

    const remaining = await service.removeTitleCandidate(meta.id, list[0].id)
    expect(remaining.map((item) => item.name)).toEqual(['候选一'])
  })

  it('resolveDir caches directory across calls', async () => {
    const meta = await service.create({ name: 'X' })
    ;(service as unknown as { dirCache: Map<string, string> }).dirCache.delete(meta.id)
    const listSpy = vi.spyOn(service['library'], 'list')
    await service.resolveDir(meta.id)
    await service.resolveDir(meta.id)
    expect(listSpy).toHaveBeenCalledTimes(1)
  })

  it('hides archived projects from the default list and still resolves them', async () => {
    const kept = await service.create({ name: '在写' })
    const archived = await service.create({ name: '归档书' })
    await service.setArchived(archived.id, true)
    const listed = await service.listProjects()
    expect(listed.map((p) => p.id)).toEqual([kept.id])
    const all = await service.listProjects({ includeArchived: true })
    expect(all.map((p) => p.id).sort()).toEqual([kept.id, archived.id].sort())
    expect(all.find((p) => p.id === archived.id)?.archivedAt).toBeTruthy()
    expect(await service.resolveDir(archived.id)).toBe(archived.path)
  })

  it('扫描时把改名后的文件夹名同步为书名', async () => {
    const oldName = '让你演财阀恶女，你怎么成全首尔的白月光了？'
    const folderName = '让你演财阀恶女，你怎么成白月光了'
    const meta = await createWritingProject(service, { name: oldName })
    const nextDir = path.join(path.dirname(meta.path), folderName)
    await rename(meta.path, nextDir)
    // 上一次扫描已经按大纲里的旧书名登记了新路径
    await service['library'].create({ name: oldName, path: nextDir })

    const listed = await service.scanProjects()
    expect(listed.map((item) => item.name)).toEqual([folderName])

    const outline = await readFile(path.join(nextDir, '大纲', '大纲.md'), 'utf-8')
    expect(outline).toContain(`《${folderName}》大纲`)
    expect(outline).not.toContain(oldName)
    const projectJson = JSON.parse(await readFile(path.join(nextDir, 'project.json'), 'utf-8'))
    expect(projectJson.name).toBe(folderName)
    const core = await readFile(path.join(nextDir, '设定', '核心设定.md'), 'utf-8')
    expect(core).toContain(`- **书名**：${folderName}`)
    expect(core).not.toContain(oldName)
  })

  it('旧目录还在时，不把另一份大纲相同的书改成文件夹名', async () => {
    const meta = await createWritingProject(service, { name: '潮屿之主' })
    const copy = path.join(path.dirname(meta.path), '师父的七个师姐')
    await cp(meta.path, copy, { recursive: true })

    const listed = await service.scanProjects()
    expect(listed.find((item) => item.path === copy)?.name).toBe('潮屿之主')
    expect(listed.find((item) => item.id === meta.id)?.name).toBe('潮屿之主')
    const outline = await readFile(path.join(copy, '大纲', '大纲.md'), 'utf-8')
    expect(outline).toContain('《潮屿之主》大纲')
  })

  it('纯数字文件夹名不当成新书名', async () => {
    const meta = await createWritingProject(service, { name: '穿成财阀恶女，我靠砸钱成了全校白月光' })
    const nextDir = path.join(path.dirname(meta.path), '1')
    await rename(meta.path, nextDir)

    const listed = await service.scanProjects()
    expect(listed.map((item) => item.name)).toEqual(['穿成财阀恶女，我靠砸钱成了全校白月光'])
    const outline = await readFile(path.join(nextDir, '大纲', '大纲.md'), 'utf-8')
    expect(outline).toContain('《穿成财阀恶女，我靠砸钱成了全校白月光》')
  })

  it('scan does not resurrect an archived project as a new shelf entry', async () => {
    const archived = await service.create({ name: '归档后扫描' })
    await service.setArchived(archived.id, true)
    await service.scanProjects()
    expect(await service.listProjects()).toEqual([])
    const all = await service.listProjects({ includeArchived: true })
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(archived.id)
    expect(all[0].archivedAt).toBeTruthy()
  })

  it('unarchive puts the project back on the default list', async () => {
    const meta = await service.create({ name: '移回' })
    await service.setArchived(meta.id, true)
    await service.setArchived(meta.id, false)
    expect((await service.listProjects()).map((p) => p.id)).toEqual([meta.id])
    expect((await service.listProjects())[0].archivedAt).toBeUndefined()
  })
  it('扫描移走的作品信息项目时保留稳定 id、归档状态和读取路径', async () => {
    const meta = await service.create({ name: '待搬家的脑洞', description: '保持长线设定' })
    const archived = await service.setArchived(meta.id, true)
    const nextDir = path.join(path.dirname(meta.path), '搬家后的脑洞')
    await rename(meta.path, nextDir)

    await service.scanProjects()
    expect(await service.listProjects()).toEqual([])
    const all = await service.listProjects({ includeArchived: true })
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ id: meta.id, path: nextDir, archivedAt: archived.archivedAt })
    expect(await service.resolveDir(meta.id)).toBe(nextDir)
    expect(await service.getProjectData(meta.id)).toMatchObject({ id: meta.id, description: '保持长线设定' })
    expect(await readdir(nextDir)).toEqual(['project.json'])
  })

  it('丢失书架索引后可从作品信息恢复同一个稳定 id', async () => {
    const meta = await service.create({ name: '索引外的脑洞', description: '项目仍在磁盘上' })
    await rm(path.join(root, 'library.json'))
    const restarted = new ProjectService(path.join(root, 'projects'), new LibraryRepository(path.join(root, 'library.json')), mockSettings)

    expect(await restarted.listProjects()).toEqual([])
    expect(await restarted.scanProjects()).toEqual([expect.objectContaining({
      id: meta.id, name: meta.name, path: meta.path, description: '项目仍在磁盘上'
    })])
    expect(await restarted.getProjectData(meta.id)).toMatchObject({ id: meta.id, name: meta.name })
    expect(await readdir(meta.path)).toEqual(['project.json'])
    expect(await new LibraryRepository(path.join(root, 'another-library.json')).list()).toEqual([])
  })

  it('复制作品信息项目时给副本独立 id，原项目和副本的记录互不混用', async () => {
    const meta = await service.create({ name: '原脑洞', description: '原设定' })
    const copyDir = path.join(path.dirname(meta.path), '另存的脑洞')
    await cp(meta.path, copyDir, { recursive: true })

    const listed = await service.scanProjects()
    expect(listed).toHaveLength(2)
    expect(listed.find(item => item.id === meta.id)).toMatchObject({ name: '原脑洞', path: meta.path })
    const copy = listed.find(item => item.path === copyDir)!
    expect(copy).toBeDefined()
    expect(copy.id).not.toBe(meta.id)
    const originalData = JSON.parse(await readFile(path.join(meta.path, 'project.json'), 'utf-8'))
    const copyData = JSON.parse(await readFile(path.join(copyDir, 'project.json'), 'utf-8'))
    expect(originalData.id).toBe(meta.id)
    expect(copyData.id).toBe(copy.id)
    await service.addTitleCandidate(copy.id, { name: '副本候选', description: '只属于副本' })
    expect((await service.getProjectData(meta.id)).titleCandidates ?? []).toEqual([])
    expect((await service.getProjectData(copy.id)).titleCandidates).toEqual([
      expect.objectContaining({ name: '副本候选', description: '只属于副本' })
    ])
    expect((await service.scanProjects()).find(item => item.path === copyDir)?.id).toBe(copy.id)
  })

  it('两个同书名的作品信息项目均有有效目录时，扫描不误判为改名', async () => {
    const first = await service.create({ name: '同名脑洞' })
    const second = await service.create({ name: '同名脑洞' })
    const secondDir = path.join(path.dirname(second.path), '只是保存目录')
    await rename(second.path, secondDir)
    await service['library'].update(second.id, { path: secondDir })
    const restarted = new ProjectService(path.join(root, 'projects'), new LibraryRepository(path.join(root, 'library.json')), mockSettings)

    const listed = await restarted.scanProjects()
    expect(listed).toHaveLength(2)
    expect(listed.find(item => item.id === first.id)).toMatchObject({ name: '同名脑洞', path: first.path })
    expect(listed.find(item => item.id === second.id)).toMatchObject({ name: '同名脑洞', path: secondDir })
    expect(JSON.parse(await readFile(path.join(secondDir, 'project.json'), 'utf-8')).name).toBe('同名脑洞')
  })

})
