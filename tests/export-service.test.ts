import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { ChapterService } from '../src/main/data/chapter-service'
import { OutlineService } from '../src/main/data/outline-service'
import { ExportService } from '../src/main/data/export-service'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

const mockSettings = {
  getProjectsRoot: async (fallback: string) => fallback
} as unknown as SettingsRepository

const mockLlm = {} as unknown as LlmService

describe('ExportService', () => {
  let root: string
  let projectId: string
  let ps: ProjectService
  let dir: string
  let service: ExportService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-export-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '青云志', genre: '玄幻' })).id
    dir = await ps.resolveDir(projectId)

    // 节奏图谱：第 1、2 章属于第 1 卷，第 3 章属于第 2 卷，第 4 章未分卷；第 3 章未写正文
    await mkdir(path.join(dir, '图解'), { recursive: true })
    await writeFile(
      path.join(dir, '图解', '节奏图谱.html'),
      `<script>\nconst rhythmData = [\n` +
        `  { chapter: 1, title: '破窗', emotion: 5, climax: 1, volume: 1, actualized: true },\n` +
        `  { chapter: 2, title: '夜行', emotion: 5, climax: 1, volume: 1, actualized: true },\n` +
        `  { chapter: 3, title: '登船', emotion: 5, climax: 1, volume: 2, actualized: false },\n` +
        `  { chapter: 4, title: '未分卷章节', emotion: 5, climax: 1, volume: 0, actualized: true },\n` +
        `  { chapter: 5, title: '新程', emotion: 5, climax: 1, volume: 2, actualized: false }\n` +
        `];\n</script>`,
      'utf-8'
    )

    // 大纲.md：定义卷名
    await mkdir(path.join(dir, '大纲'), { recursive: true })
    await writeFile(
      path.join(dir, '大纲', '大纲.md'),
      '# 青云志\n\n' +
        '## 主线剧情走向\n\n' +
        '### 第1卷：破晓（第1-2章）\n引言\n\n' +
        '### 第2卷：远航（第3-3章）\n引言\n',
      'utf-8'
    )

    // 正文：第 1、2、4 章已写，第 3 章未写（保持细纲占位状态）
    await mkdir(path.join(dir, '正文'), { recursive: true })
    await writeFile(path.join(dir, '正文', '第001章 破窗.md'), '苏九破窗而出。', 'utf-8')
    await writeFile(path.join(dir, '正文', '第002章 夜行.md'), '夜色如墨。', 'utf-8')
    await writeFile(path.join(dir, '正文', '第004章 未分卷章节.md'), '未分卷正文。', 'utf-8')

    const chapterService = new ChapterService(ps)
    const outlineService = new OutlineService(ps, mockLlm)
    service = new ExportService(chapterService, outlineService, ps)
  })

  it('导出全书：按卷分组，未写正文的章节跳过', async () => {
    const { text } = await service.buildExport(projectId)

    expect(text).toContain('第1卷 破晓')
    expect(text).toContain('第1章 破窗')
    expect(text).toContain('苏九破窗而出。')
    expect(text).toContain('第2章 夜行')
    expect(text).toContain('夜色如墨。')
    // 第 3 章未写正文，即使属于第 2 卷也不应出现在导出结果里
    expect(text).not.toContain('第2卷')
    expect(text).not.toContain('第3章 登船')
    // 未分卷章节不带卷标题
    expect(text).toContain('第4章 未分卷章节')
    expect(text).toContain('未分卷正文。')
  })

  it('导出单卷：只包含该卷章节', async () => {
    const { text } = await service.buildExport(projectId, { volumeNumber: 1 })

    expect(text).toContain('第1卷 破晓')
    expect(text).toContain('第1章 破窗')
    expect(text).toContain('第2章 夜行')
    expect(text).not.toContain('第4章 未分卷章节')
  })

  it('指定的卷全部未写正文时导出结果为空文本', async () => {
    const { text } = await service.buildExport(projectId, { volumeNumber: 2 })
    expect(text.trim()).toBe('')
  })

  it('未导出过的章节：首次导出包含全部已写章节，标记后再导出报「没有未导出的章节」', async () => {
    const first = await service.buildExport(projectId, { onlyUnexported: true })
    expect(first.chapters.map((c) => c.chapterNumber)).toEqual([1, 2, 4])
    expect(first.text).toContain('第4章 未分卷章节')

    await service.markExported(projectId, first.chapters)

    await expect(service.buildExport(projectId, { onlyUnexported: true }))
      .rejects.toThrow('没有未导出的章节')
    // 全量导出不受标记影响
    const all = await service.buildExport(projectId)
    expect(all.chapters.map((c) => c.chapterNumber)).toEqual([1, 2, 4])
  })

  it('导出后新增的章节、导出后改过正文的章节都算未导出', async () => {
    const first = await service.buildExport(projectId, { onlyUnexported: true })
    await service.markExported(projectId, first.chapters)

    // 第 5 章新写正文（节奏图谱里已有占位），第 1 章正文改动
    await writeFile(path.join(dir, '正文', '第005章 新程.md'), '新的旅程开始了。', 'utf-8')
    await writeFile(path.join(dir, '正文', '第001章 破窗.md'), '苏九再次破窗而出。', 'utf-8')

    const second = await service.buildExport(projectId, { onlyUnexported: true })
    expect(second.chapters.map((c) => c.chapterNumber)).toEqual([1, 5])
    expect(second.text).toContain('苏九再次破窗而出。')
    expect(second.text).toContain('第5章 新程')
    expect(second.text).not.toContain('第2章 夜行')

    // 再标记后增量导出重新清空
    await service.markExported(projectId, second.chapters)
    await expect(service.buildExport(projectId, { onlyUnexported: true }))
      .rejects.toThrow('没有未导出的章节')
  })

  it('取消保存不调用 markExported 时，标记不影响下一次增量导出', async () => {
    const first = await service.buildExport(projectId, { onlyUnexported: true })
    // 模拟用户取消：不调用 markExported，直接再次导出
    const second = await service.buildExport(projectId, { onlyUnexported: true })
    expect(second.chapters.map((c) => c.chapterNumber)).toEqual(first.chapters.map((c) => c.chapterNumber))
  })
})
