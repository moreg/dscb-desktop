import { ipcMain, BrowserWindow } from 'electron'
import { WriteService } from '../data/write-service'
import { abortStream, beginStream, endStream } from '../data/stream-abort-registry'
import { activeBatchProjects } from '../data/write-batch-lock'
import { safeHandle, safeSend } from './safe-handle'
import type {
  AutoDeslopResult,
  MemoryApplyResult,
  MemoryExtraction,
  RhythmEvaluation,
  SettingsApplyResult
} from '../../shared/types'
import {
  validateInput,
  projectIdSchema,
  chapterNumberSchema,
  chapterContentSchema,
  batchWriteInputSchema
} from './validation'
import { z } from 'zod'
import { formatChapterProse, joinContinuation } from '../../shared/format-chapter-prose'

const styleProfileIdSchema = z.string().min(1).max(255).nullable().optional()

export function registerWriteIpc(service: WriteService): void {
  safeHandle(
    'write:auditChapter',
    async (_e, payload: { projectId: string; content: string }) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          content: chapterContentSchema
        }),
        payload
      )
      return service.auditChapter(validated.projectId, validated.content)
    }
  )

  safeHandle(
    'write:humanizeSegment',
    async (
      _e,
      payload: { projectId: string; snippet: string; violationType: string; chapterNumber?: number }
    ) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          snippet: z.string().max(50_000),
          violationType: z.string().min(1).max(100),
          chapterNumber: chapterNumberSchema.optional()
        }),
        payload
      )
      return service.humanizeSegment(
        validated.projectId,
        validated.snippet,
        validated.violationType,
        validated.chapterNumber
      )
    }
  )

  /** LLM 深度审稿（M3）：跑角色崩坏/逻辑漏洞等语义检查，返回 findings 列表 */
  safeHandle(
    'write:runDeepReview',
    async (_e, payload: { projectId: string; content: string; chapterNumber: number }) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          content: chapterContentSchema,
          chapterNumber: chapterNumberSchema
        }),
        payload
      )
      return service.runDeepReview(validated.projectId, validated.content, validated.chapterNumber)
    }
  )

  /** 结构化审核报告（对齐正文审核技能第 6 步）：聚合算法 + LLM 检查为 10 节报告 */
  safeHandle(
    'write:reviewReport',
    async (_e, payload: { projectId: string; content: string; chapterNumber: number }) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          content: chapterContentSchema,
          chapterNumber: chapterNumberSchema
        }),
        payload
      )
      return service.generateReviewReport(
        validated.projectId,
        validated.content,
        validated.chapterNumber
      )
    }
  )

  ipcMain.handle(
    'write:generateChapter',
    async (
      e,
      payload: {
        projectId: string
        chapterNumber: number
        styleProfileId?: string | null
        tempContext?: string
        existingText?: string
        autoStrength?: boolean
        requestId: string
      }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const validated = validateInput(
          z.object({
            projectId: projectIdSchema,
            chapterNumber: chapterNumberSchema,
            styleProfileId: styleProfileIdSchema,
            tempContext: z.string().optional(),
            existingText: z.string().optional(),
            autoStrength: z.boolean().optional(),
            requestId: z.string().min(1)
          }),
          payload
        )
        const signal = beginStream(validated.requestId)
        try {
          // 续写模式由 prompt 组装阶段算出（依赖细纲字数预估），回传给前端用于
          // 写后自检降级：extend 说明这一章还没写完，完成度类项不该判死。
          let continueMode: 'extend' | 'finish' | undefined
          let wordBudget:
            | { targetWords: number; chapterTargetWords: number; writtenWords: number; fromOutline: boolean; bound?: 'min' | 'about' }
            | undefined
          let autoDeslop: AutoDeslopResult | undefined
          const content = await service.generateChapterStream(
            validated.projectId,
            validated.chapterNumber,
            validated.styleProfileId,
            {
              tempContext: validated.tempContext,
              existingText: validated.existingText,
              autoStrength: validated.autoStrength === true,
              signal,
              onGenerationStage: (stage) =>
                safeSend(win, 'write:generationStage', {
                  requestId: validated.requestId,
                  stage
                }),
              onAutoDeslopResult: (result) => { autoDeslop = result },
              onPromptMeta: (meta) => {
                continueMode = meta.continueMode
                wordBudget = {
                  targetWords: meta.targetWords,
                  chapterTargetWords: meta.chapterTargetWords,
                  writtenWords: meta.writtenWords,
                  fromOutline: meta.fromOutline,
                  bound: meta.bound
                }
              },
              onToken: (token) =>
                safeSend(win, 'llm:token', {
                  requestId: validated.requestId,
                  token,
                  done: false
                })
            }
          )
          const repaired = await service.repairChapterForeshadowings(
            validated.projectId,
            validated.chapterNumber,
            formatChapterProse(joinContinuation(validated.existingText ?? '', content)),
            {
              signal, partialChapter: continueMode === 'extend', tempContext: validated.tempContext,
              onStart: () => safeSend(win, 'write:generationStage', {
                requestId: validated.requestId, stage: 'foreshadowRepair'
              })
            }
          )
          safeSend(win, 'llm:token', { requestId: validated.requestId, token: '', done: true })
          return { ok: true, content, autoDeslop, continueMode, wordBudget,
            foreshadowRepair: repaired.report,
            ...(repaired.report.status === 'applied' ? { fullContent: repaired.content } : {}) }
        } finally {
          endStream(validated.requestId)
        }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /** 按要求重写 · 第一步：只出修改建议，不改正文 */
  ipcMain.handle(
    'write:planAdjustChapter',
    async (
      e,
      payload: {
        projectId: string
        chapterNumber: number
        content: string
        instruction: string
        styleProfileId?: string | null
        requestId: string
      }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const validated = validateInput(
          z.object({
            projectId: projectIdSchema,
            chapterNumber: chapterNumberSchema,
            content: chapterContentSchema,
            instruction: z.string().min(1).max(10_000),
            styleProfileId: styleProfileIdSchema,
            requestId: z.string().min(1)
          }),
          payload
        )
        const signal = beginStream(validated.requestId)
        try {
          await service.planAdjustChapterStream(
            validated.projectId,
            validated.chapterNumber,
            validated.content,
            validated.instruction,
            validated.styleProfileId,
            {
              signal,
              onToken: (token) =>
                safeSend(win, 'llm:token', {
                  requestId: validated.requestId,
                  token,
                  done: false
                })
            }
          )
          safeSend(win, 'llm:token', { requestId: validated.requestId, token: '', done: true })
          return { ok: true }
        } finally {
          endStream(validated.requestId)
        }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'write:adjustChapter',
    async (
      e,
      payload: {
        projectId: string
        chapterNumber: number
        content: string
        instruction: string
        confirmedPlan?: string | null
        styleProfileId?: string | null
        requestId: string
      }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const validated = validateInput(
          z.object({
            projectId: projectIdSchema,
            chapterNumber: chapterNumberSchema,
            content: chapterContentSchema,
            instruction: z.string().min(1).max(10_000),
            confirmedPlan: z.string().max(50_000).nullable().optional(),
            styleProfileId: styleProfileIdSchema,
            requestId: z.string().min(1)
          }),
          payload
        )
        const signal = beginStream(validated.requestId)
        try {
          let autoDeslop: AutoDeslopResult | undefined
          const content = await service.adjustChapterStream(
            validated.projectId,
            validated.chapterNumber,
            validated.content,
            validated.instruction,
            validated.styleProfileId,
            {
              signal,
              onGenerationStage: (stage) =>
                safeSend(win, 'write:generationStage', {
                  requestId: validated.requestId,
                  stage
                }),
              onAutoDeslopResult: (result) => { autoDeslop = result },
              onToken: (token) =>
                safeSend(win, 'llm:token', {
                  requestId: validated.requestId,
                  token,
                  done: false
                })
            },
            validated.confirmedPlan
          )
          safeSend(win, 'llm:token', { requestId: validated.requestId, token: '', done: true })
          return { ok: true, content, autoDeslop }
        } finally {
          endStream(validated.requestId)
        }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'write:reviewChapter',
    async (
      e,
      payload: { projectId: string; chapterNumber: number; content?: string; requestId: string }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const signal = beginStream(payload.requestId)
        try {
          await service.reviewChapterStream(payload.projectId, payload.chapterNumber, payload.content, {
            signal,
            onToken: (token) =>
              safeSend(win, 'llm:token', {
                requestId: payload.requestId,
                token,
                done: false
              })
          })
        } finally {
          endStream(payload.requestId)
        }
        safeSend(win, 'llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /** 正文追问：全书视野（总纲/章目录/相邻章/设定追踪）+ 本章正文，只回答不改正文 */
  ipcMain.handle(
    'write:answerChapterQuestion',
    async (
      e,
      payload: {
        projectId: string
        chapterNumber: number
        content: string
        question: string
        history: { role: 'user' | 'assistant'; text: string }[]
        requestId: string
      }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const validated = validateInput(
          z.object({
            projectId: projectIdSchema,
            chapterNumber: chapterNumberSchema,
            content: chapterContentSchema,
            question: z.string().min(1).max(10_000),
            history: z
              .array(
                z.object({
                  role: z.enum(['user', 'assistant']),
                  text: z.string().max(20_000)
                })
              )
              .max(40)
              .default([]),
            requestId: z.string().min(1)
          }),
          payload
        )
        const signal = beginStream(validated.requestId)
        try {
          await service.answerChapterQuestionStream(
            validated.projectId,
            validated.chapterNumber,
            validated.content,
            validated.question,
            validated.history,
            {
              signal,
              onToken: (token) =>
                safeSend(win, 'llm:token', {
                  requestId: validated.requestId,
                  token,
                  done: false
                })
            }
          )
        } finally {
          endStream(validated.requestId)
        }
        safeSend(win, 'llm:token', { requestId: validated.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'write:detectCast',
    async (e, payload: { projectId: string; chapterNumber: number; requestId: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const signal = beginStream(payload.requestId)
        try {
          await service.detectCastStream(payload.projectId, payload.chapterNumber, {
            signal,
            onToken: (token) =>
              safeSend(win, 'llm:token', {
                requestId: payload.requestId,
                token,
                done: false
              })
          })
        } finally {
          endStream(payload.requestId)
        }
        safeSend(win, 'llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'write:detectRelationships',
    async (e, payload: { projectId: string; requestId: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const signal = beginStream(payload.requestId)
        try {
          await service.detectRelationshipsStream(payload.projectId, {
            signal,
            onToken: (token) =>
              safeSend(win, 'llm:token', {
                requestId: payload.requestId,
                token,
                done: false
              })
          })
        } finally {
          endStream(payload.requestId)
        }
        safeSend(win, 'llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'write:checkOutline',
    async (
      e,
      payload: {
        projectId: string
        chapterNumber: number
        outline: string
        content: string
        requestId: string
      }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const signal = beginStream(payload.requestId)
        try {
          await service.checkOutlineStream(
            payload.projectId,
            payload.chapterNumber,
            payload.outline,
            payload.content,
            {
              signal,
              onToken: (token) =>
                safeSend(win, 'llm:token', {
                  requestId: payload.requestId,
                  token,
                  done: false
                })
            }
          )
        } finally {
          endStream(payload.requestId)
        }
        safeSend(win, 'llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'write:extractMemory',
    async (
      e,
      payload: { projectId: string; chapterNumber: number; requestId: string }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const signal = beginStream(payload.requestId)
        try {
          await service.extractMemoryStream(payload.projectId, payload.chapterNumber, {
            signal,
            onToken: (token) =>
              safeSend(win, 'llm:token', {
                requestId: payload.requestId,
                token,
                done: false
              })
          })
        } finally {
          endStream(payload.requestId)
        }
        safeSend(win, 'llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  safeHandle(
    'write:applyMemory',
    async (_e, payload: { projectId: string; extraction: MemoryExtraction }) => {
      return service.applyMemory(payload.projectId, payload.extraction)
    }
  )

  safeHandle(
    'write:syncChapterAfterWrite',
    async (
      _e,
      payload: {
        projectId: string
        chapterNumber: number
        content: string
        force?: boolean
      }
    ) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          chapterNumber: chapterNumberSchema,
          content: chapterContentSchema,
          force: z.boolean().optional()
        }),
        payload
      )
      return service.syncChapterAfterWrite(
        validated.projectId,
        validated.chapterNumber,
        validated.content,
        // force：用户手动补跑，忽略 autoMemorySync / pipeline=off
        { skipIfDisabled: validated.force !== true }
      )
    }
  )

  safeHandle('write:repairChapterForeshadowings', async (_e, payload: {
    projectId: string; chapterNumber: number; content: string; partialChapter?: boolean; tempContext?: string
  }) => {
    const input = validateInput(z.object({ projectId: projectIdSchema, chapterNumber: chapterNumberSchema,
      content: chapterContentSchema, partialChapter: z.boolean().optional(), tempContext: z.string().max(10000).optional() }), payload)
    return service.repairChapterForeshadowings(input.projectId, input.chapterNumber, input.content,
      { partialChapter: input.partialChapter, tempContext: input.tempContext })
  })

  safeHandle('write:getChapterSummary', async (_e, payload: { projectId: string; chapterNumber: number; content: string }) => {
    const input = validateInput(z.object({ projectId: projectIdSchema, chapterNumber: chapterNumberSchema,
      content: chapterContentSchema }), payload)
    return service.getChapterSummary(input.projectId, input.chapterNumber, input.content)
  })

  safeHandle('write:generateChapterSummary', async (_e, payload: { projectId: string; chapterNumber: number; content: string; force?: boolean }) => {
    const input = validateInput(z.object({ projectId: projectIdSchema, chapterNumber: chapterNumberSchema,
      content: chapterContentSchema, force: z.boolean().optional() }), payload)
    return service.generateChapterSummary(input.projectId, input.chapterNumber, input.content, { force: input.force })
  })

  safeHandle('write:invalidateChapterMemorySync', async (_e, payload: { projectId: string; chapterNumber: number }) => {
    const validated = validateInput(z.object({ projectId: projectIdSchema, chapterNumber: chapterNumberSchema }), payload)
    service.invalidateChapterMemorySync(validated.projectId, validated.chapterNumber)
  })

  /** 写后自检清单对照（纯算法，不写记忆） */
  safeHandle(
    'write:selfCheckChapter',
    async (
      _e,
      payload: { projectId: string; chapterNumber: number; content: string }
    ) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          chapterNumber: chapterNumberSchema,
          content: chapterContentSchema
        }),
        payload
      )
      return service.selfCheckChapter(
        validated.projectId,
        validated.chapterNumber,
        validated.content
      )
    }
  )

  /** 写后自检「人物位置对应线索」一键修补（LLM 只改人物首次出场段落） */
  safeHandle(
    'write:fixCharacterPositions',
    async (
      _e,
      payload: { projectId: string; chapterNumber: number; content: string }
    ) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          chapterNumber: chapterNumberSchema,
          content: chapterContentSchema
        }),
        payload
      )
      return service.fixCharacterPositions(
        validated.projectId,
        validated.chapterNumber,
        validated.content
      )
    }
  )

  /** 落笔要点达成度核验（LLM 逐条判定） */
  safeHandle(
    'write:checkAdjustPlanCompliance',
    async (
      _e,
      payload: { projectId: string; chapterNumber: number; content: string; items: string[] }
    ) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          chapterNumber: chapterNumberSchema,
          content: chapterContentSchema,
          items: z.array(z.string().trim().min(1).max(500)).max(20)
        }),
        payload
      )
      return service.checkAdjustPlanCompliance(
        validated.projectId,
        validated.chapterNumber,
        validated.content,
        validated.items
      )
    }
  )

  safeHandle(
    'write:undoChapterSync',
    async (
      _e,
      payload: {
        projectId: string
        extraction: MemoryExtraction
        memory: MemoryApplyResult
        settings: SettingsApplyResult
      }
    ) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          extraction: z.any(),
          memory: z.any(),
          settings: z.any()
        }),
        payload
      )
      return service.undoChapterSync(validated.projectId, {
        extraction: validated.extraction as MemoryExtraction,
        memory: validated.memory as MemoryApplyResult,
        settings: validated.settings as SettingsApplyResult
      })
    }
  )

  /** 复核面板：逐条列出一章的候选记忆与校验结论 */
  safeHandle(
    'write:inspectMemoryCandidate',
    async (_e, payload: { projectId: string; chapterNumber: number }) => {
      const validated = validateInput(
        z.object({ projectId: projectIdSchema, chapterNumber: chapterNumberSchema }),
        payload
      )
      return service.inspectMemoryCandidate(validated.projectId, validated.chapterNumber)
    }
  )

  /**
   * 作者确认属实后强制写入选中的候选条目——这是唯一绕开证据校验的入口，
   * 界面必须先做二次确认再调它。
   */
  safeHandle(
    'write:forceApplyMemoryCandidateItems',
    async (
      _e,
      payload: {
        projectId: string
        chapterNumber: number
        picks: { kind: string; index: number }[]
      }
    ) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          chapterNumber: chapterNumberSchema,
          picks: z
            .array(
              z.object({
                kind: z.enum(['plotPoint', 'stateChange', 'foreshadowCollect', 'settingsPatch']),
                index: z.number().int().min(0).max(500)
              })
            )
            .min(1)
            .max(100)
        }),
        payload
      )
      return service.forceApplyMemoryCandidateItems(
        validated.projectId,
        validated.chapterNumber,
        validated.picks
      )
    }
  )

  safeHandle(
    'write:previewMemoryApply',
    async (_e, payload: { projectId: string; extraction: MemoryExtraction }) => {
      return service.previewMemoryApply(payload.projectId, payload.extraction)
    }
  )

  safeHandle(
    'write:previewSettingsApply',
    async (_e, payload: { projectId: string; extraction: MemoryExtraction }) => {
      return service.previewSettingsApply(payload.projectId, payload.extraction)
    }
  )

  safeHandle(
    'write:applySettingsPatches',
    async (
      _e,
      payload: { projectId: string; extraction: MemoryExtraction; onlyAuto?: boolean }
    ) => {
      return service.applySettingsPatches(payload.projectId, payload.extraction, {
        onlyAuto: payload.onlyAuto
      })
    }
  )

  safeHandle(
    'write:applyNewCharacters',
    async (
      _e,
      payload: { projectId: string; chars: MemoryExtraction['newCharacters'] }
    ) => {
      return service.applyNewCharacters(payload.projectId, payload.chars)
    }
  )

  safeHandle(
    'write:applyNewLocations',
    async (
      _e,
      payload: {
        projectId: string
        locs: MemoryExtraction['newLocations']
        chapterNumber?: number
      }
    ) => {
      return service.applyNewLocations(
        payload.projectId,
        payload.locs,
        payload.chapterNumber
      )
    }
  )

  safeHandle(
    'write:applyNewItems',
    async (
      _e,
      payload: { projectId: string; items: MemoryExtraction['newItems'] }
    ) => {
      return service.applyNewItems(payload.projectId, payload.items)
    }
  )

  safeHandle(
    'write:applyNewForeshadowings',
    async (
      _e,
      payload: { projectId: string; fs: MemoryExtraction['newForeshadowings'] }
    ) => {
      return service.applyNewForeshadowings(payload.projectId, payload.fs)
    }
  )

  safeHandle(
    'write:applyAllNewEntities',
    async (
      _e,
      payload: { projectId: string; chapterNumber: number }
    ) => {
      const validated = validateInput(
        z.object({ projectId: projectIdSchema, chapterNumber: chapterNumberSchema }),
        payload
      )
      return service.applyAllNewEntities(validated.projectId, validated.chapterNumber)
    }
  )

  /**
   * 解析并应用伏笔回执：把 LLM 在正文末尾写下的【本章伏笔回执】同步到伏笔库。
   * 输入 chapterNumber + receipt JSON；返回实际变更条数 + skipped 列表。
   */
  safeHandle(
    'write:applyForeshadowReceipt',
    async (
      _e,
      payload: {
        projectId: string
        chapterNumber: number
        receipt: { planted?: string[]; collected?: string[] }
      }
    ) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          chapterNumber: chapterNumberSchema,
          receipt: z.object({
            planted: z.array(z.string().min(1).max(500)).max(50).optional(),
            collected: z.array(z.string().min(1).max(500)).max(50).optional()
          })
        }),
        payload
      )
      return service.applyForeshadowReceipt(
        validated.projectId,
        validated.chapterNumber,
        validated.receipt
      )
    }
  )

  ipcMain.handle(
    'write:evaluateRhythm',
    async (
      e,
      payload: { projectId: string; chapterNumber: number; requestId: string }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const signal = beginStream(payload.requestId)
        try {
          await service.evaluateRhythmStream(payload.projectId, payload.chapterNumber, {
            signal,
            onToken: (token) =>
              safeSend(win, 'llm:token', {
                requestId: payload.requestId,
                token,
                done: false
              })
          })
        } finally {
          endStream(payload.requestId)
        }
        safeSend(win, 'llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  safeHandle(
    'write:applyRhythmEvaluation',
    async (_e, payload: { projectId: string; evaluation: RhythmEvaluation }) => {
      return service.applyRhythmEvaluation(payload.projectId, payload.evaluation)
    }
  )

  ipcMain.handle(
    'write:generateFigure',
    async (
      e,
      payload: { projectId: string; chapterNumber: number; requestId: string }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const signal = beginStream(payload.requestId)
        try {
          await service.generateFigureStream(payload.projectId, payload.chapterNumber, {
            signal,
            onToken: (token) =>
              safeSend(win, 'llm:token', {
                requestId: payload.requestId,
                token,
                done: false
              })
          })
        } finally {
          endStream(payload.requestId)
        }
        safeSend(win, 'llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  safeHandle(
    'write:saveFigure',
    async (_e, payload: { projectId: string; fileName: string; html: string }) => {
      return service.saveFigure(payload.projectId, payload.fileName, payload.html)
    }
  )

  // 写作与已有正文精修共用项目锁；暂停、失败和取消均在 finally 中释放。
  const activeBatchRequests = new Set<string>()
  ipcMain.handle('write:polishChaptersBatch', async (e, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    try {
      const validated = validateInput(batchWriteInputSchema, payload)
      if (activeBatchProjects.has(validated.projectId)) {
        throw new Error('BATCH_ALREADY_RUNNING: 该项目已有批量任务，请等待当前任务结束')
      }
      if (activeBatchRequests.has(validated.requestId)) {
        throw new Error('BATCH_REQUEST_ALREADY_RUNNING: 请勿重复提交同一个批量任务')
      }
      activeBatchProjects.add(validated.projectId)
      activeBatchRequests.add(validated.requestId)
      try {
        const signal = beginStream(validated.requestId)
        const abortBatch = () => { abortStream(validated.requestId) }
        e.sender.once('destroyed', abortBatch)
        try {
          if (e.sender.isDestroyed()) abortBatch()
          return await service.polishChaptersBatch(
            validated.projectId, validated.fromChapter, validated.toChapter, validated.styleProfileId,
            (chapter, result) => safeSend(win, 'write:batchPolishChapterComplete', {
              requestId: validated.requestId, chapter, result
            }),
            { signal, onProgress: (chapter, step) => safeSend(win, 'write:batchPolishProgress', {
              requestId: validated.requestId, chapter, step
            }) }
          )
        } finally {
          e.sender.removeListener('destroyed', abortBatch)
          endStream(validated.requestId)
        }
      } finally {
        activeBatchProjects.delete(validated.projectId)
        activeBatchRequests.delete(validated.requestId)
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  for (const channel of ['write:generateBatch', 'write:resumeBatch'] as const) {
    ipcMain.handle(channel, async (e, payload: unknown) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const validated = validateInput(batchWriteInputSchema, payload)
        if (activeBatchProjects.has(validated.projectId)) {
          throw new Error('BATCH_ALREADY_RUNNING: 该项目正在批量写作，请等待当前任务结束')
        }
        if (activeBatchRequests.has(validated.requestId)) {
          throw new Error('BATCH_REQUEST_ALREADY_RUNNING: 请勿重复提交同一个批量任务')
        }
        // 在任何异步操作前登记，防止多窗口或连续点击同时通过检查。
        activeBatchProjects.add(validated.projectId)
        activeBatchRequests.add(validated.requestId)
        try {
          const signal = beginStream(validated.requestId)
          const abortBatch = () => { abortStream(validated.requestId) }
          e.sender.once('destroyed', abortBatch)
          try {
            if (e.sender.isDestroyed()) abortBatch()
            const runBatch = channel === 'write:resumeBatch'
              ? service.resumeChaptersBatch.bind(service)
              : service.generateChaptersBatch.bind(service)
            const progress = await runBatch(
              validated.projectId,
              validated.fromChapter,
              validated.toChapter,
              (chapter, result) => {
                safeSend(win, 'write:batchChapterComplete', {
                  requestId: validated.requestId,
                  chapter,
                  result
                })
              },
              validated.styleProfileId,
              {
                signal,
                onGenerationStage: (stage, chapterNumber) =>
                  safeSend(win, 'write:batchGenerationStage', {
                    requestId: validated.requestId,
                    stage,
                    chapterNumber
                  }),
                onAutoDeslopResult: (result, chapterNumber) =>
                  safeSend(win, 'write:batchAutoDeslopResult', {
                    requestId: validated.requestId,
                    result,
                    chapterNumber
                  }),
                onToken: (token) =>
                  safeSend(win, 'llm:token', {
                    requestId: validated.requestId,
                    token,
                    done: false
                  })
              },
              validated.batchState,
              {
                autoContinue: validated.autoContinue === true,
                autoStrength: validated.autoStrength === true
              },
              (chapter, attempt, maxAttempts, waitMs) =>
                safeSend(win, 'write:batchRetryWait', {
                  requestId: validated.requestId,
                  chapter,
                  attempt,
                  maxAttempts,
                  waitMs
                })
            )
            return { ok: true, progress }
          } finally {
            e.sender.removeListener('destroyed', abortBatch)
            safeSend(win, 'llm:token', { requestId: validated.requestId, token: '', done: true })
            endStream(validated.requestId)
          }
        } finally {
          activeBatchProjects.delete(validated.projectId)
          activeBatchRequests.delete(validated.requestId)
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
  }
}
