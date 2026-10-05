import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import ShortStoryCandidateStatus, { friendlyShortStoryGenerationError } from '../src/renderer/src/ShortStoryCandidateStatus'
import type { ShortStoryCandidate } from '../src/renderer/src/short-story-candidate'

beforeAll(() => vi.stubGlobal('React', React))
afterAll(() => vi.unstubAllGlobals())

function candidate(changes: Partial<ShortStoryCandidate> = {}): ShortStoryCandidate {
  return { task: 'revise', sectionNumber: 2, append: false, text: '', status: 'generating', source: '', ...changes }
}

type StatusProps = React.ComponentProps<typeof ShortStoryCandidateStatus>

function render(changes: Partial<ShortStoryCandidate> = {}, retryDisabled = false, status: Partial<StatusProps> = {}): string {
  return renderToStaticMarkup(createElement(ShortStoryCandidateStatus, {
    candidate: candidate(changes), retryDisabled, onRetry() {}, ...status
  }))
}

describe('short-story candidate status', () => {
  it.each(['revise', 'section', 'review', 'outline'] as const)('makes the waiting %s task visibly active before receiving text', task => {
    const html = render({ task })
    expect(html).toContain(task === 'revise' ? '正在修订' : '正在生成')
    expect(html).toContain(task === 'revise' || task === 'section' ? '等待模型返回正文' : '等待模型返回内容')
    expect(html).toContain('当前任务正在进行')
    expect(html).toContain('ss-candidate-state-generating')
    expect(html).not.toContain('失败')
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('<button')
  })

  it('keeps a streaming revision visibly active after receiving text', () => {
    const html = render({ text: '修订正文' })
    expect(html).toContain('正在修订 · 已收到 4 字，仍在生成')
    expect(html).not.toContain('等待模型')
    expect(html).not.toContain('当前没有生成任务')
  })

  it('shows the new request preparation immediately instead of the old failed request', () => {
    const html = render({ status: 'failed', error: 'LLM_TIMEOUT' }, true, {
      preparing: true, preparationError: '上次保存失败', retryBlockedReason: '上次禁用原因'
    })
    expect(html).toContain('正在保存作品，准备生成…')
    expect(html).toContain('保存完成后会立即发起请求，原稿仍保留。')
    expect(html).toContain('ss-candidate-state-generating')
    expect(html).not.toContain('修订失败')
    expect(html).not.toContain('模型响应超时')
    expect(html).not.toContain('上次保存失败')
    expect(html).not.toContain('上次禁用原因')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('role="alert"')
  })

  it('places preparation errors beside the retained candidate and leaves retry available', () => {
    const html = render({ status: 'failed', error: 'LLM_TIMEOUT', text: '保留的候选' }, false, {
      preparationError: '保存失败，当前稿件仍保留：作品文件已在外部修改。'
    })
    expect(html).toMatch(/role="alert">保存失败，当前稿件仍保留：作品文件已在外部修改。<\/p>/)
    expect(html).toContain('原稿与收到的文本仍保留')
    expect(html).toContain('重新修订第 2 节')
    expect(html).not.toContain('模型响应超时')
    expect(html).not.toMatch(/<button[^>]*disabled=/)
  })

  it('places the failure and its reason together when no revision text was received', () => {
    const html = render({ status: 'failed', error: 'LLM_TIMEOUT' })
    expect(html).toContain('ss-candidate-status')
    expect(html).toContain('ss-candidate-state-failed')
    expect(html).toContain('修订失败')
    expect(html).toContain('本次未收到正文，当前没有生成任务在运行')
    expect(html).toMatch(/role="alert">模型响应超时，请重试。<\/p>/)
    expect(html).toContain('重新修订第 2 节')
    expect(html).not.toContain('正在修订')
    expect(html).not.toContain('LLM_TIMEOUT')
  })

  it('explains retained partial text after failure instead of claiming it is still streaming', () => {
    const html = render({ status: 'failed', text: '修订正文', error: '连接在返回途中断开。' })
    expect(html).toContain('已收到 4 字，当前没有生成任务在运行')
    expect(html).toContain('原稿与收到的文本仍保留')
    expect(html).toMatch(/role="alert">连接在返回途中断开。<\/p>/)
    expect(html).not.toContain('仍在生成')
    expect(html).not.toContain('本次未收到正文')
  })

  it('reports a stopped revision and retains the explanation from restored recovery text', () => {
    const html = render({ status: 'stopped', text: '修订正文', error: '已恢复上次中断的候选，当前没有生成任务在运行。' })
    expect(html).toContain('ss-candidate-state-stopped')
    expect(html).toContain('已停止修订')
    expect(html).toContain('原稿与收到的文本仍保留')
    expect(html).toMatch(/role="alert">已恢复上次中断的候选，当前没有生成任务在运行。<\/p>/)
    expect(html).toContain('重新修订第 2 节')
    expect(html).not.toContain('修订失败')
  })

  it('reports a stopped generation with no text without inventing a failure reason', () => {
    const html = render({ task: 'outline', status: 'stopped' })
    expect(html).toContain('已停止生成')
    expect(html).toContain('本次未收到内容，当前没有生成任务在运行。原稿仍保留。')
    expect(html).not.toContain('role="alert"')
  })

  it.each(['revise', 'section', 'review', 'outline'] as const)('reports completed %s candidates as waiting for adoption, without retrying', task => {
    const html = render({ task, status: 'completed', text: '完整候选', error: '旧错误' })
    expect(html).toContain(task === 'revise' ? '修订完成，待采用' : '生成完成，待采用')
    expect(html).toContain('ss-candidate-state-completed')
    expect(html).not.toContain('旧错误')
    expect(html).not.toContain('<button')
  })

  it.each([
    ['revise', '重新修订第 2 节'], ['section', '重新生成第 2 节'],
    ['review', '重新检查全文'], ['outline', '重新生成大纲']
  ] as const)('keeps the retry label bound to the %s candidate task and section', (task, label) => {
    expect(render({ task, status: 'failed' })).toMatch(new RegExp(`<button[^>]*>${label}<\\/button>`))
  })

  it('disables retry when prerequisites or another request prevent it', () => {
    const html = render({ status: 'failed' }, true)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重新修订第 2 节<\/button>/)
  })

  it('explains a blocked retry beside its disabled button', () => {
    const html = render({ status: 'failed' }, true, {
      retryBlockedReason: '请先检查全文并采用检查报告，再重新修订。'
    })
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重新修订第 2 节<\/button>/)
    expect(html).toContain('<p class="muted">请先检查全文并采用检查报告，再重新修订。</p>')
  })

  it('gives old failed candidates without stored reasons an honest fallback', () => {
    const html = render({ status: 'failed' })
    expect(html).toMatch(/role="alert">未记录具体失败原因，请重试。<\/p>/)
    expect(html).toContain('修订失败')
    expect(html).not.toContain('停止或失败')
  })
})

