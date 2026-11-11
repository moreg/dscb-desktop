import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, LlmService } from '../src/main/data/llm-service'
import { abortStream, activeStreamCount, clearAllStreams } from '../src/main/data/stream-abort-registry'
import type { ScriptStudioStore } from '../src/main/data/script-studio-store'
import { featureCategoryOf } from '../src/shared/agent-tasks'
import {
  FEATURE_SCRIPT,
  FEATURE_STORYBOARD,
  FEATURE_STORYBOARD_SEGMENT,
  LLM_ABORTED,
  LLM_EMPTY,
  SCRIPT_CONFLICT,
  SCRIPT_EXPORT_BLOCKED,
  SCRIPT_PARSE_FAILED,
  SCRIPT_RUN_ACTIVE,
  SCRIPT_STALE,
  SCRIPT_STORYBOARD_BLOCKED,
  SCRIPT_STUDIO_INVOKE_CHANNELS,
  SCRIPT_STUDIO_TOKEN_CHANNELS,
  SHOT_FIELDS,
  scriptProjectSchema,
  SOURCE_MAX_RANGES,
  type PromptPackage,
  type ScriptProject,
  type ScriptSettings,
  type Shot11,
  type StoryboardUnit
} from '../src/shared/script-studio'
import type { RendererApi } from '../src/shared/types'
import type { IpcTransport } from '../src/preload/api'

const { handlers, send, showSaveDialog } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  send: vi.fn(),
  showSaveDialog: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn)
    }
  },
  BrowserWindow: {
    fromWebContents: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } })
  },
  dialog: { showSaveDialog }
}))

const { registerScriptStudioIpc } = await import('../src/main/ipc/script-studio')
const { ScriptStudioStore: ScriptStudioStoreCtor } = await import('../src/main/data/script-studio-store')
const { createRendererApi } = await import('../src/preload/api')

const DEFAULT_SETTINGS: ScriptSettings = {
  format: 'short',
  platform: '抖音',
  aspectRatio: '9:16',
  targetDurationSec: 90,
  visualStyle: '暂定',
  adaptStrength: 'medium',
  paceTier: 'short-high',
  resolution: '1080p',
  extraRequirements: ''
}

const SCRIPT_BODY = 'SC1 日 内 老宅书房\n林远把账册推过桌面。\n林远\n把账册给我。'
const scriptJson = JSON.stringify({
  body: SCRIPT_BODY,
  adaptationNote: '重组为一个完整戏剧单元',
  tentative: [], additions: [], characters: ['林远'], scenes: ['书房'], props: ['账册'],
  creativeNotes: '压缩环境描写', risks: ['时间线合并导致因果简化']
})

function shot(): Shot11 {
  const base = Object.fromEntries(SHOT_FIELDS.map(field => [field, `${field} 的可执行描述`])) as Shot11
  return { ...base, subjectActionExpression: '林远把账册推过桌面', dialogueAndTone: '林远：「把账册给我。」；语气：低沉' }
}

function makeUnits(): StoryboardUnit[] {
  return [{
    id: 'unit-1', index: 1, durationSec: 8, emotion: '紧绷',
    dramaticAction: '林远交出账册', paceTier: 'short-high', paceReason: '开场高密度',
    suggestedShotCount: 1, firstFrame: '账册摊开在桌上', lastFrame: '账册停在桌沿',
    continuity: '账册位置与上一段一致', characterPositions: '林远在画面左侧',
    assetRefs: [], shots: [shot()]
  }]
}

const storyboardJson = JSON.stringify({ units: makeUnits() })

const event = () => ({ sender: Object.assign(new EventEmitter(), { isDestroyed: () => false }) })
const now = () => new Date().toISOString()

function makeApi(): { api: RendererApi; invoke: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn()
  const on = vi.fn()
  const removeListener = vi.fn()
  const api = createRendererApi({ invoke, on, removeListener } as unknown as IpcTransport) as unknown as RendererApi
  return { api, invoke, on, removeListener }
}

