import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WriteService } from '../src/main/data/write-service'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { MemoryWriter } from '../src/main/data/memory-writer'
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
    await expect(service.generateChapterStream(id, 1, { autoDeslopAfterContinue: true })).rejects.toMatchObject({
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

  it('写后核对用早期正文识别伤势矛盾，不把后章康复当作当前依据', async () => {
    const injury = '郎中说，陆安左手的伤至少要吊七日，今夜连缰绳都握不住。'
    const healed = '拆开夹板后，陆安左手已经可以稳稳握住缰绳。'
    const draft = '仍是受伤当晚，陆安左手稳稳握住缰绳，勒马停在渡口。鞍边系着一枚铜铃。'
    const prose = new ProseRepo(dir)
    await writeFile(join(dir, '大纲', '大纲.md'), '# 寻母')
    await prose.write(1, `船到了河心，陆安才松开压在伤口上的衣角。\n\n${injury}`, '渡河')
    await prose.write(2, '陆安让船夫把马牵到渡口，自己用右手撑着站了起来。', '上岸')
    await prose.write(3, draft, '回渡口')
    await prose.write(5, `七天后，郎中又来看他。\n\n${healed}\n\n郎中临走送了陆安一只银铃。`, '拆夹板')
    await new MemoryWriter(dir).applyNewItems([{ name: '银铃', category: '信物', notes: '郎中在拆夹板后相赠。' }], 5)
    generate.mockResolvedValue(JSON.stringify({
      completed: true, checked: ['mainline', 'knowledge', 'thread', 'item'],
      findings: [{ kind: 'thread', message: '第 1 章明确限制陆安当晚左手的活动。', snippet: draft, reference: injury }]
    }))

    const result = await service.syncChapterAfterWrite(id, 3, draft, { selfCheck: null })
    const prompt = generate.mock.calls[0][0]
    expect(prompt).toContain('核对时间顺序、位置、伤势、关系变化和能力的条件与代价')
    expect(prompt).toMatch(/第 1 章 · 正文\/第001章 渡河\.md:\d+–\d+\n郎中说/)
    expect(prompt).toContain(injury)
    expect(prompt).not.toContain(healed)
    expect(prompt).not.toContain('银铃')
    expect(result?.memory.reviewRequired?.join('\n')).toContain(`依据：${injury}`)
    expect(generate.mock.calls.map(([, opts]) => opts?.meta?.feature)).toEqual(['longformGuard'])
  })

  it('写后核对同时提供有出入的远章和邻章原文，争议事实不能擅自沿用一边', async () => {
    const old = '顾宁记得铜阀试验录像的交付经过。那段样片只录到水压表，小阀门根本没拍进去。'
    const nearby = '小阀门的编号，就在你交的样片里。'
    const draft = '顾宁没去开档案袋，便断言那段样片肯定没有拍到小阀门。'
    const prose = new ProseRepo(dir)
    await prose.write(5, old, '事故记录')
    await prose.write(63, '沈唯把泡烂的纸扔进盆里。', '找证词')
    await prose.write(64, `雨水从窗缝里淌了进来。\n\n${nearby}`, '一段口供')
    await prose.write(66, draft, '认领证物')
    generate.mockResolvedValue(JSON.stringify({
      completed: true, checked: ['mainline', 'knowledge', 'thread', 'item'],
      findings: [{ kind: 'thread', message: '第5、64章对样片内容说法不一。可保留已交付样片，具体画面待核。', snippet: draft, reference: nearby }]
    }))
    const result = await service.syncChapterAfterWrite(id, 66, draft, { selfCheck: null })
    const prompt = generate.mock.calls[0][0]
    expect(prompt).toContain('多个已写章节若对同一既成细节有不相容的描述')
    expect(prompt).toContain('保留各方证据共同能证实的部分')
    expect(prompt).toContain(old)
    expect(prompt).toContain(nearby)
    expect(result?.memory.reviewRequired?.join('\n')).toContain(`依据：${nearby}`)
    expect(generate.mock.calls.map(([, opts]) => opts?.meta?.feature)).toEqual(['longformGuard'])
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
