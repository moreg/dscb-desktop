import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ChapterDirectionService } from '../src/main/data/chapter-direction-service'
import { DetailedOutlineMdRepo } from '../src/main/data/skill-format/detailed-outline-md-repo'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { authorAllowsStoryEnding, assertNoUnauthorizedStoryEnding, NO_STORY_ENDING } from '../src/shared/chapter-directions'
import type { LlmService } from '../src/main/data/llm-service'

export const fiveDirections = () => ({ directions: ['a', 'b', 'c', 'd', 'e'].map((id, index) => ({
  id, title: `调查走向${index + 1}`, connection: '承接寻找失踪账本的主线。', conflict: `阻力${index + 1}来自证人的不同立场。`,
  progression: `通过调查渠道${index + 1}取得账本的线索。`, ending: '在渡口找到船夫，尚未取得账本。',
  hook: '船夫提到东岸仓库。', outlineReason: '落实第一阶段寻账，不提前揭露幕后主使。'
})), recommendedId: 'c', recommendationReason: '证人动机与当前调查阶段相符，留下东岸仓库的后续线索。' })

describe('无细纲方向与反向细纲', () => {
  let dir: string
  let model: ReturnType<typeof vi.fn>
  let service: ChapterDirectionService
  const prose = '林遥走到渡口，船夫把一张纸条塞进她手里。\n\n纸条上写着东岸仓库，她将纸条收进衣袋。'
  const facts = () => ({ events: [
    { text: '林遥在渡口收到船夫给的纸条。', evidence: '林遥走到渡口，船夫把一张纸条塞进她手里。' },
    { text: '纸条指向东岸仓库，林遥收好纸条。', evidence: '纸条上写着东岸仓库，她将纸条收进衣袋。' }
  ], hook: { text: '获得东岸仓库的线索。', evidence: '纸条上写着东岸仓库，她将纸条收进衣袋。' },
  characters: [{ text: '林遥', evidence: '林遥走到渡口，船夫把一张纸条塞进她手里。' }], foreshadowings: [] })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chapter-directions-'))
    await mkdir(join(dir, '大纲'))
    await writeFile(join(dir, '大纲', '大纲.md'), '# 总纲\n\n先寻账本，后到东岸仓库，最终查清幕后主使。')
    model = vi.fn(async (_prompt, opts) => JSON.stringify(opts?.meta?.feature === 'chapterOutlineFromProse'
      ? facts() : opts?.meta?.feature === 'chapterDirectionReview' ? { completed: true, passed: true, issues: [] } : fiveDirections()))
    service = new ChapterDirectionService(dir, 3, { generateStream: model } as unknown as LlmService, 'project')
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
  const generate = () => service.generate('只有全书大纲，没有上一章正文和细纲。', '', '', true)
  const selected = async () => {
    const candidates = await generate()
    return service.select({ token: candidates.token, directionId: candidates.recommendedId }, '', '', 2500)
  }

  it('只有大纲时返回五项与唯一推荐，规划不创建细纲或事实记忆', async () => {
    const result = await generate()
    expect(result.directions).toHaveLength(5)
    expect(result.recommendedId).toBe('c')
    expect(result.missingPreviousProse).toBe(true)
    expect(model.mock.calls[0][0]).toContain(NO_STORY_ENDING)
    expect(await new DetailedOutlineMdRepo(dir).readChapter(3)).toBeNull()
    expect(await generate()).toEqual(result)
    expect(model.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'chapterDirections')).toHaveLength(1)
  })

  it('推荐标识不能落到候选集合外，不默认使用第一项', async () => {
    model.mockResolvedValue(JSON.stringify({ ...fiveDirections(), recommendedId: 'missing' }))
    await expect(generate()).rejects.toThrow('必须推荐其中一项')
    expect(await service.read()).toBeNull()
  })

  it('大纲改动或原先缺失的上一章正文被补入后，旧方向不能采用', async () => {
    const candidates = await generate()
    await new ProseRepo(dir).write(2, '林遥已经取得账本，准备上船。')
    await expect(service.select({ token: candidates.token, directionId: 'c' }, '', '', 2500)).rejects.toThrow('DIRECTION_CONTEXT_CHANGED')
  })

  it('前章后台概要、记忆同步或自动草稿落盘期间，不误报 DIRECTION_CONTEXT_CHANGED', async () => {
    model.mockImplementationOnce(async () => {
      await mkdir(join(dir, '记忆', '章节概要'), { recursive: true })
      await writeFile(join(dir, '记忆', '章节概要', '第002章.json'), '{"chapterNumber":2}')
      await mkdir(join(dir, '追踪'), { recursive: true })
      await writeFile(join(dir, '追踪', '角色状态.md'), '# 角色状态\n')
      await mkdir(join(dir, '正文'), { recursive: true })
      await writeFile(join(dir, '正文', '.draft-003.md'), '临时自动保存草稿')
      return JSON.stringify(fiveDirections())
    })
    const candidates = await generate()
    expect(candidates.directions).toHaveLength(5)
    await writeFile(join(dir, '记忆', '章节概要', '第002章.json'), '{"chapterNumber":2,"updated":true}')
    await writeFile(join(dir, '正文', '.draft-003.md'), '更新后的临时自动保存草稿')
    const chosen = await service.select({ token: candidates.token, directionId: 'c' }, '', '', 2500)
    expect(chosen.choice.directionId).toBe('c')
  })

  it('重新生成后旧 token 不可采用，作者调整随所选方向持久化', async () => {
    const old = await generate()
    const fresh = await service.generate('大纲内容', '', '', true, undefined, true)
    await expect(service.select({ token: old.token, directionId: 'a' }, '', '', 2500)).rejects.toThrow('DIRECTION_CONTEXT_CHANGED')
    const result = await service.select({ token: fresh.token, directionId: 'b', adjustment: '先与船夫交涉，暂不进仓库。' }, '', '', 2500)
    expect(result.plan).toContain('调查走向2')
    expect(result.plan).toContain('暂不进仓库')
    expect(result.authorInstruction).toContain('暂不进仓库')
    expect((await service.read())?.selected).toEqual(result)
  })

  it('取消后不写候选，不覆盖原候选', async () => {
    const original = await generate()
    const controller = new AbortController()
    model.mockImplementation(async () => { controller.abort(); return JSON.stringify(fiveDirections()) })
    await expect(service.generate('资料', '', '', true, controller.signal, true)).rejects.toThrow('LLM_ABORTED')
    expect((await service.read())?.candidates.token).toBe(original.token)
  })

  it('五项方向未经允许规划全书终局时不保存候选', async () => {
    const invalid = fiveDirections()
    invalid.directions[0].ending = '迎来全书终局，交代所有人物一生归宿。'
    model.mockResolvedValue(JSON.stringify(invalid))
    await expect(generate()).rejects.toThrow('方向审核未通过')
    expect(await service.read()).toBeNull()
  })

  it('正文没有完结标记但语义进入全书终局时仍拒绝交稿', async () => {
    const plan = await selected()
    model.mockResolvedValue(JSON.stringify({ completed: true, passed: false, issues: ['正文交代所有人物一生归宿，关闭了全书后续空间。'] }))
    await expect(service.verify('多年以后，她已过完安稳的一生，所有人的命运都已尘埃落定。', plan)).rejects.toThrow('禁止主动完结')
  })

  it('依最终正文创建可读的逐章细纲，重复补跑复用同版本结果', async () => {
    const plan = await selected()
    await new ProseRepo(dir).write(3, prose)
    await service.verify(prose, plan)
    await service.createOutline(prose, '渡口纸条', plan)
    const detail = await new DetailedOutlineMdRepo(dir).readChapter(3)
    expect(detail?.plotSummary).toContain('船夫给的纸条')
    expect(detail?.hook).toContain('东岸仓库')
    expect(detail?.charactersAppearing).toContain('林遥')
    const count = model.mock.calls.length
    await service.createOutline(prose, '渡口纸条', plan)
    expect(model).toHaveBeenCalledTimes(count)
    expect((await service.read())?.generated?.sourceHash).toBeTruthy()
  })

  it('正文原句不能支持反向细纲时拒绝写入', async () => {
    const plan = await selected()
    await new ProseRepo(dir).write(3, prose)
    model.mockResolvedValue(JSON.stringify({ ...facts(), events: [{ text: '抓获幕后主使。', evidence: '她当场抓获了幕后主使。' }] }))
    await expect(service.createOutline(prose, '纸条', plan)).rejects.toThrow('缺少可定位')
    expect(await new DetailedOutlineMdRepo(dir).readChapter(3)).toBeNull()
  })

  it('补全原有空模板时保留作者字段，并写入正文来源和证据', async () => {
    await mkdir(join(dir, '细纲'))
    await writeFile(join(dir, '细纲', '细纲_第003章_纸条.md'), '# 本章模板\n\n## 第 3 章：纸条\n\n- **核心事件**：待补充\n- **作者备注**：保留船夫身份的悬念。\n')
    const plan = await selected()
    await new ProseRepo(dir).write(3, prose)
    await service.createOutline(prose, '纸条', plan)
    const raw = (await new DetailedOutlineMdRepo(dir).readRaw(3))!
    expect(raw.text).toContain('保留船夫身份的悬念')
    expect(raw.text).toContain(`方向任务：${plan.candidates.token}`)
    expect(raw.text).toContain('正文依据：林遥走到渡口')
    expect((await new DetailedOutlineMdRepo(dir).readChapter(3))?.plotSummary).toContain('船夫给的纸条')
  })

  it('反向提取期间正文修改，不采用旧稿细纲', async () => {
    const plan = await selected()
    await new ProseRepo(dir).write(3, prose)
    model.mockImplementation(async () => { await new ProseRepo(dir).write(3, '作者的新正文。'); return JSON.stringify(facts()) })
    await expect(service.createOutline(prose, '纸条', plan)).rejects.toThrow('DIRECTION_CONTEXT_CHANGED')
    expect(await new DetailedOutlineMdRepo(dir).readChapter(3)).toBeNull()
  })

  it('补全并再次更新整卷文件中的本章时，保留卷首、相邻章和作者字段', async () => {
    await mkdir(join(dir, '细纲'))
    const file = join(dir, '细纲', '第01卷.md')
    const previous = '## 第2章：前章\n\n- **核心事件**：林遥听说渡口有线索。'
    const next = '## 第4章：仓库\n\n- **核心事件**：林遥到仓库寻找账本。'
    await writeFile(file, `# 第一卷\n\n卷首说明。\n\n${previous}\n\n## 第3章：纸条\n\n- **核心事件**：（待生成）\n- **作者备注**：保留船夫身份。\n\n${next}\n`)
    const plan = await selected()
    await new ProseRepo(dir).write(3, prose)
    await service.createOutline(prose, '纸条', plan)
    const originalCalls = model.mock.calls.length
    await service.createOutline(prose, '纸条', plan)
    expect(model).toHaveBeenCalledTimes(originalCalls)
    const edited = prose + '\n\n林遥转身离开渡口。'
    await new ProseRepo(dir).write(3, edited)
    await service.createOutline(edited, '纸条', plan)
    const full = await readFile(file, 'utf8')
    expect(full).toContain('# 第一卷\n\n卷首说明。')
    expect(full).toContain(previous)
    expect(full).toContain(next)
    expect(full).toContain('保留船夫身份')
    expect(full.match(/方向任务：/g)).toHaveLength(1)
    expect((await new DetailedOutlineMdRepo(dir).readChapter(4))?.plotSummary).toBe('林遥到仓库寻找账本。')
    expect((await new DetailedOutlineMdRepo(dir).readRaw(3))?.text).toContain('正文依据：林遥走到渡口')
  })

  it('作者修改已生成的细纲后，补跑不覆盖作者内容', async () => {
    const plan = await selected()
    await new ProseRepo(dir).write(3, prose)
    await service.createOutline(prose, '纸条', plan)
    const raw = (await new DetailedOutlineMdRepo(dir).readRaw(3))!
    const file = join(dir, '细纲', raw.fileName)
    await writeFile(file, raw.text + '\n作者补充：保留船夫身份的悬念。')
    await expect(service.createOutline(prose, '纸条', plan)).rejects.toThrow('已被作者修改')
    expect(await readFile(file, 'utf8')).toContain('作者补充')
  })
})

