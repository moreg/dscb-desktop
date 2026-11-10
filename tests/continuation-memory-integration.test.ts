import { withPassingLongformGuard } from './helpers/passing-longform'
import { createWritingProject } from './helpers/writing-project'
import { acceptedDeslop } from './helpers/accepted-deslop'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { WriteService } from '../src/main/data/write-service'
import { WriteFlowService } from '../src/main/data/write-flow-service'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { OutlineRepository } from '../src/main/data/outline-repository'
import { MemoryWriter } from '../src/main/data/memory-writer'
import { CharacterRepo } from '../src/main/data/memory/character-repo'
import { ChapterSummaryRepo } from '../src/main/data/memory/chapter-summary-repo'
import { readLongformReviewState } from '../src/main/data/longform-review-state'
import { StyleProfileService } from '../src/main/data/style-profile-service'
import { ChapterService } from '../src/main/data/chapter-service'
import { hashProse } from '../src/main/data/memory/prose-memory-index'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

describe('续写质量与长篇记忆集成', () => {
  let root: string
  let dir: string
  let id: string
  let service: WriteService
  let projects: ProjectService
  let generateStream: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'continuation-memory-'))
    const settings = { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository
    projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
    id = (await createWritingProject(projects, { name: '长篇证据', genre: '玄幻' })).id
    dir = await projects.resolveDir(id)
    generateStream = vi.fn().mockResolvedValue('{}')
    const llm = { generateStream } as unknown as LlmService
    service = new WriteService(projects, withPassingLongformGuard(llm), undefined, undefined, undefined, undefined, undefined, acceptedDeslop)
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it.each(['continue', 'rewrite'] as const)('手机 %s 只返回候选，正文、概要和待审核状态不变', async mode => {
    const repo = new ProseRepo(dir)
    const source = '宋禾把账本放在窗边，低声问：“船还在吗？'
    const draft = mode === 'continue' ? '”岸边传来橹声。' : '我把账本放在窗边，听见岸上传来的橹声。'
    await repo.write(1, source)
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 1, plotSummary: '宋禾等待渡船。' })
    const before = await readLongformReviewState(dir)
    generateStream.mockResolvedValue(draft)
    const deslop = Object.assign(Object.create(acceptedDeslop) as typeof acceptedDeslop, {
      deslop: vi.fn(acceptedDeslop.deslop)
    })
    const writer = new WriteService(projects, withPassingLongformGuard({ generateStream } as unknown as LlmService),
      undefined, undefined, undefined, undefined, undefined, deslop)

    const result = mode === 'continue'
      ? await writer.generateChapterStream(id, 1, { previewOnly: true, existingText: source, autoDeslopAfterContinue: true })
      : await writer.adjustChapterStream(id, 1, source, '改为第一人称。', { previewOnly: true })
    expect(result).toBe(draft)
    expect(deslop.deslop).toHaveBeenCalledWith(draft, expect.anything())
    expect(await repo.read(1)).toBe(source)
    expect((await new ChapterService(projects).getChapter(id, 1)).meta.autoDeslop).toBeUndefined()
    expect(await new ChapterSummaryRepo(dir).read(1)).toBeNull()
    expect(await readLongformReviewState(dir)).toEqual(before)
    expect(generateStream.mock.calls.map(([, opts]) => opts?.meta?.feature))
      .toEqual([mode === 'continue' ? 'chapter' : 'chapter-adjust'])
  })

  it.each(['正文', '细纲'] as const)('提示组装完成后作者修改%s，旧提示生成结果不能覆盖当前版本', async changed => {
    const repo = new ProseRepo(dir)
    const source = '沈禾站在渡口等船。'
    const newSource = '沈禾带着儿子到了渡口。'
    await repo.write(1, source)
    const outline = new OutlineRepository(dir)
    await outline.upsertDetailed({ chapterNumber: 1, plotSummary: '沈禾在渡口等空船。' })
    const build = service.buildChapterPrompt.bind(service)
    vi.spyOn(service, 'buildChapterPrompt').mockImplementationOnce(async (...args) => {
      const prompt = await build(...args)
      if (changed === '正文') await repo.write(1, newSource)
      else await outline.upsertDetailed({ chapterNumber: 1, plotSummary: '沈禾在渡口等载着家人的船。' })
      return prompt
    })
    generateStream.mockResolvedValue('空船从下游划过来，船头的油灯刚熄。')
    await expect(service.generateChapterStream(id, 1, { existingText: source }))
      .rejects.toThrow(changed === '正文' ? 'CHAPTER_REVISION_CONFLICT' : 'LONGFORM_CONTEXT_CHANGED')
    expect(await repo.read(1)).toBe(changed === '正文' ? newSource : source)
  })

  it('实际发送的新章和续写消息同时保留作者规则、选定文风、计划和场景资料', async () => {
    const bookRule = '涨潮后东侧石阶会被水淹。'
    const negative = '作者负向要求：保留旧港方言，不使用现代网络梗。'
    const positive = '作者正向要求：保持第三人称限知视角。'
    const instruction = '本段改用第一人称，停在关窗后的平静处。'
    await writeFile(join(dir, '设定', '港口规则.md'), `# 港口规则\n\n${bookRule}`)
    await new CharacterRepo(dir).create({ name: '宋禾', role: '主角', personality: '遇事习惯先让孩子走' })
    const outline = new OutlineRepository(dir)
    await outline.upsertDetailed({ chapterNumber: 2, plotSummary: '次日宋禾收到认领通知。' })
    const settings = { get: async () => ({ chapterRuleOverrides: { negative, dialogue: positive } }),
      getSettingsFile: () => join(root, 'settings.json') } as unknown as SettingsRepository
    const llm = withPassingLongformGuard({ generateStream } as unknown as LlmService)
    const styles = new StyleProfileService(projects, llm, join(root, 'styles.json'))
    const style = await styles.create({
      name: '旧港语调', sourceType: 'sampleText', sampleText: '', identifiedStyle: '克制平实',
      sentencePatterns: [], vocabularyPreferences: [], punctuationAndRhythm: [], narrativePerspective: [],
      tone: [], narrativeTemplates: [], styleConstraints: [], characterConstraints: [], plotConstraints: [],
      stylePrompt: '动作紧时写短，停下来思考时可用长句。'
    })
    const writer = new WriteService(projects, llm, undefined, undefined, undefined, settings)
    generateStream.mockResolvedValue('窗框上积着一条细细的水线。')
    const scenes = [
      '宋禾得在守桥人拦下她前说服孩子先走。', '船工扶住梯子，宋禾托孩子过栏杆。',
      '邻居笑宋禾等涨潮才想起晒鱼。', '潮水淹到石阶，宋禾带孩子绕去西门。',
      '宋禾攀住松动的铁梯，左手腾不出来。', '宋禾独坐在窗前，想起自己忘了收衣服。'
    ]
    for (const [i, scene] of scenes.entries()) {
      await outline.upsertDetailed({ chapterNumber: 1, plotSummary: scene, wordEstimate: '2500',
        charactersAppearing: ['宋禾'], hook: '停在窗边，不写第二天。' })
      const start = i % 3 === 0 ? '' : i % 3 === 1 ? '宋禾握住窗闩，还在犹豫。' : '宋禾等着天色暗下去。'.repeat(240)
      await writer.generateChapterStream(id, 1, style.id, { previewOnly: true, existingText: start, tempContext: instruction })
      const [user, options] = generateStream.mock.calls.at(-1)!
      const system = options.systemPrompt as string
      for (const value of [style.stylePrompt, negative, positive, '本次临时要求优先', '顺畅协作',
        '一句一段也可以是一句有层次的长句', '避免机械问答']) expect(system).toContain(value)
      for (const value of [bookRule, scene, '宋禾', '次日宋禾收到认领通知', '停在窗边，不写第二天。', instruction]) {
        expect(user).toContain(value)
      }
      if (start) expect(user).toContain(start)
      expect(system + user).not.toMatch(/章末必须以.*(?:对话|事件).*结尾|旁白只补必要内容|优先用对话推进剧情/)
    }
  })

  it('生成服务为手机和批量调用返回纯正文，同时保留流式伏笔回执供编辑器处理', async () => {
    const raw = '他在门上看见 Keep Out，便收回了手。\n\n【本章伏笔回执】\n{"planted":["门上的警告"],"collected":[]}'
    generateStream.mockImplementation(async (_prompt, options) => {
      options.onToken(raw)
      return raw
    })
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 1, plotSummary: '门上的警告' })
    const onToken = vi.fn()
    const result = await service.generateChapterStream(id, 1, { onToken })
    expect(result).toBe('他在门上看见Keep Out，便收回了手。')
    expect(onToken).toHaveBeenCalledWith(raw)
  })

  it.each([
    ['　　刘青沿着石阶走到窗边。\r\n\r\n\r\n　　他把木闩往回拉了一寸。', '\r\n\r\n', '屋檐下滴水的声音停了，他才推开那扇窄窗。'],
    ['刘青沿着石阶走到窗边。\n\n他把木闩往回拉了一寸。  ', '\n\n', '江面横过一线灯光，小船沿着浅滩转向了上游。'],
    ['　　刘青一手扶住木闩，压低声音说：“是你的船吗？', '', '”窗外没有应声，系船的绳子在雨里越绷越紧。']
  ])('交稿原样保存作者前部，续写只修改接缝及新增部分', async (prefix, seam, suffix) => {
    const repo = new ProseRepo(dir)
    await repo.write(1, prefix, '窗前')
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 1, plotSummary: '刘青在窗前寻找一艘靠岸的小船。' })
    generateStream.mockImplementation(async (_prompt, options) => options?.meta?.feature === 'outlineCheck' ? '[]' : suffix)
    const onFinalProseReady = vi.fn()
    const result = await service.deliverChapter(id, 1, null, { existingText: prefix, onFinalProseReady })
    const full = prefix + seam + suffix
    expect(result).toMatchObject({ ok: true, content: suffix, fullContent: full, saved: { content: full } })
    expect(onFinalProseReady).toHaveBeenCalledWith(full)
    expect(await repo.read(1)).toBe(full)
    expect(generateStream.mock.calls.find(([, options]) => options?.meta?.feature === 'chapter')?.[0]).toContain(prefix)
  })

  it('事实冲突只允许修新增部分，拒绝顺带改动只读前部的局部替换', async () => {
    const prefix = '刘青沿着栏杆走了几步，停在挂油灯的那根柱子旁。'
    const badTail = '刘青径直跳上了小船，松开缆绳，朝河心划去。'
    const fixedTail = '刘青扯了扯缆绳，留在岸边，等船里的人先开口。'
    const boundary = '刘青应留在岸边等待，不在本章独自上船。'
    const repo = new ProseRepo(dir)
    await repo.write(1, prefix, '岸边')
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 1, plotSummary: boundary })
    let replacements = 0
    generateStream.mockImplementation(async (prompt, options) => {
      switch (options?.meta?.feature) {
        case 'chapter': return badTail
        case 'outlineCheck':
        case 'batchOutline': return '[]'
        case 'longformGuard': {
          expect(prompt).toContain(`本章前 ${prefix.length} 字符为只读旧稿`)
          const manuscript = prompt.split('【本章实际正文】').at(-1) as string
          return JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item', 'boundary'],
            findings: manuscript.includes(badTail) ? [{ kind: 'boundary', message: '本章不可上船', snippet: badTail, reference: boundary }] : [] })
        }
        case 'continuityRepair':
          replacements++
          return JSON.stringify({ replacements: [
            ...(replacements === 1 ? [{ before: prefix, after: '刘青沿着栏杆走了几步，把油灯吹灭了。' }] : []),
            { before: badTail, after: fixedTail }
          ] })
        case 'continuityRepairVerify': return '{"passed":true,"issues":[]}'
        default: throw new Error(`未预期的模型调用 ${options?.meta?.feature}`)
      }
    })
    const writer = new WriteService(projects, { generateStream } as unknown as LlmService,
      undefined, undefined, undefined, undefined, undefined, acceptedDeslop)
    const result = await writer.deliverChapter(id, 1, null, { existingText: prefix })
    expect(replacements).toBe(2)
    expect(result).toMatchObject({ ok: true, conflictRepaired: true, fullContent: prefix + '\n\n' + fixedTail })
    expect(await repo.read(1)).toBe(result.fullContent)
  })

  it('没有细纲或跨章记忆时，仍用本章只读前部的原文核对续写', async () => {
    const prefix = '林遥从门缝递出唯一一把铜钥匙，看着顾宁把它收进贴身衣袋。\n\n门从里面关上了。'
    const badTail = '她从自己口袋里摸出刚才递过门缝的铜钥匙，把门推开。'
    const fixedTail = '她按了按空口袋，回身敲门，等顾宁从里面开锁。'
    const repo = new ProseRepo(dir)
    await repo.write(1, prefix, '门外')
    let reviewed = false
    generateStream.mockImplementation(async (prompt, options) => {
      switch (options?.meta?.feature) {
        case 'chapter': return badTail
        case 'longformGuard': {
          reviewed = true
          const manuscript = prompt.split('【本章实际正文】').at(-1) as string
          expect(manuscript).toContain(prefix)
          return JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item', 'boundary'],
            findings: manuscript.includes(badTail) ? [{
              kind: 'item', message: '钥匙已交给顾宁，林遥没有收回钥匙。', snippet: badTail,
              reference: '林遥从门缝递出唯一一把铜钥匙，看着顾宁把它收进贴身衣袋。'
            }] : [] })
        }
        case 'outlineCheck':
        case 'batchOutline': return '[]'
        case 'continuityRepair': return JSON.stringify({ replacements: [{ before: badTail, after: fixedTail }] })
        case 'continuityRepairVerify': return '{"passed":true,"issues":[]}'
        default: throw new Error(`未预期的模型调用 ${options?.meta?.feature}`)
      }
    })
    const writer = new WriteService(projects, { generateStream } as unknown as LlmService,
      undefined, undefined, undefined, undefined, undefined, acceptedDeslop)
    const result = await writer.deliverChapter(id, 1, null, { existingText: prefix })
    expect(reviewed).toBe(true)
    expect(result).toMatchObject({ ok: true, conflictRepaired: true, fullContent: prefix + '\n\n' + fixedTail })
    expect(await repo.read(1)).toBe(result.fullContent)
  })

  it('生成结果大段复制远章正文时拦截返回，不交给调用方保存', async () => {
    const old = '陆安推开祠堂的木门，一枚青铜钥匙从门楣上落下。他用袖口接住钥匙，看见齿缝中塞着尚未干透的红泥。院里没有脚印，只有井沿留着半只破鞋。他把钥匙放进内袋，绕过供桌走到后窗。窗纸上新割出的孔洞正对着山路，一匹无人的马停在那里，鞍边挂着他昨夜交给弟弟的包袱。'
    await new ProseRepo(dir).write(3, old, '钥匙')
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 249, plotSummary: '陆安抵达祠堂' })
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 250, plotSummary: '陆安调查新线索' })
    generateStream.mockResolvedValue(old)
    await expect(service.generateChapterStream(id, 250)).rejects.toThrow('LLM_PROSE_REPETITION')
  })

  it('字数上限不转成必须补足的下限，保留剧情完成后的停止选项', async () => {
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 1, plotSummary: '交还信物', wordEstimate: '不超过3000字' })
    const p = await service.buildChapterPrompt(id, 1, null, undefined, '甲'.repeat(2000))
    expect(p.wordTarget.bound).toBe('about')
    expect(p.user).toContain('这是剩余上限，允许少写')
    expect(p.user).toContain('若剧情已全部完成，可自然结束')
    expect(p.user).not.toMatch(/不少于\s*1000|新增\s*1000\s*字.{0,8}硬性下限/)
  })

  it('保留7600字符长章中段独有事实和未完台词', async () => {
    const fact = '阿明把唯一的虎符烧成了灰，此后再无虎符。'
    const existing = '甲'.repeat(3000) + fact + '乙'.repeat(4500) + '他问：“证据究竟在'
    const p = await service.buildChapterPrompt(id, 1, null, undefined, existing)
    expect(p.user).toContain(existing)
    expect(p.user).toContain('未完句或未闭合台词优先自然接完，再续完进行中的动作或剧情点')
    expect(p.user).not.toContain('省略本章中段')
  })

  it('超出同章上下文预算时明确拒绝，不偷偷丢掉中段', async () => {
    await expect(service.buildChapterPrompt(id, 1, null, undefined, '甲'.repeat(40001)))
      .rejects.toThrow('CHAPTER_CONTEXT_TOO_LARGE')
  })
  it('接近字数上限时收尾预算不超过剩余额度，已经达到上限则不追加字数任务', async () => {
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 1, plotSummary: '交还信物', wordEstimate: '不超过3000字' })
    const near = await service.buildChapterPrompt(id, 1, null, undefined, '甲'.repeat(2950))
    expect(near.targetWords).toBe(50)
    const done = await service.buildChapterPrompt(id, 1, null, undefined, '甲'.repeat(3000))
    expect(done.targetWords).toBe(0)
    expect(done.user).toContain('额度为零且末句已完整时无需新增正文')
  })

  it('第250章能召回第3章的道具原文，改写后不会继续引用旧版本', async () => {
    const prose = new ProseRepo(dir)
    await prose.write(3, '陆安将乌金虎符投入熔炉，虎符融成铁水。从此军令只能由印信传递。', '焚符')
    await prose.write(240, '新的一日，陆安抵达边城。', '边城')
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 250, plotSummary: '陆安调查乌金虎符的下落', charactersAppearing: ['陆安'] })
    const first = await service.buildChapterPrompt(id, 250)
    expect(first.user).toContain('与本章有关的历史正文证据')
    expect(first.user).toContain('第 3 章 · 正文/')
    expect(first.user).toContain('虎符融成铁水')
    await prose.write(3, '陆安将乌金虎符封进石匣，交给守门人保管。', '焚符')
    const next = await service.buildChapterPrompt(id, 250)
    expect(next.user).toContain('交给守门人保管')
    expect(next.user).not.toContain('虎符融成铁水')
  })

  it('从本章地点与上章真实尾段召回远章证据，不读取本章旧稿或后章正文', async () => {
    const prose = new ProseRepo(dir)
    const pump = '鹭湾旧泵房有两把闸锁，左边那把的锁簧早叫水泡软了。'
    const barge = '驳船的两扇舱窗都钉死了。守舱人用钩子拉过木梯，照旧把梯绳打成活结。'
    await prose.write(3, pump, '闸锁')
    await prose.write(4, barge, '船梯')
    await prose.write(26, '渡口外只泊着驳船，江风把渡票掀到水里。', '渡口')
    await prose.write(27, '旧稿写她已经打开鹭湾旧泵房的铁门。', '隔墙')
    await prose.write(28, '她用驳船的木梯撞坏鹭湾旧泵房的铁门。', '开门')
    await mkdir(join(dir, '细纲'), { recursive: true })
    await writeFile(join(dir, '细纲', '细纲_第027章_隔墙.md'), [
      '# 隔墙', '', '## 第27章：隔墙', '',
      '- **核心事件**：她停在路口，等天亮再走。', '- **本章地点**：鹭湾旧泵房'
    ].join('\n'))
    const ending = vi.spyOn(WriteFlowService.prototype, 'extractEndingState').mockResolvedValue({
      chapterNumber: 26, characterPositions: [], characterStates: [], timePoint: '', unfinished: [], suspense: '', props: []
    })
    try {
      const prompt = await service.buildChapterPrompt(id, 27, null, undefined, '雨已经停了。她站在墙根，听了一会儿，没有叫门。')
      const evidence = prompt.user.split('# 与本章有关的历史正文证据')[1]?.split('\n---')[0] ?? ''
      expect(ending).toHaveBeenCalled()
      expect(evidence).toContain(`第 3 章 · 正文/第003章 闸锁.md:1–1\n${pump}`)
      expect(evidence).toContain(`第 4 章 · 正文/第004章 船梯.md:1–1\n${barge}`)
      expect(prompt.user).not.toContain('旧稿写她已经打开')
      expect(prompt.user).not.toContain('撞坏鹭湾旧泵房的铁门')
    } finally {
      ending.mockRestore()
    }
  })

  it('正文与细纲不同时，近期记忆不把计划包装成已发生事实', async () => {
    await new ProseRepo(dir).write(1, '陆安仍未找到母亲，渡船停在岸边。', '寻找')
    await mkdir(join(dir, '细纲'), { recursive: true })
    await writeFile(join(dir, '细纲', '细纲_第001章_寻找.md'), '# 寻找\n\n- **核心事件**：陆安救出了母亲，渡船沉没。')
    const p = await service.buildChapterPrompt(id, 2)
    const previousProse = p.user.split('**上一章完整正文**')[1]?.split('```')[1] ?? ''
    expect(previousProse).toContain('陆安仍未找到母亲')
    expect(previousProse).not.toContain('陆安救出了母亲')
  })

  it('回写旧章时过滤后章自动新增人物，保留作者卡及本章明确点名', async () => {
    await new MemoryWriter(dir).applyNewCharacters([
      { name: '莫蓉', role: '配角', identity: '在灯楼完成反间的档案员', personality: '善于说谎' },
      { name: '秦一', role: '配角', identity: '接任地下电台的主持人', personality: '不怕孤独' },
      { name: '许望海', role: '配角', identity: '失踪多年的河工', personality: '多年不肯回乡' }
    ], 30)
    await new CharacterRepo(dir).create({ name: '闻晓', role: '主角', personality: '一碰到潮湿的楼梯便走得很慢' })
    await new ProseRepo(dir).write(30, '莫蓉接过那只封缄的箱子，夜里独自去了灯楼。', '交接')
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 12, plotSummary: '闻晓在渡口等许望海。',
      charactersAppearing: ['闻晓', '许望海'] })
    const prompt = await service.buildChapterPrompt(id, 12, null, undefined, '秦一在她出门前叫住她，将忘在桌上的铜钱递过来。')
    const cards = prompt.user.split('# 角色信息')[1]?.split('\n---')[0] ?? ''
    expect(cards).toContain('闻晓')
    expect(cards).toContain('许望海')
    expect(cards).toContain('秦一')
    expect(prompt.user).not.toContain('莫蓉')
    expect(cards).not.toContain('接任地下电台的主持人')
    expect(cards).not.toContain('失踪多年的河工')
  })

  it('前章原稿缺失时把孤立旧概要降级为线索，保留细纲衔接', async () => {
    const removedProse = '林遥打开窗，从墙根的药罐里取出那封信。'
    await new ChapterSummaryRepo(dir).write({ schemaVersion: 1, chapterNumber: 8, sourceHash: hashProse(removedProse),
      generatedAt: '', events: [{ text: '林遥取出了药罐里的信', evidence: removedProse }], stateChanges: [], openThreads: [] })
    const outlines = new OutlineRepository(dir)
    await outlines.upsertDetailed({ chapterNumber: 8, plotSummary: '林遥回到屋里找信，暂时没有读到。' })
    await outlines.upsertDetailed({ chapterNumber: 9, plotSummary: '林遥和来客在檐下谈话。' })
    const prompt = await service.buildChapterPrompt(id, 9, null, undefined, '雨打在檐下，来客没进门。', true)
    expect(prompt.user).toContain('缺少对应正文的旧概要（仅作待核对线索，不是原文或已确认事实）')
    expect(prompt.user).toContain('上一章计划（非实际正文）')
    expect(prompt.user).not.toContain(removedProse)
  })

  it('回写旧章不注入未来时间线与已撤销的设定演进', async () => {
    await mkdir(join(dir, '追踪'), { recursive: true })
    await writeFile(join(dir, '追踪', '时间线.md'), '# 时间线\n\n## 历史事件与小说事件对照表\n\n| 章节 | 事件 |\n|---|---|\n| 第8章 | 旧友到访 |\n| 第11章 | 秘密未来伏击 |\n')
    await writeFile(join(dir, '追踪', '设定演进.md'), '# 设定演进\n\n| 日期 | 章节 | 类型 | 文件 | 摘要 | 状态 |\n|---|---|---|---|---|---|\n| 今天 | 第8章 | 能力 | 规则 | 已知规则 | 已应用 |\n| 今天 | 第9章 | 能力 | 规则 | 撤销规则 | 已撤销 |\n| 今天 | 第100章 | 能力 | 规则 | 未来称帝规则 | 已应用 |\n')
    const p = await service.buildChapterPrompt(id, 10)
    expect(p.user).toContain('已知规则')
    expect(p.user).not.toContain('秘密未来伏击')
    expect(p.user).not.toContain('未来称帝规则')
    expect(p.user).not.toContain('撤销规则')
  })

  it('前向续写不从人物卡找回旧稿身份，保留作者后来改的人设', async () => {
    const prose = new ProseRepo(dir)
    const characters = new CharacterRepo(dir)
    const card = await characters.create({ name: '林遥', identity: '渡船伙计', personality: '慢熟' })
    const old = '信封里夹着一张亲笔供状。顾宁按住印泥，说林遥是沈家的新任家主。'
    await prose.write(9, old, '渡口来信')
    await new MemoryWriter(dir).applyAutomatic({
      chapterNumber: 9, newCharacters: [], newLocations: [], newItems: [], newForeshadowings: [], newPlotPoints: [], collectedForeshadowings: [],
      characterStateChanges: [
        { name: '林遥', field: '身份', oldValue: '渡船伙计', newValue: '沈家的新任家主', evidence: old },
        { name: '林遥', field: '性格', oldValue: '慢熟', newValue: '行事武断', evidence: old }
      ]
    }, { sourceContent: old })
    await characters.update(card.id, { personality: '遇到难事先听完再开口' })
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 10, plotSummary: '林遥在渡口收下信封', charactersAppearing: ['林遥'] })
    const prior = await service.buildChapterPrompt(id, 10)
    expect(prior.user).toContain('沈家的新任家主')
    await prose.write(9, '船到了对岸，林遥在舱底摸到一只信封，封口还没拆。', '渡口来信')
    const after = await service.buildChapterPrompt(id, 10)
    expect(after.user).toContain('渡船伙计')
    expect(after.user).toContain('遇到难事先听完再开口')
    expect(after.user).not.toContain('沈家的新任家主')
    expect(after.user).not.toContain('行事武断')
    expect((await characters.get(card.id))?.identity).toBe('沈家的新任家主')
  })

  it('首登章节改稿后撤下自动人物卡旧身份，保留当章点名与作者改过的卡片', async () => {
    const prose = new ProseRepo(dir)
    const characters = new CharacterRepo(dir)
    const chapter = 7
    await prose.write(chapter, '乔娘掏出过关的公文，江小满才认出她是盐巡新任的掌印官。', '一纸公文')
    await new MemoryWriter(dir).applyNewCharacters([{ name: '乔娘', role: '配角', identity: '盐巡新任的掌印官', personality: '' }], chapter)
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 10, plotSummary: '江小满向乔娘借一条船', charactersAppearing: ['乔娘'] })
    expect((await service.buildChapterPrompt(id, 10)).user).toContain('盐巡新任的掌印官')

    await prose.write(chapter, '乔娘数出三枚铜板，用一片草叶卷好，托江小满还给守闸的人。', '一纸公文')
    const rewritten = (await service.buildChapterPrompt(id, 10)).user
    expect(rewritten).toContain('乔娘')
    expect(rewritten).not.toContain('盐巡新任的掌印官')
    const card = (await characters.list()).find(c => c.name === '乔娘')!
    expect(card.identity).toBe('盐巡新任的掌印官')

    await characters.update(card.id, { identity: '在埠头替人补网的乔婶' })
    expect((await service.buildChapterPrompt(id, 10)).user).toContain('在埠头替人补网的乔婶')
  })

  it('续写章中只采用之前的追踪快照，不偷用本章旧稿的章末身份、道具或时间线', async () => {
    const prose = new ProseRepo(dir)
    await prose.write(9, '林遥在渡口踩住缆绳，手里还攥着封蜡未拆的信。')
    await prose.write(10, '顾宁摊开信，林遥终于认出署名的人是她兄长。')
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 10, plotSummary: '林遥在渡口等人' })
    await mkdir(join(dir, '追踪'), { recursive: true })
    await writeFile(join(dir, '追踪', '角色状态.md'), [
      '## 历史快照（第9章）', '| 角色 | 当前立场 | 身份 | 更新章节 |', '|---|---|---|---|',
      '| 林遥 | 在渡口等人 | 渡船伙计 | 第9章 |', '',
      '## 当前状态', '| 角色 | 当前立场 | 身份 | 更新章节 |', '|---|---|---|---|',
      '| 林遥 | 已确认兄长署名 | 沈家旧主 | 第10章 |', ''
    ].join('\n'))
    await writeFile(join(dir, '追踪', '物品.md'), [
      '## 历史快照（第9章）', '| 物品 | 当前持有者 | 状态 | 更新章节 |', '|---|---|---|---|',
      '| 信笺 | 林遥 | 封蜡未拆 | 第9章 |', '',
      '## 当前状态', '| 物品 | 当前持有者 | 状态 | 更新章节 |', '|---|---|---|---|',
      '| 信笺 | 顾宁 | 开信烧毁 | 第10章 |', ''
    ].join('\n'))
    await writeFile(join(dir, '追踪', '时间线.md'), [
      '## 历史事件与小说事件对照表', '| 章节 | 事件 |', '|---|---|',
      '| 第9章 | 晚潮涨到石阶 |', '| 第10章 | 暗格找到族谱 |'
    ].join('\n'))
    const prompt = await service.buildChapterPrompt(id, 10, null, undefined, '林遥蹲在渡口，把手从缆绳上挪开。')
    expect(prompt.user).toContain('在渡口等人')
    expect(prompt.user).toContain('封蜡未拆')
    expect(prompt.user).toContain('晚潮涨到石阶')
    expect(prompt.user).not.toContain('已确认兄长署名')
    expect(prompt.user).not.toContain('开信烧毁')
    expect(prompt.user).not.toContain('暗格找到族谱')
  })
})
