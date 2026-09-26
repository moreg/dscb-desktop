import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { SettingsRepository } from '../src/main/data/settings-repository'
import { WriteService } from '../src/main/data/write-service'
import { WriteFlowService } from '../src/main/data/write-flow-service'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { ForeshadowingMdRepo } from '../src/main/data/skill-format/foreshadowing-md-repo'
import { validateMemoryCandidate } from '../src/main/data/memory-evidence-validator'
import { parseMemoryExtractionJson } from '../src/shared/parsers'
import { summarizePostWriteSync } from '../src/shared/post-write-sync'
import type { LlmService } from '../src/main/data/llm-service'
import type { MemoryExtraction } from '../src/shared/types'

function memory(text: string): MemoryExtraction {
  return { chapterNumber: 1, newCharacters: [], newLocations: [], newItems: [], newForeshadowings: [],
    newPlotPoints: [{ title: '院门', event: text, evidence: text }], characterStateChanges: [],
    collectedForeshadowings: [], settingsPatches: [], settingsSuggestions: [] }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('记忆候选提交与过期任务', () => {
  let root: string, dir: string, id: string
  let service: WriteService, flow: WriteFlowService, settings: SettingsRepository
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'memory-candidate-'))
    settings = new SettingsRepository(join(root, 'settings.json'))
    const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
    id = (await projects.create({ name: '记忆候选', genre: '玄幻' })).id
    dir = await projects.resolveDir(id)
    const llm = { generateStream: vi.fn().mockResolvedValue('{}') } as unknown as LlmService
    flow = new WriteFlowService(llm)
    service = new WriteService(projects, llm, flow, undefined, undefined, settings)
    vi.spyOn(service, 'selfCheckChapter').mockResolvedValue({ schemaVersion: 1, chapterNumber: 1,
      generatedAt: '', ok: true, summary: '', counts: { pass: 0, warn: 0, fail: 0, skip: 0 }, items: [] })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('同步接受额外引用引号，并将真实原文保存进候选记录', async () => {
    const prose = '林远推开木门走进院子，放下行囊。'
    const extraction = memory('林远推开木门走进院子')
    extraction.newPlotPoints[0].evidence = '“林远推开木门走进院子”'
    vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(JSON.stringify(extraction))
    const result = await service.syncChapterAfterWrite(id, 1, prose)
    expect(result?.memory.reviewRequired).toBeUndefined()
    expect(result?.memory.applied.plotPoints).toBe(1)
    const saved = JSON.parse(await readFile(join(dir, '.cache', 'memory-candidates', 'chapter-1.json'), 'utf8'))
    expect(saved.extraction.newPlotPoints[0].evidence).toBe('林远推开木门走进院子')
    expect(saved.status).not.toBe('pending')
  })

  it('自动补找缺失引文后重新校验，并保存修复证据', async () => {
    const prose = '林远推开木门走进院子，放下行囊。'
    const extraction = memory('林远走进院子')
    extraction.newPlotPoints[0].evidence = '林远进入了院子'
    vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(JSON.stringify(extraction))
    const repaired = memory('林远走进院子')
    repaired.newPlotPoints[0].evidence = '林远推开木门走进院子'
    const repair = vi.spyOn(flow, 'repairMemoryEvidence').mockResolvedValue(repaired)
    const result = await service.syncChapterAfterWrite(id, 1, prose)
    expect(repair).toHaveBeenCalledTimes(1)
    expect(result?.memory.applied.plotPoints).toBe(1)
    expect(result?.memory.heldBack).toBeUndefined()
    const saved = JSON.parse(await readFile(join(dir, '.cache', 'memory-candidates', 'chapter-1.json'), 'utf8'))
    expect(saved.extraction.newPlotPoints[0].evidence).toBe('林远推开木门走进院子')
  })

  it('正文自检失败时不花费调用补证', async () => {
    const extraction = memory('不存在的院门动作')
    const repair = vi.spyOn(flow, 'repairMemoryEvidence')
    const result = await service.syncChapterAfterWrite(id, 1, '林远坐在窗边。', { extraction, selfCheck: null })
    expect(repair).not.toHaveBeenCalled()
    expect(result?.memory.reviewRequired).toBeDefined()
  })

  it('一条证据不过关时其余记忆照常入库，候选文件标 partial', async () => {
    // 回归：旧实现一条不过就整章连坐。实测连写 10 章，每章十几条证据里总有失手的，
    // 结果 10 章的记忆一条也没进库，其中大半是压根不要求证据的新角色/新地点。
    const prose = '林远推开木门走进院子，放下行囊。'
    const extraction = memory('林远推开木门走进院子')
    extraction.newCharacters = [{ name: '林远', role: '主角', identity: '游侠', personality: '寡言' }]
    extraction.newPlotPoints.push({ title: '虚构', event: '林远拔刀', evidence: '林远拔刀砍翻了三个人' })
    vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(JSON.stringify(extraction))

    const result = await service.syncChapterAfterWrite(id, 1, prose)

    expect(result?.memory.reviewRequired).toBeUndefined()
    expect(result?.memory.heldBack).toHaveLength(1)
    expect(result?.memory.heldBack?.[0]).toContain('虚构')
    expect(result?.memory.applied.plotPoints).toBe(1)
    const saved = JSON.parse(await readFile(join(dir, '.cache', 'memory-candidates', 'chapter-1.json'), 'utf8'))
    expect(saved.status).toBe('partial')
    expect(saved.itemIssues).toHaveLength(1)
    expect(saved.chapterIssues).toEqual([])
    // 被挡下的条目原样留在候选文件里，供后续复核
    expect(saved.extraction.newPlotPoints).toHaveLength(2)
  })

  it('单独应用记忆也要核对已保存正文，细纲式回收不能绕过候选核验', async () => {
    const prose = '林远收起古铜钥匙，推开门走出院子。'
    await new ProseRepo(dir).write(1, prose)
    const repo = new ForeshadowingMdRepo(dir)
    const item = await repo.create({ content: '古铜钥匙的主人是谁', expectedCollect: 20 })
    await repo.plant(item.id, 1)
    const candidate = memory(prose)
    candidate.collectedForeshadowings = [{ foreshadowingId: item.id, content: item.content, chapter: 1,
      evidence: '第20章计划揭晓钥匙主人是掌柜。' }]
    const result = await service.applyMemory(id, candidate)
    // 分级后这条属于条目级：只挡它自己，不再连坐整章其余记忆
    expect(result.heldBack?.join('')).toContain('正文原文依据')
    expect(result.applied.collected).toBe(0)
    const actual = (await repo.list()).find((f) => f.id === item.id)
    expect(actual?.status).toBe('planted')
    expect(actual?.actualCollect).toBeUndefined()
  })

  it('应用旧提取时证据已从正文删除，应保留待核对而非写回过期结果', async () => {
    const candidate = memory('林远推开木门走进院子。')
    await new ProseRepo(dir).write(1, '林远锁上木门离开院子。')
    const result = await service.applyMemory(id, candidate)
    expect(result.heldBack?.length).toBeGreaterThan(0)
    expect(result.applied.plotPoints).toBe(0)
  })

  it('正确原文配错伏笔编号也不能回收另一条伏笔', async () => {
    const prose = '掌柜拿出航海日志，师父失踪的真相终于大白：他随船去了南洋。'
    await new ProseRepo(dir).write(1, prose)
    const repo = new ForeshadowingMdRepo(dir)
    const mirror = await repo.create({ content: '古铜镜的来历究竟是什么' })
    const master = await repo.create({ content: '师父为何在暴雨夜失踪' })
    await repo.plant(mirror.id, 1)
    await repo.plant(master.id, 1)
    const candidate = memory(prose)
    candidate.collectedForeshadowings = [{ foreshadowingId: mirror.id, content: master.content, chapter: 1, evidence: prose }]
    const result = await service.applyMemory(id, candidate)
    expect(result.heldBack?.join('')).toContain('编号与原问题不一致')
    expect(result.applied.collected).toBe(0)
    expect((await repo.list()).every((f) => f.status === 'planted')).toBe(true)
  })

  it('逐条复核：强制写入只落选中的条目，并记进 forced 不再重复报', async () => {
    const prose = '林远推开木门走进院子，放下行囊。'
    const extraction = memory('林远推开木门走进院子')
    // 两条都定位不到：一条作者确认属实强制写入，另一条留着
    extraction.newPlotPoints = [
      { title: '甲', event: '林远拔刀', evidence: '林远拔刀砍翻了三个人' },
      { title: '乙', event: '林远上马', evidence: '林远翻身上马疾驰而去' }
    ]
    vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(JSON.stringify(extraction))
    await service.syncChapterAfterWrite(id, 1, prose)
    await new ProseRepo(dir).write(1, prose)

    const before = await service.inspectMemoryCandidate(id, 1)
    expect(before?.items.filter((i) => i.issues.length)).toHaveLength(2)
    expect(before?.items.every((i) => !i.forced)).toBe(true)

    const res = await service.forceApplyMemoryCandidateItems(id, 1, [
      { kind: 'plotPoint', index: 0 }
    ])
    expect(res.forcedCount).toBe(1)
    expect(res.applied.applied.plotPoints).toBe(1)

    const after = await service.inspectMemoryCandidate(id, 1)
    // 强制写入的那条标成 forced，不再算待核对；没选的那条原样留着
    expect(after?.items.find((i) => i.index === 0)?.forced).toBe(true)
    expect(after?.items.filter((i) => i.issues.length && !i.forced)).toHaveLength(1)
    const saved = JSON.parse(await readFile(join(dir, '.cache', 'memory-candidates', 'chapter-1.json'), 'utf8'))
    expect(saved.forced).toEqual([{ kind: 'plotPoint', key: 'plot:甲' }])
    expect(saved.itemIssues).toHaveLength(1)
    expect(saved.status).toBe('partial')
  })

  it('正文在候选之后改过时拒绝强制写入', async () => {
    // 回归：强制写入一度完全不看 sourceHash，旧稿提取的结论会被写进改过的新稿记忆
    const prose = '林远推开木门走进院子，放下行囊。'
    vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(
      JSON.stringify(memory('凭空捏造的一句话在这里'))
    )
    await service.syncChapterAfterWrite(id, 1, prose)
    await new ProseRepo(dir).write(1, '林远锁上木门离开了院子，什么也没带。')

    const detail = await service.inspectMemoryCandidate(id, 1)
    expect(detail?.stale).toBe(true)
    await expect(
      service.forceApplyMemoryCandidateItems(id, 1, [{ kind: 'plotPoint', index: 0 }])
    ).rejects.toThrow('先「重跑本章记忆同步」')
  })

  it('同一份正文重跑保留已确认条目，且换了提取顺序也能按 key 认出来', async () => {
    const prose = '林远推开木门走进院子，放下行囊。'
    await new ProseRepo(dir).write(1, prose)
    const first = memory('林远推开木门走进院子')
    first.newPlotPoints = [
      { title: '甲', event: '林远拔刀', evidence: '林远拔刀砍翻了三个人' },
      { title: '乙', event: '林远上马', evidence: '林远翻身上马疾驰而去' }
    ]
    vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(JSON.stringify(first))
    await service.syncChapterAfterWrite(id, 1, prose)
    await service.forceApplyMemoryCandidateItems(id, 1, [{ kind: 'plotPoint', index: 0 }])

    // 重跑：同一份正文，但模型这次把两条的顺序调了个个儿
    const second = memory('林远推开木门走进院子')
    second.newPlotPoints = [
      { title: '乙', event: '林远上马', evidence: '林远翻身上马疾驰而去' },
      { title: '甲', event: '林远拔刀', evidence: '林远拔刀砍翻了三个人' }
    ]
    vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(JSON.stringify(second))
    await service.syncChapterAfterWrite(id, 1, prose)

    const after = await service.inspectMemoryCandidate(id, 1)
    // 「甲」这次排在下标 1，靠 key 仍认得出是已确认过的那条
    expect(after?.items.find((i) => i.label.includes('甲'))?.forced).toBe(true)
    expect(after?.items.find((i) => i.label.includes('乙'))?.forced).toBe(false)
    expect(after?.items.filter((i) => i.issues.length && !i.forced)).toHaveLength(1)
  })

  it('正文改过后重跑会丢弃旧的确认记录', async () => {
    const prose = '林远推开木门走进院子，放下行囊。'
    await new ProseRepo(dir).write(1, prose)
    vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(
      JSON.stringify(memory('凭空捏造的一句话在这里'))
    )
    await service.syncChapterAfterWrite(id, 1, prose)
    await service.forceApplyMemoryCandidateItems(id, 1, [{ kind: 'plotPoint', index: 0 }])
    expect((await service.inspectMemoryCandidate(id, 1))?.items[0].forced).toBe(true)

    // 改写正文后重跑：那些确认是针对旧稿做的，必须重新判断
    const rewritten = '林远锁上木门离开了院子，什么也没带。'
    await new ProseRepo(dir).write(1, rewritten)
    await service.syncChapterAfterWrite(id, 1, rewritten)

    expect((await service.inspectMemoryCandidate(id, 1))?.items[0].forced).toBe(false)
  })

  it('一条都不选时拒绝强制写入', async () => {
    const prose = '林远推开木门走进院子，放下行囊。'
    vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(JSON.stringify(memory('凭空捏造的一句话在这里')))
    await service.syncChapterAfterWrite(id, 1, prose)
    await expect(service.forceApplyMemoryCandidateItems(id, 1, [])).rejects.toThrow('没有选中任何条目')
  })

  it('较慢的旧提取晚返回时不能覆盖已经提交的新记忆', async () => {
    const oldText = '林远推开木门走进院子。'
    const nextText = '林远锁上木门离开院子。'
    const oldResult = deferred<string>(), started = deferred<void>()
    vi.spyOn(flow, 'extractMemoryStream').mockImplementation(async (text) => {
      if (text === oldText) { started.resolve(); return oldResult.promise }
      return JSON.stringify(memory(nextText))
    })
    const old = service.syncChapterAfterWrite(id, 1, oldText)
    await started.promise
    const current = await service.syncChapterAfterWrite(id, 1, nextText)
    expect(current?.memory.applied.plotPoints).toBe(1)
    oldResult.resolve(JSON.stringify(memory(oldText)))
    expect((await old)?.memory.superseded).toBe(true)
    const candidate = JSON.parse(await readFile(join(dir, '.cache', 'memory-candidates', 'chapter-1.json'), 'utf8'))
    expect(candidate.extraction.newPlotPoints[0].event).toBe(nextText)
    expect(candidate.status).toBe('applied')
  })

  it.each(['draft', 'saved'] as const)('%s 正文变化会使正在提取的候选失效', async (kind) => {
    const text = '林远推开木门走进院子。'
    const pending = deferred<string>(), started = deferred<void>()
    vi.spyOn(flow, 'extractMemoryStream').mockImplementation(() => { started.resolve(); return pending.promise })
    const apply = vi.spyOn(service, 'applyMemory')
    const task = service.syncChapterAfterWrite(id, 1, text)
    await started.promise
    if (kind === 'draft') service.invalidateChapterMemorySync(id, 1)
    else await new ProseRepo(dir).write(1, '林远锁上木门离开院子。')
    pending.resolve(JSON.stringify(memory(text)))
    expect((await task)?.memory.superseded).toBe(true)
    expect(apply).not.toHaveBeenCalled()
  })

  it('深审未返回前不提交，发现矛盾后保留候选供核对', async () => {
    await settings.update({ reviewRules: { enabled: true, autoDeepReview: true } })
    const text = '林远推开木门走进院子。'
    vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(JSON.stringify(memory(text)))
    const review = deferred<Awaited<ReturnType<WriteService['runDeepReview']>>>(), started = deferred<void>()
    vi.spyOn(service, 'runDeepReview').mockImplementation(() => { started.resolve(); return review.promise })
    const apply = vi.spyOn(service, 'applyMemory')
    const task = service.syncChapterAfterWrite(id, 1, text)
    await started.promise
    expect(apply).not.toHaveBeenCalled()
    review.resolve([{ category: 'llm_review', severity: 'error', ruleId: 'logic_hole', message: '前文院门已被烧毁' }])
    const result = (await task)!
    expect(apply).not.toHaveBeenCalled()
    expect(result.memory.reviewRequired?.join('')).toContain('院门已被烧毁')
    expect(summarizePostWriteSync(result).phase).toBe('partial')
    const candidate = JSON.parse(await readFile(join(dir, '.cache', 'memory-candidates', 'chapter-1.json'), 'utf8'))
    expect(candidate.status).toBe('pending')
  })

  it('写入途中被编辑取消时撤销自动结果，不继续更新设定', async () => {
    const text = '林远推开木门走进院子。'
    vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(JSON.stringify(memory(text)))
    const applied = service.applyMemory.bind(service)
    vi.spyOn(service, 'applyMemory').mockImplementation(async (...args) => {
      const result = await applied(...args)
      service.invalidateChapterMemorySync(id, 1)
      return result
    })
    const settingsApply = vi.spyOn(service, 'applySettingsPatches')
    expect((await service.syncChapterAfterWrite(id, 1, text))?.memory.superseded).toBe(true)
    expect(settingsApply).not.toHaveBeenCalled()
    const timeline = await readFile(join(dir, '追踪', '时间线.md'), 'utf8')
    expect(timeline).not.toContain(text)
  })

  it('完整流程提取失败不得作为空提取清除原有记忆', async () => {
    const text = '林远推开木门走进院子。'
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(text)
    vi.spyOn(flow, 'extractMemoryStream').mockRejectedValue(new Error('模型断流'))
    vi.spyOn(flow, 'evaluateRhythmStream').mockResolvedValue('{}')
    vi.spyOn(flow, 'generateFigureStream').mockResolvedValue('{}')
    const apply = vi.spyOn(service, 'applyMemory')
    const result = await service.runFullFlowForChapter(id, 1, () => undefined)
    expect(apply).not.toHaveBeenCalled()
    expect(result.memoryApply?.reviewRequired?.join('')).toContain('模型断流')
  })
})

