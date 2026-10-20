import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WriteService } from '../src/main/data/write-service'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { readLongformPlan } from '../src/main/data/longform-plan'
import { createWritingProject } from './helpers/writing-project'
import { acceptedDeslop } from './helpers/accepted-deslop'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { ChapterFlowResult } from '../src/shared/types'

const goal = '陆安全书目标是找到失踪母亲，不会永久放弃寻找。'
const content = '陆安宣布永久放弃寻找母亲，从此只在街边卖画谋生。'
const clear = JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread'], findings: [] })
const conflict = JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread'], findings: [
  { kind: 'mainline', message: '主角无转变过程直接永久放弃全书目标。', snippet: content, reference: goal }
] })

describe('续写与连续批次的长篇约束', () => {
  let root: string, dir: string, id: string, service: WriteService
  let generate: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'longform-writing-'))
    const settings = { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository
    const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
    const project = await createWritingProject(projects, { name: '寻母', genre: '玄幻' })
    dir = project.path; id = project.id
    generate = vi.fn().mockImplementation(async (_prompt, opts) => opts?.meta?.feature === 'longformGuard' ? conflict : content)
    service = new WriteService(projects, { generateStream: generate } as unknown as LlmService,
      undefined, undefined, undefined, undefined, undefined, acceptedDeslop)
    await writeFile(join(dir, '大纲', '大纲.md'), `# 寻母\n\n## 主线剧情走向\n\n${goal}\n\n### 第1卷：寻信（第1-100章）\n本卷先寻找密信，第100章才确认母亲下落。`)
    await writeFile(join(dir, '细纲', '细纲_第001章_寻信.md'), '# 细纲\n\n## 第 1 章：寻信\n\n- **核心事件**：陆安向船夫打听母亲下落。')
  })
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

  it('写前包含作者主线和大纲内嵌卷计划', async () => {
    const prompt = await service.buildChapterPrompt(id, 1)
    expect(prompt.user).toContain(goal)
    expect(prompt.user).toContain('第100章才确认母亲下落')
    expect(prompt.user).toContain('不能通过按正文回写细纲来消除')
  })

  it('普通续写发现跑偏保留已生成原稿，不能成功交稿', async () => {
    await expect(service.generateChapterStream(id, 1)).rejects.toThrow('LONGFORM_CONFLICT')
    expect(await new ProseRepo(dir).read(1)).toContain('永久放弃寻找母亲')
    expect(generate.mock.calls.some(([, opts]) => opts?.meta?.feature === 'longformGuard')).toBe(true)
  })

  it('写后同步同样核对主线，冲突稿不能提取/提交记忆', async () => {
    await new ProseRepo(dir).write(1, content)
    const result = await service.syncChapterAfterWrite(id, 1, content, { selfCheck: null })
    expect(result?.memory.reviewRequired?.join('\n')).toContain('LONGFORM_CONFLICT')
    expect(generate.mock.calls.every(([, opts]) => opts?.meta?.feature === 'longformGuard')).toBe(true)
  })

  it('连续批次在回写细纲之前暂停，保留当前稿且不生成下一章；恢复复用当前稿重新核对', async () => {
    const original = await readFile(join(dir, '细纲', '细纲_第001章_寻信.md'), 'utf8')
    const result = { chapterNumber: 1, content,
      outlineDiff: { chapterNumber: 1, hasOutline: true, checked: true, passed: true, diffs: [] },
      memory: { newPlotPoints: [], characterStateChanges: [] },
      memoryApply: { applied: {}, errors: [] }, selfCheck: { items: [] } } as unknown as ChapterFlowResult
    const flow = vi.spyOn(service, 'runFullFlowForChapter').mockResolvedValue(result)
    const summary = vi.spyOn(service, 'generateChapterSummary').mockResolvedValue({ chapterNumber: 1, sourceHash: '', generatedAt: '',
      events: [], stateChanges: [], openThreads: [], continuity: [], stale: false })
    const progress = await service.generateChaptersBatch(id, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress).toMatchObject({ status: 'paused', pendingPostProcessChapter: 1, completed: [1] })
    expect(flow).toHaveBeenCalledTimes(1)
    expect(summary).not.toHaveBeenCalled()
    expect(await new ProseRepo(dir).read(1)).toBe(content)
    expect(await new ProseRepo(dir).read(2)).toBe('')
    expect(await readFile(join(dir, '细纲', '细纲_第001章_寻信.md'), 'utf8')).toBe(original)
    // A later retry must not reuse the rejected verdict or skip the saved chapter.
    generate.mockResolvedValue(clear)
    flow.mockResolvedValue({ ...result, outlineDiff: { ...result.outlineDiff, checked: true, proseSynced: undefined } })
    const resumed = await service.generateChaptersBatch(id, 1, 1, () => {}, null, {},
      { fromChapter: 1, total: 1, completed: [1], pendingPostProcessChapter: 1 }, { autoContinue: true })
    expect(resumed.status).toBe('completed')
    expect(flow.mock.calls[1][3]?.contentOverride).toBe(content)
  })

  it('检查期间作者改变主线，旧通过结论不能生效', async () => {
    generate.mockImplementation(async (_prompt, opts) => {
      if (opts?.meta?.feature === 'longformGuard') {
        await writeFile(join(dir, '大纲', '大纲.md'), '# 寻母\n\n## 主线剧情走向\n\n新的目标：寻找失踪父亲并查明身世。')
        return clear
      }
      return content
    })
    await expect(service.generateChapterStream(id, 1)).rejects.toThrow('LONGFORM_CONTEXT_CHANGED')
  })

  it('卷纲超长明确要求整理，不能静默漏掉尾部终局约束', async () => {
    await mkdir(join(dir, '大纲'), { recursive: true })
    await writeFile(join(dir, '大纲', '第1卷_寻信.md'), '# 卷纲\n\n' + '计划'.repeat(10000))
    await expect(readLongformPlan(dir, 1)).rejects.toThrow('LONGFORM_PLAN_TOO_LARGE')
  })
})
