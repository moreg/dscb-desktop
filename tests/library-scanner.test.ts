import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readAppProjectIdentity, scanProjectsRoot } from '../src/main/data/skill-format/library-scanner'

describe('library scanner', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aw-scanner-'))
  })
  afterEach(async () => {
    // root 由 mkdtemp 创建，清理范围限制在本测试的临时目录。
    expect(root.startsWith(join(tmpdir(), 'aw-scanner-'))).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  async function appProject(folder: string, data: unknown): Promise<string> {
    const dir = join(root, folder)
    await mkdir(dir)
    await writeFile(join(dir, 'project.json'), JSON.stringify(data), 'utf-8')
    return dir
  }

  it('只有有效 project.json 的新作品也能识别，重复扫描和改目录保留稳定 ID', async () => {
    const identity = { schemaVersion: 1, id: 'a-stable-project-id', name: '只存脑洞的新作品', description: '主人公发现祖父留下的异能债务' }
    const dir = await appProject('new-book', identity)
    const expected = [{ path: dir, id: identity.id, name: identity.name }]
    expect(await scanProjectsRoot(root)).toEqual(expected)
    expect(await scanProjectsRoot(root)).toEqual(expected)
    const renamed = join(root, 'renamed-book')
    await rename(dir, renamed)
    expect(await scanProjectsRoot(root)).toEqual([{ path: renamed, id: identity.id, name: identity.name }])
  })

  it('拒绝空目录、其他 JSON、损坏 JSON 和不满足 schemaVersion/id/name 的目录', async () => {
    await mkdir(join(root, 'empty'))
    await mkdir(join(root, 'other-json'))
    await writeFile(join(root, 'other-json', 'settings.json'), '{"schemaVersion":1,"id":"settings","name":"设置"}', 'utf-8')
    await mkdir(join(root, 'broken'))
    await writeFile(join(root, 'broken', 'project.json'), '{"schemaVersion":1,', 'utf-8')
    const invalid = [
      null, [], { name: '普通 JSON' }, { schemaVersion: '1', id: 'project', name: '错误版本' },
      { schemaVersion: 2, id: 'project', name: '未知版本' }, { schemaVersion: 1, name: '缺 ID' },
      { schemaVersion: 1, id: '', name: '空 ID' }, { schemaVersion: 1, id: '   ', name: '空白 ID' },
      { schemaVersion: 1, id: 42, name: '数字 ID' }, { schemaVersion: 1, id: 'project', name: '' },
      { schemaVersion: 1, id: 'project', name: '  ' }, { schemaVersion: 1, id: 'project', name: 42 }
    ]
    for (let index = 0; index < invalid.length; index++) await appProject(`invalid-${index}`, invalid[index])
    expect(await scanProjectsRoot(root)).toEqual([])
  })

  it('兼容只有大纲的旧项目，损坏或无有效 ID 的 project.json 不阻止旧项目识别', async () => {
    const named = join(root, 'legacy')
    const fallback = await appProject('旧目录书名', { schemaVersion: 1, id: '', name: '无效元数据标题' })
    await mkdir(join(named, '大纲'), { recursive: true })
    await mkdir(join(fallback, '大纲'))
    await writeFile(join(named, '大纲', '大纲.md'), '# 《大纲里的旧书名》大纲\n\n## 基本信息\n', 'utf-8')
    await writeFile(join(fallback, '大纲', '大纲.md'), '旧格式正文没有书名标题', 'utf-8')
    expect((await scanProjectsRoot(root)).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: named, name: '大纲里的旧书名' }, { path: fallback, name: '旧目录书名' }
    ].sort((a, b) => a.path.localeCompare(b.path)))
  })

  it('有效 app 元数据优先于旧大纲，不根据目录名或大纲重新分配 ID', async () => {
    const identity = { schemaVersion: 1, id: 'persistent-id', name: '当前书名' }
    const dir = await appProject('a-folder', identity)
    await mkdir(join(dir, '大纲'))
    await writeFile(join(dir, '大纲', '大纲.md'), '# 《之前的书名》大纲\n', 'utf-8')
    expect(await readAppProjectIdentity(dir)).toEqual({ id: identity.id, name: identity.name })
    expect(await scanProjectsRoot(root)).toEqual([{ path: dir, id: identity.id, name: identity.name }])
  })

  it('只扫描直接项目子目录，文件和不存在的根目录不会成为作品', async () => {
    await writeFile(join(root, 'file.json'), '{"schemaVersion":1,"id":"file","name":"文件"}', 'utf-8')
    const outer = join(root, 'outer')
    await mkdir(join(outer, 'inner'), { recursive: true })
    await writeFile(join(outer, 'inner', 'project.json'), '{"schemaVersion":1,"id":"inner","name":"嵌套目录"}', 'utf-8')
    expect(await scanProjectsRoot(root)).toEqual([])
    expect(await scanProjectsRoot(join(root, 'does-not-exist'))).toEqual([])
  })
})
