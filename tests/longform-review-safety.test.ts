import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WriteService } from '../src/main/data/write-service'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { ChapterSummaryRepo } from '../src/main/data/memory/chapter-summary-repo'
import { PlotPointRepo } from '../src/main/data/memory/plot-point-repo'
import { ProseMemoryIndex, hashProse } from '../src/main/data/memory/prose-memory-index'
import { buildContinuityContext } from '../src/main/data/memory/continuity-context'
import { markLongformPending, markBatchReviewPending, readLongformReviewState, clearLongformPending } from '../src/main/data/longform-review-state'
import { MemoryWriter } from '../src/main/data/memory-writer'
import { SettingsWriter } from '../src/main/data/settings-writer'
import type { WriteFlowService } from '../src/main/data/write-flow-service'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { ChapterSelfCheckReport, MemoryExtraction } from '../src/shared/types'
import { createWritingProject } from './helpers/writing-project'
import { acceptedDeslop } from './helpers/accepted-deslop'
import type { AsyncLocalStorage } from 'async_hooks'

const goal = '陆安必须寻找失踪的母亲，不能无故放弃这个全书目标。'
const bad = '陆安宣布永久放弃寻找母亲，从此只在街边卖画谋生。'
const good = '陆安向船夫询问母亲的下落，随后沿着河岸继续寻找。'
const cleared = JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item'], findings: [] })
const rejected = JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item'], findings: [
  { kind: 'mainline', message: '无转变依据直接放弃全书目标。', snippet: bad, reference: goal }
] })
const check: ChapterSelfCheckReport = { schemaVersion: 1, chapterNumber: 1, generatedAt: '', ok: true, summary: '通过',
  counts: { pass: 0, fail: 0, warn: 0, skip: 0 }, items: [] }
const extraction = (chapter: number): MemoryExtraction => ({ chapterNumber: chapter, newCharacters: [], newLocations: [], newItems: [],
  newForeshadowings: [], newPlotPoints: [], characterStateChanges: [], collectedForeshadowings: [], settingsPatches: [], settingsSuggestions: [] })

