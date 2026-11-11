import { randomUUID } from 'crypto'
import { BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron'
import { writeTextAtomic } from '../data/atomic'
import {
  buildScriptPrompt,
  buildStoryboardPrompt,
  parseStructured,
  type BuiltPrompt
} from '../data/script-studio-prompts'
import {
  buildPromptPackages,
  validatePackage,
  validateStoryboard
} from '../data/script-prompt-kit'
import { abortStream, beginStream, endStream } from '../data/stream-abort-registry'
import { unitDialogueIssues } from '../data/script-dialogue'
import type { LlmService } from '../data/llm-service'
import type { ScriptStudioStore } from '../data/script-studio-store'
import { safeHandle, safeSend } from './safe-handle'
import { validateInput } from './validation'
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
  SCRIPT_SOURCE_MISSING,
  SCRIPT_STALE,
  SCRIPT_STORYBOARD_BLOCKED,
  SCRIPT_STUDIO_INVOKE_CHANNELS,
  SCRIPT_STUDIO_TOKEN_CHANNELS,
  adoptScriptCandidateInputSchema,
  buildStudioPromptPackageInputSchema,
  createScriptProjectInputSchema,
  exportStudioMarkdownInputSchema,
  generateStudioScriptInputSchema,
  generateStudioStoryboardInputSchema,
  listStudioRunsInputSchema,
  recoverStudioRunsInputSchema,
  saveScriptProjectInputSchema,
  saveScriptStoryboardInputSchema,
  scriptProjectIdSchema,
  scriptStructuredOutputSchema,
  storyboardStructuredOutputSchema,
  type GenerateStudioScriptResult,
  type GenerateStudioStoryboardResult,
  type GenerationRun,
  type RunKind,
  type SaveScriptStoryboardResult,
  type ScriptCandidate,
  type ScriptProject,
  type ScriptStructuredOutput
} from '../../shared/script-studio'

const [
  CH_LIST, CH_CREATE, CH_GET, CH_SAVE, CH_ADOPT, CH_SAVE_SB,
  CH_GEN_SCRIPT, CH_GEN_SB, CH_BUILD, CH_EXPORT, CH_LIST_RUNS, CH_RECOVER
] = SCRIPT_STUDIO_INVOKE_CHANNELS
const [TOKEN_SCRIPT, TOKEN_SB] = SCRIPT_STUDIO_TOKEN_CHANNELS

interface StreamOutcome {
  text: string
  aborted: boolean
  error?: string
  retainedText: string
}

