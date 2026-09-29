import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cp, mkdtemp, readFile, rename, stat } from 'fs/promises'
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

  it('updates novel name and description in project data and library metadata', async () => {
    const meta = await service.create({ name: '旧书名', description: '旧简介' })
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
    const meta = await service.create({ name: oldName })
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
    const meta = await service.create({ name: '潮屿之主' })
    const copy = path.join(path.dirname(meta.path), '师父的七个师姐')
    await cp(meta.path, copy, { recursive: true })

    const listed = await service.scanProjects()
    expect(listed.find((item) => item.path === copy)?.name).toBe('潮屿之主')
    expect(listed.find((item) => item.id === meta.id)?.name).toBe('潮屿之主')
    const outline = await readFile(path.join(copy, '大纲', '大纲.md'), 'utf-8')
    expect(outline).toContain('《潮屿之主》大纲')
  })

  it('纯数字文件夹名不当成新书名', async () => {
    const meta = await service.create({ name: '穿成财阀恶女，我靠砸钱成了全校白月光' })
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
})
