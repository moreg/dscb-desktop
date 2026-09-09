import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { performance } from 'perf_hooks'
import { DetailedOutlineMdRepo } from '../src/main/data/skill-format/detailed-outline-md-repo'

const fileName = (number: number): string => `细纲_第${String(number).padStart(3, '0')}章_试火.md`
const chapterText = (number: number, event = '邱北点燃湿柴'): string =>
  `# ${fileName(number)}\n\n## 第 ${number} 章：试火\n\n- **核心事件**：${event}\n- **字数预估**：3000 字以内\n- **伏笔埋设**：\n  - 湿柴来历\n\n## 情节安排\n\n众人在海边试火。\n`

describe('DetailedOutlineMdRepo.readChapter', () => {
  let projectDir: string
  let detailDir: string

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(join(tmpdir(), 'wdesk-chapter-read-'))
    detailDir = join(projectDir, '细纲')
    await fs.mkdir(detailDir)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    const target = resolve(projectDir)
    // 仅允许删除本测试用 mkdtemp 创建的系统临时目录。
    expect(dirname(target)).toBe(resolve(tmpdir()))
    expect(basename(target).startsWith('wdesk-chapter-read-')).toBe(true)
    await fs.rm(target, { recursive: true, force: true })
  })

  it('标准每章文件仅读取目标文件，跨 Repo 实例复用缓存且不共享可变返回值', async () => {
    await Promise.all([1, 2, 3].map((n) => fs.writeFile(join(detailDir, fileName(n)), chapterText(n))))
    const reads = vi.spyOn(fs, 'readFile')
    const first = await new DetailedOutlineMdRepo(projectDir).readChapter(2)
    expect(first?.plotSummary).toBe('邱北点燃湿柴')
    expect(first?.wordEstimate).toBe('3000 字以内')
    expect(first?.proseSections).toEqual([{ title: '情节安排', text: '众人在海边试火。' }])
    expect(reads).toHaveBeenCalledTimes(1)
    expect(reads.mock.calls[0][0]).toBe(join(detailDir, fileName(2)))
    first!.foreshadowings!.push('调用方修改')
    first!.rawFields!['核心事件'] = '调用方覆盖'
    reads.mockClear()
    const second = await new DetailedOutlineMdRepo(projectDir).readChapter(2)
    expect(reads).not.toHaveBeenCalled()
    expect(second?.foreshadowings).toEqual(['湿柴来历'])
    expect(second?.rawFields?.['核心事件']).toBe('邱北点燃湿柴')
  })

  it('兼容旧卷、标准变体和只由 H1 标记章号的文件，结果保持 listAll 的优先级', async () => {
    await fs.writeFile(join(detailDir, '第01卷.md'), '# 第 1 卷\n\n## 第 1 章：登船\n- **核心事件**：七人登船\n\n## 第 2 章：断电\n- **核心事件**：船上断电\n')
    await fs.writeFile(join(detailDir, fileName(2)), chapterText(2, '每章文件内容'))
    await fs.writeFile(join(detailDir, fileName(3)), '# 细纲：第 3 章 试火\n\n## 核心事件\n\n七人围着湿柴折腾了一下午。\n')
    await fs.writeFile(join(detailDir, '特别章.md'), chapterText(4))
    const repo = new DetailedOutlineMdRepo(projectDir)
    const expected = await repo.listAll()
    for (const number of [1, 2, 3, 4]) {
      expect(await repo.readChapter(number)).toEqual(expected.find((d) => d.chapterNumber === number))
    }
    expect((await repo.readChapter(2))?.plotSummary).toBe('船上断电')
  })

  it('旧卷缓存索引可读取不同章，并在卷内容变化后重新建立索引', async () => {
    const path = join(detailDir, '第01卷.md')
    await fs.writeFile(path, '# 第 1 卷\n\n## 第 1 章：起航\n- **核心事件**：船开了\n\n## 第 2 章：登岸\n- **核心事件**：船靠岸\n')
    const reads = vi.spyOn(fs, 'readFile')
    expect((await new DetailedOutlineMdRepo(projectDir).readChapter(1))?.plotSummary).toBe('船开了')
    expect((await new DetailedOutlineMdRepo(projectDir).readChapter(2))?.plotSummary).toBe('船靠岸')
    expect(reads).toHaveBeenCalledTimes(1)
    await fs.writeFile(path, '# 第 1 卷\n\n## 第 3 章：换章\n- **核心事件**：风暴来了\n')
    expect(await new DetailedOutlineMdRepo(projectDir).readChapter(2)).toBeNull()
    expect((await new DetailedOutlineMdRepo(projectDir).readChapter(3))?.plotSummary).toBe('风暴来了')
    expect(reads).toHaveBeenCalledTimes(2)
  })

  it('同大小外部编辑即使恢复 mtime 也会失效；增删和改名立即可见', async () => {
    const path = join(detailDir, fileName(1))
    await fs.writeFile(path, chapterText(1, '甲点燃湿柴'))
    const repo = new DetailedOutlineMdRepo(projectDir)
    expect((await repo.readChapter(1))?.plotSummary).toBe('甲点燃湿柴')
    const before = await fs.stat(path)
    await fs.writeFile(path, chapterText(1, '乙点燃湿柴'))
    await fs.utimes(path, before.atime, before.mtime)
    expect((await new DetailedOutlineMdRepo(projectDir).readChapter(1))?.plotSummary).toBe('乙点燃湿柴')
    await fs.rename(path, join(detailDir, fileName(2)))
    expect(await repo.readChapter(1)).toBeNull()
    expect((await repo.readChapter(2))?.chapterNumber).toBe(2)
    await fs.unlink(join(detailDir, fileName(2)))
    expect(await repo.readChapter(2)).toBeNull()
    await fs.writeFile(path, chapterText(1, '新文件内容'))
    expect((await repo.readChapter(1))?.plotSummary).toBe('新文件内容')
  })

  it('项目之间的同章文件独立缓存，缺少目录或章号返回 null', async () => {
    await fs.writeFile(join(detailDir, fileName(1)), chapterText(1, '项目甲'))
    const secondProject = join(projectDir, '另一本书')
    const secondRepo = new DetailedOutlineMdRepo(secondProject)
    expect(await secondRepo.readChapter(1)).toBeNull()
    await fs.mkdir(join(secondProject, '细纲'), { recursive: true })
    await fs.writeFile(join(secondProject, '细纲', fileName(1)), chapterText(1, '项目乙'))
    expect((await new DetailedOutlineMdRepo(projectDir).readChapter(1))?.plotSummary).toBe('项目甲')
    expect((await secondRepo.readChapter(1))?.plotSummary).toBe('项目乙')
    expect(await secondRepo.readChapter(9)).toBeNull()
  })

  it.each([100, 1000])('%i 章仅加载 1 个正文文件，复检无需再次读正文（耗时仅作观测）', async (count) => {
    const body = '\n## 情节细化\n\n' + '众人在海边试火，邱北挡住海风，又加了一把干草。'.repeat(100)
    // 分批写入，避免测试自身同时打开上千个文件。
    for (let start = 1; start <= count; start += 50) {
      await Promise.all(Array.from({ length: Math.min(50, count - start + 1) }, (_, index) => {
        const number = start + index
        return fs.writeFile(join(detailDir, fileName(number)), chapterText(number) + body)
      }))
    }
    const reads = vi.spyOn(fs, 'readFile')
    const baselineStart = performance.now()
    const all = await new DetailedOutlineMdRepo(projectDir).listAll()
    const baselineMs = performance.now() - baselineStart
    expect(reads).toHaveBeenCalledTimes(count)
    reads.mockClear()
    const firstStart = performance.now()
    expect(await new DetailedOutlineMdRepo(projectDir).readChapter(count)).toEqual(all[count - 1])
    const firstMs = performance.now() - firstStart
    expect(reads).toHaveBeenCalledTimes(1)
    reads.mockClear()
    const repeatStart = performance.now()
    expect(await new DetailedOutlineMdRepo(projectDir).readChapter(count)).toEqual(all[count - 1])
    const repeatMs = performance.now() - repeatStart
    expect(reads).not.toHaveBeenCalled()
    console.info(`[outline-read ${count}章] 全量 ${baselineMs.toFixed(1)}ms / 按章 ${firstMs.toFixed(1)}ms / 缓存 ${repeatMs.toFixed(1)}ms；文件读取 ${count} → 1 → 0`)
  }, 20_000)
})
