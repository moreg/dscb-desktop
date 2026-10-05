import { describe, expect, it } from 'vitest'
import { finalizeChapterContinuation, finalizeChapterRewrite } from '../src/renderer/src/chapter-generation-finalize'

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
    expect(editorDraft).toBe('林舟推开门。\n他没有回头。')
    expect(finalText).toBe(editorDraft)
  })
})

describe('续写先采用补写稿再同步记忆', () => {
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
    })).toEqual({ content: '已有正文。\n新增正文。', canSyncMemory: true })
  })

  it('补写失败保留生成稿，同时禁止启动自动记忆同步', () => {
    expect(finalizeChapterContinuation('已有正文。', '预览', {
      ok: true, content: '新正文。', foreshadowRepair: { status: 'failed', message: '未通过' }
    })).toEqual({ content: '已有正文。\n新正文。', canSyncMemory: false })
  })
})
