import React, { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import DeslopResultActions from '../src/renderer/src/DeslopResultActions'
import type { DeslopResult } from '../src/shared/types'

beforeAll(() => vi.stubGlobal('React', React))
afterAll(() => vi.unstubAllGlobals())
const result: DeslopResult = { rewritten: '候选正文', beforeWords: 4, afterWords: 4, deleteRatio: 0,
  processedGates: ['E'], changeSummary: [],
  remainingFindings: [{ line: 1, column: 1, gate: 'E', type: 'dialogue-quality-incomplete', severity: 'blocking', excerpt: '', message: '比例未通过' }],
  dialogueQuality: { passed: false, attempts: 3, beforeRatio: 0.4, afterRatio: 0.4591, issues: ['对白比例未达到69%—71%'] }
}
function buttons(node: ReactNode): ReactElement<{ onClick: () => void; disabled?: boolean; children: ReactNode }>[] {
  if (!React.isValidElement<{ children?: ReactNode }>(node)) return []
  if (node.type === 'button') return [node as ReactElement<{ onClick: () => void; disabled?: boolean; children: ReactNode }>]
  return React.Children.toArray(node.props.children).flatMap(buttons)
}
describe('manual candidate choices', () => {
  it('shows failure details with an enabled apply choice, without changing prose before a click', () => {
    const apply = vi.fn(), discard = vi.fn()
    const props = { result, identical: false, staleBaseline: false, onApply: apply, onDiscard: discard }
    const html = renderToStaticMarkup(createElement(DeslopResultActions, props))
    expect(html).toContain('45.91%')
    expect(html).toContain('对白比例未达到69%—71%')
    expect(html).toContain('应用候选稿')
    expect(html).toContain('不应用，保留原文')
    expect(html).not.toContain('disabled')
    expect(apply).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled()
    const actions = buttons(DeslopResultActions(props))
    actions[1].props.onClick()
    expect(apply).toHaveBeenCalledOnce(); expect(discard).not.toHaveBeenCalled()
  })
  it('discards the candidate without invoking apply, and only disables apply for identical text', () => {
    const apply = vi.fn(), discard = vi.fn()
    const props = { result, identical: true, staleBaseline: false, onApply: apply, onDiscard: discard }
    const actions = buttons(DeslopResultActions(props))
    expect(actions[1].props.disabled).toBe(true)
    actions[0].props.onClick()
    expect(discard).toHaveBeenCalledOnce(); expect(apply).not.toHaveBeenCalled()
  })
  it('also allows choosing a result with local scan findings and explains intervening author edits', () => {
    const html = renderToStaticMarkup(createElement(DeslopResultActions, {
      result: { ...result, dialogueQuality: undefined }, identical: false, staleBaseline: true, onApply() {}, onDiscard() {}
    }))
    expect(html).toContain('复扫仍有 1 处待核对项')
    expect(html).toContain('会覆盖润色期间的手动编辑；应用后可撤销')
    expect(html).not.toContain('disabled')
  })
})