describe('原文依据与完整提取', () => {
  it('完整句引文不会被后一无关句的否定词误伤', () => {
    const quote = '林远把钥匙交给沈青。'
    expect(validateMemoryCandidate(quote + '沈青没有说话。', memory(quote))).toEqual([])
  })
  it('截掉否定词、来源不存在或无来源的状态不能自动生效', () => {
    const extraction = memory('林远已经死在山洞里。')
    expect(validateMemoryCandidate('众人听说林远已经死在山洞里。', extraction).join('')).toMatch(/不确定|否定/)
    expect(validateMemoryCandidate('林远仍活着。', extraction).join('')).toContain('缺少可定位')
    extraction.newPlotPoints = []
    extraction.characterStateChanges = [{ name: '林远', field: '伤势', oldValue: '', newValue: '死亡' }]
    expect(validateMemoryCandidate('林远仍活着。', extraction).join('')).toContain('缺少可定位')
  })
  it('坏JSON和漏字段有错误标记，明确完整空数组才表示无变化', () => {
    expect(parseMemoryExtractionJson('{坏JSON', 1).parseError).toBeTruthy()
    expect(parseMemoryExtractionJson('{"settingsSuggestions":[]}', 1).parseError).toBeTruthy()
    const empty = memory('')
    empty.newPlotPoints = []
    expect(parseMemoryExtractionJson(JSON.stringify(empty), 1).parseError).toBeUndefined()
  })
  it('长章记忆提取包含中段，超过预算明确失败而不截断成空记忆', async () => {
    const llm = { generateStream: vi.fn().mockResolvedValue('{}') } as unknown as LlmService
    const flow = new WriteFlowService(llm)
    const body = '甲'.repeat(8500) + '唯一的钥匙已交给沈青。' + '乙'.repeat(5000)
    await flow.extractMemoryStream(body, 1, [])
    expect(vi.mocked(llm.generateStream).mock.calls[0][0]).toContain(body)
    await expect(flow.extractMemoryStream('甲'.repeat(40001), 1, [])).rejects.toThrow('未清理原有记忆')
  })
})
