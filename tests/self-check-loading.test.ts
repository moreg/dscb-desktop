import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { WriteService } from '../src/main/data/write-service'
import type { ProjectService } from '../src/main/data/project-service'
import type { LlmService } from '../src/main/data/llm-service'
import { OutlineRepository } from '../src/main/data/outline-repository'
import { DetailedOutlineMdRepo } from '../src/main/data/skill-format/detailed-outline-md-repo'
import * as selfCheck from '../src/main/data/chapter-self-check'

describe('自检按章加载与完整卷纲禁抢写提示', () => {
  let projectDir: string
  let service: WriteService

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(join(tmpdir(), 'wdesk-self-check-loading-'))
    const projects = { resolveDir: vi.fn().mockResolvedValue(projectDir) } as unknown as ProjectService
    service = new WriteService(projects, {} as LlmService)
    await fs.mkdir(join(projectDir, '细纲'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    const target = resolve(projectDir)
    expect(dirname(target)).toBe(resolve(tmpdir()))
    expect(basename(target).startsWith('wdesk-self-check-loading-')).toBe(true)
    await fs.rm(target, { recursive: true, force: true })
  })

  it('自检读取本章字段不调用全量细纲，并保留 JSON 旧数据回退', async () => {
    await fs.writeFile(join(projectDir, '细纲', '细纲_第001章_试火.md'), '# 细纲_第001章_试火.md\n\n## 第 1 章：试火\n- **核心事件**：邱北点燃湿柴\n- **章末钩子**：天边升起黑烟\n- **字数预估**：3000 字以内\n')
    const listAll = vi.spyOn(DetailedOutlineMdRepo.prototype, 'listAll')
    const evaluate = vi.spyOn(selfCheck, 'evaluateChapterSelfCheck')
    await service.selfCheckChapter('project', 1, '邱北点燃了湿柴。')
    expect(listAll).not.toHaveBeenCalled()
    expect(evaluate).toHaveBeenLastCalledWith(expect.objectContaining({ plotSummary: '邱北点燃湿柴', hook: '天边升起黑烟', targetWords: 3000, targetBound: 'about' }))
    await new OutlineRepository(projectDir).upsertDetailed({ chapterNumber: 2, plotSummary: '旧数据核心事件', wordEstimate: '2500 字' })
    await service.selfCheckChapter('project', 2, '正文')
    expect(evaluate).toHaveBeenLastCalledWith(expect.objectContaining({ plotSummary: '旧数据核心事件', targetWords: 2500 }))
    expect(listAll).not.toHaveBeenCalled()
  })

  it('超过 8 条的后续章节提示全部进入算法，长提示保留后半段事件', async () => {
    await fs.mkdir(join(projectDir, '大纲'))
    await fs.writeFile(join(projectDir, '大纲', '大纲.md'), '# 大纲\n\n## 主线剧情走向\n\n### 第1卷：荒岛（第1-20章）\n寻找生路。\n')
    const longHint = `第 12 章：${'一行较长的背景描述。'.repeat(15)}最终夺取灯塔钥匙。`
    const hints = [...Array.from({ length: 10 }, (_, index) => `第 ${index + 2} 章：事件${index + 2}`), longHint]
    await fs.writeFile(join(projectDir, '大纲', '第1卷_荒岛.md'), `# 卷纲：第1卷 荒岛（第1-20章）\n\n## 各章安排\n\n- 第 1 章：当前事件\n${hints.map((hint) => `- ${hint}`).join('\n')}\n`)
    const evaluate = vi.spyOn(selfCheck, 'evaluateChapterSelfCheck')
    await service.selfCheckChapter('project', 1, '邱北点燃了湿柴。')
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ doNotAdvanceHints: hints }))
  })
})
