import { describe, expect, it } from 'vitest'
import { chapterReviewFailureMessage, failedChapterContinuationDraft, failedChapterRewriteDraft, finalizeChapterContinuation, finalizeChapterRewrite, interruptedChapterDraft, interruptedChapterRetryMessage, shouldRepairChapterOnRetry } from '../src/renderer/src/chapter-generation-finalize'

describe('失败后的重试方向', () => {
  it.each(['LONGFORM_CONFLICT: 冲突', 'LONGFORM_REVIEW_INCOMPLETE: 核对超时', 'CHAPTER_REPAIR_BUDGET: 剧情纠错耗尽'])('%s 只修复当前稿', error => {
    expect(shouldRepairChapterOnRetry({ ok: false, error }, '已保存的正文。')).toBe(true)
    expect(shouldRepairChapterOnRetry({ ok: false, error }, '')).toBe(false)
  })
  it('完整稿的后处理超时走补检，真正的生成中断继续续写', () => {
    expect(shouldRepairChapterOnRetry({ ok: false, error: 'LLM_TIMEOUT', retainedContent: '完整稿。' }, '完整稿。')).toBe(true)
    expect(shouldRepairChapterOnRetry({ ok: false, error: 'LLM_TIMEOUT' }, '半稿。')).toBe(false)
    expect(shouldRepairChapterOnRetry({ ok: true }, '完整稿。')).toBe(false)
  })
})

describe('重写后检查失败', () => {
  it('保留后端确认完整的稿件，未完成生成仍退回原稿', () => {
    expect(failedChapterRewriteDraft('原稿。', { ok: false, error: 'LONGFORM_REVIEW_INCOMPLETE: LLM_TIMEOUT', retainedContent: '新稿。' })).toBe('新稿。')
    expect(failedChapterRewriteDraft('原稿。', { ok: false, error: 'LLM_TIMEOUT' })).toBe('原稿。')
    expect(failedChapterRewriteDraft('原稿。', { ok: false, retainedContent: '  ' })).toBe('原稿。')
  })
  it('内层超时不吞掉外层检查失败原因', () => {
    const error = 'LONGFORM_REVIEW_INCOMPLETE: 长篇一致性核对未完成，已暂停推进。LLM_TIMEOUT'
    expect(chapterReviewFailureMessage(error)).toContain('长篇一致性检查超时')
    expect(interruptedChapterRetryMessage(error, true)).not.toContain('生成超时')
    expect(chapterReviewFailureMessage('LLM_TIMEOUT')).toBeUndefined()
  })
})

describe('中断续写保留草稿', () => {
  it.each(['LONGFORM_REVIEW_INCOMPLETE: 缺少可定位的新稿与对照依据', 'LONGFORM_CONFLICT: 冲突', 'CHAPTER_REPAIR_BUDGET'])('%s 保留完整精修稿，不重复拼接前文', error => {
    expect(failedChapterContinuationDraft('原有前文。', '流式原稿。', {
      ok: false, error, retainedContent: '原有前文。\n\n完整精修稿。'
    })).toBe('原有前文。\n\n完整精修稿。')
    expect(failedChapterContinuationDraft('', '流式原稿。', {
      ok: false, error, retainedContent: '完整精修稿。'
    })).toBe('完整精修稿。')
  })
  it('旧后端未附完整稿时，核对失败仍保留小说预览而不是清空', () => {
    const error = 'LONGFORM_REVIEW_INCOMPLETE: 缺少可定位的新稿与对照依据'
    expect(failedChapterContinuationDraft('', '他把门推开，屋内空无一人。', { ok: false, error }))
      .toBe('他把门推开，屋内空无一人。')
    expect(interruptedChapterRetryMessage(error, true)).toContain('正文已保留')
    expect(failedChapterContinuationDraft('原稿。', '', { ok: false, error })).toBe('原稿。')
  })
  it.each(['LLM_TIMEOUT', 'LLM_ABORTED', 'LLM_OUTPUT_TRUNCATED'])('%s 保留已有正文和新增正文', error => {
    expect(interruptedChapterDraft('他推开门。', '“你来了。”', error)).toBe('他推开门。\n\n“你来了。”')
  })
  it.each(['LLM_TIMEOUT', 'LLM_OUTPUT_TRUNCATED'])('%s 没有收到新正文时保留原稿', error => {
    expect(interruptedChapterDraft('原稿。', '', error)).toBe('原稿。')
  })
  it.each(['LLM_TIMEOUT', 'LLM_OUTPUT_TRUNCATED'])('%s 流程旁白不作为中断草稿保存', error => {
    expect(interruptedChapterDraft('原稿。', '我会调用 story-long-write 技能来生成正文。', error)).toBe('原稿。')
  })
  it('其他失败回滚预览，不把错误消息保留到正文', () => {
    expect(interruptedChapterDraft('原稿。', 'Error: sign in', 'AGY_AUTH_EXPIRED')).toBe('原稿。')
  })
  it('截断提示根据实际保留的正文说明重试落点', () => {
    expect(interruptedChapterRetryMessage('LLM_OUTPUT_TRUNCATED', true)).toContain('从当前草稿继续写')
    expect(interruptedChapterRetryMessage('LLM_OUTPUT_TRUNCATED', false)).toContain('未保留新的正文')
    expect(interruptedChapterRetryMessage('LLM_AUTH_FAILED', false)).toBeUndefined()
  })
})

