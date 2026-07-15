import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DiagnosticsService } from '../src/main/data/diagnostics-service'
import type { ProjectService } from '../src/main/data/project-service'

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
