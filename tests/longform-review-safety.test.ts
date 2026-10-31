import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'fs/promises'
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
import { markLongformPending, markBatchReviewPending, clearBatchReviewPending, readLongformReviewState, clearLongformPending } from '../src/main/data/longform-review-state'
import { MemoryWriter } from '../src/main/data/memory-writer'
import { SettingsWriter } from '../src/main/data/settings-writer'
import type { WriteFlowService } from '../src/main/data/write-flow-service'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { ChapterSelfCheckReport, MemoryExtraction } from '../src/shared/types'
import { createWritingProject } from './helpers/writing-project'
import { acceptedDeslop } from './helpers/accepted-deslop'
import type { AsyncLocalStorage } from 'async_hooks'
import type { ChapterMemoryCoordinator } from '../src/main/data/chapter-memory-coordinator'
import { ChapterService } from '../src/main/data/chapter-service'

const goal = '陆安必须寻找失踪的母亲，不能无故放弃这个全书目标。'
const bad = '陆安宣布永久放弃寻找母亲，从此只在街边卖画谋生。'
const good = '陆安向船夫询问母亲的下落，随后沿着河岸继续寻找。'
const cleared = JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item', 'boundary'], findings: [] })
const rejected = JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item', 'boundary'], findings: [
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

  it('CLI 模型的已核验分项在中断后保存并重新核验，正文变更后不能复用', async () => {
    const first = '陆安丢掉旧信。', second = '船夫离开渡口。'
    const original = `开头。${first}\n${'无关正文。'.repeat(100)}\n${second}结尾。`
    await new ProseRepo(dir).write(1, original)
    vi.spyOn(service, 'buildChapterPrompt').mockResolvedValue({ user: '上下文', system: '' } as Awaited<ReturnType<WriteService['buildChapterPrompt']>>)
    ;(settings as unknown as { getDeslopRules: () => Promise<object> }).getDeslopRules = async () => ({})
    const flow = (service as unknown as { flow: WriteFlowService }).flow
    vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue('[]')
    const internal = service as unknown as { llm: LlmService; assertLongformConsistency: () => Promise<unknown>; repairLongformConflict: (
      pid: string, chapter: number, text: string, issue: string, cb: () => void, options: object
    ) => Promise<string> }
    vi.spyOn(internal, 'assertLongformConsistency').mockResolvedValue(async () => {})
    let phase = 0, repairCalls = 0, verificationCalls = 0
    const model = vi.fn().mockImplementation(async (prompt, options) => {
      if (options?.meta?.feature === 'continuityRepairVerify') {
        if (prompt.includes('独立的长篇冲突修复规划 Agent')) return JSON.stringify({ groups: [{ ids: ['G1'] }, { ids: ['G2'] }] })
        if (prompt.includes('判断当前稿是否已经完整解决本项')) return phase === 2 ? '{"resolved":true}' : '{"resolved":false}'
        verificationCalls++
        if (phase === 2 && verificationCalls === 1) return '{"passed":false,"issues":["旧信需要交代保管位置"]}'
        return '{"passed":true,"issues":[]}'
      }
      if (options?.meta?.feature === 'continuityRepair') {
        repairCalls++
        if (phase === 0 && repairCalls === 2) throw new Error('LLM_ABORTED')
        const target = prompt.split('--- 最初确认的问题 ---')[1].split('--- 本轮需要解决的问题')[0]
        const before = target.includes('本章：陆安丢掉旧信。') ? (phase === 2 ? '陆安收好旧信。' : first) : second
        return JSON.stringify({ replacements: [{ before, after: before === first ? '陆安收好旧信。' : before === second ? '船夫留在渡口。' : '陆安把旧信收进衣袋。' }] })
      }
      throw new Error('unexpected model call')
    })
    internal.llm = { generateStream: model, getCacheIdentity: async () => null, getOperationIdentity: async () => 'cli-model' } as unknown as LlmService
    const issue = 'LONGFORM_CONFLICT: 冲突\n主线：旧信不能丢\n本章：陆安丢掉旧信。\n依据：必须保留\n章节边界：船夫不能离开\n本章：船夫离开渡口。\n依据：必须等候'
    await expect(internal.repairLongformConflict(id, 1, original, issue, () => {}, {})).rejects.toThrow('LLM_ABORTED')
    expect(await new ProseRepo(dir).read(1)).toBe(original)
    const checkpoint = JSON.parse(await readFile(join(dir, '.cache', 'chapter-stages', '1-longform-repair-progress.json'), 'utf8'))
    expect(checkpoint.value.next).toBe(1)
    phase = 1; repairCalls = 0; verificationCalls = 0
    expect(await internal.repairLongformConflict(id, 1, original, issue, () => {}, {}))
      .toContain('陆安收好旧信。')
    expect(repairCalls).toBe(1)
    expect(verificationCalls).toBeGreaterThanOrEqual(2)
    phase = 2; repairCalls = 0; verificationCalls = 0
    const resumed = await internal.repairLongformConflict(id, 1, original, issue, () => {}, {})
    expect(resumed).toContain('陆安把旧信收进衣袋。')
    expect(resumed).toContain('船夫留在渡口。')
    expect(repairCalls).toBe(1)
    await new ProseRepo(dir).write(1, original + '作者新添一句。')
    phase = 0; repairCalls = 0
    await expect(internal.repairLongformConflict(id, 1, original + '作者新添一句。', issue, () => {}, {})).rejects.toThrow('LLM_ABORTED')
    expect(repairCalls).toBe(2)
  })

  it('最终细纲复核的新问题自动进入修复队列，并在修改后重新整章复核', async () => {
    const first = '陆安丢掉旧信。', second = '船夫离开渡口。', third = '标签属于船夫。'
    const original = `开头。${first}${second}${third}${'无关正文。'.repeat(100)}`
    await new ProseRepo(dir).write(1, original)
    vi.spyOn(service, 'buildChapterPrompt').mockResolvedValue({ user: '上下文', system: '' } as Awaited<ReturnType<WriteService['buildChapterPrompt']>>)
    const flow = (service as unknown as { flow: WriteFlowService }).flow
    const outline = vi.spyOn(flow, 'checkOutlineStream').mockResolvedValueOnce('[]').mockResolvedValueOnce(JSON.stringify([{
      type: 1, priority: 'P1', outline: '标签属于陆安。', actual: third, suggestion: '修正标签归属。', boundaryViolation: false
    }])).mockResolvedValue('[]')
    const internal = service as unknown as { llm: LlmService; assertLongformConsistency: () => Promise<unknown>; repairLongformConflict: (
      pid: string, chapter: number, text: string, issue: string, cb: () => void, options: object
    ) => Promise<string> }
    vi.spyOn(internal, 'assertLongformConsistency').mockResolvedValue(async () => {})
    const model = vi.fn().mockImplementation(async (prompt, options) => {
      if (options?.meta?.feature === 'continuityRepairVerify') {
        if (prompt.includes('独立的长篇冲突修复规划 Agent')) return JSON.stringify({ groups: [{ ids: ['G1'] }, { ids: ['G2'] }] })
        if (prompt.includes('判断当前稿是否已经完整解决本项')) return '{"resolved":false}'
        return '{"passed":true,"issues":[]}'
      }
      if (options?.meta?.feature === 'continuityRepair') {
        const target = prompt.split('--- 最初确认的问题 ---')[1].split('--- 本轮需要解决的问题')[0]
        const before = target.includes('修正标签归属') ? third : target.includes('旧信不能丢') ? first : second
        return JSON.stringify({ replacements: [{ before, after: before === first ? '陆安收好旧信。' : before === second ? '船夫留在渡口。' : '标签属于陆安。' }] })
      }
      throw new Error('unexpected model call')
    })
    internal.llm = { generateStream: model } as unknown as LlmService
    const issue = 'LONGFORM_CONFLICT: 冲突\n主线：旧信不能丢\n本章：陆安丢掉旧信。\n依据：必须保留\n章节边界：船夫不能离开\n本章：船夫离开渡口。\n依据：必须等候'
    const result = await internal.repairLongformConflict(id, 1, original, issue, () => {}, {})
    expect(result).toContain('标签属于陆安。')
    expect(outline).toHaveBeenCalledTimes(3)
    expect(model.mock.calls.filter(([, options]) => options?.meta?.feature === 'continuityRepair')).toHaveLength(3)
    expect(await new ProseRepo(dir).read(1)).toBe(original)
  })

  async function seedSummary(chapter: number, prose: string) {
    await new ChapterSummaryRepo(dir).write({ schemaVersion: 1, chapterNumber: chapter, sourceHash: hashProse(prose), generatedAt: '',
      events: [{ text: '陆安放弃寻找', evidence: prose }], stateChanges: [], openThreads: [], continuity: [
        { kind: 'thread', subject: '寻找母亲', object: '', aspect: '进展', value: '已放弃', evidence: prose }
      ] })
  }

  function stubSuccessfulPostChecks() {
    const flow = (service as unknown as { flow: WriteFlowService }).flow
    vi.spyOn(flow, 'extractEndingState').mockResolvedValue({ chapterNumber: 1,
      characterPositions: [], characterStates: [], timePoint: '', unfinished: [], suspense: '', props: [] })
    vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue('[]')
    vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(JSON.stringify(extraction(1)))
    return flow
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

  it('后章内嵌前章完整补跑时复用已通过的同稿核对，独立补跑仍重新核对', async () => {
    verdict = cleared
    await new ProseRepo(dir).write(1, good)
    const internal = service as unknown as {
      assertLongformConsistency: (id: string, chapter: number, prose: string) => Promise<() => Promise<void>>
      runFullFlowForChapterInOperation: () => Promise<unknown>
    }
    vi.spyOn(internal, 'runFullFlowForChapterInOperation').mockImplementation(async () => {
      await (await internal.assertLongformConsistency(id, 1, good))()
    })
    await service.runChapterWrite(id, 3, async () => {
      await (await internal.assertLongformConsistency(id, 1, good))()
      await service.runFullFlowForChapter(id, 2, () => {})
    })
    expect(generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'longformGuard')).toHaveLength(1)
    await service.runFullFlowForChapter(id, 2, () => {})
    expect(generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'longformGuard')).toHaveLength(2)
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

  it('手动概要与后台同稿核对并发时共享任务，不互相覆盖隔离标记', async () => {
    await new ProseRepo(dir).write(1, good)
    let release!: () => void
    let started!: () => void
    let joined!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const start = new Promise<void>(resolve => { started = resolve })
    const join = new Promise<void>(resolve => { joined = resolve })
    generate.mockImplementation(async (_prompt, opts) => {
      if (opts?.meta?.feature === 'longformGuard') { started(); await gate; return cleared }
      return JSON.stringify({ events: [{ text: '继续寻找母亲', evidence: good }], stateChanges: [], openThreads: [], continuity: [] })
    })
    const summary = service.generateChapterSummary(id, 1, good, { force: true })
    await start
    const internal = service as unknown as { assertLongformConsistency: (pid: string, n: number, text: string,
      opts: { signal?: AbortSignal; onStart: () => void }) => Promise<() => Promise<void>> }
    const background = internal.assertLongformConsistency(id, 1, good, { signal: new AbortController().signal, onStart: joined })
    await join
    expect(generate.mock.calls.filter(([, o]) => o?.meta?.feature === 'longformGuard')).toHaveLength(1)
    release()
    const [result, receipt] = await Promise.all([summary, background])
    await receipt()
    expect(result.stale).toBe(false)
    expect((await readLongformReviewState(dir)).pending['1']).toBeUndefined()
    expect((await new ChapterSummaryRepo(dir).read(1))?.sourceHash).toBe(hashProse(good))
  })

  it('取消同稿共享核对的一个调用者，不取消其他调用者或污染通过记录', async () => {
    await new ProseRepo(dir).write(1, good)
    let release!: () => void
    let started!: () => void
    let joined!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const start = new Promise<void>(resolve => { started = resolve })
    const join = new Promise<void>(resolve => { joined = resolve })
    generate.mockImplementation(async (_prompt, opts) => {
      if (opts?.meta?.feature === 'longformGuard') { started(); await gate; expect(opts.signal.aborted).toBe(false); return cleared }
      return '{}'
    })
    const internal = service as unknown as { assertLongformConsistency: (pid: string, n: number, text: string,
      opts: { signal?: AbortSignal; onStart?: () => void }) => Promise<() => Promise<void>> }
    const controller = new AbortController()
    const first = internal.assertLongformConsistency(id, 1, good, { signal: controller.signal })
    const cancelled = expect(first).rejects.toThrow('LLM_ABORTED')
    await start
    const second = internal.assertLongformConsistency(id, 1, good, { onStart: joined })
    await join
    controller.abort()
    await cancelled
    release()
    await (await second)()
    expect((await readLongformReviewState(dir)).pending['1']).toBeUndefined()
    expect(generate.mock.calls.filter(([, o]) => o?.meta?.feature === 'longformGuard')).toHaveLength(1)
  })

  it('恢复稿的旧道具名在润色及记忆提取前即被拦住，批次重试仍复用原稿且不能推进', async () => {
    const previous='陆安把原信装入绸布封套，收入衣内保管。'
    const stale='陆安从衣内取出青布封套，将原信递给陆宁。'
    await new ProseRepo(dir).write(1,previous)
    await new ProseRepo(dir).write(2,stale)
    await new ChapterSummaryRepo(dir).write({schemaVersion:1,chapterNumber:1,sourceHash:hashProse(previous),generatedAt:'',
      events:[],stateChanges:[],openThreads:[],continuity:[{kind:'item',subject:'原信',object:'',aspect:'持有者',value:'陆安，装在绸布封套内',evidence:previous}]})
    verdict=JSON.stringify({completed:true,checked:['mainline','knowledge','thread','item','boundary'],findings:[
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

  it('批次隔离与单章待核对的拦截提示分别指向批次恢复和单章同步', async () => {
    await new ProseRepo(dir).write(1, good)
    const token = await markBatchReviewPending(dir, 1, hashProse(good))
    await expect(service.buildChapterPrompt(id, 2)).rejects.toThrow('批次隔离')
    await expect(service.buildChapterPrompt(id, 2)).rejects.toThrow('补跑待核对章节')
    await clearBatchReviewPending(dir, 1, token)
    await markLongformPending(dir, 1, hashProse(good))
    await expect(service.buildChapterPrompt(id, 2)).rejects.toThrow('重新同步 / 补跑同步')
    expect(await new ProseRepo(dir).read(1)).toBe(good)
  })

  it('单章写作交稿核对查出冲突时自动修复、落盘并复核解除待核对', async () => {
    verdict = rejected
    await new ProseRepo(dir).write(1, bad)
    const repairSpy = vi.spyOn(service as unknown as { repairLongformConflict: () => Promise<string> },
      'repairLongformConflict').mockImplementation(async () => { verdict = cleared; return good })
    const autoRepaired = (service as unknown as {
      assertLongformConsistencyAutoRepaired: (pid: string, n: number, text: string, opts?: object) => Promise<string>
    }).assertLongformConsistencyAutoRepaired.bind(service)
    await expect(autoRepaired(id, 1, bad)).resolves.toBe(good)
    expect(repairSpy).toHaveBeenCalledTimes(1)
    expect(await new ProseRepo(dir).read(1)).toBe(good)
    expect((await readLongformReviewState(dir)).pending['1']).toBeUndefined()
  })

  it('实际续写自动补核前章后继续组装上下文，预览仍保持只读', async () => {
    verdict = cleared
    await new ProseRepo(dir).write(1, good)
    await seedSummary(1, good)
    await markLongformPending(dir, 1, hashProse(good))
    await expect(service.buildChapterPrompt(id, 2)).rejects.toThrow('LONGFORM_HISTORY_PENDING')
    expect(generate).not.toHaveBeenCalled()
    const stages: string[] = []
    const prompt = await service.runChapterWrite(id, 2, () => service.buildChapterPrompt(
      id, 2, null, '本章继续询问线索', undefined, true, undefined, detail => stages.push(detail)))
    expect(prompt.user).toContain(good)
    expect(stages.some(s => s.includes('自动补核第 1 章'))).toBe(true)
    expect((await readLongformReviewState(dir)).pending['1']).toBeUndefined()
    expect(await new ProseRepo(dir).read(1)).toBe(good)
    const audits = generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'longformGuard')
    expect(audits).toHaveLength(1)
    expect(audits[0][0]).not.toContain('本章继续询问线索')
  })

  it('补核按章节顺序进行，不处理当前章与未来章', async () => {
    verdict = cleared
    for (const n of [1, 2, 3, 4]) {
      await new ProseRepo(dir).write(n, good)
      await markLongformPending(dir, n, hashProse(good))
    }
    const internal = service as unknown as {
      recoverLongformHistory: (pid: string, dir: string, chapter: number) => Promise<void>
    }
    await internal.recoverLongformHistory(id, dir, 3)
    expect(generate.mock.calls.filter(([, o]) => o?.meta?.feature === 'longformGuard')
      .map(([, o]) => o.meta.chapterNumber)).toEqual([1, 2])
    expect(Object.keys((await readLongformReviewState(dir)).pending)).toEqual(['3', '4'])
  })

  it('自动补核发现真实冲突时报告具体章节与原因，保留正文和隔离', async () => {
    await new ProseRepo(dir).write(1, bad)
    await markLongformPending(dir, 1, hashProse(bad))
    await expect(service.buildChapterPrompt(id, 2, null, undefined, undefined, true))
      .rejects.toThrow(/第 1 章自动补核未完成：[\s\S]*LONGFORM_CONFLICT[\s\S]*无转变依据/)
    expect((await readLongformReviewState(dir)).pending['1']).toBeDefined()
    expect(await new ProseRepo(dir).read(1)).toBe(bad)
    expect(generate.mock.calls.every(([, o]) => o?.meta?.feature === 'longformGuard')).toBe(true)
  })

  it('实际续写自动恢复批次遗留的前章，预览仍只读且不处理当前章或未来章', async () => {
    verdict = cleared
    stubSuccessfulPostChecks()
    for (const n of [1, 2, 3, 4]) {
      await new ProseRepo(dir).write(n, good)
      await seedSummary(n, good)
      await markBatchReviewPending(dir, n, hashProse(good))
      await markLongformPending(dir, n, hashProse(good))
    }
    await expect(service.buildChapterPrompt(id, 3)).rejects.toThrow('LONGFORM_HISTORY_PENDING')
    expect(generate).not.toHaveBeenCalled()
    const stages: string[] = []
    const internal = service as unknown as {
      recoverLongformHistory: (pid: string, dir: string, chapter: number, signal?: AbortSignal, progress?: (s: string) => void) => Promise<void>
    }
    await service.runChapterWrite(id, 3, () => internal.recoverLongformHistory(id, dir, 3, undefined, s => stages.push(s)))
    const state = await readLongformReviewState(dir)
    expect(Object.keys(state.pending)).toEqual(['3', '4'])
    expect(Object.keys(state.batchPending!)).toEqual(['3', '4'])
    expect([...new Set(generate.mock.calls.filter(([, o]) => o?.meta?.feature === 'longformGuard')
      .map(([, o]) => o.meta.chapterNumber))]).toEqual([1, 2])
    expect(stages.some(s => s.includes('自动补跑第 2 章'))).toBe(true)
    expect(await new ProseRepo(dir).read(2)).toBe(good)
  })

  it('前章批次恢复完成后继续生成提示词，不把当前章要求传给前章', async () => {
    verdict = cleared
    stubSuccessfulPostChecks()
    await new ProseRepo(dir).write(1, good)
    await seedSummary(1, good)
    await markBatchReviewPending(dir, 1, hashProse(good))
    const prompt = await service.buildChapterPrompt(id, 2, null, '本章继续询问线索', undefined, true)
    expect(prompt.user).toContain(good)
    expect((await readLongformReviewState(dir)).batchPending?.['1']).toBeUndefined()
    const audits = generate.mock.calls.filter(([, o]) => o?.meta?.feature === 'longformGuard')
    expect(audits.length).toBeGreaterThan(0)
    expect(audits[0][0]).not.toContain('本章继续询问线索')
  })

  it('同时重试共享同一前章补跑，取消一方不会中断另一方', async () => {
    await new ProseRepo(dir).write(1, good)
    const token = await markBatchReviewPending(dir, 1, hashProse(good))
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const repair = vi.spyOn(service, 'repairQuarantinedChapters').mockImplementation(async (_id, _cb, opts) => {
      started()
      await gate
      expect(opts?.signal?.aborted).toBe(false)
      await clearBatchReviewPending(dir, 1, token)
      return { ok: true, repaired: [1], cleared: [], failures: [] }
    })
    const internal = service as unknown as {
      recoverLongformHistory: (pid: string, dir: string, n: number, signal?: AbortSignal, progress?: (s: string) => void) => Promise<void>
    }
    const firstController = new AbortController()
    const first = internal.recoverLongformHistory(id, dir, 2, firstController.signal)
    const firstFailure = expect(first).rejects.toThrow('LLM_ABORTED')
    await ready
    let secondJoined!: () => void
    const joined = new Promise<void>(resolve => { secondJoined = resolve })
    const second = internal.recoverLongformHistory(id, dir, 2, undefined, () => secondJoined())
    await joined
    firstController.abort()
    await firstFailure
    release()
    await second
    expect(repair).toHaveBeenCalledOnce()
    expect((await readLongformReviewState(dir)).batchPending?.['1']).toBeUndefined()
  })

  it('前章缺少概要时自动复用保存稿完整补跑，失败保留隔离并报告具体原因', async () => {
    verdict = cleared
    await new ProseRepo(dir).write(1, good)
    await markBatchReviewPending(dir, 1, hashProse(good))
    await markLongformPending(dir, 1, hashProse(good))
    const batchSpy = vi.spyOn(service, 'generateChaptersBatch').mockResolvedValue({
      status: 'paused', fromChapter: 1, toChapter: 1, total: 1, completed: [1], current: 1, currentChapter: 1,
      pendingPostProcessChapter: 1, pauseReason: '记忆同步失败：测试服务暂不可用'
    })
    await expect(service.buildChapterPrompt(id, 2, null, undefined, undefined, true))
      .rejects.toThrow('第 1 章自动补跑未完成：记忆同步失败：测试服务暂不可用')
    expect(batchSpy).toHaveBeenCalledWith(id, 1, 1, expect.any(Function), null, expect.objectContaining({ onlyChapters: [1] }),
      { fromChapter: 1, total: 1, completed: [1], pendingPostProcessChapter: 1 }, { autoContinue: true })
    expect(generate).not.toHaveBeenCalled()
    const state = await readLongformReviewState(dir)
    expect(state.batchPending?.['1']).toBeDefined()
    expect(state.pending['1']).toBeDefined()
    expect(await new ProseRepo(dir).read(1)).toBe(good)
  })

  it('自动恢复不能只凭完成返回值放行，仍须确认隔离确实解除', async () => {
    await new ProseRepo(dir).write(1, good)
    await markBatchReviewPending(dir, 1, hashProse(good))
    vi.spyOn(service, 'repairQuarantinedChapters').mockResolvedValue({ ok: true, repaired: [1], cleared: [], failures: [] })
    await expect(service.buildChapterPrompt(id, 2, null, undefined, undefined, true))
      .rejects.toThrow('自动补跑后仍有未完成检查')
    expect((await readLongformReviewState(dir)).batchPending?.['1']).toBeDefined()
    expect(generate).not.toHaveBeenCalled()
  })

  it('取消前章批次自动补跑时保留隔离，不开始后章', async () => {
    await new ProseRepo(dir).write(1, good)
    await seedSummary(1, good)
    await markBatchReviewPending(dir, 1, hashProse(good))
    const controller = new AbortController()
    generate.mockImplementation(async () => { controller.abort(); return cleared })
    await expect(service.buildChapterPrompt(id, 2, null, undefined, undefined, true, controller.signal))
      .rejects.toThrow('LLM_ABORTED')
    expect((await readLongformReviewState(dir)).batchPending?.['1']).toBeDefined()
    expect(await new ProseRepo(dir).read(1)).toBe(good)
    expect(generate.mock.calls.every(([, o]) => o?.meta?.feature === 'longformGuard')).toBe(true)
  })

  it('补核取消或期间正文变化时不解除隔离，下一次重试可恢复', async () => {
    await new ProseRepo(dir).write(1, good)
    await markLongformPending(dir, 1, hashProse(good))
    const controller = new AbortController()
    controller.abort()
    await expect(service.buildChapterPrompt(id, 2, null, undefined, undefined, true, controller.signal))
      .rejects.toThrow('LLM_ABORTED')
    expect(generate).not.toHaveBeenCalled()
    const changed = good + '船夫点了点头。'
    generate.mockImplementation(async () => {
      await new ProseRepo(dir).write(1, changed)
      return cleared
    })
    await expect(service.buildChapterPrompt(id, 2, null, undefined, undefined, true))
      .rejects.toThrow('LONGFORM_CONTEXT_CHANGED')
    expect((await readLongformReviewState(dir)).pending['1']).toBeDefined()
    generate.mockResolvedValue(cleared)
    const internal = service as unknown as {
      recoverLongformHistory: (pid: string, dir: string, chapter: number) => Promise<void>
    }
    await internal.recoverLongformHistory(id, dir, 2)
    expect((await readLongformReviewState(dir)).pending['1']).toBeUndefined()
    expect(await new ProseRepo(dir).read(1)).toBe(changed)
  })

  it('传入正文与磁盘保存稿不一致时不自动修复，原样抛出冲突', async () => {
    verdict = rejected
    await new ProseRepo(dir).write(1, bad)
    const repairSpy = vi.spyOn(service as unknown as { repairLongformConflict: () => Promise<string> },
      'repairLongformConflict')
    const autoRepaired = (service as unknown as {
      assertLongformConsistencyAutoRepaired: (pid: string, n: number, text: string, opts?: object) => Promise<string>
    }).assertLongformConsistencyAutoRepaired.bind(service)
    await expect(autoRepaired(id, 1, bad + '后来他又后悔了。')).rejects.toThrow('LONGFORM_CONFLICT')
    expect(repairSpy).not.toHaveBeenCalled()
    expect(await new ProseRepo(dir).read(1)).toBe(bad)
  })

  it('自动修复失败时保留当前稿，错误附带原始冲突明细', async () => {
    verdict = rejected
    await new ProseRepo(dir).write(1, bad)
    vi.spyOn(service as unknown as { repairLongformConflict: () => Promise<string> },
      'repairLongformConflict').mockRejectedValue(new Error('模拟修复失败'))
    const autoRepaired = (service as unknown as {
      assertLongformConsistencyAutoRepaired: (pid: string, n: number, text: string, opts?: object) => Promise<string>
    }).assertLongformConsistencyAutoRepaired.bind(service)
    await expect(autoRepaired(id, 1, bad)).rejects.toThrow(/LONGFORM_CONFLICT[\s\S]*自动修复未完成[\s\S]*模拟修复失败/)
    expect(await new ProseRepo(dir).read(1)).toBe(bad)
  })

  it('补跑待核对章节：有正文的章复用批次恢复机制，正文丢失的章清残留记录', async () => {
    await new ProseRepo(dir).write(1, good)
    await markBatchReviewPending(dir, 1, hashProse('已丢失的旧稿'))
    await markLongformPending(dir, 1, hashProse('已丢失的旧稿'))
    await markBatchReviewPending(dir, 2, hashProse(bad))
    const batchSpy = vi.spyOn(service as unknown as { generateChaptersBatch: () => Promise<unknown> },
      'generateChaptersBatch').mockResolvedValue({ status: 'completed' })
    const repair = (service as unknown as {
      repairQuarantinedChapters: (pid: string, cb: (n: number, r: unknown) => void, opts?: object) =>
        Promise<{ ok: boolean; repaired: number[]; cleared: number[]; failures: Array<{ chapter: number; error: string }> }>
    }).repairQuarantinedChapters.bind(service)
    const result = await repair(id, () => {})
    expect(result.ok).toBe(true)
    expect(result.repaired).toEqual([1])
    expect(result.cleared).toEqual([2])
    const call = batchSpy.mock.calls[0] as unknown as Array<unknown>
    expect(call[1]).toBe(1)
    expect(call[2]).toBe(1)
    expect(call[6]).toMatchObject({ fromChapter: 1, total: 1, completed: [1], pendingPostProcessChapter: 1 })
  })

  it('补跑查出冲突时保留隔离并在结果中报告', async () => {
    verdict = rejected
    await new ProseRepo(dir).write(1, bad)
    await markBatchReviewPending(dir, 1, hashProse(bad))
    const stages: string[] = []
    const steps: Array<{ step: string; chapter: number }> = []
    const repair = (service as unknown as {
      repairQuarantinedChapters: (pid: string, cb: (n: number, r: unknown) => void, opts?: object) =>
        Promise<{ ok: boolean; repaired: number[]; cleared: number[]; failures: Array<{ chapter: number; error: string }> }>
    }).repairQuarantinedChapters.bind(service)
    const result = await repair(id, () => {}, {
      onRepairProgress: (message: string) => stages.push(message),
      onFlowProgress: (step: string, chapter: number) => steps.push({ step, chapter })
    })
    expect(result.ok).toBe(false)
    expect(result.failures[0]?.chapter).toBe(1)
    expect(result.failures[0]?.error).toContain('LONGFORM_CONFLICT')
    expect((await readLongformReviewState(dir)).batchPending?.['1']).toBeDefined()
    expect(await new ProseRepo(dir).read(1)).toBe(bad)
    // 补跑进度必须可见：每章开始与流程步骤都要发事件，不能让界面停在"准备补跑"
    expect(stages.some((s) => s.startsWith('开始完整补跑第 1 章'))).toBe(true)
    expect(steps.some((s) => s.chapter === 1 && s.step.startsWith('continuity'))).toBe(true)
  })

  it('概要与正文一致仍不能跳过批次欠下的记忆和细纲检查', async () => {
    verdict = cleared
    const flow = stubSuccessfulPostChecks()
    await new ProseRepo(dir).write(1, good)
    await seedSummary(1, good)
    await markBatchReviewPending(dir, 1, hashProse(good))
    await markLongformPending(dir, 1, hashProse(good))
    const batchSpy = vi.spyOn(service as unknown as { generateChaptersBatch: () => Promise<unknown> },
      'generateChaptersBatch')
    const guardCalls = () => generate.mock.calls.filter(([, o]) => o?.meta?.feature === 'longformGuard').length
    const repair = (service as unknown as {
      repairQuarantinedChapters: (pid: string, cb: (n: number, r: unknown) => void, opts?: object) =>
        Promise<{ ok: boolean; repaired: number[]; cleared: number[]; failures: Array<{ chapter: number; error: string }> }>
    }).repairQuarantinedChapters.bind(service)
    const result = await repair(id, () => {})
    expect(result.ok).toBe(true)
    expect(result.repaired).toEqual([1])
    expect(batchSpy).toHaveBeenCalledOnce()
    expect(flow.extractMemoryStream).toHaveBeenCalled()
    expect(flow.checkOutlineStream).toHaveBeenCalled()
    expect(guardCalls()).toBeGreaterThan(0)
    const state = await readLongformReviewState(dir)
    expect(state.pending['1']).toBeUndefined()
    expect(state.batchPending?.['1']).toBeUndefined()
    expect(await new ProseRepo(dir).read(1)).toBe(good)
  })

  it('仅欠单章核对且概要有效时仍可快速补核', async () => {
    verdict = cleared
    await new ProseRepo(dir).write(1, good)
    await seedSummary(1, good)
    await markLongformPending(dir, 1, hashProse(good))
    const batch = vi.spyOn(service, 'generateChaptersBatch')
    const result = await service.repairQuarantinedChapters(id, () => {})
    expect(result).toMatchObject({ ok: true, repaired: [1] })
    expect(batch).not.toHaveBeenCalled()
    expect((await readLongformReviewState(dir)).pending['1']).toBeUndefined()
  })

  it.each(['新批次', '正文变化', '取消'] as const)('单章补核即将完成时发生%s，旧结果不能宣布完成', async change => {
    verdict = cleared
    await new ProseRepo(dir).write(1, good)
    await seedSummary(1, good)
    await markLongformPending(dir, 1, hashProse(good))
    const controller = new AbortController()
    const internal = service as unknown as {
      assertLongformConsistency: (pid: string, n: number, text: string, opts?: object) => Promise<() => Promise<void>>
    }
    const checkOriginal = internal.assertLongformConsistency.bind(service)
    let token: string | undefined
    vi.spyOn(internal, 'assertLongformConsistency').mockImplementation(async (...args) => {
      const confirm = await checkOriginal(...args)
      if (change === '新批次') token = await markBatchReviewPending(dir, 1, hashProse(good))
      if (change === '正文变化') await new ProseRepo(dir).write(1, good + '船夫离开了。')
      if (change === '取消') controller.abort()
      return confirm
    })
    const result = await service.repairQuarantinedChapters(id, () => {}, { signal: controller.signal })
    expect(result.ok).toBe(false)
    expect(result.repaired).toEqual([])
    if (token) expect((await readLongformReviewState(dir)).batchPending?.['1']?.token).toBe(token)
    if (change === '正文变化') expect(await new ProseRepo(dir).read(1)).toBe(good + '船夫离开了。')
  })

  it('快路径查出冲突且修复失败时保留隔离并报告', async () => {
    verdict = rejected
    await new ProseRepo(dir).write(1, bad)
    await seedSummary(1, bad)
    await markLongformPending(dir, 1, hashProse(bad))
    vi.spyOn(service as unknown as { repairLongformConflict: () => Promise<string> },
      'repairLongformConflict').mockRejectedValue(new Error('模拟修复失败'))
    const batchSpy = vi.spyOn(service as unknown as { generateChaptersBatch: () => Promise<unknown> },
      'generateChaptersBatch')
    const repair = (service as unknown as {
      repairQuarantinedChapters: (pid: string, cb: (n: number, r: unknown) => void, opts?: object) =>
        Promise<{ ok: boolean; repaired: number[]; cleared: number[]; failures: Array<{ chapter: number; error: string }> }>
    }).repairQuarantinedChapters.bind(service)
    const result = await repair(id, () => {})
    expect(result.ok).toBe(false)
    expect(result.failures[0]?.chapter).toBe(1)
    expect(result.failures[0]?.error).toContain('LONGFORM_CONFLICT')
    expect(result.failures[0]?.error).toContain('自动修复未完成')
    expect(batchSpy).not.toHaveBeenCalled()
    expect((await readLongformReviewState(dir)).pending['1']).toBeDefined()
    expect(await new ProseRepo(dir).read(1)).toBe(bad)
  })

  it('快路径冲突修复成功后转入完整补跑重建概要与记忆', async () => {
    verdict = rejected
    await new ProseRepo(dir).write(1, bad)
    await seedSummary(1, bad)
    await markLongformPending(dir, 1, hashProse(bad))
    vi.spyOn(service as unknown as { repairLongformConflict: () => Promise<string> },
      'repairLongformConflict').mockImplementation(async () => { verdict = cleared; return good })
    const batchSpy = vi.spyOn(service as unknown as { generateChaptersBatch: () => Promise<unknown> },
      'generateChaptersBatch').mockResolvedValue({ status: 'completed' })
    const progressMessages: string[] = []
    const repair = (service as unknown as {
      repairQuarantinedChapters: (pid: string, cb: (n: number, r: unknown) => void, opts?: object) =>
        Promise<{ ok: boolean; repaired: number[]; cleared: number[]; failures: Array<{ chapter: number; error: string }> }>
    }).repairQuarantinedChapters.bind(service)
    const result = await repair(id, () => {}, { onRepairProgress: (m: string) => progressMessages.push(m) })
    expect(result.repaired).toEqual([1])
    expect(batchSpy).toHaveBeenCalledTimes(1)
    const call = batchSpy.mock.calls[0] as unknown as Array<unknown>
    expect(call[6]).toMatchObject({ fromChapter: 1, total: 1, completed: [1], pendingPostProcessChapter: 1 })
    expect(progressMessages.some((m) => m.includes('转入完整补跑'))).toBe(true)
  })

  it('没有隔离章节时补跑为空操作', async () => {
    const batchSpy = vi.spyOn(service as unknown as { generateChaptersBatch: () => Promise<unknown> },
      'generateChaptersBatch')
    const repair = (service as unknown as {
      repairQuarantinedChapters: (pid: string, cb: (n: number, r: unknown) => void, opts?: object) =>
        Promise<{ ok: boolean; repaired: number[]; cleared: number[]; failures: Array<{ chapter: number; error: string }> }>
    }).repairQuarantinedChapters.bind(service)
    const result = await repair(id, () => {})
    expect(result).toEqual({ ok: true, repaired: [], cleared: [], failures: [] })
    expect(batchSpy).not.toHaveBeenCalled()
  })

  it('删稿重写：清空正文、概要、章节剧情点并解除全部隔离', async () => {
    await new ProseRepo(dir).write(1, good)
    await seedSummary(1, good)
    await markBatchReviewPending(dir, 1, hashProse(good))
    await markLongformPending(dir, 1, hashProse(good))
    const plotDir = join(dir, '记忆', '剧情点')
    await mkdir(plotDir, { recursive: true })
    await writeFile(join(plotDir, '第001章 试探.md'), '剧情点内容', 'utf8')
    const drop = (service as unknown as {
      dropQuarantinedChapter: (pid: string, chapter: number) => Promise<void>
    }).dropQuarantinedChapter.bind(service)
    await drop(id, 1)
    expect(await new ProseRepo(dir).read(1)).toBe('')
    const state = await readLongformReviewState(dir)
    expect(state.pending['1']).toBeUndefined()
    expect(state.batchPending?.['1']).toBeUndefined()
    await expect(new ChapterSummaryRepo(dir).read(1)).resolves.toBeNull()
    await expect(stat(join(plotDir, '第001章 试探.md'))).rejects.toThrow()
    // 未隔离的章不受影响，删稿拒绝执行
    await new ProseRepo(dir).write(2, good)
    await expect(drop(id, 2)).rejects.toThrow('不在待核对隔离中')
    expect(await new ProseRepo(dir).read(2)).toBe(good)
  })

  it('修复一轮不收敛即停手并建议重新生成', async () => {
    verdict = rejected
    await new ProseRepo(dir).write(1, bad)
    await markBatchReviewPending(dir, 1, hashProse(bad))
    vi.spyOn(service as unknown as { repairLongformConflict: () => Promise<string> },
      'repairLongformConflict').mockResolvedValue(bad + '随后齐越又提了一次旧剑。')
    const repair = (service as unknown as {
      repairQuarantinedChapters: (pid: string, cb: (n: number, r: unknown) => void, opts?: object) =>
        Promise<{ ok: boolean; repaired: number[]; cleared: number[]; failures: Array<{ chapter: number; error: string }> }>
    }).repairQuarantinedChapters.bind(service)
    const result = await repair(id, () => {})
    expect(result.ok).toBe(false)
    expect(result.failures[0]?.chapter).toBe(1)
    expect(result.failures[0]?.error).toContain('LONGFORM_CONFLICT')
    expect(result.failures[0]?.error).toContain('建议删除本章正文重新生成')
    expect((await readLongformReviewState(dir)).batchPending?.['1']).toBeDefined()
    // 保留当前稿=修复稿：外层在重跑核对前已把修复稿落盘
    expect(await new ProseRepo(dir).read(1)).toBe(bad + '随后齐越又提了一次旧剑。')
  })

  it.each([
    { proseFirst: true, boundaryViolation: false, passes: true },
    { proseFirst: false, boundaryViolation: false, passes: false },
    { proseFirst: true, boundaryViolation: true, passes: false }
  ])('局部冲突修复遵守正文优先策略及边界：%j', async ({ proseFirst, boundaryViolation, passes }) => {
    const content = bad + '街边的灯还亮着，船夫站在河边等他，手里捏着一封信。'
    await new ProseRepo(dir).write(1, content)
    vi.spyOn(service, 'buildChapterPrompt').mockResolvedValue({ user: goal, system: '' } as Awaited<ReturnType<WriteService['buildChapterPrompt']>>)
    generate.mockImplementation(async (_prompt, opts) => {
      if (opts?.meta?.feature === 'continuityRepair') {
        expect(_prompt).toContain('原稿细纲检查发现的待修项')
        expect(_prompt).toContain('补入旧日信物')
        return JSON.stringify({ replacements: [{ before: '永久放弃', after: '绝不放弃' }] })
      }
      if (opts?.meta?.feature === 'continuityRepairVerify') return JSON.stringify({ passed: true, issues: [] })
      return cleared
    })
    const flow = (service as unknown as { flow: WriteFlowService }).flow
    vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue(JSON.stringify([{
      type: 1, typeLabel: '漏写', priority: 'P1', outline: '河边问路时应出现旧日信物。',
      actual: '正文尚未出示旧日信物。', suggestion: '补入旧日信物。', resolution: 'updateContent', boundaryViolation
    }]))
    const internal = service as unknown as { repairLongformConflict: (
      id: string, chapter: number, content: string, issue: string, progress: () => void, opts: object
    ) => Promise<string> }
    const repaired = internal.repairLongformConflict(id, 1, content, '不能放弃寻母目标。', () => {}, { proseFirst })
    if (passes) await expect(repaired).resolves.toBe(content.replace('永久放弃', '绝不放弃'))
    else await expect(repaired).rejects.toThrow(boundaryViolation ? '章节边界' : '补入旧日信物')
    expect(await new ProseRepo(dir).read(1)).toBe(content)
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
    verdict = cleared
    const internal = service as unknown as { autoDeslopGeneratedProse: () => Promise<string> }
    vi.spyOn(internal, 'autoDeslopGeneratedProse').mockRejectedValue(new Error('LLM_ABORTED'))
    await expect(service.generateChapterStream(id, 1)).rejects.toThrow('LLM_ABORTED')
    expect(await new ProseRepo(dir).read(1)).toBe(bad)
    expect((await readLongformReviewState(dir)).pending['1']).toBeDefined()
    expect(await new ProseMemoryIndex(dir).searchBefore(2, '陆安寻找母亲')).toEqual([])
  })

  it('新章事实修复失败时不先消耗整章润色调用，并保留原稿与隔离', async () => {
    const internal = service as unknown as {
      autoDeslopGeneratedProse: () => Promise<string>
      repairLongformConflict: () => Promise<string>
    }
    const polish = vi.spyOn(internal, 'autoDeslopGeneratedProse')
    vi.spyOn(internal, 'repairLongformConflict').mockRejectedValue(new Error('修复仍有冲突'))
    await expect(service.generateChapterStream(id, 1)).rejects.toThrow('修复仍有冲突')
    expect(polish).not.toHaveBeenCalled()
    expect(await new ProseRepo(dir).read(1)).toBe(bad)
    expect((await readLongformReviewState(dir)).pending['1']).toBeDefined()
  })

  it('新章先修复事实，再润色修复稿，润色变稿仍独立核对且正确保存', async () => {
    const internal = service as unknown as {
      autoDeslopGeneratedProse: (pid: string, chapter: number, text: string) => Promise<string>
      repairLongformConflict: () => Promise<string>
    }
    const repair = vi.spyOn(internal, 'repairLongformConflict').mockImplementation(async () => { verdict = cleared; return good })
    const polished = good + '船夫指向上游。'
    const polish = vi.spyOn(internal, 'autoDeslopGeneratedProse').mockResolvedValue(polished)
    const final = vi.fn(), repaired = vi.fn()
    await expect(service.generateChapterStream(id, 1, { proseFirst: true, onFinalProseReady: final, onConflictRepaired: repaired }))
      .resolves.toBe(polished)
    expect(repair).toHaveBeenCalledWith(id, 1, bad, expect.any(String), expect.any(Function), expect.objectContaining({ proseFirst: true }))
    expect(polish.mock.calls[0][2]).toBe(good)
    expect(final.mock.calls.map(([text]) => text)).toEqual([good, polished])
    expect(repaired).toHaveBeenCalledWith(good)
    expect(await new ProseRepo(dir).read(1)).toBe(polished)
    expect((await readLongformReviewState(dir)).pending['1']).toBeUndefined()
    const audits = generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'longformGuard')
    expect(audits).toHaveLength(3)
    expect(audits[2][0]).toContain(polished)
  })

  it('新章润色未改变正文时，前置与最终核对只请求一次真实检查', async () => {
    verdict = cleared
    await expect(service.generateChapterStream(id, 1)).resolves.toBe(bad)
    expect(generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'longformGuard')).toHaveLength(1)
    expect((await readLongformReviewState(dir)).pending['1']).toBeUndefined()
  })

  it.each(['rejected', 'failed', 'changed', 'incomplete'] as const)('补跑 %s 表达检查时仅复用同稿已完成的拒绝结论，仍执行事实和写后检查', async mode => {
    verdict = cleared
    await new ProseRepo(dir).write(1, good)
    stubSuccessfulPostChecks()
    await new ChapterService(projects).setAutoDeslopReport(id, 1, good, {
      status: mode === 'failed' ? 'failed' : 'review_required', message: '仍需精修', remainingIssues: 1,
      repairAttempts: 2, verificationAttempts: mode === 'incomplete' ? 0 : 2, issues: ['频道重复播报'],
      dialogueQuality: { passed: false, beforeRatio: 0.2, afterRatio: 0.2, attempts: 2, issues: ['频道重复播报'] }
    })
    const content = mode === 'changed' ? good + '船夫走到河边。' : good
    if (mode === 'changed') await new ProseRepo(dir).write(1, content)
    const polish = vi.spyOn(service as unknown as { autoDeslopGeneratedProse: () => Promise<string> }, 'autoDeslopGeneratedProse')
    const result = await service.runFullFlowForChapter(id, 1, () => {}, { contentOverride: content })
    expect(polish).toHaveBeenCalledTimes(mode === 'rejected' ? 0 : 1)
    expect(generate.mock.calls.some(([, opts]) => opts?.meta?.feature === 'longformGuard')).toBe(true)
    expect(result.outlineDiff.checked).toBe(true)
    if (mode === 'rejected') expect(result.autoDeslop).toMatchObject({ status: 'review_required', issues: ['频道重复播报'] })
  })

  it('连续流程把正文优先策略传入生成；修复预算耗尽后不再重复检查与修复', async () => {
    const generateChapter = vi.spyOn(service, 'generateChapterStream').mockImplementation(async (_pid, _chapter, opts) => {
      if (typeof opts === 'object') await opts?.onProseGenerated?.(bad)
      throw new Error('LONGFORM_CONFLICT: 本章仍有冲突。自动修复未完成：CHAPTER_REPAIR_BUDGET: 本轮修复已耗尽。')
    })
    const internal = service as unknown as { repairLongformConflict: () => Promise<string> }
    const repair = vi.spyOn(internal, 'repairLongformConflict')
    await expect(service.runFullFlowForChapter(id, 1, () => {}, { proseFirst: true,
      onProseGenerated: text => new ProseRepo(dir).write(1, text) }))
      .rejects.toThrow('CHAPTER_REPAIR_BUDGET')
    expect(generateChapter).toHaveBeenCalledWith(id, 1, expect.objectContaining({ proseFirst: true }))
    expect(repair).not.toHaveBeenCalled()
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

  it('设定补丁排队时主线更新，释放队列重新核对后只提交一次', async () => {
    verdict = cleared
    await new ProseRepo(dir).write(1, good)
    const coordinator = (service as unknown as { memoryCoordinator: ChapterMemoryCoordinator }).memoryCoordinator
    const exclusive = coordinator.exclusive.bind(coordinator)
    vi.spyOn(coordinator, 'exclusive').mockImplementationOnce(async (pid, action) => {
      await writeFile(join(dir, '大纲', '大纲.md'), `# 寻母\n\n## 主线剧情走向\n\n${goal}必须核实渡船。`)
      return exclusive(pid, action)
    })
    const apply = vi.spyOn(SettingsWriter.prototype, 'applyPatches')
    await expect(service.applySettingsPatches(id, extraction(1))).resolves.toMatchObject({ errors: [] })
    expect(generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'longformGuard')).toHaveLength(2)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('设定补丁排队时本章改稿，不得自动重试并应用旧提取', async () => {
    verdict = cleared
    await new ProseRepo(dir).write(1, good)
    const coordinator = (service as unknown as { memoryCoordinator: ChapterMemoryCoordinator }).memoryCoordinator
    const exclusive = coordinator.exclusive.bind(coordinator)
    vi.spyOn(coordinator, 'exclusive').mockImplementationOnce(async (pid, action) => {
      await new ProseRepo(dir).write(1, good + '船夫点头。')
      return exclusive(pid, action)
    })
    const apply = vi.spyOn(SettingsWriter.prototype, 'applyPatches')
    await expect(service.applySettingsPatches(id, extraction(1))).rejects.toThrow('本章正文已变化')
    expect(apply).not.toHaveBeenCalled()
  })

  it('设定补丁重新核对发现主线冲突，仍然阻止提交', async () => {
    verdict = cleared
    await new ProseRepo(dir).write(1, bad)
    const coordinator = (service as unknown as { memoryCoordinator: ChapterMemoryCoordinator }).memoryCoordinator
    const exclusive = coordinator.exclusive.bind(coordinator)
    vi.spyOn(coordinator, 'exclusive').mockImplementationOnce(async (pid, action) => {
      await writeFile(join(dir, '大纲', '大纲.md'), `# 寻母\n\n## 主线剧情走向\n\n${goal}必须核实渡船。`)
      verdict = rejected
      return exclusive(pid, action)
    })
    const apply = vi.spyOn(SettingsWriter.prototype, 'applyPatches')
    await expect(service.applySettingsPatches(id, extraction(1))).rejects.toThrow('LONGFORM_CONFLICT')
    expect(apply).not.toHaveBeenCalled()
  })

  it('设定补丁重试后资料继续变化，停止而不是无限重试', async () => {
    verdict = cleared
    await new ProseRepo(dir).write(1, good)
    const coordinator = (service as unknown as { memoryCoordinator: ChapterMemoryCoordinator }).memoryCoordinator
    const exclusive = coordinator.exclusive.bind(coordinator)
    let revision = 0
    vi.spyOn(coordinator, 'exclusive').mockImplementation(async (pid, action) => {
      await writeFile(join(dir, '大纲', '大纲.md'), `# 寻母\n\n## 主线剧情走向\n\n${goal}计划版本${++revision}。`)
      return exclusive(pid, action)
    })
    const apply = vi.spyOn(SettingsWriter.prototype, 'applyPatches')
    await expect(service.applySettingsPatches(id, extraction(1))).rejects.toThrow('主线计划已变化')
    expect(generate.mock.calls.filter(([, opts]) => opts?.meta?.feature === 'longformGuard')).toHaveLength(2)
    expect(apply).not.toHaveBeenCalled()
  })
})