describe('short-story generation error messages', () => {
  it.each([
    ['LLM_NOT_CONFIGURED', '尚未配置模型服务'], ['LLM_AUTH_FAILED', '模型服务认证失败'],
    ['LLM_RATE_LIMIT', '请求过于频繁'], ['LLM_TIMEOUT', '模型响应超时'],
    ['LLM_OUTPUT_TRUNCATED', '模型输出不完整'], ['LLM_ABORTED', '生成已停止'],
    ['LLM_REQUEST_FAILED', '模型请求失败']
  ])('translates %s, including errors wrapped by IPC', (code, message) => {
    expect(friendlyShortStoryGenerationError(`Error invoking remote method: Error: ${code}`)).toContain(message)
  })

  it.each([
    'IPC_INPUT_INVALID: task: Invalid option: expected one of "outline"|"section"|"review"',
    'Error invoking remote method shortStory:generate: Error: 未知中短篇写作任务'
  ])('explains a running version that does not support the requested task', raw => {
    expect(friendlyShortStoryGenerationError(raw)).toBe('当前运行版本不支持此任务，请关闭并重新打开应用后重试。')
  })

  it('preserves an unknown reason and does not mistake another invalid field for an old application version', () => {
    const raw = 'IPC_INPUT_INVALID: story.kind: Invalid option: expected short or medium'
    expect(friendlyShortStoryGenerationError(raw)).toBe(raw)
    expect(friendlyShortStoryGenerationError(' 连接断开，已收到部分正文。 ')).toBe(' 连接断开，已收到部分正文。 ')
  })
})
