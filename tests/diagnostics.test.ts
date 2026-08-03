import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DiagnosticsService } from '../src/main/data/diagnostics-service'
import type { ProjectService } from '../src/main/data/project-service'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'

const SAMPLE = 'O:/book/测试写作'
const HAS = existsSync(join(SAMPLE, '大纲', '大纲.md'))

/** 用 stub 的 projectService 让 resolveDir 指向给定目录 */
function serviceFor(dir: string): DiagnosticsService {
  const stub = { resolveDir: async () => dir } as unknown as ProjectService
  return new DiagnosticsService(stub)
}

describe('格式体检 DiagnosticsService', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'diag-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('健康样本（测试写作）应无告警', async () => {
    if (!HAS) return
    const report = await serviceFor(SAMPLE).report('x')
    expect(report).toEqual([])
  })

  it('角色目录无文件时不告警（新建项目正常）', async () => {
    mkdirSync(join(tmp, '设定', '角色'), { recursive: true })
    // 空目录：CharacterRepo 返回 0，但无文件含字段 -> 不告警
    const report = await serviceFor(tmp).report('x')
    const charWarn = report.find((d) => d.file.includes('设定/角色'))
    expect(charWarn).toBeUndefined()
  })

  it('伏笔表头缺关键词 -> 告警', async () => {
    mkdirSync(join(tmp, '追踪'), { recursive: true })
    writeFileSync(
      join(tmp, '追踪', '伏笔.md'),
      '# 伏笔追踪\n\n| 编号 | 描述 | 何时 |\n|---|---|---|\n| F1 | 婚戒 | 开头 |\n| F2 | 反噬 | 中段 |\n',
      'utf-8'
    )
    const report = await serviceFor(tmp).report('x')
    const fbWarn = report.find((d) => d.file.includes('伏笔.md'))
    expect(fbWarn).toBeDefined()
    expect(fbWarn!.message).toContain('0 条')
    expect(fbWarn!.hint).toContain('编号')
  })

  it('rhythmData 块存在但 entry 格式错 -> 告警', async () => {
    mkdirSync(join(tmp, '图解'), { recursive: true })
    writeFileSync(
      join(tmp, '图解', '节奏图谱.html'),
      '<html><script>const rhythmData = [{ chapter: 1, title: "双引号" }];</script></html>',
      'utf-8'
    )
    const report = await serviceFor(tmp).report('x')
    const rWarn = report.find((d) => d.file.includes('节奏图谱'))
    expect(rWarn).toBeDefined()
    expect(rWarn!.hint).toContain('单引号')
  })

  it('空骨架（app 新建项目）不误报', async () => {
    mkdirSync(join(tmp, '设定', '角色'), { recursive: true })
    mkdirSync(join(tmp, '追踪'), { recursive: true })
    writeFileSync(join(tmp, '设定', '角色', '空.md'), '# 空\n', 'utf-8')
    writeFileSync(join(tmp, '追踪', '伏笔.md'), '# 伏笔追踪\n', 'utf-8')
    const report = await serviceFor(tmp).report('x')
    expect(report).toEqual([])
  })
})

/**
 * 交叉一致性体检：三处（节奏图谱 / 细纲 / 正文）都能解析，但互相对不上。
 * 真实案例：J:\book\团建翻船 —— 批量写细纲的脚本把 300 章 actualized 刷成 true，
 * 而正文只写了 4 章；细纲 1-4 章被 app 保存时吞掉了引用块，情绪值静默回退图谱。
 */
