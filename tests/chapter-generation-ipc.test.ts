import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WriteService } from '../src/main/data/write-service'
import type { AutoDeslopResult, ChapterStreamResult } from '../src/shared/types'
import { activeStreamCount, clearAllStreams } from '../src/main/data/stream-abort-registry'
import { ChapterWriteReviewError, ChapterRewriteReviewError, ChapterRepairReviewRequiredError } from '../src/main/data/chapter-rewrite-review-error'

type Handler = (event: { sender: object }, payload: unknown) => Promise<ChapterStreamResult>
const { handlers, send } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  send: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  BrowserWindow: {
    fromWebContents: () => ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send }
    })
  }
}))
const { registerWriteIpc } = await import('../src/main/ipc/write')

describe('正文生成 IPC 以精修最终稿交稿', () => {
  const generate = vi.fn<WriteService['generateChapterStream']>()
  const adjust = vi.fn<WriteService['adjustChapterStream']>()
  const repair = vi.fn<WriteService['repairChapterForeshadowings']>()
  const sync = vi.fn<WriteService['syncChapterAfterWrite']>()
  const writeScope = vi.fn<(pid: string, chapter: number, action: () => Promise<unknown>) => Promise<unknown>>()
  const report: AutoDeslopResult = { status: 'applied', message: '已完成自动去 AI 味', remainingIssues: 0 }
  beforeEach(() => {
    handlers.clear()
    send.mockClear()
    clearAllStreams()
    writeScope.mockReset().mockImplementation(async (_pid, _ch, action) => action())
    generate.mockReset()
    adjust.mockReset()
    sync.mockReset().mockResolvedValue(null)
    repair.mockReset().mockImplementation(async (_pid, _ch, content) => ({ content, report: { status: 'unchanged', message: '无遗漏' } }))
    registerWriteIpc({ generateChapterStream: generate, adjustChapterStream: adjust, repairChapterForeshadowings: repair,
      syncChapterAfterWrite: sync,
      runChapterWrite: writeScope } as unknown as WriteService)
  })

  it('重写检查超时仍返回失败和完整待复核稿，不发送成功完成事件', async () => {
    adjust.mockRejectedValue(new ChapterRewriteReviewError('已完整生成的新稿。', new Error('LONGFORM_REVIEW_INCOMPLETE: LLM_TIMEOUT')))
    expect(await handlers.get('write:adjustChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, content: '原稿', instruction: '调整', requestId: 'adjust-timeout'
    })).toEqual({ ok: false, error: 'LONGFORM_REVIEW_INCOMPLETE: LLM_TIMEOUT', retainedContent: '已完整生成的新稿。' })
    expect(send).not.toHaveBeenCalledWith('llm:token', expect.objectContaining({ done: true }))
    expect(activeStreamCount()).toBe(0)
  })

  it('续写核对缺少依据时返回已保存精修整章，仍保持失败且不启动记忆同步', async () => {
    const error = 'LONGFORM_REVIEW_INCOMPLETE: 缺少可定位的新稿与对照依据'
    generate.mockRejectedValue(new ChapterWriteReviewError('已有开头。\n\n精修后的续写。', new Error(error)))
    expect(await handlers.get('write:generateChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 2, existingText: '已有开头。', requestId: 'retained-generation'
    })).toEqual({ ok: false, error, retainedContent: '已有开头。\n\n精修后的续写。' })
    expect(send).not.toHaveBeenCalledWith('llm:token', expect.objectContaining({ done: true }))
    expect(sync).not.toHaveBeenCalled()
    expect(repair).not.toHaveBeenCalled()
    expect(activeStreamCount()).toBe(0)
  })

  it('结构修复候选只返回供作者对照，不能作为成功结果或同步记忆', async () => {
    generate.mockRejectedValue(new ChapterWriteReviewError('保存的原稿。',
      new ChapterRepairReviewRequiredError('保存的原稿。', '经过复核的候选稿。', 'structure')))
    const result = await handlers.get('write:generateChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, existingText: '保存的原稿。', repairOnly: true, requestId: 'review-structure'
    })
    expect(result).toMatchObject({ ok: false, retainedContent: '保存的原稿。', repairCandidate: {
      original: '保存的原稿。', candidate: '经过复核的候选稿。', scope: 'structure'
    } })
    expect(sync).not.toHaveBeenCalled()
    expect(repair).not.toHaveBeenCalled()
  })

  it('只修复模式透传并以整章回包，不把原稿重复拼接到修复稿前', async () => {
    generate.mockImplementation(async (_pid, _chapter, _style, opts) => {
      expect(opts).toMatchObject({ repairOnly: true, existingText: '已有正文。', tempContext: '保留章末' })
      opts?.onConflictRepaired?.('修复后的整章。')
      return '修复后的整章。'
    })
    const result = await handlers.get('write:generateChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, existingText: '已有正文。', tempContext: '保留章末',
      repairOnly: true, requestId: 'repair-existing'
    })
    expect(result).toMatchObject({ ok: true, fullContent: '修复后的整章。' })
    expect(repair).toHaveBeenCalledWith('project-1', 1, '修复后的整章。', expect.any(Object))
    expect(activeStreamCount()).toBe(0)
  })

  it('补跑伏笔和更新记忆均将真实进度绑定到本次请求', async () => {
    repair.mockImplementation(async (_pid, _ch, content, opts) => {
      opts?.onProgress?.({ stage: 'review', round: 2 })
      return { content, report: { status: 'unchanged', message: '通过' } }
    })
    sync.mockImplementation(async (_pid, _ch, _text, opts) => {
      opts?.onProgress?.({ stage: 'extract' })
      opts?.onProgress?.({ stage: 'writeMemory' })
      return null
    })
    await handlers.get('write:repairChapterForeshadowings')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, content: '正文', requestId: 'repair-1'
    })
    await handlers.get('write:syncChapterAfterWrite')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, content: '正文', requestId: 'memory-1'
    })
    expect(send.mock.calls).toEqual([
      ['write:postWriteProgress', { requestId: 'repair-1', progress: { stage: 'review', round: 2 } }],
      ['write:postWriteProgress', { requestId: 'memory-1', progress: { stage: 'extract' } }],
      ['write:postWriteProgress', { requestId: 'memory-1', progress: { stage: 'writeMemory' } }]
    ])
  })

  it('续写返回润色片段、模式和报告，流式原稿只作预览', async () => {
    generate.mockImplementation(async (_project, _chapter, _style, opts) => {
      opts?.onGenerationStage?.('generating')
      opts?.onToken?.('原始预览')
      opts?.onGenerationStage?.('deslop')
      opts?.onAutoDeslopResult?.(report)
      opts?.onPromptMeta?.({ continueMode: 'extend', targetWords: 800, chapterTargetWords: 3000, writtenWords: 1000, fromOutline: true, bound: 'min' })
      return '最终精修片段'
    })
    const result = await handlers.get('write:generateChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, requestId: 'generation-1', existingText: '已有正文'
    })
    expect(result).toMatchObject({ ok: true, content: '最终精修片段', autoDeslop: report, continueMode: 'extend' })
    expect(send.mock.calls).toEqual([
      ['write:generationStage', { requestId: 'generation-1', stage: 'generating' }],
      ['llm:token', { requestId: 'generation-1', token: '原始预览', done: false }],
      ['write:generationStage', { requestId: 'generation-1', stage: 'deslop' }],
      ['llm:token', { requestId: 'generation-1', token: '', done: true }]
    ])
    expect(activeStreamCount()).toBe(0)
    expect(repair).toHaveBeenCalledWith('project-1', 1, '已有正文最终精修片段',
      expect.objectContaining({ partialChapter: true }))
  })

  it('单章续写自动强度选项传给生成服务', async () => {
    generate.mockResolvedValue('正文')
    await handlers.get('write:generateChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, requestId: 'auto-strength', autoStrength: true
    })
    expect(generate.mock.calls[0][3]).toMatchObject({ autoStrength: true })
  })

  it('完整伏笔检查和补写结束后才交稿，返回整章而不是重复拼接的增量', async () => {
    const events: string[] = []
    let finish!: () => void
    generate.mockImplementation(async (_pid, _ch, _style, opts) => {
      events.push('generated')
      opts?.onPromptMeta?.({ continueMode: 'finish', targetWords: 300, chapterTargetWords: 3000, writtenWords: 2800, fromOutline: true, bound: 'min' })
      return '本轮收尾。'
    })
    repair.mockImplementation(async (_pid, _ch, content, opts) => {
      expect(content).toBe('已有正文。\n\n本轮收尾。')
      opts?.onStart?.()
      events.push('checking')
      await new Promise<void>((resolve) => { finish = resolve })
      events.push('repaired')
      return { content: '已有正文。\n补入的伏笔。\n本轮收尾。', report: { status: 'applied', message: '已补写' } }
    })
    const pending = handlers.get('write:generateChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, requestId: 'generation-repair', existingText: '已有正文。'
    })
    await vi.waitFor(() => expect(events).toEqual(['generated', 'checking']))
    expect(send).toHaveBeenCalledWith('write:generationStage', { requestId: 'generation-repair', stage: 'foreshadowRepair' })
    expect(send.mock.calls.some(([channel, payload]) => channel === 'llm:token' && payload.done)).toBe(false)
    expect(activeStreamCount()).toBe(1)
    finish()
    expect(await pending).toMatchObject({ ok: true, content: '本轮收尾。', fullContent: '已有正文。\n补入的伏笔。\n本轮收尾。',
      foreshadowRepair: { status: 'applied' } })
    expect(events).toEqual(['generated', 'checking', 'repaired'])
    expect(activeStreamCount()).toBe(0)
  })

  it('生成和写后修复共用执行作用域，并以修复后的整章继续检查，不重复拼接旧前缀', async () => {
    let inScope = false
    writeScope.mockImplementation(async (_pid, _ch, action) => {
      inScope = true
      try { return await action() } finally { inScope = false }
    })
    generate.mockImplementation(async (_pid, _ch, _style, opts) => {
      expect(inScope).toBe(true)
      opts?.onConflictRepaired?.('已修正的开头。\n阶段收尾。')
      return '已修正的开头。\n阶段收尾。'
    })
    repair.mockImplementation(async (_pid, _ch, content, opts) => {
      expect(inScope).toBe(true)
      expect(content).toBe('已修正的开头。\n阶段收尾。')
      opts?.onAutoDeslopResult?.({ status: 'review_required', remainingIssues: 0, message: '边界已修复，表达待复核' })
      return { content: '最终开头。\n最终阶段收尾。', report: { status: 'applied', message: '超纲已修复' } }
    })
    const result = await handlers.get('write:generateChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, requestId: 'late-boundary', existingText: '旧开头。'
    })
    expect(result).toMatchObject({ ok: true, fullContent: '最终开头。\n最终阶段收尾。', autoDeslop: { status: 'review_required' } })
    expect(writeScope).toHaveBeenCalledTimes(1)
    expect(inScope).toBe(false)
    expect(activeStreamCount()).toBe(0)
  })

  it('写后超纲修复失败不发送成功交稿事件', async () => {
    generate.mockResolvedValue('已经生成的正文。')
    repair.mockRejectedValue(new Error('LONGFORM_CONFLICT: 超纲修复未通过，CHAPTER_REPAIR_BUDGET'))
    expect(await handlers.get('write:generateChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, requestId: 'late-boundary-failed'
    })).toMatchObject({ ok: false, error: expect.stringContaining('CHAPTER_REPAIR_BUDGET'), retainedContent: '已经生成的正文。' })
    expect(send.mock.calls.some(([channel, payload]) => channel === 'llm:token' && payload.done)).toBe(false)
    expect(activeStreamCount()).toBe(0)
  })

  it('补写失败保留本轮生成片段，并将失败结论交给编辑器暂停记忆同步', async () => {
    generate.mockResolvedValue('已生成的新正文。')
    repair.mockResolvedValue({ content: '旧正文。\n已生成的新正文。', report: { status: 'failed', message: '补写未通过' } })
    expect(await handlers.get('write:generateChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, requestId: 'generation-failed-repair', existingText: '旧正文。'
    })).toMatchObject({ ok: true, content: '已生成的新正文。', foreshadowRepair: { status: 'failed' } })
    expect(activeStreamCount()).toBe(0)
  })

  it('重写采用整章最终稿，润色失败报告仍以成功回包保留成稿', async () => {
    const failed: AutoDeslopResult = { status: 'failed', message: '自动去 AI 味失败，已保留生成原稿', remainingIssues: 0 }
    adjust.mockImplementation(async (_project, _chapter, _content, _instruction, _style, opts) => {
      opts?.onToken?.('重写流式成稿')
      opts?.onGenerationStage?.('deslop')
      opts?.onAutoDeslopResult?.(failed)
      return '保留的重写成稿'
    })
    expect(await handlers.get('write:adjustChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, content: '旧稿', instruction: '精修对白', requestId: 'adjust-1'
    })).toEqual({ ok: true, content: '保留的重写成稿', autoDeslop: failed })
    expect(send).toHaveBeenCalledWith('write:generationStage', { requestId: 'adjust-1', stage: 'deslop' })
    expect(activeStreamCount()).toBe(0)
  })

  it('生成失败不伪造成功稿，并释放可取消请求', async () => {
    generate.mockRejectedValue(new Error('LLM_ABORTED'))
    expect(await handlers.get('write:generateChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, requestId: 'generation-1'
    })).toEqual({ ok: false, error: 'LLM_ABORTED' })
    expect(activeStreamCount()).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })
})