describe('只有明确作者要求才能全书完结', () => {
  it.each(['', '继续写。', '写完本章。', '这次让本章完结。', '结束战斗。', '本卷收尾。', '最后一章细纲里安排了结局。', '不要全书完结。', '这本书不能完结，继续写下去。',
    '全书完结还早，继续铺垫主线。', '等到全书完结时再揭晓，当前先调查。', '如果以后需要，写最终章。', '若有必要，写最终章。', '等主线结束，写最终章。', '请写大结局前的准备。',
    '全书完结了吗？', '现在写最终章？', '请写全书完结的伏笔。', '读者说“请写全书完结”，本章继续调查。', '这次让本章完结，保留全书大结局的悬念。'])('%s 不构成完结授权', instruction => {
    expect(authorAllowsStoryEnding(instruction)).toBe(false)
  })
  it.each(['请写全书完结。', '这本书要完结。', '写最终章。', '允许全书收尾。', '现在写大结局。', '请完成全书收尾。', '大结局', '这次直接写完结吧。', '请写全书最终章。'])('%s 构成明确授权', instruction => {
    expect(authorAllowsStoryEnding(instruction)).toBe(true)
  })
  it('拦截全书完结标记，允许普通角色台词及获准最终章', () => {
    expect(() => assertNoUnauthorizedStoryEnding('她放下刀：“结束了。”')).not.toThrow()
    expect(() => assertNoUnauthorizedStoryEnding('正文。\n\n（全书完）')).toThrow('未授权')
    expect(() => assertNoUnauthorizedStoryEnding('正文。\n\n全书完', '请写全书完结。')).not.toThrow()
  })
})