describe('交叉一致性体检', () => {
  let tmp: string

  const rhythmHtml = (rows: string[]): string =>
    `<html><script>\nconst rhythmData = [\n${rows.join(',\n')}\n];\n</script></html>`

  const entry = (ch: number, e: number, c: number, actualized: boolean): string =>
    `  { chapter: ${ch}, title: '第${ch}章', emotion: ${e}, climax: ${c}, volume: 1, actualized: ${actualized} }`

  const detailed = (ch: number, e: number, c: number, withQuote = true): string =>
    `# 细纲_第${String(ch).padStart(3, '0')}章_第${ch}章\n\n## 第 ${ch} 章：第${ch}章\n\n` +
    (withQuote ? `> 节奏对齐：情绪值 ${e}、爽点类型 ${c}（小打脸）｜所属卷：第 1 卷\n\n` : '') +
    `- **核心事件**：略。\n`

  const writeRhythm = (rows: string[]): void => {
    mkdirSync(join(tmp, '图解'), { recursive: true })
    writeFileSync(join(tmp, '图解', '节奏图谱.html'), rhythmHtml(rows), 'utf-8')
  }
  const writeDetailed = (ch: number, e: number, c: number, withQuote = true): void => {
    mkdirSync(join(tmp, '细纲'), { recursive: true })
    writeFileSync(
      join(tmp, '细纲', `细纲_第${String(ch).padStart(3, '0')}章_第${ch}章.md`),
      detailed(ch, e, c, withQuote),
      'utf-8'
    )
  }
  const writeProse = (ch: number): void => {
    mkdirSync(join(tmp, '正文'), { recursive: true })
    writeFileSync(join(tmp, '正文', `第${String(ch).padStart(3, '0')}章 第${ch}章.md`), '正文内容\n', 'utf-8')
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'diag-consist-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('actualized 标了但没正文 -> 告警并给出章号', async () => {
    writeRhythm([entry(1, 5, 1, true), entry(2, 5, 1, true), entry(3, 5, 1, false)])
    writeProse(1)

    const report = await serviceFor(tmp).report('x')
    const warn = report.find((d) => d.message.includes('actualized=true'))
    expect(warn).toBeDefined()
    expect(warn!.severity).toBe('warn')
    expect(warn!.message).toContain('1 章标记为实际值')
    expect(warn!.message).toContain('2')
  })

  it('正文已成稿但仍是预测值 -> info 提示', async () => {
    writeRhythm([entry(1, 5, 1, false)])
    writeProse(1)

    const report = await serviceFor(tmp).report('x')
    const info = report.find((d) => d.message.includes('仍是预测值'))
    expect(info).toBeDefined()
    expect(info!.severity).toBe('info')
  })

  it('细纲丢了节奏对齐引用块 -> 告警静默回退', async () => {
    writeRhythm([entry(1, 5, 1, false), entry(2, 5, 1, false)])
    writeDetailed(1, 5, 1, true)
    writeDetailed(2, 5, 1, false)

    const report = await serviceFor(tmp).report('x')
    const warn = report.find((d) => d.message.includes('静默回退'))
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('1 章细纲读不到')
    expect(warn!.hint).toContain('节奏对齐')
  })

  it('细纲与节奏图谱数值打架 -> 告警', async () => {
    writeRhythm([entry(1, 8, 3, false)])
    writeDetailed(1, 5, 1)

    const report = await serviceFor(tmp).report('x')
    const warn = report.find((d) => d.message.includes('与节奏图谱不一致'))
    expect(warn).toBeDefined()
  })

  it('已回填章节的细纲(规划值) vs 图谱(实际值) 不算打架', async () => {
    writeRhythm([entry(1, 2.5, 1, true)])
    writeDetailed(1, 5, 1)
    writeProse(1)

    const report = await serviceFor(tmp).report('x')
    expect(report.find((d) => d.message.includes('与节奏图谱不一致'))).toBeUndefined()
  })

  it('三处一致时无告警', async () => {
    writeRhythm([entry(1, 5, 1, true), entry(2, 6, 2, false)])
    writeDetailed(1, 5, 1)
    writeDetailed(2, 6, 2)
    writeProse(1)

    const report = await serviceFor(tmp).report('x')
    expect(report).toEqual([])
  })

  it('还没建节奏图谱时不做一致性检查', async () => {
    writeDetailed(1, 5, 1)
    const report = await serviceFor(tmp).report('x')
    expect(report).toEqual([])
  })
})

/**
 * 「文件在那儿，但应用读不到」——命名不合约定导致的静默失效。
 * 真实案例：`恋综直播` 10 份 `卷纲_第一卷.md` 从没进过写作 prompt；
 * `师父的七个师姐` 3 章正文存成 .txt，应用里一章都看不到。
 */