describe('剧本创作 IPC / preload', () => {
  let root: string
  let store: ScriptStudioStore
  let project: ScriptProject
  let generateStream: ReturnType<typeof vi.fn>
  let requestId: string

  beforeEach(async () => {
    handlers.clear()
    clearAllStreams()
    send.mockClear()
    showSaveDialog.mockReset()
    root = mkdtempSync(join(tmpdir(), 'script-studio-ipc-'))
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: join(root, 'export.md') })
    store = new ScriptStudioStoreCtor(join(root, 'script-projects'))
    project = await store.create({
      title: '测试项目',
      settings: DEFAULT_SETTINGS,
      sourceText: SCRIPT_BODY,
      sourceRanges: [{ kind: 'paste', label: '粘贴剧本' }],
      outlineHint: '',
      sourceKind: 'pasteScript',
      truncated: false
    })
    requestId = randomUUID()
    generateStream = vi.fn(async (_prompt: string, opts: GenerateOptions) => {
      opts.onToken?.('片段')
      return scriptJson
    })
    registerScriptStudioIpc(store, { generateStream } as unknown as LlmService)
  })

  afterEach(() => {
    clearAllStreams()
    rmSync(root, { recursive: true, force: true })
  })

  it('12 个 invoke 通道全部注册，全部通道名满足 Web /^[\\w:.-]{1,120}$/ 且 feature 归 auxiliary', () => {
    expect([...handlers.keys()].sort()).toEqual([...SCRIPT_STUDIO_INVOKE_CHANNELS].sort())
    for (const channel of [...SCRIPT_STUDIO_INVOKE_CHANNELS, ...SCRIPT_STUDIO_TOKEN_CHANNELS]) {
      expect(channel).toMatch(/^[\w:.-]{1,120}$/)
    }
    expect(featureCategoryOf(FEATURE_SCRIPT)).toBe('auxiliary')
    expect(featureCategoryOf(FEATURE_STORYBOARD)).toBe('auxiliary')
    expect(featureCategoryOf(FEATURE_STORYBOARD_SEGMENT)).toBe('auxiliary')
  })

  it('所有输入 zod 校验：非法标题 / 非法路径 / 缺 requestId 在 IPC 边界拒绝', async () => {
    const invalidCreates: Array<Record<string, unknown>> = [
      { title: '' },
      { title: 'x', settings: { ...DEFAULT_SETTINGS, format: 'invalid' } },
      { title: 'x', sourceText: 123 }
    ]
    for (const override of invalidCreates) {
      await expect(handlers.get('scriptStudio:createProject')!(event(), {
        title: '合法', settings: DEFAULT_SETTINGS, sourceText: '正文', sourceRanges: [],
        outlineHint: '', sourceKind: 'pasteNovel', truncated: false, ...override
      })).rejects.toThrow('IPC_INPUT_INVALID')
    }
    await expect(handlers.get('scriptStudio:getProject')!(event(), { projectId: '../secret' })).rejects.toThrow('IPC_INPUT_INVALID')
    await expect(handlers.get('scriptStudio:generateScript')!(event(), {
      projectId: project.id, expectedRevision: project.revision
    })).rejects.toThrow('IPC_INPUT_INVALID')
    await expect(handlers.get('scriptStudio:saveStoryboard')!(event(), {
      projectId: project.id, units: [], expectedRevision: 1,
      expectedVersionId: 'x', expectedScriptFingerprint: 'short'
    })).rejects.toThrow('IPC_INPUT_INVALID')
    expect(generateStream).not.toHaveBeenCalled()
  })

  it('12 个通道可独立调用：list/create/get/save/adopt/saveStoryboard/generate/build/export/listRuns/recoverRuns', async () => {
    expect(await handlers.get('scriptStudio:listProjects')!(event())).toHaveLength(1)
    expect(await handlers.get('scriptStudio:getProject')!(event(), { projectId: project.id })).toMatchObject({ id: project.id })
    expect(await handlers.get('scriptStudio:listRuns')!(event(), { projectId: project.id })).toEqual([])
    expect(await handlers.get('scriptStudio:recoverRuns')!(event(), { projectId: project.id })).toMatchObject({ ok: true, recovered: 0 })
    const created = await handlers.get('scriptStudio:createProject')!(event(), {
      title: '第二个项目', settings: DEFAULT_SETTINGS, sourceText: '正文', sourceRanges: [],
      outlineHint: '', sourceKind: 'pasteNovel', truncated: false
    }) as ScriptProject
    expect(created.id).not.toBe(project.id)
    const fresh = await store.get(project.id)
    expect(await handlers.get('scriptStudio:saveProject')!(event(), { project: fresh })).toMatchObject({ ok: true })
    expect(await handlers.get('scriptStudio:adoptCandidate')!(event(), {
      projectId: project.id, candidateId: randomUUID(), expectedRevision: 1, body: 'x', note: ''
    })).toMatchObject({ ok: false })
    expect(await handlers.get('scriptStudio:saveStoryboard')!(event(), {
      projectId: project.id, units: makeUnits(), expectedRevision: 1,
      expectedVersionId: fresh.activeVersionId ?? '', expectedScriptFingerprint: fresh.scriptFingerprint, expectedSourceFingerprint: fresh.source.sourceFingerprint
    })).toMatchObject({ ok: false })
    expect(await handlers.get('scriptStudio:buildPromptPackage')!(event(), { projectId: project.id }))
      .toMatchObject({ ok: false, code: 'SCRIPT_SOURCE_MISSING' })
    await expect(handlers.get('scriptStudio:exportMarkdown')!(event(), {
      projectId: project.id, packages: [{ unitId: 'u' }]
    })).rejects.toThrow('IPC_INPUT_INVALID')
  })

  it('saveStoryboard 主进程闸门：非法 units 返回 SCRIPT_STORYBOARD_BLOCKED 且绝不落盘，合法 units 仍保存', async () => {
    const saveSpy = vi.spyOn(store, 'saveStoryboard')
    const fresh = await store.get(project.id)
    const baseInput = {
      projectId: project.id,
      expectedRevision: fresh.revision,
      expectedVersionId: fresh.activeVersionId ?? '',
      expectedScriptFingerprint: fresh.scriptFingerprint, expectedSourceFingerprint: fresh.source.sourceFingerprint
    }

    // 1) 16 秒：durationSec 超出 4—15 硬阻断。
    const tooLong = makeUnits().map(item => ({ ...item, durationSec: 16 }))
    const blockedDuration = await handlers.get('scriptStudio:saveStoryboard')!(event(), {
      ...baseInput, units: tooLong
    }) as { ok: boolean; code: string; message: string; issues?: Array<{ code: string; severity: string }> }
    expect(blockedDuration).toMatchObject({
      ok: false, code: SCRIPT_STORYBOARD_BLOCKED, message: '分镜存在硬阻断，未保存'
    })
    expect(blockedDuration.issues?.some(item => item.code === 'UNIT_DURATION' && item.severity === 'error')).toBe(true)
    expect(saveSpy).not.toHaveBeenCalled()

    // 2) 缺 11 字段：lighting 为空同样硬阻断。
    const missingField = makeUnits().map(item => ({
      ...item,
      shots: [{ ...item.shots[0], lighting: '   ' }]
    }))
    const blockedField = await handlers.get('scriptStudio:saveStoryboard')!(event(), {
      ...baseInput, units: missingField
    }) as { ok: boolean; code: string; issues?: Array<{ code: string; field?: string }> }
    expect(blockedField).toMatchObject({ ok: false, code: SCRIPT_STORYBOARD_BLOCKED })
    expect(blockedField.issues?.some(item => item.code === 'SHOT_FIELD_EMPTY' && item.field === 'lighting')).toBe(true)
    expect(saveSpy).not.toHaveBeenCalled()

    // 3) 合法 units：仍按原路径调用 store.saveStoryboard 并成功保存。
    const legal = await handlers.get('scriptStudio:saveStoryboard')!(event(), {
      ...baseInput, units: makeUnits()
    })
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(legal).toMatchObject({ ok: true })
    const persisted = await store.get(project.id)
    expect(persisted.storyboard?.units).toHaveLength(1)
    saveSpy.mockRestore()
  })

  it('preload：10 个 invoke 包装映射到正确通道', async () => {
    const { api, invoke } = makeApi()
    invoke.mockResolvedValue({ ok: true })
    const input = { title: 'x', settings: DEFAULT_SETTINGS, sourceText: '正文', sourceRanges: [], outlineHint: '', sourceKind: 'pasteNovel' as const, truncated: false }
    await api.listScriptProjects()
    await api.createScriptProject(input)
    await api.getScriptProject('pid')
    await api.saveScriptProject({ project })
    await api.adoptScriptCandidate({ projectId: project.id, candidateId: randomUUID(), expectedRevision: 1, body: 'x', note: '' })
    await api.saveScriptStoryboard({ projectId: project.id, units: makeUnits(), expectedRevision: 1, expectedVersionId: 'v', expectedScriptFingerprint: 'a'.repeat(64), expectedSourceFingerprint: project.source.sourceFingerprint })
    await api.buildStudioPromptPackage({ projectId: project.id })
    await api.exportStudioMarkdown({ projectId: project.id, packages: [] })
    await api.listStudioRuns({ projectId: project.id })
    await api.recoverStudioRuns({ projectId: project.id })
    expect(invoke.mock.calls.map(call => call[0])).toEqual([
      'scriptStudio:listProjects', 'scriptStudio:createProject', 'scriptStudio:getProject',
      'scriptStudio:saveProject', 'scriptStudio:adoptCandidate', 'scriptStudio:saveStoryboard',
      'scriptStudio:buildPromptPackage', 'scriptStudio:exportMarkdown',
      'scriptStudio:listRuns', 'scriptStudio:recoverRuns'
    ])
    expect(invoke.mock.calls[2]).toEqual(['scriptStudio:getProject', { projectId: 'pid' }])
  })

  it('preload：2 个流式 requestId / onToken / done / abort / removeListener 映射正确', async () => {
    const { api, invoke, on, removeListener } = makeApi()
    let finishScript!: (value: unknown) => void
    invoke.mockImplementation((channel: string) => channel === 'scriptStudio:generateScript'
      ? new Promise(resolve => { finishScript = resolve })
      : Promise.resolve({ ok: true }))
    const scriptToken = vi.fn()
    const scriptHandle = api.generateStudioScript({ projectId: project.id, expectedRevision: 1 }, scriptToken)
    expect(invoke).toHaveBeenCalledWith('scriptStudio:generateScript', {
      projectId: project.id, expectedRevision: 1, requestId: scriptHandle.requestId
    })
    const scriptCallback = on.mock.calls[0][1] as (e: unknown, p: { requestId: string; token: string; done: boolean }) => void
    expect(on.mock.calls[0][0]).toBe('scriptStudio:scriptToken')
    scriptCallback(null, { requestId: 'other', token: '不应出现', done: false })
    scriptCallback(null, { requestId: scriptHandle.requestId, token: '本作', done: false })
    scriptCallback(null, { requestId: scriptHandle.requestId, token: '', done: true })
    expect(scriptToken.mock.calls).toEqual([['本作', false], ['', true]])
    await scriptHandle.abort()
    expect(invoke).toHaveBeenLastCalledWith('llm:abort', scriptHandle.requestId)
    finishScript({ ok: true, candidate: {}, project })
    await scriptHandle
    expect(removeListener).toHaveBeenCalledWith('scriptStudio:scriptToken', scriptCallback)

    let finishBoard!: (value: unknown) => void
    invoke.mockImplementation((channel: string) => channel === 'scriptStudio:generateStoryboard'
      ? new Promise(resolve => { finishBoard = resolve })
      : Promise.resolve({ ok: true }))
    const boardToken = vi.fn()
    const boardHandle = api.generateStudioStoryboard({ projectId: project.id, expectedRevision: 1, unitId: 'unit-1' }, boardToken)
    expect(invoke).toHaveBeenCalledWith('scriptStudio:generateStoryboard', {
      projectId: project.id, expectedRevision: 1, unitId: 'unit-1', requestId: boardHandle.requestId
    })
    const boardCallback = on.mock.calls[1][1] as (e: unknown, p: { requestId: string; token: string; done: boolean }) => void
    expect(on.mock.calls[1][0]).toBe('scriptStudio:storyboardToken')
    boardCallback(null, { requestId: 'unrelated', token: '别的', done: false })
    boardCallback(null, { requestId: boardHandle.requestId, token: '分镜', done: false })
    expect(boardToken.mock.calls).toEqual([['分镜', false]])
    await boardHandle.abort()
    expect(invoke).toHaveBeenLastCalledWith('llm:abort', boardHandle.requestId)
    finishBoard({ ok: true, units: makeUnits() })
    await boardHandle
    expect(removeListener).toHaveBeenCalledWith('scriptStudio:storyboardToken', boardCallback)
  })

  it('generateScript：token/done、feature、只写 candidate 字段、run 落盘终态', async () => {
    const result = await handlers.get('scriptStudio:generateScript')!(event(), {
      projectId: project.id, expectedRevision: project.revision, requestId
    })
    expect(result).toMatchObject({ ok: true })
    expect(send.mock.calls.map(call => call[1])).toEqual([
      { requestId, token: '片段', done: false },
      { requestId, token: '', done: true }
    ])
    const options = generateStream.mock.calls[0][1] as GenerateOptions
    expect(options).toMatchObject({ meta: { feature: FEATURE_SCRIPT }, maxTokens: expect.any(Number) })
    expect(options.systemPrompt).toContain('M1 标准影视剧本')
    const updated = await store.get(project.id)
    expect(updated.candidate?.parseFallback).toBe(false)
    expect(updated.candidate?.body).toBe(SCRIPT_BODY)
    expect(updated.scriptVersions).toHaveLength(1)
    expect(updated.revision).toBe(project.revision)
    const runs = await store.listRuns(project.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'completed', kind: 'script', feature: FEATURE_SCRIPT })
    expect(runs[0].partialText).toBe(scriptJson)
    expect(activeStreamCount()).toBe(0)
  })

  it('generateScript：JSON 解析失败降级为 Markdown 候选并标 parseFallback', async () => {
    generateStream.mockResolvedValue('# SC1 日 内 书房\n\n林远把账册推过桌面。')
    const result = await handlers.get('scriptStudio:generateScript')!(event(), {
      projectId: project.id, expectedRevision: project.revision, requestId
    }) as { ok: boolean; candidate?: { parseFallback: boolean; body: string } }
    expect(result.ok).toBe(true)
    expect(result.candidate?.parseFallback).toBe(true)
    expect(result.candidate?.body).toContain('SC1')
    expect(generateStream).toHaveBeenCalledTimes(1)
  })

  it('generateStoryboard：token/done、feature（整段/按段）、返回 units 但不覆盖已保存分镜', async () => {
    generateStream.mockImplementation(async (_prompt: string, opts: GenerateOptions) => {
      opts.onToken?.('{"units"')
      return storyboardJson
    })
    const result = await handlers.get('scriptStudio:generateStoryboard')!(event(), {
      projectId: project.id, expectedRevision: project.revision, requestId
    }) as { ok: boolean; units?: StoryboardUnit[] }
    expect(result.ok).toBe(true)
    expect(result.units).toHaveLength(1)
    expect((generateStream.mock.calls[0][1] as GenerateOptions).meta?.feature).toBe(FEATURE_STORYBOARD)
    expect(send.mock.calls.map(call => call[1])).toEqual([
      { requestId, token: '{"units"', done: false },
      { requestId, token: '', done: true }
    ])
    expect((await store.get(project.id)).storyboard).toBeNull()

    send.mockClear()
    const savedSegment = await store.saveStoryboard({ projectId: project.id, units: makeUnits(),
      expectedRevision: project.revision, expectedVersionId: project.activeVersionId!,
      expectedScriptFingerprint: project.scriptFingerprint, expectedSourceFingerprint: project.source.sourceFingerprint })
    expect(savedSegment.ok).toBe(true)
    const currentSegment = await store.get(project.id)
    const segmentResult = await handlers.get('scriptStudio:generateStoryboard')!(event(), {
      projectId: project.id, expectedRevision: currentSegment.revision, unitId: 'unit-1', requestId: randomUUID()
    })
    expect(segmentResult).toMatchObject({ ok: true })
    expect((generateStream.mock.calls[1][1] as GenerateOptions).meta?.feature).toBe(FEATURE_STORYBOARD_SEGMENT)
    expect(activeStreamCount()).toBe(0)
  })

  it('generateStoryboard：硬阻断的分镜不返回成功；解析失败保留 retainedText 且不发起第三次模型修复', async () => {
    generateStream.mockResolvedValue('这是一段不是 JSON 的文本')
    const parsed = await handlers.get('scriptStudio:generateStoryboard')!(event(), {
      projectId: project.id, expectedRevision: project.revision, requestId
    })
    expect(parsed).toMatchObject({ ok: false, code: SCRIPT_PARSE_FAILED, retainedText: '这是一段不是 JSON 的文本' })
    expect(generateStream).toHaveBeenCalledTimes(1)

    const badUnit = makeUnits()
    badUnit[0].shots[0].aperture = ''
    generateStream.mockResolvedValue(JSON.stringify({ units: badUnit }))
    const blocked = await handlers.get('scriptStudio:generateStoryboard')!(event(), {
      projectId: project.id, expectedRevision: project.revision, requestId: randomUUID()
    }) as { ok: boolean; units?: StoryboardUnit[] }
    expect(blocked.ok).toBe(false)
    expect(blocked.units).toHaveLength(1)
    expect(generateStream).toHaveBeenCalledTimes(2)
    expect((await store.get(project.id)).storyboard).toBeNull()
  })

  it('停止：提前取消返回 LLM_ABORTED；中途停止保留已收到文本', async () => {
    abortStream(requestId)
    const early = await handlers.get('scriptStudio:generateScript')!(event(), {
      projectId: project.id, expectedRevision: project.revision, requestId
    })
    expect(early).toMatchObject({ ok: false, code: LLM_ABORTED, error: LLM_ABORTED })
    expect(generateStream).not.toHaveBeenCalled()
    expect(activeStreamCount()).toBe(0)

    const midRequestId = randomUUID()
    generateStream.mockImplementation(async (_prompt: string, opts: GenerateOptions) => {
      opts.onToken?.('已收到的前半段')
      abortStream(midRequestId)
      return '已收到的前半段后半段'
    })
    const mid = await handlers.get('scriptStudio:generateScript')!(event(), {
      projectId: project.id, expectedRevision: project.revision, requestId: midRequestId
    })
    expect(mid).toMatchObject({ ok: false, code: LLM_ABORTED, retainedText: '已收到的前半段' })
    const runs = await store.listRuns(project.id)
    expect(runs.some(run => run.status === 'aborted' && run.retainedText === '已收到的前半段')).toBe(true)
  })

  it('失败原因：空结果返回 LLM_EMPTY；关窗取消清理监听与流', async () => {
    generateStream.mockResolvedValueOnce('   ')
    const empty = await handlers.get('scriptStudio:generateScript')!(event(), {
      projectId: project.id, expectedRevision: project.revision, requestId
    })
    expect(empty).toMatchObject({ ok: false, code: LLM_EMPTY })
    expect((empty as { error: string }).error).toContain('未返回内容')

    const e = event()
    generateStream.mockImplementation(async (_prompt: string, opts: GenerateOptions) => {
      e.sender.emit('destroyed')
      expect(opts.signal?.aborted).toBe(true)
      throw new Error('LLM_ABORTED')
    })
    const closed = await handlers.get('scriptStudio:generateScript')!(e, {
      projectId: project.id, expectedRevision: project.revision, requestId: randomUUID()
    })
    expect(closed).toMatchObject({ ok: false, error: LLM_ABORTED })
    expect(e.sender.listenerCount('destroyed')).toBe(0)
    expect(activeStreamCount()).toBe(0)
  })

  it('冲突不覆盖：旧 revision 保存返回 SCRIPT_CONFLICT 且磁盘内容保持', async () => {
    const fresh = await store.get(project.id)
    const result = await handlers.get('scriptStudio:saveProject')!(event(), {
      project: { ...fresh, title: '被旧窗口覆盖', revision: fresh.revision + 3 }
    })
    expect(result).toMatchObject({ ok: false, code: SCRIPT_CONFLICT })
    expect((result as { current: ScriptProject }).current.title).toBe('测试项目')
    expect((await store.get(project.id)).title).toBe('测试项目')
  })

  it('重复运行拒绝：存在 running run 时返回 SCRIPT_RUN_ACTIVE 且不调用模型', async () => {
    await store.writeRun({
      runId: randomUUID(), projectId: project.id, kind: 'script', feature: FEATURE_SCRIPT,
      status: 'running', requestId: randomUUID(), startedAt: now(), updatedAt: now(), partialText: ''
    })
    const result = await handlers.get('scriptStudio:generateScript')!(event(), {
      projectId: project.id, expectedRevision: project.revision, requestId
    })
    expect(result).toMatchObject({ ok: false, code: SCRIPT_RUN_ACTIVE })
    expect(generateStream).not.toHaveBeenCalled()
  })

  it('recoverRuns 把残留 running 标 interrupted，不宣称后台续跑', async () => {
    await store.writeRun({
      runId: randomUUID(), projectId: project.id, kind: 'storyboard', feature: FEATURE_STORYBOARD,
      status: 'running', requestId: randomUUID(), startedAt: now(), updatedAt: now(), partialText: '部分文本'
    })
    const result = await handlers.get('scriptStudio:recoverRuns')!(event(), { projectId: project.id })
    expect(result).toMatchObject({ ok: true, recovered: 1 })
    const runs = await store.listRuns(project.id)
    expect(runs[0].status).toBe('interrupted')
    expect(runs[0].partialText).toBe('部分文本')
  })

  it('buildPromptPackage：过期分镜硬拒 SCRIPT_STALE；正常构建返回纯净包', async () => {
    const fresh = await store.get(project.id)
    const saved = await store.saveStoryboard({
      projectId: project.id, units: makeUnits(),
      expectedRevision: fresh.revision,
      expectedVersionId: fresh.activeVersionId ?? '',
      expectedScriptFingerprint: fresh.scriptFingerprint, expectedSourceFingerprint: fresh.source.sourceFingerprint
    })
    expect(saved.ok).toBe(true)
    const built = await handlers.get('scriptStudio:buildPromptPackage')!(event(), { projectId: project.id }) as {
      ok: boolean; packages: PromptPackage[]
    }
    expect(built.ok).toBe(true)
    expect(built.packages).toHaveLength(1)
    expect(built.packages[0].quality.ok).toBe(true)
    expect(built.packages[0].body).not.toContain('9:16')

    const afterSave = await store.get(project.id)
    const changed = await store.save({
      ...afterSave,
      scriptVersions: afterSave.scriptVersions.map(version => ({ ...version, body: `${version.body}\n新增一句对白。` }))
    })
    expect(changed.ok).toBe(true)
    const stale = await handlers.get('scriptStudio:buildPromptPackage')!(event(), { projectId: project.id })
    expect(stale).toMatchObject({ ok: false, code: SCRIPT_STALE })
  })

  it('exportMarkdown：桌面写 .md、Web 返回 text/markdown、硬阻断与取消', async () => {
    const fresh = await store.get(project.id)
    await store.saveStoryboard({
      projectId: project.id, units: makeUnits(), expectedRevision: fresh.revision,
      expectedVersionId: fresh.activeVersionId ?? '', expectedScriptFingerprint: fresh.scriptFingerprint, expectedSourceFingerprint: fresh.source.sourceFingerprint
    })
    const built = await handlers.get('scriptStudio:buildPromptPackage')!(event(), { projectId: project.id }) as {
      ok: boolean; packages: PromptPackage[]
    }
    const packages = built.packages

    const fileResult = await handlers.get('scriptStudio:exportMarkdown')!(event(), {
      projectId: project.id, packages, preferText: false, allowStale: false
    })
    expect(fileResult).toMatchObject({ ok: true, mode: 'file' })
    expect(existsSync(join(root, 'export.md'))).toBe(true)
    expect(readFileSync(join(root, 'export.md'), 'utf8')).toContain('# 视频提示词包 · 测试项目')

    const textResult = await handlers.get('scriptStudio:exportMarkdown')!(event(), {
      projectId: project.id, packages, preferText: true, allowStale: false
    })
    expect(textResult).toMatchObject({ ok: true, mode: 'text', mimeType: 'text/markdown' })
    expect((textResult as { text: string }).text).toContain('```text')

    const broken = packages.map(pkg => ({ ...pkg, body: `${pkg.body}\n@图片1` }))
    const blocked = await handlers.get('scriptStudio:exportMarkdown')!(event(), {
      projectId: project.id, packages: broken
    })
    expect(blocked).toMatchObject({ ok: false, code: SCRIPT_EXPORT_BLOCKED })
    expect((blocked as { issues: unknown[] }).issues.length).toBeGreaterThan(0)

    showSaveDialog.mockResolvedValueOnce({ canceled: true })
    expect(await handlers.get('scriptStudio:exportMarkdown')!(event(), {
      projectId: project.id, packages, preferText: false
    })).toEqual({ ok: true, canceled: true })

    const stalePackages = packages.map(pkg => ({ ...pkg, meta: { ...pkg.meta, stale: true } }))
    expect(await handlers.get('scriptStudio:exportMarkdown')!(event(), {
      projectId: project.id, packages: stalePackages, preferText: true, allowStale: false
    })).toMatchObject({ ok: false, code: SCRIPT_STALE })
  })

  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(yes => { resolve = yes })
    return { promise, resolve }
  }

  it('旧分镜不能用当前 revision 重新保存为最新，原分镜及过期状态保留', async () => {
    await store.saveStoryboard({ projectId: project.id, units: makeUnits(), expectedRevision: project.revision,
      expectedVersionId: project.activeVersionId!, expectedScriptFingerprint: project.scriptFingerprint,
      expectedSourceFingerprint: project.source.sourceFingerprint })
    const before = await store.get(project.id)
    await store.save({ ...before, scriptVersions: before.scriptVersions.map(v => ({ ...v, body: v.body + '\n新剧情。' })) })
    const current = await store.get(project.id)
    const result = await handlers.get('scriptStudio:saveStoryboard')!(event(), {
      projectId: current.id, units: before.storyboard!.units, expectedRevision: current.revision,
      expectedVersionId: before.storyboard!.basedOn.versionId,
      expectedScriptFingerprint: before.storyboard!.basedOn.scriptFingerprint,
      expectedSourceFingerprint: before.storyboard!.basedOn.sourceFingerprint
    })
    expect(result).toMatchObject({ ok: false, code: SCRIPT_STALE })
    expect((await store.get(project.id)).storyboard).toEqual(before.storyboard)
    expect(await handlers.get('scriptStudio:buildPromptPackage')!(event(), { projectId: project.id }))
      .toMatchObject({ ok: false, code: SCRIPT_STALE })
  })

  it('仅来源发生变化，也拒绝旧来源分镜保存', async () => {
    await store.save({ ...project, source: { ...project.source, text: '新的来源' } })
    const current = await store.get(project.id)
    expect(current.scriptFingerprint).toBe(project.scriptFingerprint)
    expect(await handlers.get('scriptStudio:saveStoryboard')!(event(), {
      projectId: project.id, units: makeUnits(), expectedRevision: current.revision,
      expectedVersionId: project.activeVersionId, expectedScriptFingerprint: project.scriptFingerprint,
      expectedSourceFingerprint: project.source.sourceFingerprint
    })).toMatchObject({ ok: false, code: SCRIPT_STALE })
    expect((await store.get(project.id)).storyboard).toBeNull()
  })

  it('分镜返回生成时的依据，生成期间改稿不能改变返回指纹', async () => {
    const started = deferred<void>(); const completion = deferred<string>()
    generateStream.mockImplementation(async () => { started.resolve(); return completion.promise })
    const result = handlers.get('scriptStudio:generateStoryboard')!(event(), {
      projectId: project.id, expectedRevision: project.revision, requestId
    })
    await started.promise
    await store.save({ ...project, scriptVersions: project.scriptVersions.map(v => ({ ...v, body: v.body + '\n修改。' })) })
    completion.resolve(storyboardJson)
    expect(await result).toMatchObject({ ok: true, basedOn: {
      projectId: project.id, versionId: project.activeVersionId,
      scriptFingerprint: project.scriptFingerprint, sourceFingerprint: project.source.sourceFingerprint
    } })
  })

  it('恢复记录跳过活跃及取消收尾中的请求，并维持项目互斥直到终态落盘', async () => {
    const started = deferred<void>(); const completion = deferred<string>()
    generateStream.mockImplementation(async () => { started.resolve(); return completion.promise })
    const pending = handlers.get('scriptStudio:generateScript')!(event(), {
      projectId: project.id, expectedRevision: project.revision, requestId
    })
    await started.promise
    abortStream(requestId)
    const recovered = await handlers.get('scriptStudio:recoverRuns')!(event(), {})
    expect(recovered).toMatchObject({ ok: true, recovered: 0 })
    expect((await store.listRuns(project.id))[0].status).toBe('running')
    expect(await handlers.get('scriptStudio:generateStoryboard')!(event(), {
      projectId: project.id, expectedRevision: project.revision, requestId: randomUUID()
    })).toMatchObject({ ok: false, code: SCRIPT_RUN_ACTIVE })
    completion.resolve(scriptJson)
    expect(await pending).toMatchObject({ ok: false, code: LLM_ABORTED })
    expect((await store.listRuns(project.id))[0].status).toBe('aborted')
    await expect(store.assertNoActiveRun(project.id, 'script')).resolves.toBeUndefined()
  })

  it('两个窗口同时生成时，检查和登记原子化，只调用一次模型', async () => {
    const completion = deferred<string>()
    generateStream.mockImplementation(() => completion.promise)
    const inputs = [requestId, randomUUID()]
    const requests = inputs.map(id => handlers.get('scriptStudio:generateScript')!(event(), {
      projectId: project.id, expectedRevision: project.revision, requestId: id
    }))
    // 任一请求先返回的只能是被互斥拒绝的请求，另一个仍在等待模型。
    expect(await Promise.race(requests)).toMatchObject({ ok: false, code: SCRIPT_RUN_ACTIVE })
    completion.resolve(scriptJson)
    const results = await Promise.all(requests)
    expect(results.filter(r => (r as { ok: boolean }).ok)).toHaveLength(1)
    expect(generateStream).toHaveBeenCalledTimes(1)
  })

  it('模型完成后保存异常仍保留完整原始文本，并释放任务互斥', async () => {
    const save = vi.spyOn(store, 'saveCandidate').mockRejectedValueOnce(new Error('磁盘暂时不可写'))
    const result = await handlers.get('scriptStudio:generateScript')!(event(), {
      projectId: project.id, expectedRevision: project.revision, requestId
    })
    expect(result).toMatchObject({ ok: false, error: '磁盘暂时不可写', retainedText: scriptJson })
    expect((await store.listRuns(project.id))[0]).toMatchObject({ status: 'failed', partialText: scriptJson, retainedText: scriptJson })
    save.mockRestore()
    await expect(store.assertNoActiveRun(project.id, 'script')).resolves.toBeUndefined()
    expect(await handlers.get('scriptStudio:generateScript')!(event(), {
      projectId: project.id, expectedRevision: project.revision, requestId: randomUUID()
    })).toMatchObject({ ok: true })
  })

  it('导出重新比对磁盘指纹：旧包默认拒绝，允许旧版时必须标明过期', async () => {
    await store.saveStoryboard({ projectId: project.id, units: makeUnits(), expectedRevision: project.revision,
      expectedVersionId: project.activeVersionId!, expectedScriptFingerprint: project.scriptFingerprint,
      expectedSourceFingerprint: project.source.sourceFingerprint })
    const built = await handlers.get('scriptStudio:buildPromptPackage')!(event(), { projectId: project.id }) as { packages: PromptPackage[] }
    const current = await store.get(project.id)
    await store.save({ ...current, scriptVersions: current.scriptVersions.map(v => ({ ...v, body: v.body + '\n修改。' })) })
    const input = { projectId: project.id, packages: built.packages, preferText: true }
    expect(await handlers.get('scriptStudio:exportMarkdown')!(event(), input))
      .toMatchObject({ ok: false, code: SCRIPT_STALE })
    const allowed = await handlers.get('scriptStudio:exportMarkdown')!(event(), { ...input, allowStale: true }) as { text: string }
    expect(allowed.text).toContain('已过期（基于旧版本）')
    expect(allowed.text).not.toContain('最新（基于当前正式稿与分镜）')
    expect(built.packages[0].meta.stale).toBe(false)
    const other = await store.create({ title: '其他项目', settings: DEFAULT_SETTINGS, sourceText: '正文', sourceRanges: [], outlineHint: '', sourceKind: 'pasteNovel', truncated: false })
    expect(await handlers.get('scriptStudio:exportMarkdown')!(event(), { ...input, projectId: other.id, allowStale: true }))
      .toMatchObject({ ok: false, code: SCRIPT_EXPORT_BLOCKED })
  })

  it.each([11, SOURCE_MAX_RANGES])('中短篇全文 %i 节可创建、重读与保存，所有来源记录完整保留', async count => {
    const ranges = Array.from({ length: count }, (_, i) => ({ kind: 'shortStorySection' as const,
      label: `第 ${i + 1} 节`, storyId: randomUUID(), sectionNumber: i + 1 }))
    const created = await handlers.get('scriptStudio:createProject')!(event(), {
      title: '全文改编', settings: DEFAULT_SETTINGS, sourceText: ranges.map(r => r.label + '正文。').join('\n'),
      sourceRanges: ranges, outlineHint: '', sourceKind: 'short', truncated: false
    }) as ScriptProject
    expect(created.source.ranges).toEqual(ranges)
    const loaded = await store.get(created.id)
    expect(scriptProjectSchema.safeParse(loaded).success).toBe(true)
    const saved = await handlers.get('scriptStudio:saveProject')!(event(), { project: loaded })
    expect(saved).toMatchObject({ ok: true, project: { source: { ranges } } })
    expect((await store.get(created.id)).source.ranges).toEqual(ranges)
  })

  it('台词遗漏在生成、保存和绕过专用保存后的构建阶段都被阻断', async () => {
    const units = makeUnits()
    units[0].shots[0].dialogueAndTone = '无对白'
    generateStream.mockResolvedValue(JSON.stringify({ units }))
    const generated = await handlers.get('scriptStudio:generateStoryboard')!(event(), {
      projectId: project.id, expectedRevision: project.revision, requestId: randomUUID()
    })
    expect(generated).toMatchObject({ ok: false, quality: { errors: [expect.objectContaining({ code: 'DIALOGUE_SOURCE_MISMATCH' })] } })
    const saved = await handlers.get('scriptStudio:saveStoryboard')!(event(), {
      projectId: project.id, units, expectedRevision: project.revision, expectedVersionId: project.activeVersionId,
      expectedScriptFingerprint: project.scriptFingerprint, expectedSourceFingerprint: project.source.sourceFingerprint
    })
    expect(saved).toMatchObject({ ok: false, code: SCRIPT_STORYBOARD_BLOCKED })
    expect((await store.get(project.id)).storyboard).toBeNull()
    await store.saveStoryboard({ projectId: project.id, units, expectedRevision: project.revision,
      expectedVersionId: project.activeVersionId!, expectedScriptFingerprint: project.scriptFingerprint,
      expectedSourceFingerprint: project.source.sourceFingerprint })
    expect(await handlers.get('scriptStudio:buildPromptPackage')!(event(), { projectId: project.id }))
      .toMatchObject({ ok: false, code: SCRIPT_STORYBOARD_BLOCKED })
  })

  it('单段提示词携带完整原单元，重生成漏台词或变更 ID 都被阻断', async () => {
    await store.saveStoryboard({ projectId: project.id, units: makeUnits(), expectedRevision: project.revision,
      expectedVersionId: project.activeVersionId!, expectedScriptFingerprint: project.scriptFingerprint,
      expectedSourceFingerprint: project.source.sourceFingerprint })
    const fresh = await store.get(project.id)
    for (const units of [makeUnits().map(u => ({ ...u, id: 'wrong-id' })),
      makeUnits().map(u => ({ ...u, shots: u.shots.map(s => ({ ...s, dialogueAndTone: '无对白' })) }))]) {
      generateStream.mockResolvedValue(JSON.stringify({ units }))
      expect(await handlers.get('scriptStudio:generateStoryboard')!(event(), {
        projectId: project.id, expectedRevision: fresh.revision, unitId: 'unit-1', requestId: randomUUID()
      })).toMatchObject({ ok: false })
    }
    expect(generateStream.mock.calls[0][0]).toContain('原单元完整记录')
    expect(generateStream.mock.calls[0][0]).toContain('把账册给我。')
    const called = generateStream.mock.calls.length
    expect(await handlers.get('scriptStudio:generateStoryboard')!(event(), {
      projectId: project.id, expectedRevision: fresh.revision, unitId: 'unknown', requestId: randomUUID()
    })).toMatchObject({ ok: false })
    expect(generateStream).toHaveBeenCalledTimes(called)
  })

  it('超长单元构建为连续包，完整导出成功，漏段、重复和乱序导出被拒', async () => {
    const units = makeUnits()
    units[0].shots = Array.from({ length: 12 }, (_, index) => ({ ...shot(),
      dialogueAndTone: index ? '无对白' : shot().dialogueAndTone,
      subjectActionExpression: `动作${index}：` + '左手托账册右手翻页，露出印记再抬眼。'.repeat(9),
      nextTransition: `账册居中，手停在第${index}页` }))
    await store.saveStoryboard({ projectId: project.id, units, expectedRevision: project.revision,
      expectedVersionId: project.activeVersionId!, expectedScriptFingerprint: project.scriptFingerprint,
      expectedSourceFingerprint: project.source.sourceFingerprint })
    const result = await handlers.get('scriptStudio:buildPromptPackage')!(event(), { projectId: project.id }) as { ok: boolean; packages: PromptPackage[] }
    expect(result.ok).toBe(true)
    expect(result.packages.length).toBeGreaterThan(1)
    expect(result.packages.every(p => p.quality.ok)).toBe(true)
    expect(await handlers.get('scriptStudio:exportMarkdown')!(event(), {
      projectId: project.id, packages: result.packages, preferText: true
    })).toMatchObject({ ok: true, mode: 'text' })
    for (const packages of [result.packages.slice(1), [...result.packages, result.packages[0]], [...result.packages].reverse()]) {
      expect(await handlers.get('scriptStudio:exportMarkdown')!(event(), {
        projectId: project.id, packages, preferText: true
      })).toMatchObject({ ok: false, code: SCRIPT_EXPORT_BLOCKED, issues: [expect.objectContaining({ code: 'SOURCE_SHOTS_MISMATCH' })] })
    }
  })

  it('节奏档案与模板设置实际保存并使旧分镜过期', async () => {
    await store.saveStoryboard({ projectId: project.id, units: makeUnits(), expectedRevision: project.revision,
      expectedVersionId: project.activeVersionId!, expectedScriptFingerprint: project.scriptFingerprint,
      expectedSourceFingerprint: project.source.sourceFingerprint })
    const current = await store.get(project.id)
    const result = await handlers.get('scriptStudio:saveProject')!(event(), { project: { ...current,
      settings: { ...current.settings, promptMode: 'B', paceMode: 'auto', targetAudience: '悬疑观众',
        rhythmProfile: { first3: '印记露出', first15: '索账', first30: '背叛', breathing: '读清印记', avoidDragging: '不重复', completionGoal: '追看' } } } })
    expect(result).toMatchObject({ ok: true, project: { settings: { promptMode: 'B', paceMode: 'auto', targetAudience: '悬疑观众' } } })
    expect((await store.get(project.id)).settings.rhythmProfile?.first3).toBe('印记露出')
    expect(await handlers.get('scriptStudio:buildPromptPackage')!(event(), { projectId: project.id }))
      .toMatchObject({ ok: false, code: SCRIPT_STALE })
  })


  it('本次模板选择通过 IPC 生效，不修改已保存项目或使分镜过期', async () => {
    await store.saveStoryboard({ projectId: project.id, units: makeUnits(), expectedRevision: project.revision,
      expectedVersionId: project.activeVersionId!, expectedScriptFingerprint: project.scriptFingerprint,
      expectedSourceFingerprint: project.source.sourceFingerprint })
    const before = await store.get(project.id)
    for (const promptMode of ['A', 'B', 'C'] as const) {
      const result = await handlers.get('scriptStudio:buildPromptPackage')!(event(), { projectId: project.id, promptMode }) as { ok: boolean; packages: PromptPackage[] }
      expect(result.ok).toBe(true)
      expect(result.packages[0].meta.mode).toBe(promptMode)
      expect(await handlers.get('scriptStudio:exportMarkdown')!(event(), { projectId: project.id, packages: result.packages, preferText: true }))
        .toMatchObject({ ok: true, mode: 'text' })
    }
    expect(await store.get(project.id)).toEqual(before)
    expect(generateStream).not.toHaveBeenCalled()
    await expect(handlers.get('scriptStudio:buildPromptPackage')!(event(), { projectId: project.id, promptMode: 'X' })).rejects.toThrow('IPC_INPUT_INVALID')
  })

})
