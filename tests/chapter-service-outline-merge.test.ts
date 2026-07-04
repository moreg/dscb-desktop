import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
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
 * 章节列表合并细纲字段测试。
 *
 * 验证修复：在「大纲」页改细纲后，章节列表立即反映最新值。
 * listChapters / getChapter 应以细纲为 title/emotion/climax/synopsis(核心事件)/
 * appearingCharacters 的真相源，细纲为空才回退节奏图谱/章节进度笔记。
 */
describe('ChapterService outline merge', () => {
  let root: string
  let projectId: string
  let ps: ProjectService
  let dir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-merge-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '合并测试', genre: '玄幻' })).id
    dir = await ps.resolveDir(projectId)

    // 节奏图谱 html：chapter 1（旧标题/旧情绪）+ chapter 2
    await mkdir(path.join(dir, '图解'), { recursive: true })
    await writeFile(
      path.join(dir, '图解', '节奏图谱.html'),
      `<script>\nconst rhythmData = [\n` +
        `  { chapter: 1, title: '旧标题', emotion: 3, climax: 1, volume: 1, actualized: false },\n` +
        `  { chapter: 2, title: '第二章', emotion: 5, climax: 2, volume: 1, actualized: false }\n` +
        `];\n</script>`,
      'utf-8'
    )

    // 章节进度笔记：chapter 1 有旧备注 + 字数
    await mkdir(path.join(dir, '记忆系统'), { recursive: true })
    await writeFile(
      path.join(dir, '记忆系统', '章节进度.md'),
      '# 章节进度\n\n## 第 1 卷\n\n' +
        '| 章节 | 标题 | 状态 | 字数 | 备注 |\n' +
        '| --- | --- | --- | --- | --- |\n' +
        '| 第 1 章 | 旧标题 | 草稿 | 1000 | 旧备注 |\n',
      'utf-8'
    )

    // 角色卡：苏九（主角）、老吴（核心配角）
    await writeFile(
      path.join(dir, '记忆系统', '角色卡.md'),
      '# 角色卡\n\n## 主角\n\n### 苏九（男主）\n- **身份**：少年\n\n## 核心配角\n\n### 老吴\n- **身份**：掌柜\n',
      'utf-8'
    )
  })

  it('listChapters 用细纲 title/emotion/climax 覆盖节奏图谱旧值', async () => {
    // 细纲：chapter 1 新标题/新情绪，chapter 2 无细纲（回退节奏图谱）
    await mkdir(path.join(dir, '细纲'), { recursive: true })
    await writeFile(
      path.join(dir, '细纲', '第01卷.md'),
      '# 第 01 卷细纲\n\n' +
        '## 第 1 章：破窗\n' +
        '- **核心事件**：苏九破窗逃出\n' +
        '- **爽点**：打脸\n' +
        '- **章末钩子**：窗外有人\n' +
        '- **节奏标注**：\n' +
        '  - 情绪值：8\n' +
        '  - 爽点类型：3\n' +
        '- **出场顺序**：\n' +
        '  1. 苏九（主角）\n' +
        '  2. 老吴（配角）\n',
      'utf-8'
    )

    const service = new ChapterService(ps)
    const list = await service.listChapters(projectId)
    const ch1 = list.find((c) => c.chapterNumber === 1)!
    const ch2 = list.find((c) => c.chapterNumber === 2)!

    // chapter 1：细纲优先
    expect(ch1.title).toBe('破窗')
    expect(ch1.emotion).toBe(8)
    expect(ch1.climax).toBe(3)
    // chapter 2：无细纲，回退节奏图谱
    expect(ch2.title).toBe('第二章')
    expect(ch2.emotion).toBe(5)
    expect(ch2.climax).toBe(2)
  })

  it('listChapters synopsis 来自细纲核心事件(plotSummary)，细纲为空回退章节进度笔记', async () => {
    await mkdir(path.join(dir, '细纲'), { recursive: true })
    await writeFile(
      path.join(dir, '细纲', '第01卷.md'),
      '# 第 01 卷细纲\n\n' +
        '## 第 1 章：破窗\n' +
        '- **核心事件**：苏九破窗逃出\n' +
        '- **出场顺序**：\n' +
        '  1. 苏九（主角）\n',
      'utf-8'
    )

    const service = new ChapterService(ps)
    const list = await service.listChapters(projectId)
    const ch1 = list.find((c) => c.chapterNumber === 1)!

    // 细纲核心事件覆盖章节进度笔记的「旧备注」
    expect(ch1.synopsis).toBe('苏九破窗逃出')
  })

  it('listChapters 无细纲时 synopsis 回退章节进度笔记', async () => {
    // 不创建细纲文件
    const service = new ChapterService(ps)
    const list = await service.listChapters(projectId)
    const ch1 = list.find((c) => c.chapterNumber === 1)!
    expect(ch1.synopsis).toBe('旧备注')
  })

  it('listChapters appearingCharacters 把细纲角色名映射成角色卡 id', async () => {
    await mkdir(path.join(dir, '细纲'), { recursive: true })
    await writeFile(
      path.join(dir, '细纲', '第01卷.md'),
      '# 第 01 卷细纲\n\n' +
        '## 第 1 章：破窗\n' +
        '- **核心事件**：苏九破窗\n' +
        '- **出场顺序**：\n' +
        '  1. 苏九（主角）\n' +
        '  2. 老吴（配角）\n' +
        '  3. 路人甲（无角色卡）\n',
      'utf-8'
    )

    const service = new ChapterService(ps)
    const list = await service.listChapters(projectId)
    const ch1 = list.find((c) => c.chapterNumber === 1)!

    // 苏九、老吴 能匹配角色卡 → 转成 id；路人甲无角色卡 → 跳过
    expect(ch1.appearingCharacters).toBeDefined()
    expect(ch1.appearingCharacters!.length).toBe(2)
    // id 是由姓名确定性 hash 生成的，这里只验证 id 非空且与角色卡一致
    const { CharacterCardMdRepo } = await import(
      '../src/main/data/skill-format/character-card-md-repo'
    )
    const chars = await new CharacterCardMdRepo(dir).list()
    const suId = chars.find((c) => c.name === '苏九')!.id
    const wuId = chars.find((c) => c.name === '老吴')!.id
    expect(ch1.appearingCharacters).toContain(suId)
    expect(ch1.appearingCharacters).toContain(wuId)
    expect(ch1.appearingCharacters).not.toContain('路人甲')
  })

  it('listChapters 细纲无出场顺序时 appearingCharacters 为 undefined', async () => {
    await mkdir(path.join(dir, '细纲'), { recursive: true })
    await writeFile(
      path.join(dir, '细纲', '第01卷.md'),
      '# 第 01 卷细纲\n\n## 第 1 章：破窗\n- **核心事件**：苏九破窗\n',
      'utf-8'
    )

    const service = new ChapterService(ps)
    const list = await service.listChapters(projectId)
    const ch1 = list.find((c) => c.chapterNumber === 1)!
    expect(ch1.appearingCharacters).toBeUndefined()
  })

  it('getChapter 同步合并细纲字段（编辑器打开单章也用细纲最新值）', async () => {
    await mkdir(path.join(dir, '细纲'), { recursive: true })
    await writeFile(
      path.join(dir, '细纲', '第01卷.md'),
      '# 第 01 卷细纲\n\n' +
        '## 第 1 章：破窗\n' +
        '- **核心事件**：苏九破窗逃出\n' +
        '- **节奏标注**：\n' +
        '  - 情绪值：8\n' +
        '  - 爽点类型：3\n' +
        '- **出场顺序**：\n' +
        '  1. 苏九（主角）\n',
      'utf-8'
    )

    const service = new ChapterService(ps)
    const { meta } = await service.getChapter(projectId, 1)
    expect(meta.title).toBe('破窗')
    expect(meta.emotion).toBe(8)
    expect(meta.climax).toBe(3)
    expect(meta.synopsis).toBe('苏九破窗逃出')
    expect(meta.appearingCharacters).toBeDefined()
    expect(meta.appearingCharacters!.length).toBe(1)
  })

  it('改细纲后 listChapters 反映最新值（端到端：编辑细纲→列表刷新）', async () => {
    await mkdir(path.join(dir, '细纲'), { recursive: true })
    const detailFile = path.join(dir, '细纲', '第01卷.md')

    // 第一版细纲
    await writeFile(
      detailFile,
      '# 第 01 卷细纲\n\n## 第 1 章：原标题\n- **核心事件**：原事件\n',
      'utf-8'
    )
    const service = new ChapterService(ps)
    let list = await service.listChapters(projectId)
    let ch1 = list.find((c) => c.chapterNumber === 1)!
    expect(ch1.title).toBe('原标题')
    expect(ch1.synopsis).toBe('原事件')

    // 用户在「大纲」页改了细纲（模拟 outline:updateDetailed 只写细纲文件）
    await writeFile(
      detailFile,
      '# 第 01 卷细纲\n\n## 第 1 章：新标题\n- **核心事件**：新事件\n',
      'utf-8'
    )
    list = await service.listChapters(projectId)
    ch1 = list.find((c) => c.chapterNumber === 1)!
    expect(ch1.title).toBe('新标题')
    expect(ch1.synopsis).toBe('新事件')
  })
})