describe('命名不合约定导致读不到', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'diag-naming-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('卷纲全叫 卷纲_第X卷.md -> 告警', async () => {
    mkdirSync(join(tmp, '大纲'), { recursive: true })
    writeFileSync(join(tmp, '大纲', '卷纲_第一卷.md'), '# 卷纲\n', 'utf-8')
    writeFileSync(join(tmp, '大纲', '卷纲_第二卷.md'), '# 卷纲\n', 'utf-8')

    const report = await serviceFor(tmp).report('x')
    const warn = report.find((d) => d.message.includes('卷纲'))
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('2 份')
    expect(warn!.hint).toContain('第N卷')
  })

  it('已有合规卷纲时不告警（新旧并存也算通过）', async () => {
    mkdirSync(join(tmp, '大纲'), { recursive: true })
    writeFileSync(join(tmp, '大纲', '第1卷_觉醒.md'), '# 卷纲\n', 'utf-8')
    writeFileSync(join(tmp, '大纲', '卷纲_第一卷.md'), '# 旧文件\n', 'utf-8')

    const report = await serviceFor(tmp).report('x')
    expect(report.find((d) => d.message.includes('卷纲'))).toBeUndefined()
  })

  it('大纲/ 下的旧版按卷细纲不会被当成卷纲', async () => {
    // 旧项目把按卷细纲放在 大纲/细纲_第01卷.md，文件名含「卷」但不是卷纲
    mkdirSync(join(tmp, '大纲'), { recursive: true })
    writeFileSync(join(tmp, '大纲', '细纲_第01卷.md'), '# 细纲\n', 'utf-8')
    writeFileSync(join(tmp, '大纲', '细纲_第02卷.md'), '# 细纲\n', 'utf-8')

    const report = await serviceFor(tmp).report('x')
    expect(report.find((d) => d.message.includes('卷纲'))).toBeUndefined()
  })

  it('大纲.md 本身不会被当成卷纲', async () => {
    mkdirSync(join(tmp, '大纲'), { recursive: true })
    writeFileSync(join(tmp, '大纲', '大纲.md'), '# 大纲\n', 'utf-8')

    const report = await serviceFor(tmp).report('x')
    expect(report.find((d) => d.message.includes('卷纲'))).toBeUndefined()
  })

  it('正文存成 .txt -> 告警', async () => {
    mkdirSync(join(tmp, '正文'), { recursive: true })
    writeFileSync(join(tmp, '正文', '第01章_奉命下山.txt'), '正文\n', 'utf-8')
    writeFileSync(join(tmp, '正文', '第002章 正常.md'), '正文\n', 'utf-8')

    const report = await serviceFor(tmp).report('x')
    const warn = report.find((d) => d.message.includes('.txt'))
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('1 章')
  })

  it('正文目录里的非章节 txt 不误报', async () => {
    mkdirSync(join(tmp, '正文'), { recursive: true })
    writeFileSync(join(tmp, '正文', '素材备忘.txt'), '随手记\n', 'utf-8')

    const report = await serviceFor(tmp).report('x')
    expect(report).toEqual([])
  })
})

