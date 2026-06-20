import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'path'
import { FigureService } from '../src/main/data/figure-service'
import type { ProjectService } from '../src/main/data/project-service'

const SAMPLE = 'O:/book/测试写作'
const HAS = existsSync(join(SAMPLE, '图解', '第2章-破窗救美.html'))
const describeIf = HAS ? describe : describe.skip

function serviceFor(dir: string): FigureService {
  const stub = { resolveDir: async () => dir } as unknown as ProjectService
  return new FigureService(stub)
}

describeIf('FigureService 关键情节图解', () => {
  it('list 发现所有 第N章-*.html（排除节奏图谱）', async () => {
    const list = await serviceFor(SAMPLE).list('x')
    expect(list.length).toBeGreaterThanOrEqual(2)
    const ch2 = list.find((f) => f.chapterNumber === 2)
    expect(ch2).toBeDefined()
    expect(ch2!.fileName).toContain('破窗救美')
    // 不含节奏图谱
    expect(list.find((f) => f.fileName.includes('节奏图谱'))).toBeUndefined()
  })

  it('read 解析章节、标题、各结构化节', async () => {
    const fig = await serviceFor(SAMPLE).read('x', '第2章-破窗救美.html')
    expect(fig).not.toBeNull()
    expect(fig!.chapterNumber).toBe(2)
    expect(fig!.title).toContain('破窗救美')
    // 应含前因/转折过程/后果/角色状态/爽点 等节
    const names = fig!.sections.map((s) => s.name)
    expect(names).toContain('前因')
    expect(names).toContain('后果')
    expect(names.some((n) => n.includes('爽点'))).toBe(true)
  })

  it('read 提取 Mermaid 源码', async () => {
    const fig = await serviceFor(SAMPLE).read('x', '第2章-破窗救美.html')
    const mermaidSection = fig!.sections.find((s) => s.kind === 'mermaid')
    expect(mermaidSection).toBeDefined()
    expect(mermaidSection!.mermaid).toContain('graph TD')
  })

  it('read 角色状态变化为表格', async () => {
    const fig = await serviceFor(SAMPLE).read('x', '第2章-破窗救美.html')
    const tableSection = fig!.sections.find((s) => s.kind === 'table')
    expect(tableSection).toBeDefined()
    expect(tableSection!.rows!.length).toBeGreaterThanOrEqual(2)
    // 首行是表头（角色/转折前/转折后），苏铭在数据行
    expect(tableSection!.rows![0].join('|')).toBe('角色|转折前|转折后')
    const dataText = tableSection!.rows!.slice(1).flat().join('|')
    expect(dataText).toContain('苏铭')
    expect(dataText).toContain('徐昭昭')
  })
})
