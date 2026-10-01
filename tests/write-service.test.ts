import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { OutlineRepository } from '../src/main/data/outline-repository'
import { CharacterRepository } from '../src/main/data/character-repository'
import { StyleProfileRepository } from '../src/main/data/style-profile-repository'
import { WriteService } from '../src/main/data/write-service'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { ChapterFlowResult } from '../src/shared/types'

function mockLlm(reply: string): LlmService {
  return { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
}

const mockSettings = { getProjectsRoot: async (fallback: string) => fallback } as unknown as SettingsRepository

describe('WriteService', () => {
  let root: string
  let projectId: string
  let ps: ProjectService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-ws-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '青云志', genre: '玄幻' })).id
  })

  it('buildChapterPrompt assembles project, outline, characters, prev chapter', async () => {
    const dir = await ps.resolveDir(projectId)
    await new OutlineRepository(dir).writeMain({
      schemaVersion: 1,
      updatedAt: 't',
      synopsis: '少年修仙主线'
    })
    await new OutlineRepository(dir).upsertDetailed({
      chapterNumber: 2,
      plotSummary: '本章细纲：林远突破'
    })
    await new CharacterRepository(dir).create({ name: '林远', role: '主角', personality: '坚毅' })
    // 新数据源：第 1 章正文写入 ProseRepo（正文/001.md）
    await new ProseRepo(dir).write(1, '前一章的正文内容。')

    const service = new WriteService(ps, mockLlm('正文'))
    const { system, user } = await service.buildChapterPrompt(projectId, 2)
    expect(user).toContain('青云志')
    expect(user).toContain('少年修仙主线')
    expect(user).toContain('林远突破')
    expect(user).toContain('林远')
    expect(user).toContain('前一章的正文内容')
    // 新的 system prompt 含技能守则
    expect(system).toContain('章末结尾硬性原则')
    expect(system).toContain('禁用高频词')
  })

  it('buildChapterPrompt injects recent plot summaries as mid-range memory', async () => {
    const dir = await ps.resolveDir(projectId)
    const { mkdir, writeFile } = await import('fs/promises')
    await mkdir(path.join(dir, '记忆', '剧情点'), { recursive: true })
    await mkdir(path.join(dir, '正文'), { recursive: true })
    await writeFile(
      path.join(dir, '记忆', '剧情点', '第003章 初露锋芒.md'),
      `# 第3章 初露锋芒\n\n## 字段\n\n- **核心事件**：林远当众击败赵乾，名声初起\n`,
      'utf-8'
    )
    await writeFile(
      path.join(dir, '记忆', '剧情点', '第004章 收徒风波.md'),
      `# 第4章 收徒风波\n\n## 字段\n\n- **核心事件**：长老逼林远收徒，林远拒绝并立下赌约\n`,
      'utf-8'
    )
    // 仅已写正文的章进入中程记忆
    await new ProseRepo(dir).write(3, '第三章正文：林远击败赵乾。')
    await new ProseRepo(dir).write(4, '第四章结尾：林远离开大殿。')

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 5)
    expect(user).toContain('较早已写章节概要')
    expect(user).toContain('实际正文')
    expect(user).toContain('第 3 章')
    expect(user).toContain('击败赵乾')
    expect(user).toContain('第 4 章')
    expect(user).toContain('林远离开大殿')
    expect(user).not.toContain('林远拒绝并立下赌约')
    expect(user).toContain('不能用它覆盖正文已发生的情节')
    expect(user).toContain('只是检索坐标，禁止写入正文')
  })

  it('buildChapterPrompt injects chapter self-check checklist (suspense, foreshadow, power bounds)', async () => {
    const dir = await ps.resolveDir(projectId)
    const { mkdir, writeFile } = await import('fs/promises')
    await mkdir(path.join(dir, '设定', '世界观'), { recursive: true })
    await mkdir(path.join(dir, '追踪'), { recursive: true })
    await writeFile(
      path.join(dir, '设定', '世界观', '金手指.md'),
      `# 金手指

## 限制与副作用
- **限制**：只能看到当日运势，无法看到长期命运
- **限制**：调整幅度有限，只能调 1-2 级，不能直接改变命运
- **消耗**：每次使用消耗精神力，连续使用会头痛
`,
      'utf-8'
    )
    await new OutlineRepository(dir).upsertDetailed({
      chapterNumber: 2,
      plotSummary: '林远当众击败赵乾，立下赌约',
      hook: '长老突然现身'
    })
    // 上一章正文 → 触发结尾状态或至少 prevTail 衔接自检
    await new ProseRepo(dir).write(1, '赵乾惨叫一声跪倒在地。林远收剑，望向山门阴影：「谁？」')

    // 到期伏笔
    await writeFile(
      path.join(dir, '追踪', '伏笔.md'),
      `# 伏笔

| 内容 | 状态 | 埋设章节 | 预计回收 |
|---|---|---|---|
| 山门阴影中的人是谁 | 已埋设 | 1 | 2 |
| 长老的真实身份 | 已埋设 | 1 | 9 |
`,
      'utf-8'
    )

    const service = new WriteService(ps, mockLlm('正文'))
    // mock extractEndingState to return suspense
    ;(service as unknown as { flow: unknown }).flow = {
      extractEndingState: async () => ({
        chapterNumber: 1,
        characterPositions: [{ name: '林远', location: '山门', action: '收剑' }],
        characterStates: [],
        timePoint: '黄昏',
        unfinished: ['尚未看清山门来人'],
        suspense: '山门阴影里站着谁？',
        props: ['长剑']
      })
    }

    const { user } = await service.buildChapterPrompt(projectId, 2)
    expect(user).toContain('写前/写后自检清单')
    expect(user).toContain('上章悬念')
    expect(user).toContain('山门阴影')
    expect(user).toContain('未完成')
    expect(user).toContain('本章核心事件')
    expect(user).toContain('击败赵乾')
    expect(user).toContain('金手指边界')
    expect(user).toMatch(/只能|无法|不能|消耗/)
    expect(user).toContain('输出前必须对照')
  })

  /**
   * 回归：结尾状态提取失败时，之前 selfCheckChapter 的 skip 提示说的是
   * 「本次会话没写过本章正文」——但明明刚在这次会话里为这一章生成过 prompt，
   * 只是那次辅助 LLM 调用炸了。现在要能分清「提取失败」和「没跑过」。
   */
  it('extractEndingState 失败时，selfCheckChapter 的提示要说清是「提取失败」而不是「没跑过」', async () => {
    const dir = await ps.resolveDir(projectId)
    await new ProseRepo(dir).write(1, '赵乾惨叫一声跪倒在地。林远收剑，望向山门阴影：「谁？」')

    const service = new WriteService(ps, mockLlm('正文'))
    ;(service as unknown as { flow: unknown }).flow = {
      extractEndingState: async () => {
        throw new Error('LLM 超时')
      }
    }

    // 触发一次真实的生成流程：会尝试提取上章结尾状态，且会失败
    await service.buildChapterPrompt(projectId, 2)

    const report = await service.selfCheckChapter(projectId, 2, '第二章正文，随便写点内容。')
    const skipped = report.items.find((i) => i.id === 'prev_state_missing')
    expect(skipped?.verdict).toBe('skip')
    expect(skipped?.detail).toContain('提取失败')
    expect(skipped?.detail).not.toContain('没写过本章正文')
  })

  it('从没生成过时，selfCheckChapter 的提示仍是原来「没跑过」的措辞', async () => {
    const dir = await ps.resolveDir(projectId)
    await new ProseRepo(dir).write(1, '第一章的正文。')

    const service = new WriteService(ps, mockLlm('正文'))
    // 不调用 buildChapterPrompt：从未真正尝试过提取上章结尾状态
    const report = await service.selfCheckChapter(projectId, 2, '第二章正文，随便写点内容。')
    const skipped = report.items.find((i) => i.id === 'prev_state_missing')
    expect(skipped?.detail).toContain('没写过本章正文')
  })

  it('buildChapterPrompt injects volume anchors and blocks future spoilers', async () => {
    const dir = await ps.resolveDir(projectId)
    const { mkdir, writeFile } = await import('fs/promises')
    await mkdir(path.join(dir, '大纲'), { recursive: true })
    // 大纲.md 卷表：本章落在第 1 卷
    await writeFile(
      path.join(dir, '大纲', '大纲.md'),
      `# 青云志

## 主线剧情走向

少年修仙

### 第1卷：开端（第1-10章）

立足门派

## 逐章节奏标注

| 章节 | 标题 | 情绪 | 爽点 |
|---|---|---|---|
| 1 | 开篇 | 5 | 1 |
`,
      'utf-8'
    )
    await writeFile(
      path.join(dir, '大纲', '第1卷_开端.md'),
      `# 卷纲：第1卷 开端（第1-10章）

## 卷核心
- **卷名**：开端
- **章节范围**：第1-10章
- **核心冲突**：林远立足门派，暗中积蓄
- **人物弧线**：落魄外门 → 崭露头角

## 情绪弧线
1-3章铺垫 → 4-7章打脸 → 8-10章卷终

## 反转
- 第 3 章：林远当众打脸赵乾
- 第 9 章：长老真实身份揭晓（卷末）

## 各章核心事件

### 第3章：初露锋芒
- **核心事件**：林远击败赵乾

### 第9章：身份揭晓
- **核心事件**：长老身份揭晓，林远卷入宗门秘辛
`,
      'utf-8'
    )

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 5)
    expect(user).toContain('卷级定位')
    expect(user).toContain('硬约束')
    // 未来反转不得抢写
    expect(user).toContain('禁止提前')
    expect(user).toContain('第 9 章')
    // 已发生反转可保留
    expect(user).toContain('第 3 章')
    expect(user).toContain('击败赵乾')
  })

  it('generateChapterStream calls llm with assembled prompt', async () => {
    const llm = mockLlm('生成的正文')
    const service = new WriteService(ps, llm)
    const full = await service.generateChapterStream(projectId, 1)
    expect(full).toBe('生成的正文')
    expect(llm.generateStream).toHaveBeenCalled()
  })

  it('adjustChapterStream revises existing prose from a follow-up instruction', async () => {
    const llm = mockLlm('修订后的完整正文')
    const service = new WriteService(ps, llm)

    const full = await service.adjustChapterStream(
      projectId,
      1,
      '当前正文：主角只是站着解释。',
      '加强动作冲突，删掉旁白解释。'
    )

    expect(full).toBe('修订后的完整正文')
    expect(llm.generateStream).toHaveBeenCalled()
    const [prompt, opts] = vi.mocked(llm.generateStream).mock.calls[0]
    expect(prompt).toContain('按用户追问调整第 1 章已生成正文')
    expect(prompt).toContain('加强动作冲突，删掉旁白解释。')
    expect(prompt).toContain('当前正文：主角只是站着解释。')
    expect(prompt).toContain('直接输出调整后的完整正文')
    expect(opts?.meta).toEqual({ feature: 'chapter-adjust', projectId, chapterNumber: 1 })
  })

  it('planAdjustChapterStream only asks for a plan, not revised prose', async () => {
    const llm = mockLlm('## 理解你的要求\n加强冲突。\n## 落笔要点\n1. 改对话')
    const service = new WriteService(ps, llm)

    const full = await service.planAdjustChapterStream(
      projectId,
      1,
      '当前正文：主角只是站着解释。',
      '加强动作冲突，删掉旁白解释。'
    )

    expect(full).toContain('落笔要点')
    expect(llm.generateStream).toHaveBeenCalled()
    const [prompt, opts] = vi.mocked(llm.generateStream).mock.calls[0]
    expect(prompt).toContain('先出修改方案')
    expect(prompt).toContain('不落笔')
    expect(prompt).toContain('禁止输出修订后的完整正文')
    expect(prompt).toContain('加强动作冲突，删掉旁白解释。')
    expect(prompt).toContain('当前正文：主角只是站着解释。')
    expect(prompt).not.toContain('直接输出调整后的完整正文')
    expect(opts?.meta).toEqual({ feature: 'chapter-adjust-plan', projectId, chapterNumber: 1 })
  })

  it('adjustChapterStream includes confirmed plan when user approved suggestions', async () => {
    const llm = mockLlm('按方案修订后的正文')
    const service = new WriteService(ps, llm)
    const plan = '## 落笔要点\n1. 删旁白\n2. 加动作对峙'

    await service.adjustChapterStream(
      projectId,
      1,
      '当前正文：主角只是站着解释。',
      '加强动作冲突',
      null,
      {},
      plan
    )

    const [prompt] = vi.mocked(llm.generateStream).mock.calls[0]
    expect(prompt).toContain('用户已确认的修改方案')
    expect(prompt).toContain('删旁白')
    expect(prompt).toContain('加动作对峙')
    expect(prompt).toContain('加强动作冲突')
    expect(prompt).toContain('直接输出调整后的完整正文')
  })

  it('adjustChapter prompt enforces user instruction as highest priority over outline/character', async () => {
    const llm = mockLlm('修订后的完整正文')
    const service = new WriteService(ps, llm)

    await service.adjustChapterStream(
      projectId,
      1,
      '当前正文：主角只是站着解释。',
      '把这段改成女主主动反击，删掉所有旁白解释。'
    )

    const [prompt] = vi.mocked(llm.generateStream).mock.calls[0]
    // 用户追问要求被标为最高优先级，覆盖细纲/人物/伏笔
    expect(prompt).toContain('最高优先级')
    expect(prompt).toContain('覆盖一切既有约束')
    expect(prompt).toContain('以用户要求为准')
    // 要求逐条落实 + 输出前自检，避免遗漏
    expect(prompt).toContain('逐条')
    expect(prompt).toContain('自检')
    // 用户要求文本必须出现在当前正文之后、紧贴输出指令（注意力最靠后）
    const instructionIdx = prompt.indexOf('把这段改成女主主动反击，删掉所有旁白解释。')
    const contentIdx = prompt.indexOf('当前正文：主角只是站着解释。')
    expect(instructionIdx).toBeGreaterThan(contentIdx)
    expect(prompt).toContain('直接输出调整后的完整正文')
  })

  it('answerChapterQuestionStream injects book-wide context: A catalog + B neighbors + settings files', async () => {
    const fs = await import('fs/promises')
    const dir = await ps.resolveDir(projectId)

    // A：总纲
    await fs.writeFile(
      path.join(dir, '大纲', '大纲.md'),
      '# 《青云志》大纲\n\n## 主线剧情走向\n\n少年修仙主线\n'
    )

    // 上下文文件：设定/
    await fs.mkdir(path.join(dir, '设定'), { recursive: true })
    await fs.writeFile(
      path.join(dir, '设定', '题材定位.md'),
      '# 题材定位\n\n## 核心梗\n重生武术传奇凭运势罗盘摆摊算命。\n'
    )

    // A：细纲章目录（第 1/2/3 章）
    await fs.mkdir(path.join(dir, '细纲'), { recursive: true })
    await fs.writeFile(
      path.join(dir, '细纲', '细纲_第001章_初入仙门.md'),
      `# 细纲_第001章_初入仙门.md\n\n## 第 1 章：初入仙门\n\n- **核心事件**：林远踏入宗门\n- **章末钩子**：长老目光一凝\n`
    )
    await fs.writeFile(
      path.join(dir, '细纲', '细纲_第002章_筑基之夜.md'),
      `# 细纲_第002章_筑基之夜.md\n\n## 第 2 章：筑基之夜\n\n- **核心事件**：林远突破筑基\n- **章末钩子**：门外脚步声\n`
    )
    await fs.writeFile(
      path.join(dir, '细纲', '细纲_第003章_试炼开场.md'),
      `# 细纲_第003章_试炼开场.md\n\n## 第 3 章：试炼开场\n\n- **核心事件**：外门试炼开始\n`
    )

    // B：相邻章正文（问第 2 章 → 应注入第 1、3 章）
    await new ProseRepo(dir).write(1, '第1章正文：林远推开山门，香火扑面。', '初入仙门')
    await new ProseRepo(dir).write(3, '第3章正文：试炼台鼓声如雷。', '试炼开场')

    await new CharacterRepository(dir).create({ name: '林远', role: '主角', personality: '坚毅' })

    const llm = mockLlm('人物动机合理，因为……')
    const service = new WriteService(ps, llm)
    const full = await service.answerChapterQuestionStream(
      projectId,
      2,
      '第2章正文：林远盘膝而坐，真气翻涌。',
      '这一章和前后衔接自然吗？'
    )

    expect(full).toBe('人物动机合理，因为……')
    expect(llm.generateStream).toHaveBeenCalled()
    // loadChapterContext 可能先调 endingState 等辅助 LLM，取真正的 ask 调用
    const askCall = vi
      .mocked(llm.generateStream)
      .mock.calls.find((c) => (c[1] as { meta?: { feature?: string } } | undefined)?.meta?.feature === 'ask')
    expect(askCall).toBeDefined()
    const [prompt, opts] = askCall!
    expect(opts?.meta).toEqual({ feature: 'ask', projectId, chapterNumber: 2 })
    expect(opts?.systemPrompt).toBeTruthy()

    // 只答不改
    expect(prompt).toContain('只回答问题')
    expect(prompt).toContain('不要重写正文')
    expect(prompt).toContain('这一章和前后衔接自然吗？')
    expect(prompt).toContain('第2章正文：林远盘膝而坐，真气翻涌。')

    // A：总纲 + 章目录摘要
    expect(prompt).toContain('少年修仙主线')
    expect(prompt).toContain('全书章目录')
    expect(prompt).toContain('林远踏入宗门')
    expect(prompt).toContain('林远突破筑基')
    expect(prompt).toContain('外门试炼开始')
    expect(prompt).toContain('← 当前章')

    // B：相邻章正文
    expect(prompt).toContain('相邻章正文')
    expect(prompt).toContain('林远推开山门，香火扑面')
    expect(prompt).toContain('试炼台鼓声如雷')

    // 上下文文件：设定
    expect(prompt).toContain('题材定位')
    expect(prompt).toContain('运势罗盘')
    expect(prompt).toContain('林远')
  })

  it('buildChapterPrompt injects default style and allows temporary override', async () => {
    const dir = await ps.resolveDir(projectId)
    await new StyleProfileRepository(dir).write({
      schemaVersion: 1,
      items: [
        {
          id: 'style-default',
          name: '默认文风',
          sourceType: 'sampleText',
          sampleText: '样文',
          identifiedStyle: '冷峻',
          sentencePatterns: ['短句'],
          vocabularyPreferences: ['克制'],
          punctuationAndRhythm: ['停顿多'],
          narrativePerspective: ['第三人称近距离'],
          tone: ['冷静'],
          narrativeTemplates: ['冲突先行'],
          styleConstraints: ['避免华丽修辞'],
          characterConstraints: ['保持主角冷静'],
          plotConstraints: ['避免金手指'],
          dos: ['用短句推进'],
          donts: ['不要抒情泛滥'],
          stylePrompt: '默认文风提示',
          createdAt: '2026-06-22T00:00:00.000Z',
          updatedAt: '2026-06-22T00:00:00.000Z'
        },
        {
          id: 'style-temp',
          name: '临时文风',
          sourceType: 'sampleText',
          sampleText: '样文',
          identifiedStyle: '轻快',
          sentencePatterns: ['长短句交替'],
          vocabularyPreferences: ['俏皮'],
          punctuationAndRhythm: ['轻快'],
          narrativePerspective: ['第一人称'],
          tone: ['调侃'],
          narrativeTemplates: ['吐槽推进'],
          styleConstraints: ['对话口语化'],
          characterConstraints: ['多用内心吐槽'],
          plotConstraints: ['轻快推进'],
          dos: ['多用口语'],
          donts: ['不要端着'],
          stylePrompt: '临时文风提示',
          createdAt: '2026-06-22T00:00:00.000Z',
          updatedAt: '2026-06-22T00:00:00.000Z'
        }
      ]
    })
    await ps.updateProjectData(projectId, { defaultStyleProfileId: 'style-default' })

    const service = new WriteService(ps, mockLlm('正文'))
    const defaultPrompt = await service.buildChapterPrompt(projectId, 1)
    const overridePrompt = await service.buildChapterPrompt(projectId, 1, 'style-temp')

    expect(defaultPrompt.system).toContain('默认文风提示')
    expect(overridePrompt.system).toContain('临时文风提示')
    expect(overridePrompt.system).not.toContain('默认文风提示')
  })

  describe('generateChaptersBatch / resumeChaptersBatch', () => {
    beforeEach(() => {
      vi.spyOn(WriteService.prototype, 'generateChapterSummary').mockImplementation(async (_pid, ch) => ({
        chapterNumber: ch, sourceHash: 'test', generatedAt: '', events: [], stateChanges: [], openThreads: [], stale: false
      }))
    })

    afterEach(() => vi.restoreAllMocks())
    function makeFlowResult(ch: number, content: string): ChapterFlowResult {
      return {
        chapterNumber: ch,
        content,
        audit: {
          schemaVersion: 1,
          wordCount: content.length,
          passed: { ending: true, forbiddenWords: true, wordCount: true },
          counts: { error: 0, warn: 0, info: 0 },
          violations: []
        },
        outlineDiff: { chapterNumber: ch, diffs: [], passed: true },
        memory: {
          chapterNumber: ch,
          newCharacters: [],
          newLocations: [],
        newItems: [],
          newForeshadowings: [],
          newPlotPoints: [],
          characterStateChanges: [],
          collectedForeshadowings: []
        },
        rhythm: null,
        figure: {
          chapterNumber: ch,
          shouldGenerate: false,
          type: '',
          topic: '',
          fileName: '',
          html: '',
          reason: '未执行'
        }
      }
    }

    it('pauses after each chapter except the last (3 chapters)', async () => {
      const service = new WriteService(ps, mockLlm(''))
      const spy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockImplementation(async (_pid, ch) => makeFlowResult(ch, `第${ch}章正文`))

      const completed: { chapter: number; result: ChapterFlowResult }[] = []
      const progress = await service.generateChaptersBatch(
        projectId,
        1,
        3,
        (chapter, result) => completed.push({ chapter, result })
      )

      expect(progress.status).toBe('paused')
      expect(progress.currentChapter).toBe(1)
      expect(progress.fromChapter).toBe(1)
      expect(progress.toChapter).toBe(3)
      expect(progress.total).toBe(3)
      expect(progress.completed).toEqual([1])
      expect(progress.pauseReason).toContain('确认')
      expect(completed).toHaveLength(1)
      expect(completed[0].chapter).toBe(1)
      // 只调用了第 1 章
      expect(spy).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    })

    it('autoContinue writes the whole range without pausing', async () => {
      const service = new WriteService(ps, mockLlm(''))
      const spy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockImplementation(async (_pid, ch) => makeFlowResult(ch, `第${ch}章正文`))

      const completed: number[] = []
      const progress = await service.generateChaptersBatch(
        projectId,
        1,
        10,
        (chapter) => completed.push(chapter),
        null,
        {},
        undefined,
        { autoContinue: true }
      )

      expect(progress.status).toBe('completed')
      expect(progress.currentChapter).toBe(10)
      expect(progress.total).toBe(10)
      expect(progress.completed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(completed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(spy).toHaveBeenCalledTimes(10)
      spy.mockRestore()
    })

    it.each(['P0', 'omission', 'core', 'structure'])('autoContinue rewrites the outline from prose on outline issue %s and keeps writing', async (issue) => {
      const dir = await ps.resolveDir(projectId)
      const { mkdir, writeFile, readFile } = await import('fs/promises')
      await mkdir(path.join(dir, '细纲'), { recursive: true })
      for (const ch of [1, 2, 3, 4]) {
        await writeFile(
          path.join(dir, '细纲', `细纲_第${String(ch).padStart(3, '0')}章_测试章${ch}.md`),
          `# 细纲_第${String(ch).padStart(3, '0')}章_测试章${ch}.md\n\n## 第 ${ch} 章：测试章${ch}\n\n> 所属卷：第 1 卷\n\n- **核心事件**：原细纲事件${ch}\n`,
          'utf-8'
        )
      }
      const llm = mockLlm('')
      vi.mocked(llm.generateStream).mockImplementation(async (prompt: string) =>
        prompt.includes('细纲联动校准器')
          ? JSON.stringify([2, 3, 4].map((ch) => ({ chapterNumber: ch, patch: { plotSummary: `承接正文${ch}` } })))
          : JSON.stringify({ patch: { plotSummary: '按正文重写的事件', title: '擅自改名' } }))
      const service = new WriteService(ps, llm)
      vi.spyOn(service, 'runFullFlowForChapter').mockImplementation(async (_pid, ch) => {
        const result = makeFlowResult(ch, `第${ch}章正文`)
        if (ch === 1) {
          result.outlineDiff.diffs = [{ type: issue === 'core' ? 4 : issue === 'structure' ? 5 : 1,
            typeLabel: '漏写', priority: issue === 'P0' ? 'P0' : 'P1', suggestion: '补写关键交接结果' }]
        }
        return result
      })
      const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
      expect(progress.status).toBe('completed')
      expect(progress.completed).toEqual([1, 2])
      const first = await readFile(path.join(dir, '细纲', '细纲_第001章_测试章1.md'), 'utf-8')
      expect(first).toContain('按正文重写的事件')
      expect(first).toContain('## 第 1 章：测试章1')
      expect(first).not.toContain('擅自改名')
      expect(await readFile(path.join(dir, '细纲', '细纲_第003章_测试章3.md'), 'utf-8')).toContain('承接正文3')
    })

    it('autoContinue pauses with the outline intact when the prose rewrite fails', async () => {
      const dir = await ps.resolveDir(projectId)
      const { mkdir, writeFile, readFile } = await import('fs/promises')
      await mkdir(path.join(dir, '细纲'), { recursive: true })
      await writeFile(
        path.join(dir, '细纲', '细纲_第001章_测试章1.md'),
        '# 细纲_第001章_测试章1.md\n\n## 第 1 章：测试章1\n\n- **核心事件**：原细纲事件\n',
        'utf-8'
      )
      const service = new WriteService(ps, mockLlm('不是 JSON'))
      vi.spyOn(service, 'runFullFlowForChapter').mockImplementation(async (_pid, ch) => {
        const result = makeFlowResult(ch, `第${ch}章正文`)
        result.outlineDiff.diffs = [{ type: 1, typeLabel: '漏写', priority: 'P1', suggestion: '补写关键交接结果' }]
        return result
      })
      const progress = await service.generateChaptersBatch(projectId, 1, 3, () => {}, null, {}, undefined, { autoContinue: true })
      expect(progress.status).toBe('paused')
      expect(progress.pendingPostProcessChapter).toBe(1)
      expect(progress.pauseReason).toContain('以正文回写细纲未完成')
      expect(await readFile(path.join(dir, '细纲', '细纲_第001章_测试章1.md'), 'utf-8')).toContain('原细纲事件')
    })

    it.each(['missing', 'unchecked'])('autoContinue saves and pauses on outline issue %s', async (issue) => {
      const service = new WriteService(ps, mockLlm(''))
      const spy = vi.spyOn(service, 'runFullFlowForChapter').mockImplementation(async (_pid, ch) => {
        const result = makeFlowResult(ch, `第${ch}章正文`)
        result.outlineDiff.hasOutline = issue !== 'missing'
        result.outlineDiff.checked = issue !== 'unchecked'
        if (!['missing', 'unchecked'].includes(issue)) {
          result.outlineDiff.diffs = [{ type: issue === 'core' ? 4 : issue === 'structure' ? 5 : 1,
            typeLabel: '漏写', priority: issue === 'P0' ? 'P0' : 'P1', suggestion: '补写关键交接结果' }]
        }
        return result
      })
      const progress = await service.generateChaptersBatch(projectId, 1, 3, () => {}, null, {}, undefined, { autoContinue: true })
      expect(progress.status).toBe('paused')
      expect(progress.completed).toEqual([1])
      expect(progress.pauseReason).toMatch(/第 1 章(?:正文)?已保存/)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(await new ProseRepo(await ps.resolveDir(projectId)).read(1)).toContain('第1章正文')
    })

    it('ordinary outline adjustments and held memory items do not interrupt continuous writing', async () => {
      const service = new WriteService(ps, mockLlm(''))
      vi.spyOn(service, 'runFullFlowForChapter').mockImplementation(async (_pid, ch) => {
        const result = makeFlowResult(ch, `第${ch}章正文`)
        result.outlineDiff.diffs = [{ type: 3, typeLabel: '细节调整', priority: 'P1', suggestion: '道具颜色不同' }]
        result.memoryApply = { applied: { characters: 0, locations: 0, items: 0, foreshadowings: 0, plotPoints: 0, stateChanges: 0, collected: 0 }, errors: [], heldBack: ['单条证据待复核'] }
        return result
      })
      const progress = await service.generateChaptersBatch(projectId, 1, 3, () => {}, null, {}, undefined, { autoContinue: true })
      expect(progress.status).toBe('completed')
      expect(progress.completed).toEqual([1, 2, 3])
    })

    it('autoContinue writes accepted正文 differences back to the detailed outline before continuing', async () => {
      const dir = await ps.resolveDir(projectId)
      const { mkdir, writeFile, readFile } = await import('fs/promises')
      await mkdir(path.join(dir, '细纲'), { recursive: true })
      for (const ch of [1, 2]) {
        await writeFile(
          path.join(dir, '细纲', `细纲_第${String(ch).padStart(3, '0')}章_测试章${ch}.md`),
          `# 细纲_第${String(ch).padStart(3, '0')}章_测试章${ch}.md\n\n## 第 ${ch} 章：测试章${ch}\n\n- **核心事件**：原细纲事件\n- **字数目标**：3000-3300 字\n`,
          'utf-8'
        )
      }

      const service = new WriteService(ps, mockLlm(''))
      vi.spyOn(service, 'runFullFlowForChapter').mockImplementation(async (_pid, ch) => {
        const result = makeFlowResult(ch, `第${ch}章扩写正文`)
        result.outlineDiff = {
          chapterNumber: ch,
          hasOutline: true,
          checked: true,
          passed: false,
          diffs: [{
            type: 5,
            typeLabel: '结构性偏离',
            priority: 'P1',
            resolution: 'review',
            suggestion: '接受扩写版并回写细纲',
            actual: '正文约 5400 字',
            outlinePatch: { wordEstimate: '5200-5600 字' }
          }]
        }
        return result
      })

      const completed: ChapterFlowResult[] = []
      const progress = await service.generateChaptersBatch(
        projectId,
        1,
        2,
        (_chapter, result) => completed.push(result),
        null,
        {},
        undefined,
        { autoContinue: true }
      )

      expect(progress.status).toBe('completed')
      expect(completed).toHaveLength(2)
      expect(completed.every((result) => result.outlineDiff.diffs.length === 0)).toBe(true)
      const updated = await readFile(
        path.join(dir, '细纲', '细纲_第001章_测试章1.md'),
        'utf-8'
      )
      expect(updated).toContain('- **字数目标**：5200-5600 字')
    })

    it('autoContinue adjusts the next three outlines after an accepted core-event change', async () => {
      const dir = await ps.resolveDir(projectId)
      const { mkdir, writeFile, readFile } = await import('fs/promises')
      await mkdir(path.join(dir, '细纲'), { recursive: true })
      for (const ch of [1, 2, 3, 4]) {
        await writeFile(
          path.join(dir, '细纲', `细纲_第${String(ch).padStart(3, '0')}章_测试章${ch}.md`),
          `# 细纲_第${String(ch).padStart(3, '0')}章_测试章${ch}.md\n\n## 第 ${ch} 章：测试章${ch}\n\n> 所属卷：第 1 卷\n\n- **核心事件**：原细纲事件${ch}\n- **字数目标**：3000-3300 字\n`,
          'utf-8'
        )
      }
      const llm = mockLlm(JSON.stringify([2, 3, 4].map((ch) => ({
        chapterNumber: ch,
        reason: '承接上一章新结果',
        patch: { plotSummary: `承接改写后的核心事件${ch}` }
      }))))
      const service = new WriteService(ps, llm)
      vi.spyOn(service, 'runFullFlowForChapter').mockImplementation(async (_pid, ch) => {
        const result = makeFlowResult(ch, `第${ch}章正文`)
        if (ch === 1) {
          result.outlineDiff = {
            chapterNumber: ch,
            hasOutline: true,
            checked: true,
            passed: false,
            diffs: [{
              type: 4,
              typeLabel: '核心事件改',
              priority: 'P1',
              resolution: 'review',
              suggestion: '接受正文新结果并联动后续细纲',
              actual: '主角提前拿到账册，但整体方向不变',
              outlinePatch: { plotSummary: '主角提前拿到账册' }
            }]
          }
        }
        return result
      })

      const progress = await service.generateChaptersBatch(
        projectId, 1, 4, () => {}, null, {}, undefined, { autoContinue: true }
      )

      expect(progress.status).toBe('completed')
      for (const ch of [2, 3, 4]) {
        const updated = await readFile(
          path.join(dir, '细纲', `细纲_第${String(ch).padStart(3, '0')}章_测试章${ch}.md`),
          'utf-8'
        )
        expect(updated).toContain(`- **核心事件**：承接改写后的核心事件${ch}`)
        expect(updated).toContain(`## 第 ${ch} 章：测试章${ch}`)
      }
    })

    it('autoContinue writes a volume-level mainline change back from prose', async () => {
      const dir = await ps.resolveDir(projectId)
      const { mkdir, writeFile, readFile } = await import('fs/promises')
      await mkdir(path.join(dir, '细纲'), { recursive: true })
      await writeFile(
        path.join(dir, '细纲', '细纲_第001章_测试章1.md'),
        '# 细纲_第001章_测试章1.md\n\n## 第 1 章：测试章1\n\n- **核心事件**：原细纲事件\n',
        'utf-8'
      )
      const service = new WriteService(ps, mockLlm(''))
      vi.spyOn(service, 'runFullFlowForChapter').mockImplementation(async (_pid, ch) => {
        const result = makeFlowResult(ch, `第${ch}章正文`)
        result.outlineDiff = {
          chapterNumber: ch,
          hasOutline: true,
          checked: true,
          passed: false,
          diffs: [{
            type: 4,
            typeLabel: '核心事件改',
            priority: 'P1',
            resolution: 'review',
            suggestion: '本卷主线改为提前决战，需要作者确认',
            actual: '卷终决战提前',
            outlinePatch: { plotSummary: '提前完成整卷决战' }
          }]
        }
        return result
      })

      const progress = await service.generateChaptersBatch(
        projectId, 1, 3, () => {}, null, {}, undefined, { autoContinue: true }
      )
      expect(progress.status).toBe('completed')
      expect(progress.completed).toEqual([1, 2, 3])
      expect(await readFile(path.join(dir, '细纲', '细纲_第001章_测试章1.md'), 'utf-8')).toContain('提前完成整卷决战')
    })

    it('autoContinue stops at a chapter boundary once aborted, as paused', async () => {
      const service = new WriteService(ps, mockLlm(''))
      const controller = new AbortController()
      const spy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockImplementation(async (_pid, ch) => {
          // 第 2 章写完时用户点了「⏹ 停止」
          if (ch === 2) controller.abort()
          return makeFlowResult(ch, `第${ch}章正文`)
        })

      const completed: number[] = []
      const progress = await service.generateChaptersBatch(
        projectId,
        1,
        10,
        (chapter) => completed.push(chapter),
        null,
        { signal: controller.signal },
        undefined,
        { autoContinue: true }
      )

      // 停在章与章之间：已完成的章都保留，状态是 paused 而不是 failed，
      // 这样「继续下一章」从第 3 章接着跑，不会重写已经写好的第 2 章。
      expect(progress.status).toBe('paused')
      expect(progress.currentChapter).toBe(2)
      expect(progress.completed).toEqual([1, 2])
      expect(completed).toEqual([1, 2])
      expect(spy).toHaveBeenCalledTimes(2)
      spy.mockRestore()
    })

    it('autoContinue still stops at the failing chapter', async () => {
      const service = new WriteService(ps, mockLlm(''))
      const spy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockImplementation(async (_pid, ch) => {
          if (ch === 3) throw new Error('LLM 超时')
          return makeFlowResult(ch, `第${ch}章正文`)
        })

      const progress = await service.generateChaptersBatch(
        projectId,
        1,
        5,
        () => {},
        null,
        {},
        undefined,
        { autoContinue: true }
      )

      expect(progress.status).toBe('failed')
      expect(progress.currentChapter).toBe(3)
      expect(progress.completed).toEqual([1, 2])
      expect(progress.error).toContain('LLM 超时')
      spy.mockRestore()
    })

    it('resumeChaptersBatch carries autoContinue to the rest of the range', async () => {
      const service = new WriteService(ps, mockLlm(''))
      const spy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockImplementation(async (_pid, ch) => makeFlowResult(ch, `第${ch}章正文`))

      const completed: number[] = []
      const progress = await service.resumeChaptersBatch(
        projectId,
        2,
        5,
        (chapter) => completed.push(chapter),
        null,
        {},
        { fromChapter: 1, total: 5, completed: [1, 2] },
        { autoContinue: true }
      )

      expect(progress.status).toBe('completed')
      expect(progress.total).toBe(5)
      expect(progress.completed).toEqual([1, 2, 3, 4, 5])
      expect(completed).toEqual([3, 4, 5])
      spy.mockRestore()
    })

    it('autoStrength: 按每章节奏算出不同的 strengthOverride 传给 runFullFlowForChapter', async () => {
      // 回归：批量续写不能像编辑器「采用建议」那样直接改写 provider 配置——
      // 那样跑完一批后 provider 会永久停在最后一章的建议值上。这里验证的是
      // strengthOverride 确实按每章的节奏数据分别算出、分别传下去，而不是
      // 全批用同一个值，也不是完全没生效。
      const dir = await ps.resolveDir(projectId)
      const { writeFile, mkdir } = await import('fs/promises')
      await mkdir(path.join(dir, '图解'), { recursive: true })
      await writeFile(
        path.join(dir, '图解', '节奏图谱.html'),
        [
          '<script>',
          'const rhythmData = [',
          "  { chapter: 1, title: '大高潮', emotion: 5, climax: 3, volume: 1, actualized: false },",
          "  { chapter: 2, title: '过渡章', emotion: 2, climax: 0, volume: 1, actualized: false },",
          "  { chapter: 3, title: '常规章', emotion: 5, climax: 1, volume: 1, actualized: false }",
          '];',
          '</script>'
        ].join('\n'),
        'utf-8'
      )

      const service = new WriteService(ps, mockLlm(''))
      const spy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockImplementation(async (_pid, ch) => makeFlowResult(ch, `第${ch}章正文`))

      await service.generateChaptersBatch(
        projectId,
        1,
        3,
        () => {},
        null,
        {},
        undefined,
        { autoContinue: true, autoStrength: true }
      )

      expect(spy).toHaveBeenCalledTimes(3)
      // 第 1 章：爽点 3 级大高潮 -> 拉满
      expect(spy.mock.calls[0][3]).toMatchObject({
        strengthOverride: { temperature: 1.0, reasoningEffort: 'high' }
      })
      // 第 2 章：情绪 2、无爽点的过渡章 -> 求稳
      expect(spy.mock.calls[1][3]).toMatchObject({
        strengthOverride: { temperature: 0.6, reasoningEffort: 'low' }
      })
      // 第 3 章：情绪 5、爽点 1，不满足前两条 -> 默认档
      expect(spy.mock.calls[2][3]).toMatchObject({
        strengthOverride: { temperature: 0.8, reasoningEffort: 'medium' }
      })
      spy.mockRestore()
    })

    it('autoStrength 关闭（默认）时不传 strengthOverride，行为与之前一致', async () => {
      const service = new WriteService(ps, mockLlm(''))
      const spy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockImplementation(async (_pid, ch) => makeFlowResult(ch, `第${ch}章正文`))

      await service.generateChaptersBatch(projectId, 1, 1, () => {})

      expect(spy.mock.calls[0][3]).toMatchObject({ strengthOverride: undefined })
      spy.mockRestore()
    })

    it('autoStrength 打开但这章没有节奏数据时，用默认档而不是报错中断整批', async () => {
      const service = new WriteService(ps, mockLlm(''))
      const spy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockImplementation(async (_pid, ch) => makeFlowResult(ch, `第${ch}章正文`))

      const progress = await service.generateChaptersBatch(
        projectId,
        1,
        1,
        () => {},
        null,
        {},
        undefined,
        { autoStrength: true }
      )

      expect(progress.status).toBe('completed')
      expect(spy.mock.calls[0][3]).toMatchObject({
        strengthOverride: { temperature: 0.8, reasoningEffort: 'medium' }
      })
      spy.mockRestore()
    })

    describe('429 限流退避重试', () => {
      afterEach(() => {
        vi.useRealTimers()
      })

      it('限流后按 30s/60s/120s 退避重试，重试成功则整批继续', async () => {
        // 回归：连续模式背靠背打请求最容易撞限流，之前是零重试，整批直接停在这一章，
        // 逼用户手动点「重试」。这里验证撞限流后会自己扛，不用人管。
        vi.useFakeTimers()
        const service = new WriteService(ps, mockLlm(''))
        let calls = 0
        const spy = vi.spyOn(service, 'runFullFlowForChapter').mockImplementation(async (_pid, ch) => {
          calls++
          if (calls <= 2) throw new Error('LLM_RATE_LIMIT')
          return makeFlowResult(ch, `第${ch}章正文`)
        })
        const waits: [number, number, number, number][] = []
        let started!: () => void
        const firstRetry = new Promise<void>((resolve) => { started = resolve })
        const onRetryWait = (chapter: number, attempt: number, maxAttempts: number, waitMs: number): void => {
          waits.push([chapter, attempt, maxAttempts, waitMs])
          started()
        }

        const promise = service.generateChaptersBatch(
          projectId,
          9,
          9,
          () => {},
          null,
          {},
          undefined,
          { autoContinue: true },
          onRetryWait
        )
        await firstRetry
        await vi.advanceTimersByTimeAsync(30_000) // 第 1 次重试的等待
        await vi.advanceTimersByTimeAsync(60_000) // 第 2 次重试的等待
        const progress = await promise

        expect(progress.status).toBe('completed')
        expect(progress.completed).toEqual([9])
        expect(calls).toBe(3)
        expect(waits).toEqual([
          [9, 1, 3, 30_000],
          [9, 2, 3, 60_000]
        ])
        spy.mockRestore()
      })

      it('重试次数用完仍限流则整批照常落 failed，行为跟之前一致，只是多等了几轮', async () => {
        vi.useFakeTimers()
        const service = new WriteService(ps, mockLlm(''))
        const spy = vi
          .spyOn(service, 'runFullFlowForChapter')
          .mockRejectedValue(new Error('LLM_RATE_LIMIT'))

        let started!: () => void
        const firstRetry = new Promise<void>((resolve) => { started = resolve })
        const promise = service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, undefined, started)
        await firstRetry
        await vi.advanceTimersByTimeAsync(30_000)
        await vi.advanceTimersByTimeAsync(60_000)
        await vi.advanceTimersByTimeAsync(120_000)
        const progress = await promise

        expect(progress.status).toBe('failed')
        expect(progress.error).toContain('LLM_RATE_LIMIT')
        // 初次 + 3 次重试 = 4 次调用
        expect(spy).toHaveBeenCalledTimes(4)
        spy.mockRestore()
      })

      it('非限流错误不重试，立刻失败', async () => {
        const service = new WriteService(ps, mockLlm(''))
        const spy = vi.spyOn(service, 'runFullFlowForChapter').mockRejectedValue(new Error('LLM 超时'))

        const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {})

        expect(progress.status).toBe('failed')
        expect(progress.error).toContain('LLM 超时')
        expect(spy).toHaveBeenCalledTimes(1)
        spy.mockRestore()
      })

      it('等待限流重试期间点「停止」能立刻打断，不用等满 30 秒', async () => {
        vi.useFakeTimers()
        const controller = new AbortController()
        const service = new WriteService(ps, mockLlm(''))
        let calls = 0
        const spy = vi
          .spyOn(service, 'runFullFlowForChapter')
          .mockImplementation(async (_pid, ch, _onProgress, opts) => {
            calls++
            if ((opts as { signal?: AbortSignal })?.signal?.aborted) throw new Error('LLM_ABORTED')
            if (calls === 1) throw new Error('LLM_RATE_LIMIT')
            return makeFlowResult(ch, `第${ch}章正文`)
          })

        let started!: () => void
        const firstRetry = new Promise<void>((resolve) => { started = resolve })
        const promise = service.generateChaptersBatch(
          projectId,
          1,
          1,
          () => {},
          null,
          { signal: controller.signal },
          undefined,
          undefined,
          started
        )
        // 让第一次调用先跑完、进入 30s 等待，再点停止——不推进任何真实/虚拟时间
        await firstRetry
        controller.abort()
        const progress = await promise

        expect(progress.status).toBe('failed')
        expect(progress.error).toContain('LLM_ABORTED')
        // 中止后由批量循环直接停止，不再进入一次无意义的生成调用。
        expect(calls).toBe(1)
        spy.mockRestore()
      })
    })

    it('returns completed when fromChapter === toChapter (single chapter)', async () => {
      const service = new WriteService(ps, mockLlm(''))
      const spy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockImplementation(async (_pid, ch) => makeFlowResult(ch, `第${ch}章正文`))

      const completed: number[] = []
      const progress = await service.generateChaptersBatch(
        projectId,
        5,
        5,
        (chapter) => completed.push(chapter)
      )

      expect(progress.status).toBe('completed')
      expect(progress.currentChapter).toBe(5)
      expect(progress.completed).toEqual([5])
      expect(completed).toEqual([5])
      expect(spy).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    })

    it('returns failed when runFullFlowForChapter throws', async () => {
      const service = new WriteService(ps, mockLlm(''))
      const spy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockRejectedValue(new Error('LLM 超时'))

      const progress = await service.generateChaptersBatch(
        projectId,
        1,
        3,
        () => {
          // 不应被调用
          expect.fail('onChapterComplete should not be called on failure')
        }
      )

      expect(progress.status).toBe('failed')
      expect(progress.currentChapter).toBe(1)
      expect(progress.completed).toEqual([])
      expect(progress.error).toContain('LLM 超时')
      spy.mockRestore()
    })

    it('resumeChaptersBatch continues from fromChapter + 1', async () => {
      const service = new WriteService(ps, mockLlm(''))
      const spy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockImplementation(async (_pid, ch) => makeFlowResult(ch, `第${ch}章正文`))

      // 从第 2 章继续到第 3 章（即 fromChapter=1 已完成，继续 2-3）
      const completed: number[] = []
      const progress = await service.resumeChaptersBatch(
        projectId,
        1,
        3,
        (chapter) => completed.push(chapter)
      )

      // 第 2 章完成后应暂停（因为还有第 3 章）
      expect(progress.status).toBe('paused')
      expect(progress.currentChapter).toBe(2)
      expect(progress.completed).toEqual([2])
      expect(completed).toEqual([2])
      expect(spy).toHaveBeenCalledWith(
        projectId,
        2,
        expect.any(Function),
        expect.objectContaining({ styleProfileId: null })
      )
      spy.mockRestore()
    })

    it('resumeChaptersBatch completes when only one chapter remains', async () => {
      const service = new WriteService(ps, mockLlm(''))
      const spy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockImplementation(async (_pid, ch) => makeFlowResult(ch, `第${ch}章正文`))

      // 从第 3 章继续到第 3 章（即只剩最后一章）
      const completed: number[] = []
      const progress = await service.resumeChaptersBatch(
        projectId,
        2,
        3,
        (chapter) => completed.push(chapter)
      )

      expect(progress.status).toBe('completed')
      expect(progress.currentChapter).toBe(3)
      expect(progress.completed).toEqual([3])
      expect(completed).toEqual([3])
      spy.mockRestore()
    })

    it('persists generated content in skill format so ProseRepo can read it back', async () => {
      const service = new WriteService(ps, mockLlm(''))
      const spy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockImplementation(async (_pid, ch) => makeFlowResult(ch, `第${ch}章的正文内容`))

      await service.generateChaptersBatch(projectId, 1, 1, () => {})

      // 回归：批量续写必须写成技能格式 `正文/第NNN章 标题.md`。
      // 早先直接 ProseRepo.write(ch, content) 缺 title，落到旧格式 001.md，
      // 而 read() 优先技能格式——该章只要在编辑器存过一次，批量结果就永远读不回来。
      const dir = await ps.resolveDir(projectId)
      const { readdir } = await import('fs/promises')
      const files = await readdir(path.join(dir, '正文'))
      expect(files.some((f) => f.startsWith('第001章') && f.endsWith('.md'))).toBe(true)
      expect(files).not.toContain('001.md')

      // 最关键的一条：写完之后读得回来
      const readBack = await new ProseRepo(dir).read(1)
      expect(readBack).toBe('第1章的正文内容')
      spy.mockRestore()
    })

    it('批量续写拒绝覆盖同章已有的技能格式正文', async () => {
      const dir = await ps.resolveDir(projectId)
      const { mkdir, writeFile } = await import('fs/promises')
      await mkdir(path.join(dir, '正文'), { recursive: true })
      // 模拟该章此前在编辑器保存过（技能格式）
      await writeFile(path.join(dir, '正文', '第001章 旧标题.md'), '旧的正文', 'utf-8')

      const service = new WriteService(ps, mockLlm(''))
      const spy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockImplementation(async (_pid, ch) => makeFlowResult(ch, `第${ch}章的新正文`))

      const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {})

      expect(await new ProseRepo(dir).read(1)).toBe('旧的正文')
      expect(progress.status).toBe('failed')
      expect(progress.error).toContain('已有正文')
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    it('落盘失败时保存独立恢复稿，不误发章节完成事件', async () => {
      const service = new WriteService(ps, mockLlm(''))
      const flowSpy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockImplementation(async (_pid, ch) => makeFlowResult(ch, `第${ch}章的正文内容`))
      // 模拟磁盘写失败（文件被占用 / 无权限 / 节奏图谱写失败）
      const saveSpy = vi
        .spyOn(
          (service as unknown as { chapterService: { updateContent: unknown } }).chapterService,
          'updateContent' as never
        )
        .mockRejectedValue(new Error('EBUSY: resource busy or locked'))

      const delivered: Array<{ chapter: number; content: string }> = []
      const progress = await service.generateChaptersBatch(projectId, 1, 2, (chapter, result) =>
        delivered.push({ chapter, content: result.content })
      )

      expect(delivered).toEqual([])
      expect(progress.status).toBe('failed')
      expect(progress.error).toContain('保存失败')
      expect(progress.error).toContain('EBUSY')
      // 没存成就不算完成
      expect(progress.completed).toEqual([])
      const { readdir, readFile } = await import('fs/promises')
      const recoveryDir = path.join(await ps.resolveDir(projectId), '.cache', 'batch-drafts')
      const [recovery] = await readdir(recoveryDir)
      expect(await readFile(path.join(recoveryDir, recovery), 'utf-8')).toBe('第1章的正文内容')
      expect(progress.error).toContain(recovery)
      flowSpy.mockRestore()
      saveSpy.mockRestore()
    })

    it('resume 透传 batchState 时进度按整批统计，不从剩余段重新计数', async () => {
      const service = new WriteService(ps, mockLlm(''))
      const spy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockImplementation(async (_pid, ch) => makeFlowResult(ch, `第${ch}章正文`))

      // 整批 1-3，第 1 章已完成，现在续跑
      const progress = await service.resumeChaptersBatch(
        projectId,
        1,
        3,
        () => {},
        null,
        {},
        { fromChapter: 1, total: 3, completed: [1] }
      )

      expect(progress.status).toBe('paused')
      expect(progress.total).toBe(3)
      expect(progress.fromChapter).toBe(1)
      expect(progress.completed).toEqual([1, 2])
      expect(progress.current).toBe(2)
      spy.mockRestore()
    })
  })

  describe('runFullFlowForChapter (非 mock 集成测试)', () => {
    /**
     * C1 回归测试：验证步骤 3-6 收到的是步骤 1 生成的内存 content，
     * 而非从磁盘重新加载的空/过期内容。
     */
    it('passes generated content to all flow steps (not reloaded from disk)', async () => {
      const llm = mockLlm('')
      const service = new WriteService(ps, llm)
      const knownContent = '这是步骤1生成的正文内容，尚未落盘。'

      // 创建细纲文件（DetailedOutlineMdRepo 读 细纲/第NN卷.md）
      const dir = await ps.resolveDir(projectId)
      const { writeFile, mkdir } = await import('fs/promises')
      await mkdir(path.join(dir, '细纲'), { recursive: true })
      await writeFile(
        path.join(dir, '细纲', '第01卷.md'),
        '# 第01卷\n\n## 第1章：测试章节\n\n**核心事件：** 测试事件\n**爽点：** 测试爽点\n**章末钩子：** 测试钩子\n**本章写作要求：** 必须当面交接账册\n\n### 情节安排\n先验印章，再交账册，不得倒序。\n',
        'utf-8'
      )

      // 步骤 1：mock generateChapterStream 返回已知 content
      const genSpy = vi
        .spyOn(service, 'generateChapterStream')
        .mockResolvedValue(knownContent)

      // 步骤 3-6：spy flow 方法，记录 content 参数
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const flow = (service as unknown as { flow: any }).flow
      const outlineSpy = vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue('[]')
      const memSpy = vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue('{}')
      const rhythmSpy = vi.spyOn(flow, 'evaluateRhythmStream').mockResolvedValue('{}')
      const figSpy = vi.spyOn(flow, 'generateFigureStream').mockResolvedValue('{}')

      const result = await service.runFullFlowForChapter(projectId, 1, () => {})

      // 验证所有 flow 方法都收到了步骤 1 生成的 content
      expect(outlineSpy).toHaveBeenCalledWith(
        expect.stringContaining('必须当面交接账册'), // 完整细纲，不能只传核心事件
        knownContent,        // ← 关键：content 必须是步骤 1 生成的
        1,
        expect.any(Object)
      )
      expect(outlineSpy.mock.calls[0][0]).toContain('先验印章，再交账册，不得倒序。')
      expect(memSpy).toHaveBeenCalledWith(
        knownContent,        // ← 关键
        1,
        expect.any(Array),   // knownCharacters
        expect.any(Object),
      expect.any(Array)
      )
      // 批量流程不跑节奏评估/图解（结果既不回写也不落盘）
      expect(rhythmSpy).not.toHaveBeenCalled()
      expect(figSpy).not.toHaveBeenCalled()
      expect(result.rhythm).toBeNull()
      expect(result.figure.shouldGenerate).toBe(false)

      // 验证返回的 content 也是步骤 1 生成的
      expect(result.content).toBe(knownContent)
      // 有细纲且对照跑成：两个状态位都要立起来
      expect(result.outlineDiff.hasOutline).toBe(true)
      expect(result.outlineDiff.checked).toBe(true)

      genSpy.mockRestore()
      outlineSpy.mockRestore()
      memSpy.mockRestore()
      rhythmSpy.mockRestore()
      figSpy.mockRestore()
    })

    it('marks hasOutline=false when the chapter has no outline at all', async () => {
      // 没写任何细纲文件：diffs 同样是空的，但含义是"没得对照"而不是"对照通过"，
      // 批量面板的逐章小结靠这个标志区分，否则会给自由发挥的章发绿灯。
      const service = new WriteService(ps, mockLlm(''))
      const genSpy = vi.spyOn(service, 'generateChapterStream').mockResolvedValue('正文内容')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const flow = (service as unknown as { flow: any }).flow
      const outlineSpy = vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue('[]')
      vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue('{}')
      vi.spyOn(flow, 'evaluateRhythmStream').mockResolvedValue('{}')
      vi.spyOn(flow, 'generateFigureStream').mockResolvedValue('{}')

      const result = await service.runFullFlowForChapter(projectId, 1, () => {})

      expect(result.outlineDiff.hasOutline).toBe(false)
      expect(result.outlineDiff.checked).toBe(false)
      expect(result.outlineDiff.diffs).toEqual([])
      // 没细纲就不该白烧一次对照调用
      expect(outlineSpy).not.toHaveBeenCalled()
      genSpy.mockRestore()
      vi.restoreAllMocks()
    })

    it('isolates errors: one flow step failure does not abort others', async () => {
      const llm = mockLlm('')
      const service = new WriteService(ps, llm)
      const knownContent = '正文内容'

      // 必须真有细纲，否则对照步骤根本不会被调用，"抛错也不影响其他步骤"就成了空跑
      const dir = await ps.resolveDir(projectId)
      const { writeFile, mkdir } = await import('fs/promises')
      await mkdir(path.join(dir, '细纲'), { recursive: true })
      await writeFile(
        path.join(dir, '细纲', '第01卷.md'),
        [
          '# 第01卷',
          '',
          '## 第1章：测试章节',
          '',
          '**核心事件：** 测试事件',
          '**爽点：** 测试爽点',
          '**章末钩子：** 测试钩子',
          ''
        ].join('\n'),
        'utf-8'
      )

      const genSpy = vi
        .spyOn(service, 'generateChapterStream')
        .mockResolvedValue(knownContent)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const flow = (service as unknown as { flow: any }).flow
      // 细纲对照抛错
      const outlineSpy = vi.spyOn(flow, 'checkOutlineStream').mockRejectedValue(new Error('LLM 超时'))
      // 其他步骤正常
      const memSpy = vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue('{}')
      const rhythmSpy = vi.spyOn(flow, 'evaluateRhythmStream').mockResolvedValue('{}')
      const figSpy = vi.spyOn(flow, 'generateFigureStream').mockResolvedValue('{}')

      const result = await service.runFullFlowForChapter(projectId, 1, () => {})

      // 细纲对照失败 → 用空报告兜底
      expect(result.outlineDiff.diffs).toEqual([])
      expect(result.outlineDiff.passed).toBe(true)
      // 但不能让调用方把"没跑成"读成"对照通过"：本章有细纲，只是没检查成
      expect(result.outlineDiff.hasOutline).toBe(true)
      expect(result.outlineDiff.checked).toBe(false)
      // 其他步骤仍被调用
      expect(memSpy).toHaveBeenCalled()

      genSpy.mockRestore()
      outlineSpy.mockRestore()
      memSpy.mockRestore()
      rhythmSpy.mockRestore()
      figSpy.mockRestore()
    })

    it('calls onProgress with the batch step names in order', async () => {
      const llm = mockLlm('')
      const service = new WriteService(ps, llm)

      const genSpy = vi
        .spyOn(service, 'generateChapterStream')
        .mockResolvedValue('正文')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const flow = (service as unknown as { flow: any }).flow
      vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue('[]')
      vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue('{}')
      vi.spyOn(flow, 'evaluateRhythmStream').mockResolvedValue('{}')
      vi.spyOn(flow, 'generateFigureStream').mockResolvedValue('{}')

      const steps: string[] = []
      await service.runFullFlowForChapter(projectId, 1, (step) => steps.push(step))

      // 对照/提取/深审并行成一步；自动提交在审稿之后，提取时不改全书状态。
      expect(steps).toEqual([
        'generating',
        'audit',
        'postChecks',
        'memoryApply',
        'done'
      ])

      genSpy.mockRestore()
    })

    it('applies memory and settings after extract when autoMemorySync enabled', async () => {
      const llm = mockLlm('')
      const settings = {
        getProjectsRoot: async (fallback: string) => fallback,
        getReviewRules: async () => ({ enabled: false }),
        get: async () => ({ autoMemorySync: true, settingsEvolution: 'auto_high' })
      } as unknown as SettingsRepository
      const service = new WriteService(ps, llm, undefined, undefined, undefined, settings)

      const genSpy = vi
        .spyOn(service, 'generateChapterStream')
        .mockResolvedValue('林远打开木门走进院子。')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const flow = (service as unknown as { flow: any }).flow
      vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue('[]')
      vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(
        JSON.stringify({
          newPlotPoints: [{ title: '事件', event: '林远进院', coolPoint: '', evidence: '林远打开木门走进院子。' }],
          characterStateChanges: [],
          newCharacters: [],
          newLocations: [],
          newItems: [],
          newForeshadowings: [],
          collectedForeshadowings: []
        })
      )
      vi.spyOn(flow, 'evaluateRhythmStream').mockResolvedValue('{}')
      vi.spyOn(flow, 'generateFigureStream').mockResolvedValue('{}')

      const applyMemSpy = vi.spyOn(service, 'applyMemory')
      const applySetSpy = vi.spyOn(service, 'applySettingsPatches')

      await service.runFullFlowForChapter(projectId, 1, () => {})

      expect(applyMemSpy).toHaveBeenCalledTimes(1)
      expect(applySetSpy).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({ chapterNumber: 1 }),
        { onlyAuto: true }
      )

      genSpy.mockRestore()
      applyMemSpy.mockRestore()
      applySetSpy.mockRestore()
    })

    it('skips memory apply when autoMemorySync is false', async () => {
      const llm = mockLlm('')
      const settings = {
        getProjectsRoot: async (fallback: string) => fallback,
        getReviewRules: async () => ({ enabled: false }),
        get: async () => ({ autoMemorySync: false, settingsEvolution: 'auto_high' })
      } as unknown as SettingsRepository
      const service = new WriteService(ps, llm, undefined, undefined, undefined, settings)

      const genSpy = vi
        .spyOn(service, 'generateChapterStream')
        .mockResolvedValue('正文')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const flow = (service as unknown as { flow: any }).flow
      vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue('[]')
      vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue('{}')
      vi.spyOn(flow, 'evaluateRhythmStream').mockResolvedValue('{}')
      vi.spyOn(flow, 'generateFigureStream').mockResolvedValue('{}')

      const applyMemSpy = vi.spyOn(service, 'applyMemory')
      const steps: string[] = []
      await service.runFullFlowForChapter(projectId, 1, (step) => steps.push(step))

      expect(applyMemSpy).not.toHaveBeenCalled()
      expect(steps).not.toContain('memoryApply')
      expect(steps).toContain('postChecks')

      genSpy.mockRestore()
      applyMemSpy.mockRestore()
    })

    it('skips outline check when no detailed outline exists', async () => {
      const llm = mockLlm('')
      const service = new WriteService(ps, llm)

      const genSpy = vi
        .spyOn(service, 'generateChapterStream')
        .mockResolvedValue('正文')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const flow = (service as unknown as { flow: any }).flow
      const outlineSpy = vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue('[]')
      vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue('{}')
      vi.spyOn(flow, 'evaluateRhythmStream').mockResolvedValue('{}')
      vi.spyOn(flow, 'generateFigureStream').mockResolvedValue('{}')

      // 不创建任何细纲 → outlineText 为空 → 应跳过 checkOutlineStream
      const result = await service.runFullFlowForChapter(projectId, 1, () => {})

      expect(outlineSpy).not.toHaveBeenCalled()
      expect(result.outlineDiff.diffs).toEqual([])
      expect(result.outlineDiff.passed).toBe(true)

      genSpy.mockRestore()
      outlineSpy.mockRestore()
    })
  })

  /**
   * 回归测试：bug "chapter 1 meta not found"。
   * 原因：WriteService 用旧 ChapterRepository 读 chapter meta，新项目下 chapters/001.meta.json 不存在 → 抛错。
   * 修复：review/cast/relationships/buildChapterPrompt 改走 ChapterService（新数据源 ProseRepo + 节奏图谱 rhythmData）。
   */
  describe('regression: new data source (no chapters/*.meta.json)', () => {
    it('buildReviewPrompt succeeds for chapter 1 with new data source only', async () => {
      const dir = await ps.resolveDir(projectId)
      // 写节奏图谱 rhythmData 包含 chapter 1
      const { writeFile, mkdir } = await import('fs/promises')
      await mkdir(path.join(dir, '图解'), { recursive: true })
      await writeFile(
        path.join(dir, '图解', '节奏图谱.html'),
        `<script>\nconst rhythmData = [\n  { chapter: 1, title: '开局', emotion: 5, climax: 1, volume: 1, actualized: false }\n];\n</script>`,
        'utf-8'
      )
      // 写正文到 ProseRepo（新数据源）
      await new ProseRepo(dir).write(1, '这是第 1 章的正文。')

      const service = new WriteService(ps, mockLlm(''))
      // 关键断言：不应抛 "chapter 1 meta not found"
      await expect(service.buildReviewPrompt(projectId, 1)).resolves.toContain('第 1 章的正文')
    })

    it('buildReviewPrompt prefers provided draft content over repository content', async () => {
      const dir = await ps.resolveDir(projectId)
      const { writeFile, mkdir } = await import('fs/promises')
      await mkdir(path.join(dir, '图解'), { recursive: true })
      await writeFile(
        path.join(dir, '图解', '节奏图谱.html'),
        `<script>\nconst rhythmData = [\n  { chapter: 1, title: '开局', emotion: 5, climax: 1, volume: 1, actualized: false }\n];\n</script>`,
        'utf-8'
      )
      await new ProseRepo(dir).write(1, '')

      const service = new WriteService(ps, mockLlm(''))
      const prompt = await service.buildReviewPrompt(projectId, 1, '这是编辑器里尚未保存的正文')
      expect(prompt).toContain('这是编辑器里尚未保存的正文')
    })

    it('buildReviewPrompt 约束改写成品自身去 AI 味（禁止把一种套路换成另一种）', async () => {
      const dir = await ps.resolveDir(projectId)
      const { writeFile, mkdir } = await import('fs/promises')
      await mkdir(path.join(dir, '图解'), { recursive: true })
      await writeFile(
        path.join(dir, '图解', '节奏图谱.html'),
        `<script>\nconst rhythmData = [\n  { chapter: 1, title: '开局', emotion: 5, climax: 1, volume: 1, actualized: false }\n];\n</script>`,
        'utf-8'
      )
      await new ProseRepo(dir).write(1, '')

      const service = new WriteService(ps, mockLlm(''))
      const prompt = await service.buildReviewPrompt(projectId, 1, '正文内容。')
      // 改写成品必须自身去 AI 味的硬约束
      expect(prompt).toContain('改写"成品必须自身去 AI 味')
      // 关键禁用词必须在 prompt 里点名，防止 LLM 批评"仿佛"自己却写"缓缓"
      expect(prompt).toContain('仿佛')
      expect(prompt).toContain('缓缓')
      expect(prompt).toContain('眼中闪过')
      expect(prompt).toContain('嘴角勾起')
      expect(prompt).toContain('不是A，而是B')
    })

    it('detectCastStream succeeds for chapter 1 with new data source only', async () => {
      const dir = await ps.resolveDir(projectId)
      const { writeFile, mkdir } = await import('fs/promises')
      await mkdir(path.join(dir, '图解'), { recursive: true })
      await writeFile(
        path.join(dir, '图解', '节奏图谱.html'),
        `<script>\nconst rhythmData = [\n  { chapter: 1, title: '开局', emotion: 5, climax: 1, volume: 1, actualized: false }\n];\n</script>`,
        'utf-8'
      )
      await new ProseRepo(dir).write(1, '林远出场。')

      const service = new WriteService(ps, mockLlm(''))
      // 关键断言：不应抛 "chapter 1 meta not found"
      await expect(service.detectCastStream(projectId, 1)).resolves.toBeDefined()
    })

    it('detectCastStream prompt distinguishes appeared vs mentioned-only names', async () => {
      const dir = await ps.resolveDir(projectId)
      await new CharacterRepository(dir).create({ name: '沈清秋', role: '配角' })
      await new ProseRepo(dir).write(
        1,
        '苏九推门而入。段老虎说：沈清秋昨天提过赵四。'
      )

      const llm = mockLlm('[]')
      const service = new WriteService(ps, llm)
      await service.detectCastStream(projectId, 1)

      expect(llm.generateStream).toHaveBeenCalled()
      const [prompt, opts] = vi.mocked(llm.generateStream).mock.calls[0]
      expect(prompt).toContain('真正出场')
      expect(prompt).toContain('仅被提及')
      expect(prompt).toContain('appeared')
      expect(prompt).toContain('mentioned')
      expect(prompt).toContain('不要把「提到名字」当成出场')
      expect(prompt).toContain('沈清秋')
      expect(prompt).toContain('苏九推门而入')
      expect(opts?.meta).toEqual({ feature: 'cast', projectId })
    })

    it('buildChapterPrompt for chapter 1 does not throw on missing prev chapter', async () => {
      const dir = await ps.resolveDir(projectId)
      const { writeFile, mkdir } = await import('fs/promises')
      await mkdir(path.join(dir, '图解'), { recursive: true })
      await writeFile(
        path.join(dir, '图解', '节奏图谱.html'),
        `<script>\nconst rhythmData = [\n  { chapter: 1, title: '开局', emotion: 5, climax: 1, volume: 1, actualized: false }\n];\n</script>`,
        'utf-8'
      )
      // 关键：第 1 章之前没有第 0 章，旧实现会回退到 ChapterRepository.get(0) 抛错；新实现直接跳过
      const service = new WriteService(ps, mockLlm('正文'))
      await expect(service.buildChapterPrompt(projectId, 1)).resolves.toBeDefined()
    })
  })
})