function newRun(projectId: string, kind: RunKind, feature: string, requestId: string, unitId?: string): GenerationRun {
  const timestamp = new Date().toISOString()
  return {
    runId: randomUUID(),
    projectId,
    kind,
    feature,
    status: 'running',
    requestId,
    ...(unitId ? { unitId } : {}),
    startedAt: timestamp,
    updatedAt: timestamp,
    partialText: ''
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 统一的流式执行：token/done 事件、停止保留文本、destroyed 取消、run 落盘 partialText。 */
async function streamLlm(
  llm: LlmService,
  prompt: BuiltPrompt,
  e: IpcMainInvokeEvent,
  requestId: string,
  tokenChannel: string,
  projectId: string,
  store: ScriptStudioStore,
  run: GenerationRun
): Promise<StreamOutcome> {
  const win = BrowserWindow.fromWebContents(e.sender)
  const signal = beginStream(requestId)
  const cancelOnClose = (): void => { abortStream(requestId) }
  e.sender.once('destroyed', cancelOnClose)
  let partial = ''
  let received = false
  const pendingWrites: Promise<unknown>[] = []
  const recordPartial = (text: string): void => {
    pendingWrites.push(store.writeRun({ ...run, partialText: text, updatedAt: new Date().toISOString() }).catch(() => undefined))
  }
  try {
    if (signal.aborted || e.sender.isDestroyed()) {
      return { text: '', aborted: true, retainedText: partial }
    }
    const text = await llm.generateStream(prompt.user, {
      systemPrompt: prompt.system,
      signal,
      maxTokens: prompt.maxTokens,
      meta: { feature: prompt.feature, projectId },
      onToken: token => {
        if (signal.aborted || !token) return
        partial += token
        received = true
        safeSend(win, tokenChannel, { requestId, token, done: false })
        recordPartial(partial)
      }
    })
    if (signal.aborted) return { text: '', aborted: true, retainedText: partial || text }
    if (!text.trim()) return { text: '', aborted: false, error: '模型未返回内容，请重试', retainedText: '' }
    if (!received) {
      partial = text
      safeSend(win, tokenChannel, { requestId, token: text, done: false })
      recordPartial(text)
    }
    return { text, aborted: false, retainedText: '' }
  } catch (err) {
    return {
      text: '',
      aborted: signal.aborted,
      retainedText: partial,
      error: signal.aborted ? LLM_ABORTED : errorMessage(err)
    }
  } finally {
    // 等待所有增量落盘完成后再收尾，避免 fire-and-forget 覆盖终态记录。
    await Promise.allSettled(pendingWrites)
    // 无论成功、失败还是停止，都补发 done，让前端状态条能收敛。
    safeSend(win, tokenChannel, { requestId, token: '', done: true })
    e.sender.removeListener('destroyed', cancelOnClose)
    endStream(requestId)
  }
}

async function finishRun(store: ScriptStudioStore, run: GenerationRun, outcome: StreamOutcome, status: GenerationRun['status']): Promise<void> {
  await store.writeRun({
    ...run,
    status,
    partialText: outcome.text || outcome.retainedText || run.partialText,
    ...(outcome.retainedText ? { retainedText: outcome.retainedText } : {}),
    ...(outcome.error && status === 'failed' ? { error: outcome.error.slice(0, 2000) } : {}),
    updatedAt: new Date().toISOString()
  })
}

function candidateFrom(
  text: string,
  parsed: { data?: ScriptStructuredOutput; parseFallback: boolean; fallbackText?: string },
  project: ScriptProject
): ScriptCandidate {
  const data = parsed.data
  return {
    id: randomUUID(),
    format: project.settings.format,
    body: data?.body ?? parsed.fallbackText ?? text,
    adaptationNote: data?.adaptationNote ?? '模型未返回结构化改编说明，以下为 Markdown 降级候选，请人工核对事实边界。',
    tentative: data?.tentative ?? ['结构化信息缺失，全部设定暂定，需人工确认'],
    additions: data?.additions ?? [],
    characters: data?.characters ?? [],
    scenes: data?.scenes ?? [],
    props: data?.props ?? [],
    creativeNotes: data?.creativeNotes ?? '',
    risks: data?.risks?.length
      ? data.risks
      : ['模型未返回风险清单，本候选为 Markdown 降级结果，需人工核对改编风险'],
    ...(data?.comicExtras ? { comicExtras: data.comicExtras } : {}),
    sourceFingerprint: project.source.sourceFingerprint,
    expectedRevision: project.revision,
    parseFallback: parsed.parseFallback,
    createdAt: new Date().toISOString()
  }
}

/** 注册 12 个 invoke 通道；两个生成通道走可取消的 LLM 流式请求。 */
export function registerScriptStudioIpc(store: ScriptStudioStore, llm: LlmService): void {
  safeHandle(CH_LIST, async () => store.list())

  safeHandle(CH_CREATE, async (_e, payload: unknown) =>
    store.create(validateInput(createScriptProjectInputSchema, payload)))

  safeHandle(CH_GET, async (_e, payload: unknown) =>
    store.get(validateInput(scriptProjectIdSchema, payload).projectId))

  safeHandle(CH_SAVE, async (_e, payload: unknown) =>
    store.save(validateInput(saveScriptProjectInputSchema, payload).project))

  safeHandle(CH_ADOPT, async (_e, payload: unknown) =>
    store.adoptCandidate(validateInput(adoptScriptCandidateInputSchema, payload)))

  // 显式保存分镜：先跑主进程质量闸门。手工编辑过的 units 可能含非法时长 / 空字段，
  // 必须在落盘前硬阻断，绝不调用 store.saveStoryboard 覆盖已保存分镜。
  safeHandle(CH_SAVE_SB, async (_e, payload: unknown): Promise<SaveScriptStoryboardResult> => {
    const input = validateInput(saveScriptStoryboardInputSchema, payload)
    const project = await store.get(input.projectId)
    const version = store.activeVersion(project)
    const quality = validateStoryboard(input.units, project.settings, version?.body ?? '')
    if (quality.errors.length > 0) {
      return {
        ok: false,
        code: SCRIPT_STORYBOARD_BLOCKED,
        message: '分镜存在硬阻断，未保存',
        issues: quality.errors
      }
    }
    return store.saveStoryboard(input)
  })

  // ---- 第一次 LLM：小说 → 剧本候选（只写 candidate 字段，不自动采用） ----
  safeHandle(CH_GEN_SCRIPT, async (e, payload: unknown): Promise<GenerateStudioScriptResult> => {
    const input = validateInput(generateStudioScriptInputSchema, payload)
    const project = await store.get(input.projectId)
    if (!project.source.text.trim()) {
      return { ok: false, code: SCRIPT_SOURCE_MISSING, error: '来源选材为空，请先选择小说内容' }
    }
    if (project.revision !== input.expectedRevision) {
      return { ok: false, code: SCRIPT_CONFLICT, error: '项目已在其他窗口更新，请重新读取后再生成' }
    }
    const run = newRun(input.projectId, 'script', FEATURE_SCRIPT, input.requestId)
    try {
      await store.startRun(run)
    } catch (err) {
      const message = errorMessage(err)
      return { ok: false, ...(message.startsWith(SCRIPT_RUN_ACTIVE) ? { code: SCRIPT_RUN_ACTIVE } : {}), error: message }
    }
    let outcome: StreamOutcome | undefined
    try {
      const prompt = buildScriptPrompt(project, input.instruction)
      outcome = await streamLlm(llm, prompt, e, input.requestId, TOKEN_SCRIPT, input.projectId, store, run)
      if (outcome.aborted) {
        await finishRun(store, run, outcome, 'aborted')
        return { ok: false, code: LLM_ABORTED, error: LLM_ABORTED, retainedText: outcome.retainedText }
      }
      if (outcome.error) {
        await finishRun(store, run, outcome, 'failed')
        return { ok: false, code: LLM_EMPTY, error: outcome.error, retainedText: outcome.retainedText }
      }
      const parsed = parseStructured(outcome.text, scriptStructuredOutputSchema, { markdownFallback: true })
      if (!parsed.ok) {
        await finishRun(store, { ...run }, { ...outcome, error: SCRIPT_PARSE_FAILED }, 'failed')
        return {
          ok: false,
          code: SCRIPT_PARSE_FAILED,
          error: '剧本输出不是有效 JSON，已保留原始文本，请重试或人工整理',
          retainedText: outcome.text
        }
      }
      const candidate = candidateFrom(outcome.text, parsed, project)
      const updated = await store.saveCandidate(input.projectId, candidate)
      await finishRun(store, run, outcome, 'completed')
      return { ok: true, candidate, project: updated }
    } catch (error) {
      const message = errorMessage(error)
      const retainedText = outcome?.text || outcome?.retainedText || ''
      await finishRun(store, run, { text: '', aborted: false, retainedText, error: message }, 'failed')
      return { ok: false, error: message, retainedText }
    } finally {
      store.releaseRun(run.runId)
    }
  })

  // ---- 第二次 LLM：已保存剧本 → 结构化分镜（UI 显式保存，不覆盖已保存分镜） ----
  safeHandle(CH_GEN_SB, async (e, payload: unknown): Promise<GenerateStudioStoryboardResult> => {
    const input = validateInput(generateStudioStoryboardInputSchema, payload)
    const project = await store.get(input.projectId)
    const version = project.scriptVersions.find(item => item.id === project.activeVersionId)
    if (!version || !version.body.trim()) {
      return { ok: false, code: SCRIPT_SOURCE_MISSING, error: '请先采用一版正式稿剧本，再生成分镜' }
    }
    if (project.revision !== input.expectedRevision) {
      return { ok: false, code: SCRIPT_CONFLICT, error: '项目已在其他窗口更新，请重新读取后再生成' }
    }
    if (input.unitId && !project.storyboard?.units.some(unit => unit.id === input.unitId)) {
      return { ok: false, code: SCRIPT_SOURCE_MISSING, error: '未找到指定分镜单元，请重新读取项目' }
    }
    const feature = input.unitId ? FEATURE_STORYBOARD_SEGMENT : FEATURE_STORYBOARD
    const run = newRun(input.projectId, 'storyboard', feature, input.requestId, input.unitId)
    try {
      await store.startRun(run)
    } catch (err) {
      const message = errorMessage(err)
      return { ok: false, ...(message.startsWith(SCRIPT_RUN_ACTIVE) ? { code: SCRIPT_RUN_ACTIVE } : {}), error: message }
    }
    let outcome: StreamOutcome | undefined
    try {
      const prompt = buildStoryboardPrompt(project, input.unitId)
      outcome = await streamLlm(llm, prompt, e, input.requestId, TOKEN_SB, input.projectId, store, run)
      if (outcome.aborted) {
        await finishRun(store, run, outcome, 'aborted')
        return { ok: false, code: LLM_ABORTED, error: LLM_ABORTED, retainedText: outcome.retainedText }
      }
      if (outcome.error) {
        await finishRun(store, run, outcome, 'failed')
        return { ok: false, code: LLM_EMPTY, error: outcome.error, retainedText: outcome.retainedText }
      }
      // 分镜不做 Markdown 降级，也不发起第三次模型修复。
      const parsed = parseStructured(outcome.text, storyboardStructuredOutputSchema)
      if (!parsed.ok || !parsed.data) {
        await finishRun(store, run, { ...outcome, error: SCRIPT_PARSE_FAILED }, 'failed')
        return {
          ok: false,
          code: SCRIPT_PARSE_FAILED,
          error: '分镜输出不是有效结构化 JSON，已保留原始文本；不会用第三次模型修复',
          retainedText: outcome.text
        }
      }
      const units = parsed.data.units
      const basedOn = store.makeBasedOn(project)
      const scope = input.unitId ? project.storyboard?.units.find(u => u.id === input.unitId) : null
      const quality = validateStoryboard(units, project.settings, version.body, !!input.unitId)
      if (scope) {
        if (units.length !== 1 || units[0].id !== scope.id) quality.issues.push({ code: 'UNIT_SCOPE_MISMATCH', severity: 'error',
          message: '单段重生成只能输出指定 ID 的一个单元。' })
        quality.issues.push(...unitDialogueIssues(units, scope))
        quality.errors = quality.issues.filter(item => item.severity === 'error')
        quality.ok = quality.errors.length === 0
      }
      if (quality.errors.length) {
        await finishRun(store, run, { ...outcome, error: '分镜质量闸门硬阻断' }, 'failed')
        return { ok: false, units, basedOn, quality, error: '分镜质量闸门未通过，请修改后保存' }
      }
      await finishRun(store, run, outcome, 'completed')
      return { ok: true, units, basedOn, quality }
    } catch (error) {
      const message = errorMessage(error)
      const retainedText = outcome?.text || outcome?.retainedText || ''
      await finishRun(store, run, { text: '', aborted: false, retainedText, error: message }, 'failed')
      return { ok: false, error: message, retainedText }
    } finally {
      store.releaseRun(run.runId)
    }
  })

  // ---- 第 3 步：本地确定性纯函数构建提示词包；过期分镜硬拒 ----
  safeHandle(CH_BUILD, async (_e, payload: unknown) => {
    const input = validateInput(buildStudioPromptPackageInputSchema, payload)
    const project = await store.get(input.projectId)
    if (!project.storyboard || !project.storyboard.units.length) {
      return { ok: false, code: SCRIPT_SOURCE_MISSING, message: '请先生成并保存分镜' }
    }
    const basedOn = input.expectedBasedOn ?? project.storyboard.basedOn
    const stale = store.isStale(project, basedOn)
    if (stale.stale) {
      return { ok: false, code: SCRIPT_STALE, message: `分镜已过期：${stale.reason ?? '基于旧版本'}；请重新生成分镜` }
    }
    const units = input.unitId
      ? project.storyboard.units.filter(unit => unit.id === input.unitId)
      : project.storyboard.units
    if (!units.length) {
      return { ok: false, code: SCRIPT_SOURCE_MISSING, message: '未找到指定的分镜单元' }
    }
    const storyboardFingerprint = project.storyboard.storyboardFingerprint
    const quality = validateStoryboard(project.storyboard.units, project.settings, store.activeVersion(project)?.body ?? '')
    if (!quality.ok) return { ok: false, code: SCRIPT_STORYBOARD_BLOCKED, message: '已保存分镜未通过正式稿台词与结构复核，请修正后再构建', issues: quality.errors }
    const outputSettings = { ...project.settings, ...(input.promptMode ? { promptMode: input.promptMode } : {}) }
    const packages = units.flatMap(unit => buildPromptPackages(unit, outputSettings, store.makeBasedOn(project, unit.id, {
      contentFingerprint: project.contentFingerprint,
      storyboardFingerprint,
      stale: false
    })))
    return { ok: true, packages, stale: false }
  })

  // ---- 导出：二次闸门；桌面写 .md，Web 返回 text/markdown ----
  safeHandle(CH_EXPORT, async (e, payload: unknown) => {
    const input = validateInput(exportStudioMarkdownInputSchema, payload)
    const gateIssues = input.packages.flatMap(pkg => validatePackage(pkg).errors)
    if (gateIssues.length) {
      return {
        ok: false,
        code: SCRIPT_EXPORT_BLOCKED,
        issues: gateIssues,
        message: '导出前二次闸门未通过，请修复硬阻断问题'
      }
    }
    const exported = await store.export(input.projectId, input.packages, input.allowStale)
    if (!exported.ok) return exported
    const current = await store.get(input.projectId)
    // 当前版本包（含拆段）必须完整对应已保存单元，防止客户端删镜、重排或重复片段。
    const groups = new Map<string, typeof input.packages>()
    for (const pkg of input.packages) {
      if (pkg.meta.storyboardFingerprint !== current.storyboard?.storyboardFingerprint) continue
      const id = pkg.meta.splitFromUnitId || pkg.unitId
      groups.set(id, [...(groups.get(id) ?? []), pkg])
    }
    for (const [id, packages] of groups) {
      const original = current.storyboard?.units.find(unit => unit.id === id)
      const shots = packages.flatMap(pkg => pkg.sourceShots)
      if (!original || shots.length !== original.shots.length || original.shots.some((shot, index) =>
        Object.keys(shot).some(key => shot[key as keyof typeof shot] !== shots[index]?.[key as keyof typeof shot]))) {
        return { ok: false, code: SCRIPT_EXPORT_BLOCKED, issues: [{ code: 'SOURCE_SHOTS_MISMATCH', severity: 'error',
          message: '导出镜头与已保存单元不一致，请完整构建并按顺序导出拆段结果。' }], message: '导出前镜头与台词复核未通过' }
      }
    }
    const { text, fileName } = exported
    if (input.preferText) {
      return { ok: true, mode: 'text', text, mimeType: 'text/markdown', fileName }
    }
    try {
      const win = BrowserWindow.fromWebContents(e.sender)
      const options = {
        title: '导出视频提示词包',
        defaultPath: fileName,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      }
      const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true }
      await writeTextAtomic(picked.filePath, text)
      return { ok: true, mode: 'file', path: picked.filePath, text, fileName }
    } catch {
      // Web 版无可用 dialog 时退回纯文本，由前端用 Blob 下载。
      return { ok: true, mode: 'text', text, mimeType: 'text/markdown', fileName }
    }
  })

  safeHandle(CH_LIST_RUNS, async (_e, payload: unknown) =>
    store.listRuns(validateInput(listStudioRunsInputSchema, payload).projectId))

  safeHandle(CH_RECOVER, async (_e, payload: unknown) =>
    store.recoverRuns(validateInput(recoverStudioRunsInputSchema, payload).projectId))
}
