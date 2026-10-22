import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { LibraryRepository } from '../src/main/data/library-repository'
import {
  encodeZip,
  extractProjectPackage,
  readZipEntries,
  writeProjectPackage
} from '../src/main/data/project-package'
import { ProjectService } from '../src/main/data/project-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import { createWritingProject } from './helpers/writing-project'

const mockSettings = { getProjectsRoot: async (fallback: string) => fallback } as unknown as SettingsRepository

describe('小说包', () => {
  let root: string
  let service: ProjectService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-pkg-'))
    service = new ProjectService(
      path.join(root, 'projects'),
      new LibraryRepository(path.join(root, 'library.json')),
      mockSettings
    )
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('打包后能原样解出中文路径、正文和可压缩的二进制', async () => {
    const meta = await createWritingProject(service, { name: '雨落瓦上', description: '一场夜雨' })
    const chapter = '瓦上的雨声很密。\n'
    const nested = '# 背景\n\n城里常年下雨。\n'
    const binary = Buffer.alloc(4096, 7)
    await writeFile(path.join(meta.path, '正文', '第一章 雨.md'), chapter, 'utf8')
    await mkdir(path.join(meta.path, '设定', '世界观'), { recursive: true })
    await writeFile(path.join(meta.path, '设定', '世界观', '背景设定.md'), nested, 'utf8')
    await writeFile(path.join(meta.path, '资料', '封面.bin'), binary)
    await writeFile(path.join(root, 'providers.enc'), Buffer.from('secret-key'))

    let linked: boolean
    try {
      await symlink(path.join(root, 'providers.enc'), path.join(meta.path, '外链.md'))
      linked = true
    } catch {
      linked = false
    }

    const zipPath = path.join(root, '雨落瓦上.zip')
    await writeProjectPackage(meta.path, zipPath)
    const zip = await readFile(zipPath)
    const entries = readZipEntries(zip)
    const names = entries.map((entry) => entry.name)
    expect(names.some((name) => name.endsWith('正文/第一章 雨.md'))).toBe(true)
    expect(names.some((name) => name.includes('providers.enc') || name.endsWith('外链.md'))).toBe(false)
    expect(localMethods(zip).has(8)).toBe(true)

    const importedRoot = path.join(root, 'imported')
    const dir = await extractProjectPackage(zipPath, importedRoot)
    expect(path.basename(dir)).toBe('雨落瓦上')
    expect(await readFile(path.join(dir, '正文', '第一章 雨.md'), 'utf8')).toBe(chapter)
    expect(await readFile(path.join(dir, '设定', '世界观', '背景设定.md'), 'utf8')).toBe(nested)
    expect(await readFile(path.join(dir, '资料', '封面.bin'))).toEqual(binary)
    if (linked) {
      expect((await readdir(dir)).includes('外链.md')).toBe(false)
    }
  })

  it('拒绝路径穿越、损坏的压缩包，以及不是小说的压缩包', async () => {
    const projects = path.join(root, 'projects')
    await mkdir(projects, { recursive: true })
    const slip = path.join(root, 'slip.zip')
    await writeFile(slip, encodeZip([{ name: '../outside.txt', data: Buffer.from('逃出目录') }]))
    await expect(extractProjectPackage(slip, projects)).rejects.toThrow('小说包里的路径不安全')
    expect(await readdir(root)).not.toContain('outside.txt')
    expect(await readdir(projects)).toEqual([])

    const broken = path.join(root, 'broken.zip')
    await writeFile(broken, Buffer.from('这不是压缩包'))
    await expect(extractProjectPackage(broken, projects)).rejects.toThrow('小说包已损坏')

    const notes = path.join(root, 'notes.zip')
    await writeFile(notes, encodeZip([{ name: 'readme.txt', data: Buffer.from('只是说明') }]))
    await expect(extractProjectPackage(notes, projects)).rejects.toThrow('这不是大神持笔的小说包')
    expect(await readdir(projects)).toEqual([])
  })

  it('导入已有同一本书时另存目录并更换编号，不改动原来的书', async () => {
    const meta = await createWritingProject(service, { name: '示范小说', description: '原简介' })
    const chapter = '# 第一章\n\n雨落在瓦上。\n'
    await writeFile(path.join(meta.path, '正文', '第001章.md'), chapter, 'utf8')
    const originalJson = await readFile(path.join(meta.path, 'project.json'), 'utf8')
    const zipPath = path.join(root, '示范小说.zip')
    await service.exportProjectPackage(meta.id, zipPath)

    const imported = await service.importProjectPackage(zipPath)
    expect(imported.id).not.toBe(meta.id)
    expect(imported.name).toBe('示范小说')
    expect(path.basename(imported.path)).toBe('示范小说-2')
    expect(await readFile(path.join(meta.path, 'project.json'), 'utf8')).toBe(originalJson)
    const copy = JSON.parse(await readFile(path.join(imported.path, 'project.json'), 'utf8')) as { id: string; name: string }
    expect(copy.id).toBe(imported.id)
    expect(copy.name).toBe('示范小说')
    expect(await readFile(path.join(imported.path, '正文', '第001章.md'), 'utf8')).toBe(chapter)
    expect(await readFile(path.join(imported.path, '大纲', '大纲.md'), 'utf8')).toContain('《示范小说》')
    const listed = await service.listProjects()
    expect(listed.map((project) => project.id).sort()).toEqual([meta.id, imported.id].sort())
  })

  it('只有大纲的旧项目也能导入', async () => {
    const source = path.join(root, 'loose')
    await mkdir(path.join(source, '大纲'), { recursive: true })
    await writeFile(path.join(source, '大纲', '大纲.md'), '# 《旧大纲书》大纲\n\n## 主线\n雨。\n', 'utf8')
    const zipPath = path.join(root, '旧大纲书.zip')
    await writeProjectPackage(source, zipPath)

    const imported = await service.importProjectPackage(zipPath)
    expect(imported.name).toBe('旧大纲书')
    expect(imported.id).not.toBe('')
    expect(await readFile(path.join(imported.path, '大纲', '大纲.md'), 'utf8')).toContain('《旧大纲书》')
    expect(await service.listProjects()).toHaveLength(1)
  })
})

function localMethods(zip: Buffer): Set<number> {
  const methods = new Set<number>()
  let offset = 0
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    methods.add(zip.readUInt16LE(offset + 8))
    const compressed = zip.readUInt32LE(offset + 18)
    const nameLength = zip.readUInt16LE(offset + 26)
    const extraLength = zip.readUInt16LE(offset + 28)
    offset += 30 + nameLength + extraLength + compressed
  }
  return methods
}
