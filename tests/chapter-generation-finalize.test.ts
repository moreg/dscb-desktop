import { describe, expect, it } from 'vitest'
import { finalizeChapterRewrite } from '../src/renderer/src/chapter-generation-finalize'

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
