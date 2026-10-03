import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { WriteService, type ChapterGenerateOptions } from '../src/main/data/write-service'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { StyleProfileRepository } from '../src/main/data/style-profile-repository'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { countWords } from '../src/main/data/words'
import type { DeslopOptions, DeslopService } from '../src/main/data/deslop/deslop-service'
import type { GenerateOptions, LlmService } from '../src/main/data/llm-service'
import type { WriteFlowService } from '../src/main/data/write-flow-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type {
  AutoDeslopResult,
  ChapterSelfCheckReport,
  DeslopResult,
  StyleProfile
} from '../src/shared/types'

const RAW = [
  '林远缓缓推开院门，将账册放在守门人的桌上，等他核对印章。',
  '守门人翻到最后一页，用手指沿着红印的边缘摸了一圈，又从抽屉里取出旧账册，摊在同一张桌上。',
  '院里有人催他进门，林远没有动，只把沾着泥的鞋底在门槛旁擦干净，免得踩脏门后的青砖。',
  '两本账册上的印章对得上，守门人便挪开挡门的木凳，将钥匙递给林远，让他自己开东屋的锁。',
  '林远收好钥匙，绕过院中央那堆尚未劈开的柴，走到东屋门前，先听了听里面的动静。'
].join('\n')
const POLISHED = RAW.replace('缓缓推开', '推开').replace('用手指沿着', '手指沿着')

function deslopResult(rewritten: string, patch: Partial<DeslopResult> = {}): DeslopResult {
  return {
    rewritten,
    processedGates: ['A'],
    beforeWords: countWords(RAW),
    afterWords: countWords(rewritten),
    deleteRatio: 1 - countWords(rewritten) / countWords(RAW),
    remainingFindings: [],
    changeSummary: ['- 删掉重复的程度副词，保留事件与人物行为'],
    ...patch
  }
}

function style(id: string, identifiedStyle: string): StyleProfile {
  return {
    id,
    name: identifiedStyle,
    sourceType: 'sampleText',
    sampleText: '林远将钥匙收好。',
    identifiedStyle,
    sentencePatterns: ['行动在前'],
    vocabularyPreferences: ['朴素'],
    punctuationAndRhythm: ['顺着行动分段'],
    narrativePerspective: ['第三人称'],
    tone: ['克制'],
    narrativeTemplates: [],
    styleConstraints: ['保留日常细节'],
    characterConstraints: [],
    plotConstraints: ['不凭空增加道具'],
    dos: [],
    donts: [],
    stylePrompt: '按行动写，少做解释。',
    createdAt: '',
    updatedAt: ''
  }
}

const PASSED_CHECK: ChapterSelfCheckReport = {
  schemaVersion: 1,
  chapterNumber: 1,
  generatedAt: '',
  counts: { pass: 1, fail: 0, warn: 0, skip: 0 },
  items: [],
  ok: true,
  summary: '通过'
}

