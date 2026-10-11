import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'

describe('bulk prose reads', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'prose-bulk-'))
    await fs.mkdir(join(root, '正文'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('matches single reads for preferred, compatible, empty and missing files', async () => {
    const fixtures = {
      '第001章 标题.md': '新格式',
      '第001章_旧标题.md': '旧技能格式',
      '001.md': '旧应用格式',
      '第002章_标题.md': '下划线格式',
      '003.md': '数字格式',
      '第004章 空章.md': '',
      '第005章标题.md': '容错格式'
    }
    await Promise.all(Object.entries(fixtures).map(([name, content]) =>
      fs.writeFile(join(root, '正文', name), content)))
    const repo = new ProseRepo(root)
    const bulk = await repo.readMany([1, 2, 3, 4, 5, 6])
    for (let n = 1; n <= 6; n++) {
      expect(bulk.get(n)).toEqual({ exists: await repo.exists(n), content: await repo.read(n) })
    }
    expect(bulk.get(1)?.content).toBe('新格式')
    expect(bulk.get(4)).toEqual({ exists: true, content: '' })
    expect(bulk.get(6)).toEqual({ exists: false, content: '' })
  })

  it('enumerates once for hundreds of chapters and sees external edits on the next call', async () => {
    const numbers = Array.from({ length: 200 }, (_, index) => index + 1)
    await fs.writeFile(join(root, '正文', '第001章 标题.md'), '修改前')
    const scan = vi.spyOn(fs, 'readdir')
    const repo = new ProseRepo(root)
    expect((await repo.readMany(numbers)).get(1)?.content).toBe('修改前')
    expect(scan).toHaveBeenCalledTimes(1)
    await fs.unlink(join(root, '正文', '第001章 标题.md'))
    await fs.writeFile(join(root, '正文', '001.md'), '外部替换')
    expect((await repo.readMany(numbers)).get(1)?.content).toBe('外部替换')
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('handles an absent prose directory and an empty batch', async () => {
    await fs.rmdir(join(root, '正文'))
    const repo = new ProseRepo(root)
    expect(await repo.readMany([])).toEqual(new Map())
    expect((await repo.readMany([1])).get(1)).toEqual({ exists: false, content: '' })
  })

  it('reduces 200 written chapters from 400 directory scans to one', async () => {
    const numbers = Array.from({ length: 200 }, (_, index) => index + 1)
    await Promise.all(numbers.map((n) => fs.writeFile(
      join(root, '正文', `第${String(n).padStart(3, '0')}章 标题.md`),
      '正文内容。'.repeat(500)
    )))
    const repo = new ProseRepo(root)
    const scan = vi.spyOn(fs, 'readdir')
    const start = performance.now()
    const previous = new Map<number, { exists: boolean; content: string }>()
    for (const n of numbers) {
      const exists = await repo.exists(n)
      previous.set(n, { exists, content: exists ? await repo.read(n) : '' })
    }
    const previousMs = performance.now() - start
    expect(scan).toHaveBeenCalledTimes(400)
    scan.mockClear()
    const bulkStart = performance.now()
    const bulk = await repo.readMany(numbers)
    const bulkMs = performance.now() - bulkStart
    expect(bulk).toEqual(previous)
    expect(scan).toHaveBeenCalledTimes(1)
    console.log(`[prose-read 200章] 旧路径 ${previousMs.toFixed(1)}ms / 批量 ${bulkMs.toFixed(1)}ms；目录扫描 400 → 1（合成数据，耗时仅作观测）`)
  })
})