/** 一键修复：只覆盖机械、确定的修复，且修完必须真正让对应告警消失 */
describe('一键修复 applyFix', () => {
  let tmp: string

  const rhythmHtml = (rows: string[]): string =>
    `<html><script>\nconst rhythmData = [\n${rows.join(',\n')}\n];\n</script></html>`
  const entry = (ch: number, e: number, c: number, actualized: boolean): string =>
    `  { chapter: ${ch}, title: '第${ch}章', emotion: ${e}, climax: ${c}, volume: 1, actualized: ${actualized} }`

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'diag-fix-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('reset-actualized：只改没有正文的章，已成稿的保持 true', async () => {
    mkdirSync(join(tmp, '图解'), { recursive: true })
    mkdirSync(join(tmp, '正文'), { recursive: true })
    writeFileSync(
      join(tmp, '图解', '节奏图谱.html'),
      rhythmHtml([entry(1, 5, 1, true), entry(2, 6, 2, true), entry(3, 7, 2, true)]),
      'utf-8'
    )
    writeFileSync(join(tmp, '正文', '第001章 已写.md'), '正文\n', 'utf-8')

    const service = serviceFor(tmp)
    const result = await service.applyFix('x', 'reset-actualized')
    expect(result.changed).toBe(2)

    const html = readFileSync(join(tmp, '图解', '节奏图谱.html'), 'utf-8')
    expect(html).toContain('chapter: 1')
    expect(html).toMatch(/chapter: 1[^}]*actualized: true/)
    expect(html).toMatch(/chapter: 2[^}]*actualized: false/)
    expect(html).toMatch(/chapter: 3[^}]*actualized: false/)
    // emotion/climax 不该被动过
    expect(html).toContain('emotion: 7')

    const report = await service.report('x')
    expect(report.find((d) => d.message.includes('actualized=true'))).toBeUndefined()
  })

  it('rename-volume-outlines：中文数字卷号也能改对，卷名保留', async () => {
    mkdirSync(join(tmp, '大纲'), { recursive: true })
    writeFileSync(join(tmp, '大纲', '卷纲_第一卷_觉醒.md'), '# 卷纲\n', 'utf-8')
    writeFileSync(join(tmp, '大纲', '卷纲_第02卷.md'), '# 卷纲：第二卷 破局（第31-60章）\n', 'utf-8')

    const service = serviceFor(tmp)
    const result = await service.applyFix('x', 'rename-volume-outlines')
    expect(result.changed).toBe(2)

    const files = readdirSync(join(tmp, '大纲'))
    expect(files).toContain('第1卷_觉醒.md')
    // 文件名里没有卷名时从 H1 提取
    expect(files).toContain('第2卷_破局.md')

    const report = await service.report('x')
    expect(report.find((d) => d.message.includes('卷纲'))).toBeUndefined()
  })

  it('rename-volume-outlines：H1 用「·」分隔时不把分隔符带进文件名', async () => {
    // 真实样本：`大小姐又买下了我的下家公司` 的 H1 是 `# 卷纲 · 第1卷 · 她买下了我住的整栋楼`
    mkdirSync(join(tmp, '大纲'), { recursive: true })
    writeFileSync(
      join(tmp, '大纲', '卷纲_第01卷.md'),
      '# 卷纲 · 第1卷 · 她买下了我住的整栋楼\n\n**版本**：v1.2\n',
      'utf-8'
    )
    writeFileSync(
      join(tmp, '大纲', '卷纲_第02卷.md'),
      '# 卷纲 第二卷：角落里的素人（第 31-60 章）\n',
      'utf-8'
    )

    const result = await serviceFor(tmp).applyFix('x', 'rename-volume-outlines')
    expect(result.changed).toBe(2)

    const files = readdirSync(join(tmp, '大纲'))
    expect(files).toContain('第1卷_她买下了我住的整栋楼.md')
    expect(files).toContain('第2卷_角落里的素人.md')
  })

  it('rename-volume-outlines：目标名已存在时跳过而不是覆盖', async () => {
    mkdirSync(join(tmp, '大纲'), { recursive: true })
    writeFileSync(join(tmp, '大纲', '第1卷_觉醒.md'), '新文件\n', 'utf-8')
    writeFileSync(join(tmp, '大纲', '卷纲_第一卷_觉醒.md'), '旧文件\n', 'utf-8')

    const result = await serviceFor(tmp).applyFix('x', 'rename-volume-outlines')
    expect(result.changed).toBe(0)
    expect(result.skipped?.[0]).toContain('已存在')
    expect(readFileSync(join(tmp, '大纲', '第1卷_觉醒.md'), 'utf-8')).toBe('新文件\n')
  })

  it('rename-prose-txt：改扩展名并补齐三位章号，内容不动', async () => {
    mkdirSync(join(tmp, '正文'), { recursive: true })
    writeFileSync(join(tmp, '正文', '第01章_奉命下山.txt'), '正文内容\n', 'utf-8')
    writeFileSync(join(tmp, '正文', '素材备忘.txt'), '不该动\n', 'utf-8')

    const result = await serviceFor(tmp).applyFix('x', 'rename-prose-txt')
    expect(result.changed).toBe(1)

    const files = readdirSync(join(tmp, '正文'))
    // 只改扩展名不够：ProseRepo 用 `第NNN章` 三位前缀找文件，两位章号会「列表有、内容空」
    expect(files).toContain('第001章_奉命下山.md')
    expect(files).toContain('素材备忘.txt')
    expect(readFileSync(join(tmp, '正文', '第001章_奉命下山.md'), 'utf-8')).toBe('正文内容\n')
  })

  it('rename-prose-txt：改完 ProseRepo 真能读到内容', async () => {
    mkdirSync(join(tmp, '正文'), { recursive: true })
    writeFileSync(join(tmp, '正文', '第01章_奉命下山.txt'), '正文内容一二三', 'utf-8')

    await serviceFor(tmp).applyFix('x', 'rename-prose-txt')

    const repo = new ProseRepo(tmp)
    expect(await repo.listChapterNumbers()).toEqual([1])
    expect(await repo.read(1)).toBe('正文内容一二三')
  })

  it('backfill-outline-rhythm：按节奏图谱补齐，补完告警消失', async () => {
    mkdirSync(join(tmp, '图解'), { recursive: true })
    mkdirSync(join(tmp, '细纲'), { recursive: true })
    writeFileSync(
      join(tmp, '图解', '节奏图谱.html'),
      rhythmHtml([entry(1, 8, 3, false), entry(2, 5, 1, false)]),
      'utf-8'
    )
    writeFileSync(
      join(tmp, '细纲', '细纲_第001章_无节奏.md'),
      '# 细纲_第001章_无节奏\n\n## 第 1 章：无节奏\n\n- **核心事件**：略。\n',
      'utf-8'
    )
    writeFileSync(
      join(tmp, '细纲', '细纲_第002章_有节奏.md'),
      '# 细纲_第002章_有节奏\n\n## 第 2 章：有节奏\n\n> 节奏对齐：情绪值 5、爽点类型 1（小打脸）\n\n- **核心事件**：略。\n',
      'utf-8'
    )

    const service = serviceFor(tmp)
    const result = await service.applyFix('x', 'backfill-outline-rhythm')
    expect(result.changed).toBe(1)

    const text = readFileSync(join(tmp, '细纲', '细纲_第001章_无节奏.md'), 'utf-8')
    expect(text).toContain('- **节奏标注**：')
    expect(text).toContain('  - 情绪值：8')
    expect(text).toContain('  - 爽点类型：3（大高潮）')
    expect(text).toContain('- **核心事件**：略。')

    // 已有节奏的那章不该被动过
    expect(readFileSync(join(tmp, '细纲', '细纲_第002章_有节奏.md'), 'utf-8')).toContain(
      '> 节奏对齐：情绪值 5、爽点类型 1（小打脸）'
    )

    const report = await service.report('x')
    expect(report.find((d) => d.message.includes('静默回退'))).toBeUndefined()
  })

  it('数值打架的体检项带逐章明细和两个方向的按钮', async () => {
    mkdirSync(join(tmp, '图解'), { recursive: true })
    mkdirSync(join(tmp, '细纲'), { recursive: true })
    writeFileSync(join(tmp, '图解', '节奏图谱.html'), rhythmHtml([entry(1, 7, 2, false)]), 'utf-8')
    writeFileSync(
      join(tmp, '细纲', '细纲_第001章_打架.md'),
      '# 细纲_第001章_打架\n\n## 第 1 章：打架\n\n> 节奏对齐：情绪值 8、爽点类型 3（大高潮）\n\n- **核心事件**：略。\n',
      'utf-8'
    )

    const report = await serviceFor(tmp).report('x')
    const warn = report.find((d) => d.message.includes('与节奏图谱不一致'))
    expect(warn).toBeDefined()
    expect(warn!.details?.[0]).toBe('第 1 章：细纲 情绪8/爽点3 ↔ 图谱 情绪7/爽点2')
    expect(warn!.fixes?.map((f) => f.kind)).toEqual([
      'align-outline-to-rhythm',
      'align-rhythm-to-outline'
    ])
  })

  it('align-outline-to-rhythm：改细纲，图谱不动', async () => {
    mkdirSync(join(tmp, '图解'), { recursive: true })
    mkdirSync(join(tmp, '细纲'), { recursive: true })
    writeFileSync(join(tmp, '图解', '节奏图谱.html'), rhythmHtml([entry(1, 7, 2, false)]), 'utf-8')
    writeFileSync(
      join(tmp, '细纲', '细纲_第001章_打架.md'),
      '# 细纲_第001章_打架\n\n## 第 1 章：打架\n\n> 节奏对齐：情绪值 8、爽点类型 3（大高潮）\n\n- **核心事件**：略。\n',
      'utf-8'
    )

    const service = serviceFor(tmp)
    const result = await service.applyFix('x', 'align-outline-to-rhythm')
    expect(result.changed).toBe(1)

    expect(readFileSync(join(tmp, '细纲', '细纲_第001章_打架.md'), 'utf-8')).toContain(
      '> 节奏对齐：情绪值 7、爽点类型 2（中打脸）'
    )
    // 图谱保持原值
    expect(readFileSync(join(tmp, '图解', '节奏图谱.html'), 'utf-8')).toMatch(/emotion: 7/)

    expect((await service.report('x')).find((d) => d.message.includes('与节奏图谱不一致'))).toBeUndefined()
  })

  it('align-rhythm-to-outline：改图谱，并同步大纲逐章表', async () => {
    mkdirSync(join(tmp, '图解'), { recursive: true })
    mkdirSync(join(tmp, '细纲'), { recursive: true })
    mkdirSync(join(tmp, '大纲'), { recursive: true })
    writeFileSync(join(tmp, '图解', '节奏图谱.html'), rhythmHtml([entry(1, 7, 2, false)]), 'utf-8')
    writeFileSync(
      join(tmp, '细纲', '细纲_第001章_打架.md'),
      '# 细纲_第001章_打架\n\n## 第 1 章：打架\n\n> 节奏对齐：情绪值 8、爽点类型 3（大高潮）\n\n- **核心事件**：略。\n',
      'utf-8'
    )
    writeFileSync(
      join(tmp, '大纲', '大纲.md'),
      '# 大纲\n\n## 逐章节奏标注\n\n### 第一卷\n\n| 章节 | 标题 | 情绪值 | 爽点类型 | 卷 |\n|---|---|---|---|---|\n| 第 1 章 | 打架 | 7 | 2 | 1 |\n',
      'utf-8'
    )

    const service = serviceFor(tmp)
    const result = await service.applyFix('x', 'align-rhythm-to-outline')
    expect(result.changed).toBe(1)

    const html = readFileSync(join(tmp, '图解', '节奏图谱.html'), 'utf-8')
    expect(html).toMatch(/emotion: 8/)
    expect(html).toMatch(/climax: 3/)
    // 大纲表跟着改，避免只改一处又跑偏
    expect(readFileSync(join(tmp, '大纲', '大纲.md'), 'utf-8')).toContain('| 第 1 章 | 打架 | 8 | 3 | 1 |')

    expect((await service.report('x')).find((d) => d.message.includes('与节奏图谱不一致'))).toBeUndefined()
  })

  it('已回填章节不会被当成打架而误改', async () => {
    mkdirSync(join(tmp, '图解'), { recursive: true })
    mkdirSync(join(tmp, '细纲'), { recursive: true })
    mkdirSync(join(tmp, '正文'), { recursive: true })
    // 图谱是成稿实际值 2.5，细纲是规划值 5，两者本就该不同
    writeFileSync(join(tmp, '图解', '节奏图谱.html'), rhythmHtml([entry(1, 2.5, 1, true)]), 'utf-8')
    writeFileSync(
      join(tmp, '细纲', '细纲_第001章_已写.md'),
      '# 细纲_第001章_已写\n\n## 第 1 章：已写\n\n> 节奏对齐：情绪值 5、爽点类型 1（小打脸）\n\n- **核心事件**：略。\n',
      'utf-8'
    )
    writeFileSync(join(tmp, '正文', '第001章 已写.md'), '正文\n', 'utf-8')

    const result = await serviceFor(tmp).applyFix('x', 'align-outline-to-rhythm')
    expect(result.changed).toBe(0)
    expect(readFileSync(join(tmp, '细纲', '细纲_第001章_已写.md'), 'utf-8')).toContain('情绪值 5')
  })

  it('未知修复类型直接报错', async () => {
    await expect(
      serviceFor(tmp).applyFix('x', 'nope' as never)
    ).rejects.toThrow('未知的修复类型')
  })
})
