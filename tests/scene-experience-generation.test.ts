import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import cases from './fixtures/scene-experience-cases.json'
import { createWritingProject } from './helpers/writing-project'
import { withPassingLongformGuard } from './helpers/passing-longform'
import { acceptedDeslop } from './helpers/accepted-deslop'
import { LibraryRepository } from '../src/main/data/library-repository'
import { OutlineRepository } from '../src/main/data/outline-repository'
import { ProjectService } from '../src/main/data/project-service'
import { SettingsRepository } from '../src/main/data/settings-repository'
import { StyleProfileService } from '../src/main/data/style-profile-service'
import { DetailedOutlineMdRepo } from '../src/main/data/skill-format/detailed-outline-md-repo'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { WriteService } from '../src/main/data/write-service'
import { joinContinuation } from '../src/shared/format-chapter-prose'
import type { GenerateOptions, LlmService } from '../src/main/data/llm-service'

const positive = '作者正向要求：让人物直接说出必要的犹豫。'
const negative = '作者负向要求：别添加旁观者替人物作解释。'
const bookRule = '本作只写当前人物听见与看见的事。'
const profile = '文风档案：克制叙述，长短句都服从人物呼吸。'
const rawSample = '文风分析原始样本中的情节标识，不能当本书事实。'

describe('关闭自动润色的首稿场景与按要求重写', () => {
  let root: string
  let dir: string
  let id: string
  let settings: SettingsRepository
  let projects: ProjectService
  let styleId: string
  let generate: ReturnType<typeof vi.fn<(text: string, options?: GenerateOptions) => Promise<string>>>
  let deslop: typeof acceptedDeslop
  let writer: WriteService

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'scene-experience-'))
    await mkdir(join(root, 'config'))
    settings = new SettingsRepository(join(root, 'config', 'settings.json'))
    await settings.update({ autoDeslopAfterContinue: false, chapterRuleOverrides: { deai: positive, negative } })
    projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
    const project = await createWritingProject(projects, { name: '回廊记', genre: '悬疑' })
    id = project.id
    dir = project.path
    await writeFile(join(dir, '设定', '本作规则.md'), bookRule)
    generate = vi.fn<(text: string, options?: GenerateOptions) => Promise<string>>(async () => '[]')
    const llm = withPassingLongformGuard({ generateStream: generate } as unknown as LlmService)
    const styles = new StyleProfileService(projects, llm, join(root, 'config', 'styles.json'))
    styleId = (await styles.create({
      name: '回廊语气', sourceType: 'sampleText', sampleText: rawSample, identifiedStyle: '克制',
      sentencePatterns: [], vocabularyPreferences: [], punctuationAndRhythm: [], narrativePerspective: [],
      tone: [], narrativeTemplates: [], styleConstraints: [], characterConstraints: [], plotConstraints: [],
      stylePrompt: profile
    })).id
    deslop = Object.assign(Object.create(acceptedDeslop) as typeof acceptedDeslop, { deslop: vi.fn(acceptedDeslop.deslop) })
    writer = new WriteService(projects, llm, undefined, undefined, undefined, settings, undefined, deslop)
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it.each([
    ['无纲续写', 'retreat', false, true],
    ['无纲空章', 'retreat', false, false],
    ['有纲续写', 'record', true, true],
    ['有纲空章', 'record', true, false]
  ] as const)('桌面和 Web 的交稿入口保留 %s 的作者材料及首稿', async (_name, key, hasOutline, continues) => {
    const sample = cases[key]
    const rules = '17.5 秒内只允许确认一次。'
    await writeFile(join(dir, '设定', '世界观', '背景设定.md'), '# 世界规则\n\n' + sample.world)
    const repo = new ProseRepo(dir)
    const outline = new OutlineRepository(dir)
    if (continues) await repo.write(1, sample.prefix)
    if (hasOutline) await outline.upsertDetailed({
      chapterNumber: 1, plotSummary: sample.plan, hook: sample.stop, wordEstimate: '不超过1600字', writingRequirements: rules
    })
    await outline.upsertDetailed({ chapterNumber: 2, plotSummary: sample.next })
    generate.mockImplementation(async (_prompt, options) => {
      if (options?.meta?.feature !== 'chapter') return '[]'
      options.onToken?.(sample.candidate)
      return sample.candidate
    })
    const onToken = vi.fn()
    const source = continues ? sample.prefix : ''
    const delivery = await writer.deliverChapter(id, 1, styleId, {
      existingText: source, tempContext: continues ? sample.instruction : sample.prefix + '\n' + sample.instruction, onToken
    })
    const final = joinContinuation(source, sample.candidate)
    expect(delivery).toMatchObject({ ok: true, fullContent: final, saved: { content: final } })
    expect(await repo.read(1)).toBe(final)
    expect(onToken).toHaveBeenCalledWith(sample.candidate)
    expect(deslop.deslop).not.toHaveBeenCalled()
    expect(generate.mock.calls.some(([, options]) => options?.meta?.feature === 'outline-generate')).toBe(false)
    const sent = generate.mock.calls.find(([, options]) => options?.meta?.feature === 'chapter')
    expect(sent).toBeDefined()
    const [user, options] = sent!
    const system = options?.systemPrompt ?? ''
    for (const data of [positive, negative, profile]) expect(system).toContain(data)
    for (const data of [bookRule, sample.world, sample.prefix, sample.instruction, sample.next]) expect(user).toContain(data)
    expect(system + user).not.toContain(rawSample)
    expect(system).not.toContain(sample.prefix)
    expect(user).not.toMatch(/执行清单|逐项核对|写前\/写后自检清单/)
    if (hasOutline) {
      expect(user.split(sample.plan)).toHaveLength(2)
      expect(user.split(sample.stop)).toHaveLength(2)
      expect(user.split(rules)).toHaveLength(2)
      expect(system).toContain('顺序铁律')
      expect(delivery.wordBudget?.bound).toBe('about')
    } else {
      expect(await new DetailedOutlineMdRepo(dir).readChapter(1)).toBeNull()
      expect(system + user).not.toContain('顺序铁律')
      expect(user).toContain('本章无细纲')
    }
  })

  it.each(['retreat', 'record'] as const)('按要求重写保留 %s 的原稿、规则与授权范围', async key => {
    const sample = cases[key]
    const draft = key === 'record' ? sample.draft.replace('其他方位未查', '所有广播提示都不可信') : sample.draft
    const source = sample.prefix + '\n\n' + draft
    await new ProseRepo(dir).write(1, source)
    await writeFile(join(dir, '设定', '世界观', '背景设定.md'), '# 世界规则\n\n' + sample.world)
    const final = sample.prefix + '\n\n' + sample.candidate
    generate.mockResolvedValue(final)
    const confirmed = '只重组指定场景的叙述，原有关键行动和结尾结果照旧。' +
      (key === 'record' ? '允许把全部不可信的结论缩回有证据的东侧单次失效。' : '')
    const result = await writer.adjustChapterStream(id, 1, source, sample.instruction,
      styleId, { previewOnly: true }, confirmed)
    expect(result).toBe(final)
    if (key === 'record') expect(result).not.toContain('所有广播提示都不可信')
    expect(await new ProseRepo(dir).read(1)).toBe(source)
    const [user, options] = generate.mock.calls.find(([, call]) => call?.meta?.feature === 'chapter-adjust')!
    expect(user).toContain(source)
    expect(user).toContain(confirmed)
    expect(user).toContain(sample.world)
    expect(user).toContain(sample.instruction)
    expect(options?.systemPrompt).toContain(profile)
    expect(options?.systemPrompt).toContain('其他情节、因果和信息边界以原稿为准')
    expect(options?.systemPrompt).not.toContain('顺序铁律')
  })

  it('只有标题、字数和章节要求时保留这些资料，不自动补剧情清单', async () => {
    const rules = '17.5 秒内只允许确认一次。'
    await writeFile(join(dir, '细纲', '细纲_第001章_还剩两行.md'),
      '# 细纲\n\n## 第 1 章：还剩两行\n\n- **字数预估**：不超过1200字\n- **本章写作要求**：' + rules)
    generate.mockResolvedValue(cases.record.candidate)
    await writer.generateChapterStream(id, 1, { tempContext: cases.record.instruction, autoDeslopAfterContinue: false })
    const [user, options] = generate.mock.calls.find(([, call]) => call?.meta?.feature === 'chapter')!
    expect(user).toContain('本章无细纲')
    expect(user).toContain('还剩两行')
    expect(user).toContain(rules)
    expect(user).toContain('1200 字')
    expect(options?.systemPrompt).not.toContain('顺序铁律')
    expect(generate.mock.calls.some(([, call]) => call?.meta?.feature === 'outline-generate')).toBe(false)
  })

  it('超出本章前部预算时在模型请求前拒绝，不截掉正文中段或覆盖原稿', async () => {
    const repo = new ProseRepo(dir)
    const original = cases.retreat.prefix
    await repo.write(1, original)
    const existingText = original + '甲'.repeat(40_001)
    await expect(writer.deliverChapter(id, 1, styleId, { existingText })).rejects.toThrow('CHAPTER_CONTEXT_TOO_LARGE')
    expect(generate).not.toHaveBeenCalled()
    expect(await repo.read(1)).toBe(original)
  })

  it('手机无纲预览若被事实核验发现扩大局部指引结论，保留原稿', async () => {
    const sample = cases.record
    const repo = new ProseRepo(dir)
    await repo.write(1, sample.prefix)
    const reference = '只有东侧广播指的台阶失过一次效'
    generate.mockImplementation(async (prompt, options) => {
      if (options?.meta?.feature === 'chapter') return sample.overgeneralized
      expect(options?.meta?.feature).toBe('longformGuard')
      expect(prompt).toContain(sample.prefix)
      expect(prompt).toContain(sample.overgeneralized)
      return JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item'], findings: [
        { kind: 'knowledge', message: '只证实东侧一次失效，其他方向尚未核实。', snippet: sample.overgeneralized, reference }
      ] })
    })
    const actualGuard = new WriteService(projects, { generateStream: generate } as unknown as LlmService,
      undefined, undefined, undefined, settings, undefined, deslop)
    await expect(actualGuard.generateChapterStream(id, 1, { previewOnly: true, existingText: sample.prefix,
      tempContext: sample.instruction })).rejects.toThrow(/LONGFORM_CONFLICT.*[\s\S]*其他方向尚未核实/)
    expect(await repo.read(1)).toBe(sample.prefix)
    expect(deslop.deslop).not.toHaveBeenCalled()
  })
})
