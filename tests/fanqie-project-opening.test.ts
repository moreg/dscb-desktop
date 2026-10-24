import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { fanqieIdeaProjectDraft } from '../src/shared/fanqie-project'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { OutlineService } from '../src/main/data/outline-service'
import type { FanqieChartIdea } from '../src/shared/fanqie-chart'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { LlmService } from '../src/main/data/llm-service'

const idea: FanqieChartIdea = {
  title: '契约店主', titleCandidates: [], strategy: 'fusion', genre: '都市', hookLine: '店主撕掉一张契约',
  goldenFinger: '债务可以转换为能力', fusion: '', coreConcept: '店主以契约反制债主', sellingPoint: '主动反击',
  protagonist: '陈言是店主', openingHook: '债主堵门', marketReasoning: '', readerFit: '', riskNotes: '', trendBasis: [],
  powerSystem: '所有已得能力保留；契约不能凭空变成万能传送门。',
  pacingPlan: '后段必须在最终障碍尚未解决时冻结既得资产，并核查正常交流与已有队伍。',
  openingChapters: [1, 2, 3].map(chapter => ({ chapter: chapter as 1 | 2 | 3, openingEvent: `独立方向${chapter}：债主堵门`,
    protagonistAction: '陈言更改契约', conflict: '债主索取店铺', payoff: '保住店铺', endHook: '更强债主到来', summaryApplication: '先主动行动再兑现回报' }))
}

describe('番茄脑洞转项目携带三章方向', () => {
  it('独立保存方向，修改简介和重启后保留，按章号进入细纲提示词', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fanqie-project-'))
    try {
      const library = new LibraryRepository(path.join(root, 'library.json'))
      const settings = { getProjectsRoot: async (fallback: string) => fallback } as unknown as SettingsRepository
      const projects = new ProjectService(path.join(root, 'projects'), library, settings)
      const draft = fanqieIdeaProjectDraft(idea)
      expect(draft.ideaDevelopment).toContain(idea.pacingPlan)
      expect(draft.ideaDevelopment).toContain(idea.powerSystem)
      expect(draft.openingChapters).not.toBe(idea.openingChapters)
      expect(draft.description).toContain(idea.goldenFinger)
      const project = await projects.create(draft)
      expect(path.basename(project.path)).toBe(idea.title)
      await projects.updateProjectInfo(project.id, { name: '新书名', description: '修改后的简介' })
      const reopened = new ProjectService(path.join(root, 'projects'), library, settings)
      expect((await reopened.getProjectData(project.id)).openingChapters).toEqual(idea.openingChapters)
      expect((await reopened.getProjectData(project.id)).ideaDevelopment).toBe(draft.ideaDevelopment)
      const dir = await reopened.resolveDir(project.id)
      for (const folder of ['设定', '大纲']) await mkdir(path.join(dir, folder), { recursive: true })
      await writeFile(path.join(dir, '设定', '核心设定.md'), '# 核心设定\n陈言是店主。')
      await writeFile(path.join(dir, '大纲', '大纲.md'), '# 《新书名》大纲\n陈言以契约对抗债主。')
      const generateStream = vi.fn(async () => '=== 第2章 ===\n## 第 2 章：债主登门\n- **核心事件**：陈言反击债主\n- **字数预估**：约 2500 字\n=== 第3章 ===\n## 第 3 章：契约反击\n- **核心事件**：陈言兑现契约\n- **字数预估**：约 2500 字')
      const outline = new OutlineService(reopened, { generateStream } as unknown as LlmService)
      await outline.generateDetailedRange(project.id, 2, 2)
      const prompt = generateStream.mock.calls[0] as unknown as [string]
      expect(prompt[0]).toContain('独立方向2')
      expect(prompt[0]).toContain('独立方向3')
      expect(prompt[0]).not.toContain('独立方向1')
      expect(prompt[0]).toContain('修改后的简介')
      expect(prompt[0]).toContain('存在冲突时遵循正式核心设定与大纲')
      generateStream.mockResolvedValue('=== 第4章 ===\n## 第 4 章：店铺风波\n- **核心事件**：陈言继续经营\n- **字数预估**：约 2500 字')
      await outline.generateDetailedRange(project.id, 4, 1)
      const laterPrompt = generateStream.mock.calls[1] as unknown as [string]
      expect(laterPrompt[0]).not.toContain('已采用脑洞的前三章写作方向')
      expect(laterPrompt[0]).toContain(idea.pacingPlan)
      expect(laterPrompt[0]).toContain('已采用脑洞的来源机制与长篇展开')
      expect(fanqieIdeaProjectDraft({ ...idea, openingChapters: undefined }).openingChapters).toBeUndefined()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