describe('长篇核对绕过与记忆污染回归', () => {
  let root: string, dir: string, id: string, service: WriteService, projects: ProjectService, settings: SettingsRepository
  let generate: ReturnType<typeof vi.fn>
  let verdict: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'longform-review-safety-'))
    settings = { getProjectsRoot: async (fallback: string) => fallback, get: async () => ({ autoMemorySync: true }),
      getReviewRules: async () => ({ enabled: false }) } as unknown as SettingsRepository
    projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
    const project = await createWritingProject(projects, { name: '寻母', genre: '玄幻' })
    id = project.id; dir = project.path; verdict = rejected
    generate = vi.fn().mockImplementation(async (_prompt, opts) => opts?.meta?.feature === 'longformGuard' ? verdict : bad)
    service = new WriteService(projects, { generateStream: generate } as unknown as LlmService,
      undefined, undefined, undefined, settings, undefined, acceptedDeslop)
    vi.spyOn(service, 'selfCheckChapter').mockResolvedValue(check)
    await writeFile(join(dir, '大纲', '大纲.md'), `# 寻母\n\n## 主线剧情走向\n\n${goal}`)
    for (const n of [1, 2]) await writeFile(join(dir, '细纲', `细纲_第00${n}章_寻信.md`),
      `# 细纲\n\n## 第 ${n} 章：寻信\n\n- **核心事件**：陆安向船夫询问母亲的下落。`)
  })
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

  async function seedSummary(chapter: number, prose: string) {
    await new ChapterSummaryRepo(dir).write({ schemaVersion: 1, chapterNumber: chapter, sourceHash: hashProse(prose), generatedAt: '',
      events: [{ text: '陆安放弃寻找', evidence: prose }], stateChanges: [], openThreads: [], continuity: [
        { kind: 'thread', subject: '寻找母亲', object: '', aspect: '进展', value: '已放弃', evidence: prose }
      ] })
  }

  it('CLI 同一流程复用成功核对，下一流程重新核对',async()=>{
    verdict=cleared
    await new ProseRepo(dir).write(1,good)
    const internal=service as unknown as {longformOperation:AsyncLocalStorage<Set<string>>;assertLongformConsistency:(id:string,n:number,text:string,opts?:object)=>Promise<()=>Promise<void>>}
    await internal.longformOperation.run(new Set(),async()=>{
      for(let i=0;i<3;i++)await (await internal.assertLongformConsistency(id,1,good))()
    })
    expect(generate.mock.calls.filter(([,o])=>o?.meta?.feature==='longformGuard')).toHaveLength(1)
    await internal.longformOperation.run(new Set(),()=>internal.assertLongformConsistency(id,1,good))
    expect(generate.mock.calls.filter(([,o])=>o?.meta?.feature==='longformGuard')).toHaveLength(2)
  })

  it.each(['plan','prose','instruction','routing','history'] as const)('流程中 %s 改变后不能复用旧核对',async change=>{
    verdict=cleared
    let routing='model-a'
    Object.assign((service as unknown as {llm:LlmService}).llm,{getOperationIdentity:async()=>routing})
    await new ProseRepo(dir).write(1,good)
    const n=change==='history'?2:1
    if(n===2)await new ProseRepo(dir).write(2,good)
    const internal=service as unknown as {longformOperation:AsyncLocalStorage<Set<string>>;assertLongformConsistency:(id:string,n:number,text:string,opts?:object)=>Promise<()=>Promise<void>>}
    await internal.longformOperation.run(new Set(),async()=>{
      await internal.assertLongformConsistency(id,n,good)
      if(change==='plan')await writeFile(join(dir,'大纲','大纲.md'),`# 寻母\n\n## 主线剧情走向\n\n${goal}必须核实渡船。`)
      if(change==='prose')await new ProseRepo(dir).write(1,good+'船夫点头。')
      if(change==='routing')routing='model-b'
      if(change==='history')await new ProseRepo(dir).write(1,good+'船夫已经离开。')
      await internal.assertLongformConsistency(id,n,good,change==='instruction'?{instruction:'先核实渡船'}:{})
    })
    expect(generate.mock.calls.filter(([,o])=>o?.meta?.feature==='longformGuard')).toHaveLength(2)
  })

  it('同一流程不复用冲突或取消结果，命中成功记录仍响应取消',async()=>{
    await new ProseRepo(dir).write(1,bad)
    const internal=service as unknown as {longformOperation:AsyncLocalStorage<Set<string>>;assertLongformConsistency:(id:string,n:number,text:string,opts?:object)=>Promise<()=>Promise<void>>}
    await internal.longformOperation.run(new Set(),async()=>{
      await expect(internal.assertLongformConsistency(id,1,bad)).rejects.toThrow('LONGFORM_CONFLICT')
      verdict=cleared
      await internal.assertLongformConsistency(id,1,bad)
      const controller=new AbortController();controller.abort()
      await expect(internal.assertLongformConsistency(id,1,bad,{signal:controller.signal})).rejects.toThrow('LLM_ABORTED')
    })
    expect(generate.mock.calls.filter(([,o])=>o?.meta?.feature==='longformGuard')).toHaveLength(2)
  })

  it('恢复稿的旧道具名在润色及记忆提取前即被拦住，批次重试仍复用原稿且不能推进', async () => {
    const previous='陆安把原信装入绸布封套，收入衣内保管。'
    const stale='陆安从衣内取出青布封套，将原信递给陆宁。'
    await new ProseRepo(dir).write(1,previous)
    await new ProseRepo(dir).write(2,stale)
    await new ChapterSummaryRepo(dir).write({schemaVersion:1,chapterNumber:1,sourceHash:hashProse(previous),generatedAt:'',
      events:[],stateChanges:[],openThreads:[],continuity:[{kind:'item',subject:'原信',object:'',aspect:'持有者',value:'陆安，装在绸布封套内',evidence:previous}]})
    verdict=JSON.stringify({completed:true,checked:['mainline','knowledge','thread','item'],findings:[
      {kind:'item',message:'封套没有更换依据却恢复旧名',snippet:stale,reference:previous}
    ]})
    generate.mockImplementation(async (_prompt,opts)=>opts?.meta?.feature==='longformGuard'
      ? opts.meta.chapterNumber===1 ? cleared : verdict : bad)
    const deslop=vi.spyOn(acceptedDeslop,'deslop')
    const flow=(service as unknown as {flow:WriteFlowService}).flow
    const extract=vi.spyOn(flow,'extractMemoryStream')
    const saved=vi.fn()
    await expect(service.runFullFlowForChapter(id,2,()=>{}, {contentOverride:stale,onContentGenerated:saved,proseFirst:true}))
      .rejects.toThrow('跨章道具')
    expect(deslop).not.toHaveBeenCalled()
    expect(extract).not.toHaveBeenCalled()
    expect(saved).not.toHaveBeenCalled()
    const resumed=await service.generateChaptersBatch(id,2,2,()=>{},null,{},
      {fromChapter:1,total:2,completed:[1,2],pendingPostProcessChapter:2},{autoContinue:true})
    expect(resumed,JSON.stringify(resumed)).toMatchObject({status:'paused',pendingPostProcessChapter:2})
    expect(resumed.pauseReason).toContain('跨章道具')
    expect(await new ProseRepo(dir).read(2)).toBe(stale)
    expect(await new ChapterSummaryRepo(dir).read(2)).toBeNull()
    expect(generate.mock.calls.some(([,opts])=>opts?.meta?.feature==='chapter')).toBe(false)
  })

  it('已落盘的拒绝稿从热原文索引、近期摘要和连续性台账中隔离，重启仍阻止后章', async () => {
    await new ProseRepo(dir).write(1, bad)
    await seedSummary(1, bad)
    const index = new ProseMemoryIndex(dir)
    expect(await index.searchBefore(2, '陆安寻找母亲')).not.toHaveLength(0)
    await expect(service.generateChapterSummary(id, 1, bad)).rejects.toThrow('LONGFORM_CONFLICT')
    expect(await index.searchBefore(2, '陆安寻找母亲')).toEqual([])
    expect(await new PlotPointRepo(dir).listSummariesBefore(2)).toEqual([])
    expect(await new ChapterSummaryRepo(dir).readCurrent(1, bad)).toBeNull()
    expect(await buildContinuityContext(dir, 2, { text: '陆安寻找母亲', characters: ['陆安'], aliases: [], props: [] })).toEqual([])
    const restarted = new WriteService(projects, { generateStream: generate } as unknown as LlmService)
    await expect(restarted.buildChapterPrompt(id, 2)).rejects.toThrow('LONGFORM_HISTORY_PENDING')
    expect(await new ProseRepo(dir).read(1)).toBe(bad)
  })

  it('手动概要重建和自动补齐的降级分支都不能把拒绝稿包装成有效历史', async () => {
    await new ProseRepo(dir).write(1, bad)
    await seedSummary(1, bad)
    const before = await readFile(join(dir, '记忆', '章节概要', '第001章.json'), 'utf8')
    const result = await service.regenerateSummariesBatch(id, { fromChapter: 1, toChapter: 1, onlyMissing: true }, () => {})
    expect(result.ok).toBe(false)
    expect(result.results[0].error).toContain('LONGFORM_CONFLICT')
    const complete = service as unknown as { completeChapterSummary: (pid: string, dir: string, chapter: number, prose: string) => Promise<unknown> }
    await expect(complete.completeChapterSummary(id, dir, 1, bad)).rejects.toThrow('LONGFORM_CONFLICT')
    expect(await readFile(join(dir, '记忆', '章节概要', '第001章.json'), 'utf8')).toBe(before)
  })

  it('关闭自动同步也必须核对，不能提前返回空成功', async () => {
    await new ProseRepo(dir).write(1, bad)
    vi.spyOn(settings, 'get').mockResolvedValue({ autoMemorySync: false } as Awaited<ReturnType<SettingsRepository['get']>>)
    const result = await service.syncChapterAfterWrite(id, 1, bad, { selfCheck: check })
    expect(result?.memory.reviewRequired?.join('\n')).toContain('LONGFORM_CONFLICT')
  })

  it('所有章节标为完成、关闭连续模式，也不能越过磁盘上的批次待检查标记', async () => {
    await new ProseRepo(dir).write(1, bad)
    await markBatchReviewPending(dir, 1, hashProse(bad))
    const flow = vi.spyOn(service, 'runFullFlowForChapter')
    const result = await service.resumeChaptersBatch(id, 1, 1, () => {}, null, {},
      { fromChapter: 1, total: 1, completed: [1] }, { autoContinue: false })
    expect(result).toMatchObject({ status: 'paused', pendingPostProcessChapter: 1 })
    expect(flow).not.toHaveBeenCalled()
    expect((await readLongformReviewState(dir)).batchPending?.['1']).toBeDefined()
  })

  it('旧批次没有待检查字段时，全部完成快捷返回仍会重新核对当前保存稿', async () => {
    await new ProseRepo(dir).write(1, bad)
    const result = await service.resumeChaptersBatch(id, 1, 1, () => {}, null, {},
      { fromChapter: 1, total: 1, completed: [1] }, { autoContinue: false })
    expect(result).toMatchObject({ status: 'paused', pendingPostProcessChapter: 1 })
    expect(result.pauseReason).toContain('LONGFORM_CONFLICT')
  })

  it('contentOverride 和缓存中的 proseSynced 标记不能绕过关闭同步后的最终核对', async () => {
    await new ProseRepo(dir).write(1, bad)
    verdict = cleared
    vi.spyOn(settings, 'get').mockResolvedValue({ autoMemorySync: false } as Awaited<ReturnType<SettingsRepository['get']>>)
    const flow = (service as unknown as { flow: WriteFlowService }).flow
    vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue('[]')
    vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(JSON.stringify(extraction(1)))
    await service.runFullFlowForChapter(id, 1, () => {}, { contentOverride: bad })
    const cache = (service as unknown as { postProcessCache: Map<string, { outline?: { report: { proseSynced?: number } } }> }).postProcessCache
    for (const value of cache.values()) if (value.outline) value.outline.report.proseSynced = 0
    verdict = rejected
    await expect(service.runFullFlowForChapter(id, 1, () => {}, { contentOverride: bad })).rejects.toThrow('LONGFORM_CONFLICT')
  })

  it('提取记忆等待期间前章变动，即使当前稿未变，也不能提交旧检查结论', async () => {
    verdict = cleared
    await new ProseRepo(dir).write(1, '远处的驿站仍然空着，没有任何人经过。')
    await new ProseRepo(dir).write(2, good)
    const flow = (service as unknown as { flow: WriteFlowService }).flow
    vi.spyOn(flow, 'extractMemoryStream').mockImplementation(async () => {
      await new ProseRepo(dir).write(1, '远处的驿站已经有人经过，留下了一封信。')
      return JSON.stringify(extraction(2))
    })
    const apply = vi.spyOn(MemoryWriter.prototype, 'applyAutomatic')
    const result = await service.syncChapterAfterWrite(id, 2, good, { selfCheck: check, deepReview: [] })
    expect(result?.memory.errors.join('\n')).toContain('LONGFORM_CONTEXT_CHANGED')
    expect(apply).not.toHaveBeenCalled()
    expect((await readLongformReviewState(dir)).pending['2']).toBeDefined()
  })

  it('原稿保存后中断润色时，未到交稿检查也会持久隔离原稿', async () => {
    const internal = service as unknown as { autoDeslopGeneratedProse: () => Promise<string> }
    vi.spyOn(internal, 'autoDeslopGeneratedProse').mockRejectedValue(new Error('LLM_ABORTED'))
    await expect(service.generateChapterStream(id, 1)).rejects.toThrow('LLM_ABORTED')
    expect(await new ProseRepo(dir).read(1)).toBe(bad)
    expect((await readLongformReviewState(dir)).pending['1']).toBeDefined()
    expect(await new ProseMemoryIndex(dir).searchBefore(2, '陆安寻找母亲')).toEqual([])
  })

  it('按要求重写也必须经过长篇检查', async () => {
    await new ProseRepo(dir).write(1, good)
    await expect(service.adjustChapterStream(id, 1, good, '自然润色对白')).rejects.toThrow('LONGFORM_CONFLICT')
    expect((await readLongformReviewState(dir)).pending['1']).toBeDefined()
  })

  it('强制应用候选只覆盖条目证据，不能绕过整章长篇冲突', async () => {
    await new ProseRepo(dir).write(1, bad)
    await mkdir(join(dir, '.cache', 'memory-candidates'), { recursive: true })
    const source = { ...extraction(1), newPlotPoints: [{ title: '放弃', event: '陆安放弃寻找母亲', evidence: bad }] }
    await writeFile(join(dir, '.cache', 'memory-candidates', 'chapter-1.json'), JSON.stringify({ chapterNumber: 1,
      sourceHash: hashProse(bad), extraction: source, issues: [], chapterIssues: [], itemIssues: [], status: 'pending' }))
    const apply = vi.spyOn(MemoryWriter.prototype, 'applyAutomatic')
    await expect(service.forceApplyMemoryCandidateItems(id, 1, [{ kind: 'plotPoint', index: 0 }])).rejects.toThrow('LONGFORM_CONFLICT')
    expect(apply).not.toHaveBeenCalled()
  })

  it('旧检查不能解除更新任务的隔离标记；空状态文件不能被当作无待核对章节', async () => {
    const old = await markLongformPending(dir, 1, hashProse(bad))
    const latest = await markLongformPending(dir, 1, hashProse(good))
    await expect(clearLongformPending(dir, 1, old)).rejects.toThrow('LONGFORM_CONTEXT_CHANGED')
    expect((await readLongformReviewState(dir)).pending['1'].token).toBe(latest)
    await writeFile(join(dir, '追踪', '.longform-review.json'), '')
    await expect(readLongformReviewState(dir)).rejects.toThrow('LONGFORM_STATE_INVALID')
  })

  it('通过单独的长篇或概要检查，仍不能提前解除批次的写后检查隔离', async () => {
    verdict = cleared
    await new ProseRepo(dir).write(1, good)
    await markBatchReviewPending(dir, 1, hashProse(good))
    generate.mockImplementation(async (_prompt, opts) => opts?.meta?.feature === 'longformGuard' ? cleared
      : JSON.stringify({ events: [{ text: '继续寻找', evidence: good }], stateChanges: [], openThreads: [], continuity: [] }))
    await service.generateChapterSummary(id, 1, good, { force: true })
    expect((await readLongformReviewState(dir)).batchPending?.['1']).toBeDefined()
    expect(await new ChapterSummaryRepo(dir).readCurrent(1, good)).toBeNull()
    expect(await new ProseMemoryIndex(dir).searchBefore(2, '陆安寻找母亲')).toEqual([])
  })

  it('作者明确临时调整绑定原稿与原计划，重启后可沿用；作者改计划后不会继续覆盖新计划', async () => {
    const instruction = '本章明确调整目标：放弃寻母，改为卖画谋生。'
    await new ProseRepo(dir).write(1, bad)
    generate.mockImplementation(async (prompt, opts) => opts?.meta?.feature === 'longformGuard'
      ? prompt.includes(instruction) ? cleared : rejected
      : JSON.stringify({ events: [{ text: '改为卖画', evidence: bad }], stateChanges: [], openThreads: [], continuity: [] }))
    const internal = service as unknown as { assertLongformConsistency: (pid: string, chapter: number, content: string,
      opts: { instruction: string }) => Promise<unknown> }
    await internal.assertLongformConsistency(id, 1, bad, { instruction })
    const restarted = new WriteService(projects, { generateStream: generate } as unknown as LlmService)
    await expect(restarted.generateChapterSummary(id, 1, bad)).resolves.toMatchObject({ stale: false })
    await writeFile(join(dir, '大纲', '大纲.md'), `# 寻母\n\n## 主线剧情走向\n\n${goal}\n后续恢复原寻母主线，不再沿用卖画调整。`)
    await expect(restarted.generateChapterSummary(id, 1, bad, { force: true })).rejects.toThrow('LONGFORM_CONFLICT')
  })

  it('一键采纳新增实体与单独应用设定补丁也不能跳过当前章长篇核对', async () => {
    await new ProseRepo(dir).write(1, bad)
    const value = { ...extraction(1), newCharacters: [{ name: '新画师', role: '配角', identity: '画师', personality: '沉稳' }], settingsPatches: [{ target: 'worldview' as const,
      fileName: '规则', op: 'append_h2' as const, sectionTitle: '卖画', content: '新设定', confidence: 'high' as const, evidence: bad }] }
    await mkdir(join(dir, '.cache', 'memory-candidates'), { recursive: true })
    const candidate = join(dir, '.cache', 'memory-candidates', 'chapter-1.json')
    await writeFile(candidate, JSON.stringify({ chapterNumber: 1, sourceHash: hashProse(bad), extraction: value,
      issues: [], chapterIssues: [], itemIssues: [], status: 'validated' }))
    const newCharacters = vi.spyOn(MemoryWriter.prototype, 'applyNewCharacters')
    const settingsApply = vi.spyOn(SettingsWriter.prototype, 'applyPatches')
    await expect(service.applyAllNewEntities(id, 1)).rejects.toThrow('LONGFORM_CONFLICT')
    await expect(service.applySettingsPatches(id, value, { onlyAuto: true })).rejects.toThrow('LONGFORM_CONFLICT')
    expect(newCharacters).not.toHaveBeenCalled()
    expect(settingsApply).not.toHaveBeenCalled()
    // A stale candidate is rejected even if the model would approve the new manuscript.
    verdict = cleared
    await new ProseRepo(dir).write(1, good)
    await expect(service.applyAllNewEntities(id, 1)).rejects.toThrow('版本不符')
  })
})
