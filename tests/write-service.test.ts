import { describe, it, expect, vi, beforeEach } from 'vitest'
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

  it('generateChapterStream calls llm with assembled prompt', async () => {
    const llm = mockLlm('生成的正文')
    const service = new WriteService(ps, llm)
    const full = await service.generateChapterStream(projectId, 1)
    expect(full).toBe('生成的正文')
    expect(llm.generateStream).toHaveBeenCalled()
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

    it('persists generated content to ProseRepo on each chapter', async () => {
      const service = new WriteService(ps, mockLlm(''))
      const spy = vi
        .spyOn(service, 'runFullFlowForChapter')
        .mockImplementation(async (_pid, ch) => makeFlowResult(ch, `第${ch}章的正文内容`))

      await service.generateChaptersBatch(projectId, 1, 1, () => {})

      // 验证正文已写入 ProseRepo（正文/NNN.md，NNN 为章号零填充 3 位）
      const dir = await ps.resolveDir(projectId)
      const prosePath = path.join(dir, '正文', '001.md')
      const { readFile } = await import('fs/promises')
      const saved = await readFile(prosePath, 'utf-8')
      expect(saved).toBe('第1章的正文内容')
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
        '# 第01卷\n\n## 第1章：测试章节\n\n**核心事件：** 测试事件\n**爽点：** 测试爽点\n**章末钩子：** 测试钩子\n',
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
        expect.any(String), // outlineText
        knownContent,        // ← 关键：content 必须是步骤 1 生成的
        1,
        expect.any(Object)
      )
      expect(memSpy).toHaveBeenCalledWith(
        knownContent,        // ← 关键
        1,
        expect.any(Array),   // knownCharacters
        expect.any(Object)
      )
      expect(rhythmSpy).toHaveBeenCalledWith(
        knownContent,        // ← 关键
        1,
        expect.any(Number),  // expectedEmotion
        expect.any(Object)
      )
      expect(figSpy).toHaveBeenCalledWith(
        knownContent,        // ← 关键
        1,
        expect.any(Object)
      )

      // 验证返回的 content 也是步骤 1 生成的
      expect(result.content).toBe(knownContent)

      genSpy.mockRestore()
      outlineSpy.mockRestore()
      memSpy.mockRestore()
      rhythmSpy.mockRestore()
      figSpy.mockRestore()
    })

    it('isolates errors: one flow step failure does not abort others', async () => {
      const llm = mockLlm('')
      const service = new WriteService(ps, llm)
      const knownContent = '正文内容'

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
      // 其他步骤仍被调用
      expect(memSpy).toHaveBeenCalled()
      expect(rhythmSpy).toHaveBeenCalled()
      expect(figSpy).toHaveBeenCalled()

      genSpy.mockRestore()
      outlineSpy.mockRestore()
      memSpy.mockRestore()
      rhythmSpy.mockRestore()
      figSpy.mockRestore()
    })

    it('calls onProgress with all 7 step names in order', async () => {
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

      expect(steps).toEqual([
        'generating',
        'audit',
        'outlineCheck',
        'memoryExtract',
        'rhythmEval',
        'figureGen',
        'done'
      ])

      genSpy.mockRestore()
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