describe('正文重写最终稿覆盖流式预览', () => {
  it('精修稿恰好还原为生成前正文时，编辑器仍恢复最终稿', () => {
    const sourceDraft = '林舟推开门。'
    let editorDraft = '林舟缓缓推开门。'
    const finalText = finalizeChapterRewrite(sourceDraft, (text) => { editorDraft = text })
    expect(editorDraft).toBe(sourceDraft)
    expect(finalText).toBe(editorDraft)
  })

  it('正文显示与写后检查收到同一份格式化最终稿', () => {
    let editorDraft = '流式原稿'
    const finalText = finalizeChapterRewrite('林 舟 推 开 门。\n\n他 没 有 回 头。', (text) => { editorDraft = text })
    expect(editorDraft).toBe('林舟推开门。\n\n他没有回头。')
    expect(finalText).toBe(editorDraft)
  })
})

describe('续写先采用补写稿再同步记忆', () => {
  it.each([false, true])('增量与补写整章都在交付时统一排版（整章=%s）', (full) => {
    const raw = '“先签字。别等了！”他转身。门关了。'
    const result = finalizeChapterContinuation('已有正文。', '预览', {
      ok: true, content: raw, ...(full ? { fullContent: '已有正文。' + raw } : {})
    })
    expect(result.content).toBe('已有正文。' + (full ? '' : '\n\n') + raw)
  })

  it('采用补入已有正文中段的整章，前文只出现一次', () => {
    const result = finalizeChapterContinuation('已有正文。', '流式预览。', {
      ok: true, content: '新增结尾。', fullContent: '已有正文。\n补入的伏笔。\n新增结尾。',
      foreshadowRepair: { status: 'applied', message: '已补写' }
    })
    expect(result).toEqual({ content: '已有正文。\n补入的伏笔。\n新增结尾。', canSyncMemory: true })
  })

  it('无需补写时保留增量拼接和纯正文规则', () => {
    expect(finalizeChapterContinuation('已有正文。', '预览', {
      ok: true, content: '新增正文。\n【本章伏笔回执】{"planted":[],"collected":[]}',
      foreshadowRepair: { status: 'unchanged', message: '无遗漏' }
    })).toEqual({ content: '已有正文。\n\n新增正文。', canSyncMemory: true })
  })

  it('补写失败保留生成稿，同时禁止启动自动记忆同步', () => {
    expect(finalizeChapterContinuation('已有正文。', '预览', {
      ok: true, content: '新正文。', foreshadowRepair: { status: 'failed', message: '未通过' }
    })).toEqual({ content: '已有正文。\n\n新正文。', canSyncMemory: false })
  })
})