describe('自动写作去 AI 味', () => {
  let root: string
  let dir: string
  let projectId: string
  let projects: ProjectService
  let settings: SettingsRepository
  let service: WriteService
  let llm: LlmService
  let deslop: DeslopService
  let verifierReply: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'auto-deslop-'))
    settings = {
      getProjectsRoot: async (fallback: string) => fallback,
      getSettingsFile: () => path.join(root, 'settings.json'),
      get: async () => ({ autoMemorySync: false }),
      getReviewRules: async () => ({ enabled: false }),
      getDeslopRules: vi.fn().mockResolvedValue({})
    } as unknown as SettingsRepository
    projects = new ProjectService(
      path.join(root, 'projects'),
      new LibraryRepository(path.join(root, 'library.json')),
      settings
    )
    projectId = (await projects.create({ name: '院门交接', genre: '玄幻' })).id
    dir = await projects.resolveDir(projectId)
    verifierReply = JSON.stringify({ unchanged: true, issues: [] })
    llm = {
      generateStream: vi.fn(async (_prompt: string, opts: GenerateOptions = {}) => {
        if (opts.meta?.feature === 'deslop:verify') return verifierReply
        opts.onToken?.(RAW)
        return RAW
      })
    } as unknown as LlmService
    deslop = {
      deslop: vi.fn(async (_text: string, opts: DeslopOptions = {}) => {
        opts.onToken?.('润色日志：【改写后】与【改动说明】不属于正文。')
        return deslopResult(POLISHED)
      })
    } as unknown as DeslopService
    service = new WriteService(projects, llm, undefined, undefined, undefined, settings, undefined, deslop)
    mockPrompt()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    // mkdtemp 生成的测试目录只在系统临时目录内清理。
    const resolved = path.resolve(root)
    expect(resolved.startsWith(path.resolve(tmpdir()) + path.sep + 'auto-deslop-')).toBe(true)
    await rm(resolved, { recursive: true, force: true })
  })

  function mockPrompt(continueMode?: 'extend' | 'finish'): void {
    vi.spyOn(service, 'buildChapterPrompt').mockResolvedValue({
      system: '只输出本次新增正文。',
      user: '写院门交接。',
      targetWords: 2500,
      chapterTargetWords: 2500,
      writtenWords: 0,
      wordTarget: { targetWords: 2500, fromOutline: false, bound: 'min' },
      continueMode
    })
  }

  function results(): { onAutoDeslopResult: ReturnType<typeof vi.fn>; reports: AutoDeslopResult[] } {
    const reports: AutoDeslopResult[] = []
    return { reports, onAutoDeslopResult: vi.fn((report: AutoDeslopResult) => reports.push(report)) }
  }

  function verificationCalls(): Parameters<LlmService['generateStream']>[] {
    return vi.mocked(llm.generateStream).mock.calls.filter(([, opts]) => opts?.meta?.feature === 'deslop:verify')
  }

  it('先保留生成稿，再轻度润色、核验事实并返回最终稿，日志不混入正文流', async () => {
    const events: string[] = []
    const onToken = vi.fn()
    const onGenerationStage = vi.fn()
    const { reports, onAutoDeslopResult } = results()
    vi.mocked(deslop.deslop).mockImplementation(async (text, opts) => {
      events.push('deslop')
      expect(text).toBe(RAW)
      opts?.onToken?.('这是润色进度日志。')
      return deslopResult(POLISHED)
    })
    const options: ChapterGenerateOptions = {
      onToken,
      onGenerationStage,
      onAutoDeslopResult,
      onProseGenerated: (raw) => {
        expect(raw).toBe(RAW)
        events.push('raw')
      }
    }

    const content = await service.generateChapterStream(projectId, 1, options)

    expect(content).toBe(POLISHED)
    expect(events).toEqual(['raw', 'deslop'])
    expect(onToken.mock.calls.flat().join('')).toBe(RAW)
    expect(onGenerationStage.mock.calls.map(([stage]) => stage)).toEqual(['generating', 'deslop'])
    expect(deslop.deslop).toHaveBeenCalledWith(RAW, expect.objectContaining({ levelOverride: 'mild', isTail: true }))
    expect(verificationCalls()).toHaveLength(1)
    expect(verificationCalls()[0][0]).toContain(RAW)
    expect(verificationCalls()[0][0]).toContain(POLISHED)
    expect(reports).toEqual([expect.objectContaining({ status: 'applied', remainingIssues: 0, message: expect.any(String) })])
  })

  it('沿用用户禁用词、规则覆盖、项目白名单及本次选择的文风', async () => {
    vi.mocked(settings.getDeslopRules).mockResolvedValue({
      bannedWords: ['缓缓', '微微'],
      textOverrides: { systemPrompt: '不要改动事实。', gateA: '删掉重复的程度副词。' }
    })
    await writeFile(path.join(dir, '.deslop-whitelist'), '# 项目用语\n灵气\n青砖\n', 'utf-8')
    await new StyleProfileRepository(root).write({
      schemaVersion: 1,
      items: [style('default', '默认冷峻'), style('selected', '朴素口语')]
    })
    await projects.updateProjectData(projectId, { defaultStyleProfileId: 'default' })

    await service.generateChapterStream(projectId, 1, 'selected')

    const opts = vi.mocked(deslop.deslop).mock.calls[0][1]!
    expect(opts.bannedWords).toEqual(['缓缓', '微微'])
    expect(opts.whitelist).toEqual(new Set(['灵气', '青砖']))
    expect(opts.textOverrides).toEqual({ systemPrompt: '不要改动事实。', gates: { A: '删掉重复的程度副词。' } })
    expect(opts.styleContext).toMatchObject({ genre: '玄幻', style: { identifiedStyle: '朴素口语' } })
  })

  it.each(['extend', 'finish'] as const)('续写 %s 只润色新增片段并保留尾部语义', async (mode) => {
    mockPrompt(mode)
    const existingText = '林远跟着守门人来到院门外，见桌上放着一本旧账册。'

    const content = await service.generateChapterStream(projectId, 1, { existingText })

    expect(content).toBe(POLISHED)
    expect(deslop.deslop).toHaveBeenCalledWith(RAW, expect.objectContaining({ isTail: mode !== 'extend' }))
    expect(vi.mocked(deslop.deslop).mock.calls[0][0]).not.toContain(existingText)
  })

  it('正文未变时不浪费事实核验调用', async () => {
    vi.mocked(deslop.deslop).mockResolvedValue(deslopResult(RAW, { changeSummary: [] }))
    const { reports, onAutoDeslopResult } = results()

    expect(await service.generateChapterStream(projectId, 1, { onAutoDeslopResult })).toBe(RAW)

    expect(verificationCalls()).toHaveLength(0)
    expect(reports[0].status).toBe('unchanged')
  })

  it('只有标点调整时可直接采用，不额外调用事实核验', async () => {
    const candidate = RAW.replace('，', '；')
    vi.mocked(deslop.deslop).mockResolvedValue(deslopResult(candidate))
    const { reports, onAutoDeslopResult } = results()

    expect(await service.generateChapterStream(projectId, 1, { onAutoDeslopResult })).toBe(candidate)

    expect(verificationCalls()).toHaveLength(0)
    expect(reports[0].status).toBe('applied')
  })

  it.each([
    '- [需复核] 动机存在疑问，请作者确认。',
    '- [第2/3块] [已拒绝] 输出疑似被截断。'
  ])('含需人工处理标记时保留原稿：%s', async (summary) => {
    vi.mocked(deslop.deslop).mockResolvedValue(deslopResult(POLISHED, { changeSummary: [summary] }))
    const { reports, onAutoDeslopResult } = results()

    expect(await service.generateChapterStream(projectId, 1, { onAutoDeslopResult })).toBe(RAW)

    expect(reports[0].status).toBe('review_required')
    expect(verificationCalls()).toHaveLength(0)
  })

  it('仍有检测残留时保留原稿并报告残留数', async () => {
    vi.mocked(deslop.deslop).mockResolvedValue(deslopResult(POLISHED, {
      remainingFindings: [{
        gate: 'A', type: 'banned-word', line: 1, column: 3,
        severity: 'advisory', excerpt: '缓缓', message: '程度副词重复'
      }]
    }))
    const { reports, onAutoDeslopResult } = results()

    expect(await service.generateChapterStream(projectId, 1, { onAutoDeslopResult })).toBe(RAW)

    expect(reports[0]).toMatchObject({ status: 'review_required', remainingIssues: 1 })
    expect(verificationCalls()).toHaveLength(0)
  })

  it.each([
    ['总删除超过轻度预算', RAW.split('\n').slice(0, 3).join('\n')],
    ['扩写超过轻度预算', RAW + '\n天色暗下来，东屋门外的风吹着屋檐，院里的灯次第亮起，门房走进屋内取来一壶温水，放在木桌中央。']
  ])('%s 时不采用候选', async (_label, candidate) => {
    // 故意不信任服务报告里的比例，真实正文长度才决定能否自动采用。
    vi.mocked(deslop.deslop).mockResolvedValue(deslopResult(candidate, { deleteRatio: 0 }))
    const { reports, onAutoDeslopResult } = results()

    expect(await service.generateChapterStream(projectId, 1, { onAutoDeslopResult })).toBe(RAW)

    expect(reports[0].status).toBe('review_required')
    expect(verificationCalls()).toHaveLength(0)
  })

  it('候选混入非正文格式时保留生成稿', async () => {
    vi.mocked(deslop.deslop).mockResolvedValue(deslopResult('# 改写后正文\n' + POLISHED))
    const { reports, onAutoDeslopResult } = results()

    expect(await service.generateChapterStream(projectId, 1, { onAutoDeslopResult })).toBe(RAW)

    expect(reports[0].status).toBe('review_required')
  })

  it('精修候选大量复制本章前文时保留原稿', async () => {
    const existingText = [
      '沈棠沿着河岸走了半里，终于在桥洞下面找到昨夜失踪的船夫，船夫的鞋被水冲走，左腿抵着一块青石。',
      '船夫说自己听见桥上有人喊他的名字，刚抬头就被一根木棍打中肩膀，只得翻过栏杆跳进水里，贴着河底的淤泥往岸边爬。',
      '沈棠解下腰带，将船夫受伤的左腿绑好，又把自己随身带的银子塞进他手里，让他请附近的郎中来看看。',
      '桥洞口的脚印在水边断了，沈棠拎起那根留在青石旁的木棍，见木棍末端缠着一圈蓝布。',
      '他没有回城，先去对岸找打渔的老吴，老吴这些天都在桥附近撒网，或许见过那人的衣裳。'
    ].join('\n')
    mockPrompt('finish')
    vi.mocked(deslop.deslop).mockResolvedValue(deslopResult(existingText))
    const { reports, onAutoDeslopResult } = results()

    expect(await service.generateChapterStream(projectId, 1, { existingText, onAutoDeslopResult })).toBe(RAW)

    expect(reports[0].status).toBe('review_required')
  })

  it.each([
    JSON.stringify({ unchanged: false, issues: ['人物行为发生变化'] }),
    JSON.stringify({ unchanged: true, issues: ['新增了道具'] }),
    JSON.stringify({ unchanged: true }),
    '无法确定是否保持原文事实'
  ])('事实对比未明确通过时保留原稿：%s', async (reply) => {
    verifierReply = reply
    const { reports, onAutoDeslopResult } = results()

    expect(await service.generateChapterStream(projectId, 1, { onAutoDeslopResult })).toBe(RAW)

    expect(verificationCalls()).toHaveLength(1)
    expect(reports[0].status).toBe('review_required')
  })

  it.each(['润色', '事实核验'])('%s 调用失败时保留生成稿并明确报告失败', async (step) => {
    if (step === '润色') {
      vi.mocked(deslop.deslop).mockRejectedValue(new Error('LLM_TIMEOUT'))
    } else {
      vi.mocked(llm.generateStream).mockImplementation(async (_prompt, opts = {}) => {
        if (opts.meta?.feature === 'deslop:verify') throw new Error('LLM_TIMEOUT')
        return RAW
      })
    }
    const { reports, onAutoDeslopResult } = results()

    expect(await service.generateChapterStream(projectId, 1, { onAutoDeslopResult })).toBe(RAW)

    expect(reports[0]).toMatchObject({ status: 'failed', message: expect.any(String) })
  })

  it('停止润色时传播 LLM_ABORTED，不把取消当成可恢复的润色失败', async () => {
    vi.mocked(deslop.deslop).mockRejectedValue(new Error('LLM_ABORTED'))
    const { reports, onAutoDeslopResult } = results()

    await expect(service.generateChapterStream(projectId, 1, { onAutoDeslopResult })).rejects.toThrow('LLM_ABORTED')

    expect(reports.some((report) => report.status === 'failed')).toBe(false)
  })

  it('分块润色因取消返回部分结果时也不能自动采用', async () => {
    const controller = new AbortController()
    vi.mocked(deslop.deslop).mockImplementation(async () => {
      controller.abort()
      return deslopResult(POLISHED)
    })
    const { reports, onAutoDeslopResult } = results()

    await expect(service.generateChapterStream(projectId, 1, {
      signal: controller.signal, onAutoDeslopResult
    })).rejects.toThrow('LLM_ABORTED')

    expect(reports).toHaveLength(0)
    expect(verificationCalls()).toHaveLength(0)
  })

  it('开始前已停止时不调用正文生成或润色', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(service.generateChapterStream(projectId, 1, { signal: controller.signal })).rejects.toThrow('LLM_ABORTED')

    expect(llm.generateStream).not.toHaveBeenCalled()
    expect(deslop.deslop).not.toHaveBeenCalled()
  })

  it('正文原本违反格式护栏时仍报生成失败，不进入润色回退', async () => {
    vi.mocked(llm.generateStream).mockResolvedValue('# 本章正文\n' + RAW)

    await expect(service.generateChapterStream(projectId, 1)).rejects.toThrow('LLM_PROSE_FORMAT')

    expect(deslop.deslop).not.toHaveBeenCalled()
  })

  it('按要求重写完成后同样自动轻度润色并返回最终稿', async () => {
    vi.spyOn(service, 'buildAdjustChapterPrompt').mockResolvedValue({
      system: '按要求修改正文。', user: '加强院门交接中的行动。'
    })
    const { reports, onAutoDeslopResult } = results()

    const content = await service.adjustChapterStream(projectId, 1, RAW, '让动作更简洁', {
      onAutoDeslopResult
    })

    expect(content).toBe(POLISHED)
    expect(deslop.deslop).toHaveBeenCalledWith(RAW, expect.objectContaining({ levelOverride: 'mild', isTail: true }))
    expect(verificationCalls()).toHaveLength(1)
    expect(reports[0].status).toBe('applied')
  })

  it('批量完整流程在质检、细纲对照和记忆同步中使用最终正文并返回精修报告', async () => {
    await mkdir(path.join(dir, '细纲'), { recursive: true })
    await writeFile(path.join(dir, '细纲', '第01卷.md'),
      '# 第01卷\n\n## 第1章：院门交接\n\n**核心事件：** 交付账册，核对印章后取得钥匙。\n', 'utf-8')
    const flow = (service as unknown as { flow: WriteFlowService }).flow
    const audit = vi.spyOn(service, 'auditChapter').mockResolvedValue({
      schemaVersion: 1, wordCount: countWords(POLISHED),
      counts: { error: 0, warn: 0, info: 0 },
      passed: { ending: true, forbiddenWords: true, wordCount: true }, violations: []
    })
    vi.spyOn(service, 'selfCheckChapter').mockResolvedValue(PASSED_CHECK)
    const outline = vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue('[]')
    const memory = vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(JSON.stringify({
      chapterNumber: 1, newCharacters: [], newLocations: [], newItems: [],
      newForeshadowings: [], newPlotPoints: [], characterStateChanges: [], collectedForeshadowings: []
    }))
    const sync = vi.spyOn(service, 'syncChapterAfterWrite').mockResolvedValue(null)
    const onProgress = vi.fn()

    const result = await service.runFullFlowForChapter(projectId, 1, onProgress, {
      onContentGenerated: async (content) => { await new ProseRepo(dir).write(1, content) }
    })

    expect(result.content).toBe(POLISHED)
    expect(result.autoDeslop).toMatchObject({ status: 'applied', remainingIssues: 0 })
    expect(await new ProseRepo(dir).read(1)).toBe(POLISHED)
    expect(audit).toHaveBeenCalledWith(projectId, POLISHED)
    expect(outline).toHaveBeenCalledWith(expect.any(String), POLISHED, 1, expect.any(Object))
    expect(memory).toHaveBeenCalledWith(POLISHED, 1, expect.any(Array), expect.any(Object), expect.any(Array))
    expect(sync).toHaveBeenCalledWith(projectId, 1, POLISHED, expect.any(Object))
    expect(onProgress.mock.calls.map(([step]) => step)).toContain('deslop')
  })

  it('批量润色期间停止会保留独立恢复稿，继续时重新生成未保存章节', async () => {
    await mkdir(path.join(dir, '细纲'), { recursive: true })
    await writeFile(path.join(dir, '细纲', '第01卷.md'),
      '# 第01卷\n\n## 第1章：院门交接\n\n**核心事件：** 核对印章后取得钥匙。\n', 'utf-8')
    const flow = (service as unknown as { flow: WriteFlowService }).flow
    vi.spyOn(service, 'selfCheckChapter').mockResolvedValue(PASSED_CHECK)
    vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue('[]')
    const memory = vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(JSON.stringify({
      chapterNumber: 1, newCharacters: [], newLocations: [], newItems: [],
      newForeshadowings: [], newPlotPoints: [], characterStateChanges: [], collectedForeshadowings: []
    }))
    const sync = vi.spyOn(service, 'syncChapterAfterWrite').mockResolvedValue(null)
    vi.spyOn(service, 'generateChapterSummary').mockResolvedValue({
      chapterNumber: 1, sourceHash: 'summary', generatedAt: '',
      events: [], stateChanges: [], openThreads: [], stale: false
    })
    const generate = vi.spyOn(service, 'generateChapterStream')
    const onChapterComplete = vi.fn()
    const onAutoDeslopResult = vi.fn()
    const controller = new AbortController()
    vi.mocked(deslop.deslop).mockImplementationOnce(async () => {
      controller.abort()
      return deslopResult(POLISHED)
    })

    const paused = await service.generateChaptersBatch(projectId, 1, 1, onChapterComplete, {
      signal: controller.signal, onAutoDeslopResult
    })

    expect(paused.status).toBe('paused')
    expect(paused.completed).toEqual([])
    expect(paused.pendingPostProcessChapter).toBeUndefined()
    expect(await new ProseRepo(dir).read(1)).toBe('')
    expect(onChapterComplete).not.toHaveBeenCalled()
    expect(onAutoDeslopResult).not.toHaveBeenCalled()
    expect(memory).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
    const recoveryDir = path.join(dir, '.cache', 'batch-drafts')
    const files = await readdir(recoveryDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^chapter-1-\d+\.md$/)
    expect(await readFile(path.join(recoveryDir, files[0]), 'utf-8')).toBe(RAW)
    expect(paused.pauseReason).toContain(path.join(recoveryDir, files[0]))

    const resumed = await service.resumeChaptersBatch(projectId, 1, 1, onChapterComplete,
      null, { onAutoDeslopResult }, paused)

    expect(resumed.status).toBe('completed')
    expect(resumed.completed).toEqual([1])
    expect(generate).toHaveBeenCalledTimes(2)
    expect(await new ProseRepo(dir).read(1)).toBe(POLISHED)
    expect(memory).toHaveBeenCalledOnce()
    expect(sync).toHaveBeenCalledOnce()
    expect(onChapterComplete).toHaveBeenCalledOnce()
    expect(onAutoDeslopResult).toHaveBeenCalledWith(expect.objectContaining({ status: 'applied' }), 1)
    expect(await readFile(path.join(recoveryDir, files[0]), 'utf-8')).toBe(RAW)
  })

  it('旧测试适配器不注入润色服务时继续返回正文原稿', async () => {
    service = new WriteService(projects, llm)
    mockPrompt()

    expect(await service.generateChapterStream(projectId, 1)).toBe(RAW)

    expect(deslop.deslop).not.toHaveBeenCalled()
    expect(verificationCalls()).toHaveLength(0)
  })
})
