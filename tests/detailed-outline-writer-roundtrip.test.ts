import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DetailedOutlineWriter } from '../src/main/data/skill-format/detailed-outline-writer'
import { DetailedOutlineMdRepo } from '../src/main/data/skill-format/detailed-outline-md-repo'
import { ChapterRhythmWriter } from '../src/main/data/skill-format/chapter-rhythm-writer'

/**
 * 回归：细纲 round-trip 不得丢失引用块。
 *
 * 新格式细纲把 7 Gate 徽章、三处一致、**节奏对齐（情绪值/爽点类型）**、对标状态写在
 * `## 第 N 章` 之后的 `> ` 引用块里。DetailedOutlineWriter 早先按解析出的粗体字段重建
 * 整个 section body，引用块不是字段，于是每保存一次就被整块吞掉——而解析器恰恰只从
 * 引用块读情绪值，导致该章情绪/爽点静默丢失（真实案例：J:\book\团建翻船 第 1-4 章）。
 */
describe('细纲 round-trip 保留引用块', () => {
  let projectDir: string

  const chapterFile = `# 细纲_第005章_全员笑我傻，烟从沙子里冒

## 第 5 章：全员笑我傻，烟从沙子里冒

> 【7 Gate：A-G + Gate H 通过】二次加密·预算≥75%
> 三处一致：文件名 == 大纲标题列 == 本节标题
> 节奏对齐：情绪值 5、爽点类型 1（小打脸）｜所属卷：第 1 卷
> 对标状态：跳过

- **核心事件**：邱北试错取火多次失败被笑，最后冒烟。
- **字数目标**：3000 字
- **目标情绪**：笑 → 败 → 烟起
- **本章写作要求**：
  - 开头三段内抛出冲突
  - 结尾必须留钩子

## 内容概括（五段式）

- **起因**：全员在沙滩上等救援。
`

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'outline-roundtrip-'))
    mkdirSync(join(projectDir, '细纲'), { recursive: true })
    writeFileSync(
      join(projectDir, '细纲', '细纲_第005章_全员笑我傻，烟从沙子里冒.md'),
      chapterFile,
      'utf-8'
    )
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  const read = (): string =>
    readFileSync(join(projectDir, '细纲', '细纲_第005章_全员笑我傻，烟从沙子里冒.md'), 'utf-8')

  it('改写作要求后引用块四行仍在，情绪值不丢', async () => {
    await new DetailedOutlineWriter(projectDir).update(5, {
      writingRequirements: '开头强情绪\n结尾必须留钩子',
      writingRequirementTemplateId: 'tomato-high-tension'
    })

    const text = read()
    expect(text).toContain('> 【7 Gate：A-G + Gate H 通过】二次加密·预算≥75%')
    expect(text).toContain('> 三处一致：文件名 == 大纲标题列 == 本节标题')
    expect(text).toContain('> 节奏对齐：情绪值 5、爽点类型 1（小打脸）｜所属卷：第 1 卷')
    expect(text).toContain('> 对标状态：跳过')
    expect(text).toContain('- **写作要求模板**：tomato-high-tension')

    const [detail] = await new DetailedOutlineMdRepo(projectDir).listAll()
    expect(detail).toMatchObject({ chapterNumber: 5, emotion: 5, climax: 1 })
  })

  it('其余小节与未改字段原样保留', async () => {
    await new DetailedOutlineWriter(projectDir).update(5, { plotSummary: '改后的核心事件' })

    const text = read()
    expect(text).toContain('- **核心事件**：改后的核心事件')
    expect(text).toContain('- **字数目标**：3000 字')
    expect(text).toContain('- **目标情绪**：笑 → 败 → 烟起')
    expect(text).toContain('## 内容概括（五段式）')
    expect(text).toContain('- **起因**：全员在沙滩上等救援。')
    expect(text).toContain('  - 开头三段内抛出冲突')
  })

  it('未改动的字段整行原样保留，不抹掉键名后的括号注释', async () => {
    // 放宽字段正则后，`- **对标引用**（可选）：N/A` 能被解析成字段了；
    // 但规范化重写会把括号注释吞掉——那是 patch 之外的静默改动。
    const file = join(projectDir, '细纲', '细纲_第006章_括号注释.md')
    writeFileSync(
      file,
      '# 细纲_第006章_括号注释\n\n## 第 6 章：括号注释\n\n' +
        '- **节奏标注**（对齐节奏图谱）：\n  - 情绪值：6\n  - 爽点类型：1（小打脸）\n' +
        '- **核心事件**：原始事件。\n' +
        '- **对标引用**（可选）：N/A\n',
      'utf-8'
    )

    await new DetailedOutlineWriter(projectDir).update(6, { plotSummary: '改后的事件。' })

    const text = readFileSync(file, 'utf-8')
    expect(text).toContain('- **节奏标注**（对齐节奏图谱）：')
    expect(text).toContain('- **对标引用**（可选）：N/A')
    expect(text).toContain('- **核心事件**：改后的事件。')
    expect(text).not.toContain('原始事件')
  })

  it('连续保存不会堆积空行', async () => {
    const writer = new DetailedOutlineWriter(projectDir)
    await writer.update(5, { plotSummary: 'A' })
    const once = read()
    await writer.update(5, { plotSummary: 'B' })
    const twice = read()

    expect(twice.split('\n').length).toBe(once.split('\n').length)
  })

  it('改情绪值时就地改引用块，不另起 节奏标注 字段', async () => {
    await new DetailedOutlineWriter(projectDir).update(5, { emotion: 8, climax: 3 })

    const text = read()
    expect(text).toContain('> 节奏对齐：情绪值 8、爽点类型 3（大高潮）｜所属卷：第 1 卷')
    expect(text).not.toContain('**节奏标注**')

    const [detail] = await new DetailedOutlineMdRepo(projectDir).listAll()
    expect(detail).toMatchObject({ emotion: 8, climax: 3 })
  })

  it('没有引用块时仍回退到 节奏标注 字段', async () => {
    const plain = `# 细纲_第006章_旧格式

## 第 6 章：旧格式

- **核心事件**：旧格式没有引用块。
`
    writeFileSync(join(projectDir, '细纲', '细纲_第006章_旧格式.md'), plain, 'utf-8')

    await new DetailedOutlineWriter(projectDir).update(6, { emotion: 9, climax: 4 })

    const text = readFileSync(join(projectDir, '细纲', '细纲_第006章_旧格式.md'), 'utf-8')
    expect(text).toContain('- **节奏标注**：')
    expect(text).toContain('  - 情绪值：9')
    expect(text).toContain('  - 爽点类型：4（卷终决战）')
  })

  it('ChapterRhythmWriter 从节奏图谱改情绪值时同步引用块', async () => {
    mkdirSync(join(projectDir, '图解'), { recursive: true })
    writeFileSync(
      join(projectDir, '图解', '节奏图谱.html'),
      `<script>\nconst rhythmData = [\n  { chapter: 5, title: '全员笑我傻，烟从沙子里冒', emotion: 5, climax: 1, volume: 1, actualized: false }\n];\n</script>`,
      'utf-8'
    )

    await new ChapterRhythmWriter(projectDir).update(5, { emotion: 9, climax: 4 })

    expect(read()).toContain('> 节奏对齐：情绪值 9、爽点类型 4（卷终决战）｜所属卷：第 1 卷')

    const [detail] = await new DetailedOutlineMdRepo(projectDir).listAll()
    expect(detail).toMatchObject({ emotion: 9, climax: 4 })
  })
})
