import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { ChapterService } from '../src/main/data/chapter-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

const mockSettings = {
  getProjectsRoot: async (fallback: string) => fallback
} as unknown as SettingsRepository

/**
 * ChapterEditor inline title edit 持久化测试：
 * 验证 updateChapterMeta → updateMeta → ChapterRhythmWriter 三处同步（rhythmData + 大纲逐章表 + 细纲标题），
 * 且细纲缺失时**不报错**（该章无细纲也允许改标题）。
 */
describe('ChapterService.updateMeta title persistence', () => {
  let root: string
  let projectId: string
  let ps: ProjectService
  let dir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-title-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '标题测试', genre: '玄幻' })).id
    dir = await ps.resolveDir(projectId)

    // 节奏图谱 html：3 章
    await mkdir(path.join(dir, '图解'), { recursive: true })
    await writeFile(
      path.join(dir, '图解', '节奏图谱.html'),
      `<script>\nconst rhythmData = [\n` +
        `  { chapter: 1, title: '旧1', emotion: 5, climax: 1, volume: 1, actualized: false },\n` +
        `  { chapter: 2, title: '旧2', emotion: 6, climax: 2, volume: 1, actualized: false },\n` +
        `  { chapter: 3, title: '旧3', emotion: 7, climax: 3, volume: 1, actualized: false }\n` +
        `];\n</script>`,
      'utf-8'
    )

    // 大纲逐章节奏标注
    await mkdir(path.join(dir, '大纲'), { recursive: true })
    await writeFile(
      path.join(dir, '大纲', '大纲.md'),
      '# 《标题测试》大纲\n\n## 逐章节奏标注\n\n' +
        '### 第 1 卷：开篇（第1-3章）\n\n' +
        '| 章节 | 标题 | 情绪值 | 爽点类型 |\n' +
        '| --- | --- | --- | --- |\n' +
        '| 第 1 章 | 旧1 | 5 | 1 |\n' +
        '| 第 2 章 | 旧2 | 6 | 2 |\n' +
        '| 第 3 章 | 旧3 | 7 | 3 |\n',
      'utf-8'
    )
  })

  it('updates title in rhythmData + outline table + chapter meta', async () => {
    const service = new ChapterService(ps)
    const meta = await service.updateMeta(projectId, 2, { title: '新标题2' })

    expect(meta.title).toBe('新标题2')

    // rhythmData
    const rhythmText = await readFile(path.join(dir, '图解', '节奏图谱.html'), 'utf-8')
    expect(rhythmText).toContain("title: '新标题2'")
    expect(rhythmText).not.toContain("title: '旧2'")

    // 大纲逐章节奏表
    const outlineText = await readFile(path.join(dir, '大纲', '大纲.md'), 'utf-8')
    expect(outlineText).toContain('新标题2')
    expect(outlineText).not.toMatch(/第 2 章 \| 旧2 \|/)
  })

  it('updates title in detailed outline when present', async () => {
    // 写细纲：第 2 章旧标题"旧2"
    await mkdir(path.join(dir, '细纲'), { recursive: true })
    await writeFile(
      path.join(dir, '细纲', '第01卷.md'),
      '# 第 01 卷细纲\n\n' +
        '## 第 2 章：旧2\n' +
        '- **核心事件**：测试\n',
      'utf-8'
    )

    const service = new ChapterService(ps)
    await service.updateMeta(projectId, 2, { title: '细纲新标题' })

    const detailText = await readFile(path.join(dir, '细纲', '第01卷.md'), 'utf-8')
    expect(detailText).toContain('第 2 章：细纲新标题')
    expect(detailText).not.toContain('第 2 章：旧2')
  })

  it('does NOT throw when detailed outline is absent (only rhythm + outline)', async () => {
    // 注意 beforeEach 没建细纲目录 → 细纲缺失
    const service = new ChapterService(ps)
    // 不应抛错
    const meta = await service.updateMeta(projectId, 1, { title: '细纲缺失也能改' })
    expect(meta.title).toBe('细纲缺失也能改')

    // rhythmData 仍然更新了
    const rhythmText = await readFile(path.join(dir, '图解', '节奏图谱.html'), 'utf-8')
    expect(rhythmText).toContain("title: '细纲缺失也能改'")
  })

  it('treats empty string title as no-op (does not blank)', async () => {
    const service = new ChapterService(ps)
    // 空白标题应被拒绝 — 不能清空
    const meta = await service.updateMeta(projectId, 1, { title: '' })
    expect(meta.title).toBe('旧1')
  })

  it('whitespace-only title is rejected', async () => {
    const service = new ChapterService(ps)
    const meta = await service.updateMeta(projectId, 1, { title: '   ' })
    expect(meta.title).toBe('旧1')
  })

  it('clips excessively long title (>= 50 chars rejected, 21-49 ok)', async () => {
    const service = new ChapterService(ps)
    const tooLong = '一'.repeat(60)
    const meta = await service.updateMeta(projectId, 1, { title: tooLong })
    // 应拒绝过长标题，保持原值
    expect(meta.title).toBe('旧1')

    // 合理长度可写
    const ok = '一二三四五六七八九十十一十二十三十四十五十六十七十八十九二十'
    const meta2 = await service.updateMeta(projectId, 1, { title: ok })
    expect(meta2.title).toBe(ok)
  })

  it('non-title meta patches do not throw and return chapter meta', async () => {
    // status / synopsis / hook 的写盘暂留 Phase 3b（章节进度笔记真相源未落地）；
    // 这里只验证不抛错且返回最新 meta。
    const service = new ChapterService(ps)
    const meta = await service.updateMeta(projectId, 2, { status: 'reviewed' })
    expect(meta.chapterNumber).toBe(2)
    expect(meta.title).toBe('旧2')
  })

  it('title update does not touch other chapters', async () => {
    const service = new ChapterService(ps)
    await service.updateMeta(projectId, 2, { title: '只改2' })

    const rhythmText = await readFile(path.join(dir, '图解', '节奏图谱.html'), 'utf-8')
    expect(rhythmText).toContain("title: '旧1'")
    expect(rhythmText).toContain("title: '只改2'")
    expect(rhythmText).toContain("title: '旧3'")
  })
})