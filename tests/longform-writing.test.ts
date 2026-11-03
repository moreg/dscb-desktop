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
const clear = JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item', 'boundary'], findings: [] })
const conflict = JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item', 'boundary'], findings: [
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

  it('写作末尾强化本章情节点与禁区，长篇计划不盖过本章输出任务', async () => {
    await writeFile(join(dir, '细纲', '细纲_第001章_寻信.md'), [
      '# 细纲', '', '## 第 1 章：寻信', '- **核心事件**：陆安先取信，再向船夫问路。',
      '- **章末钩子**：陆安发现信封上的红印。', '', '## 情节细化', '### 情节点序列',
      '1. 陆安取回旧信。', '2. 陆安把旧信交给船夫查看。', '', '## 写作禁区', '不得提前揭示母亲身份。'
    ].join('\n'))
    await writeFile(join(dir, '细纲', '细纲_第002章_后续.md'), '# 细纲\n\n## 第 2 章：后续\n\n- **核心事件**：次日船夫确认母亲身份。')
    const prompt = await service.buildChapterPrompt(id, 1)
    const execution = prompt.user.indexOf('【本章执行清单：写完前逐项核对】')
    const output = prompt.user.indexOf('# 现在请写第 1 章正文')
    expect(execution).toBeGreaterThan(output)
    expect(prompt.user.indexOf('【作者主线契约】')).toBeLessThan(output)
    const finalInstructions = prompt.user.slice(execution)
    expect(finalInstructions).toContain('陆安取回旧信')
    expect(finalInstructions).toContain('陆安把旧信交给船夫查看')
    expect(finalInstructions).toContain('不得提前揭示母亲身份')
    expect(finalInstructions).toContain('本章停止位置：陆安发现信封上的红印')
    expect(prompt.user).toContain('本章细纲明确安排的发现、行动和结果必须完成')
    expect(prompt.user).not.toContain('本章细纲的章末钩子照常兑现，但只到触发信号')
  })

  it('普通续写发现跑偏保留已生成原稿，不能成功交稿', async () => {
    await expect(service.generateChapterStream(id, 1)).rejects.toMatchObject({
      message: expect.stringContaining('LONGFORM_CONFLICT'), retainedContent: content
    })
    expect(await new ProseRepo(dir).read(1)).toContain('永久放弃寻找母亲')
    expect(generate.mock.calls.some(([, opts]) => opts?.meta?.feature === 'longformGuard')).toBe(true)
  })

  it('生成精修后核对失败，把精修整章附在错误中，磁盘正文仍在', async () => {
    const polished = '陆安向船夫询问母亲的下落，随后沿着河岸继续寻找。'
    vi.spyOn(service as unknown as { autoDeslopGeneratedProse: () => Promise<string> },
      'autoDeslopGeneratedProse').mockResolvedValue(polished)
    generate.mockImplementation(async (prompt, opts) => opts?.meta?.feature === 'longformGuard'
      ? (prompt.endsWith(content) ? clear : '{}') : content)
    await expect(service.generateChapterStream(id, 1)).rejects.toMatchObject({
      message: expect.stringContaining('LONGFORM_REVIEW_INCOMPLETE'), retainedContent: polished
    })
    expect(await new ProseRepo(dir).read(1)).toBe(polished)
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
