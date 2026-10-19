import { createWritingProject } from './helpers/writing-project'
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
    projectId = (await createWritingProject(ps, { name: '青云志', genre: '玄幻' })).id
  })

  it('生成可读大纲并保留原稿备份，不改实际追踪或图谱', async () => {
    const dir = await ps.resolveDir(projectId)
    const old = await fs.readFile(path.join(dir, '大纲', '大纲.md'), 'utf-8')
    await fs.writeFile(path.join(dir, '图解', '节奏图谱.html'), '<script>const rhythmData = [];</script>')
    const rhythm = await fs.readFile(path.join(dir, '图解', '节奏图谱.html'), 'utf-8')
    const facts = await fs.readFile(path.join(dir, '追踪', '角色状态.md'), 'utf-8')
    const service = new OutlineService(ps, mockLlm('# 《青云志》大纲\n\n## 主线剧情走向\n\n林远寻找师父，用医术交换线索。'))
    const result = await service.generateMain(projectId)
    expect(result.synopsis).toContain('寻找师父')
    const backups = await fs.readdir(path.join(dir, '大纲', '_基线'))
    expect(await fs.readFile(path.join(dir, '大纲', '_基线', backups[0]), 'utf-8')).toBe(old)
    expect(await fs.readFile(path.join(dir, '图解', '节奏图谱.html'), 'utf-8')).toBe(rhythm)
    expect(await fs.readFile(path.join(dir, '追踪', '角色状态.md'), 'utf-8')).toBe(facts)
  })

  it('大纲返回无效时保留原文件', async () => {
    const dir = await ps.resolveDir(projectId)
    const old = await fs.readFile(path.join(dir, '大纲', '大纲.md'), 'utf-8')
    await expect(new OutlineService(ps, mockLlm('我会先分析一下')).generateMain(projectId)).rejects.toThrow('原文件未修改')
    expect(await fs.readFile(path.join(dir, '大纲', '大纲.md'), 'utf-8')).toBe(old)
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
    const fileContent = await fs.readFile(path.join(dir, '细纲', '细纲_第003章_林远觉醒.md'), 'utf-8')
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

    expect(await fs.readFile(path.join(dir, '细纲', '细纲_第004章_深山奇遇.md'), 'utf-8')).toContain('林远深入后山')
    expect(await fs.readFile(path.join(dir, '细纲', '细纲_第005章_初试身手.md'), 'utf-8')).toContain('一掌震退')
  })

  it('作品信息里新保存的脑洞进入细纲提示词，正式设定与卷级事件仍保留', async () => {
    const meta = await createWritingProject(ps, { name: '脑洞参考书', genre: '玄幻', description: '旧简介：寻找失散的师父' })
    const dir = await ps.resolveDir(meta.id)
    const coreSettings = '# 核心设定\n\n林远是药师，不能直接获得修仙功法。'
    const volumeOutline = '# 《脑洞参考书》大纲\n\n## 主线剧情走向\n\n第四章在深山救下白衣老者，老者不会在本卷死亡。'
    await fs.writeFile(path.join(dir, '设定', '核心设定.md'), coreSettings, 'utf-8')
    await fs.writeFile(path.join(dir, '大纲', '大纲.md'), volumeOutline, 'utf-8')
    const description = '新脑洞：每次救人都会听见患者尚未发生的遗言。'
    await ps.updateProjectInfo(meta.id, { name: '脑洞参考书', description })

    const llm = mockLlm(`=== 第4章 ===\n### 第 4 章：山中救人\n- **核心事件**：林远救下白衣老者，第一次听见遗言\n- **字数预估**：约 2500 字`)
    await new OutlineService(ps, llm).generateDetailedRange(meta.id, 4, 1)

    const prompt = vi.mocked(llm.generateStream).mock.calls[0][0]
    expect(prompt).toContain(description)
    expect(prompt).toContain(coreSettings)
    expect(prompt).toContain(volumeOutline)
    expect(prompt).toContain('最新作品简介（额外构思参考）')
    expect(prompt).toContain('存在冲突时遵循正式规划')
    const updatedDir = await ps.resolveDir(meta.id)
    expect(await fs.readFile(path.join(updatedDir, '设定', '核心设定.md'), 'utf-8')).toBe(coreSettings)
    expect(await fs.readFile(path.join(updatedDir, '大纲', '大纲.md'), 'utf-8')).toBe(volumeOutline)
  })
  it('保留完整情节点、预算、禁区，传入平台和只读事实', async () => {
    const dir = await ps.resolveDir(projectId)
    await fs.writeFile(path.join(dir, '设定', '平台配置.md'), '目标平台：七猫\n章名策略：具体清楚')
    await fs.writeFile(path.join(dir, '追踪', '角色状态.md'), '林远右手受伤，不能举刀。')
    const reply = '=== 第4章 ===\n## 第 4 章：借路\n- **核心事件**：林远向药商借路\n- **节奏标注**：\n  - 情绪值：5\n  - 爽点类型：0\n\n## 情节细化\n### 情节点序列\n1. 林远用药换过路资格【交锋·密，约400字】\n\n## 字数预算契约\n预算合计：400字，篇幅仅参考。\n\n## 写作禁区\n不能凭空痊愈。'
    const llm = mockLlm(reply)
    const service = new OutlineService(ps, llm)
    await service.generateDetailedRange(projectId, 4, 1)
    const raw = await service.getDetailedRaw(projectId, 4)
    expect(raw?.text).toContain('用药换过路资格')
    expect(raw?.text).toContain('## 字数预算契约')
    expect(raw?.text).toContain('不能凭空痊愈')
    expect((await service.listDetailed(projectId)).find(x => x.chapterNumber === 4)).toMatchObject({ emotion: 5, climax: 0 })
    const prompt = vi.mocked(llm.generateStream).mock.calls[0][0]
    expect(prompt).toContain('目标平台：七猫')
    expect(prompt).toContain('不能举刀')
    expect(prompt).not.toContain('番茄短快章名（仅项目明确采用此策略时）')
    expect(await fs.readFile(path.join(dir, '追踪', '角色状态.md'), 'utf8')).toBe('林远右手受伤，不能举刀。')
  })

  it.each(['=== 第4章 ===\n## 第 4 章：借路\n- **核心事件**：换路', '=== 第99章 ===\n## 第 99 章：越界\n- **核心事件**：越界'])('缺章或越界的整批结果不落盘', async reply => {
    const dir = await ps.resolveDir(projectId)
    const before = await fs.readdir(path.join(dir, '细纲'))
    await expect(new OutlineService(ps, mockLlm(reply)).generateDetailedRange(projectId, 4, 2)).rejects.toThrow('尚未保存')
    expect(await fs.readdir(path.join(dir, '细纲'))).toEqual(before)
  })

})
