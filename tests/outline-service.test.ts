import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { OutlineService } from '../src/main/data/outline-service'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

function mockLlm(reply: string): LlmService {
  return { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
}

const mockSettings = { getProjectsRoot: async (fallback: string) => fallback } as unknown as SettingsRepository

describe('OutlineService', () => {
  let root: string
  let projectId: string
  let ps: ProjectService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-ols-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '青云志', genre: '玄幻' })).id
  })

  it('generateMain is not implemented in the current phase', async () => {
    const service = new OutlineService(ps, mockLlm('这是一个关于少年的修仙故事。'))
    await expect(service.generateMain(projectId)).rejects.toThrow(/Phase 3b/)
  })

  it('成功生成单章细纲并落盘回写', async () => {
    const dir = await ps.resolveDir(projectId)
    await fs.mkdir(path.join(dir, '设定'), { recursive: true })
    await fs.writeFile(path.join(dir, '设定', '核心设定.md'), '核心设定内容', 'utf-8')

    const llmReply = `=== 第3章 ===
### 第 3 章：林远觉醒
- **核心事件**：林远意外觉醒了神秘武魂
- **爽点/打脸**：当众展示实力痛击反派
- **字数预估**：约 3000 字
- **金句**：「三十年河东，三十年河西。」`

    const service = new OutlineService(ps, mockLlm(llmReply))
    const res = await service.generateDetailed(projectId, 3)

    expect(res.chapterNumber).toBe(3)
    expect(res.title).toBe('林远觉醒')
    expect(res.plotSummary).toBe('林远意外觉醒了神秘武魂')
    expect(res.coolPoint).toBe('当众展示实力痛击反派')
    expect(res.wordEstimate).toBe('约 3000 字')
    expect(res.goldenLine).toBe('「三十年河东，三十年河西。」')

    // 校验文件写入
    const fileContent = await fs.readFile(path.join(dir, '细纲', '第01卷.md'), 'utf-8')
    expect(fileContent).toContain('## 第 3 章：林远觉醒')
    expect(fileContent).toContain('- **核心事件**：林远意外觉醒了神秘武魂')
  })

  it('批量生成多章细纲并回写', async () => {
    const dir = await ps.resolveDir(projectId)
    await fs.mkdir(path.join(dir, '设定'), { recursive: true })
    await fs.writeFile(path.join(dir, '设定', '核心设定.md'), '核心设定内容', 'utf-8')

    const llmReply = `=== 第4章 ===
### 第 4 章：深山奇遇
- **核心事件**：林远深入后山采药，偶遇重伤的白衣老者
- **爽点**：获得无上功法传承
- **字数预估**：约 3000 字

=== 第5章 ===
### 第 5 章：初试身手
- **核心事件**：林远回到家族初试刚学成的武技
- **爽点**：一掌震退挑衅的族兄
- **字数预估**：约 2800 字`

    const service = new OutlineService(ps, mockLlm(llmReply))
    const resList = await service.generateDetailedRange(projectId, 4, 2)

    expect(resList).toHaveLength(2)
    expect(resList[0].chapterNumber).toBe(4)
    expect(resList[0].title).toBe('深山奇遇')
    expect(resList[1].chapterNumber).toBe(5)
    expect(resList[1].title).toBe('初试身手')

    const fileContent = await fs.readFile(path.join(dir, '细纲', '第01卷.md'), 'utf-8')
    expect(fileContent).toContain('## 第 4 章：深山奇遇')
    expect(fileContent).toContain('## 第 5 章：初试身手')
  })
})
