import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { ChapterDirections } from '../src/shared/chapter-directions'

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }))
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T) => {
    const index = hooks.cursor++
    if (!(index in hooks.slots)) hooks.slots[index] = initial
    return [hooks.slots[index], (next: T) => { hooks.slots[index] = next }]
  },
  useEffect: (effect: () => void, dependencies: unknown[]) => {
    const index = hooks.cursor++
    const previous = hooks.slots[index] as unknown[] | undefined
    if (!previous || dependencies.some((value, i) => value !== previous[i])) {
      hooks.slots[index] = dependencies; effect()
    }
  }
}))
import ChapterDirectionsDialog from '../src/renderer/src/ChapterDirectionsDialog'

type Interactive = React.ReactElement<{ children?: React.ReactNode; onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void; type?: string; value?: string; checked?: boolean; disabled?: boolean }>
function elements(node: React.ReactNode): Interactive[] {
  if (!React.isValidElement(node)) return []
  const element = node as Interactive
  return [element, ...React.Children.toArray(element.props.children).flatMap(elements)]
}
describe('五方向选择界面', () => {
  const onChoose = vi.fn()
  const onRegenerate = vi.fn()
  const candidates: ChapterDirections = { token: 'directions-1', chapterNumber: 5, contextHash: 'hash', missingPreviousProse: true,
    directions: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, title: `方向${id}`, connection: '从总纲当前阶段切入。', conflict: '船夫拒绝交代。',
      progression: '拿到线索。', ending: '准备前往仓库。', hook: '账本下落未明。', outlineReason: '沿着寻账主线推进。' })),
    recommendedId: 'c', recommendationReason: '与当前阶段最符合。' }
  let props: Parameters<typeof ChapterDirectionsDialog>[0]
  const render = () => { hooks.cursor = 0; return ChapterDirectionsDialog(props) }
  const button = (label: string) => elements(render()).find(element => element.type === 'button' && element.props.children === label)!
  beforeEach(() => {
    hooks.slots = []; hooks.cursor = 0; onChoose.mockReset(); onRegenerate.mockReset()
    vi.stubGlobal('React', React)
    props = { candidates, loading: false, error: '', onCancel: vi.fn(), onChoose, onRegenerate }
  })
  afterEach(() => vi.unstubAllGlobals())

  it('展示五个选项及唯一推荐，默认选中推荐项，并说明缺少上一章正文', () => {
    const tree = render()
    const radios = elements(tree).filter(element => element.type === 'input' && element.props.type === 'radio')
    expect(radios).toHaveLength(5)
    expect(radios.filter(element => element.props.checked).map(element => element.props.value)).toEqual(['c'])
    const markup = renderToStaticMarkup(tree)
    expect(markup).toContain('未找到上一章正文')
    expect(markup).toContain('与当前阶段最符合')
    button('按此方向续写').props.onClick?.()
    expect(onChoose).toHaveBeenCalledWith({ token: candidates.token, directionId: 'c', adjustment: undefined })
  })

  it('用户可以改选并调整方向，采用时携带所选标识及调整文字', () => {
    const second = elements(render()).find(element => element.type === 'input' && element.props.value === 'b')!
    second.props.onChange?.({ target: { value: 'b' } })
    const edit = elements(render()).find(element => element.type === 'textarea')!
    edit.props.onChange?.({ target: { value: '先交涉，暂不进入仓库。' } })
    button('按此方向续写').props.onClick?.()
    expect(onChoose).toHaveBeenCalledWith({ token: candidates.token, directionId: 'b', adjustment: '先交涉，暂不进入仓库。' })
  })

  it('重新生成时保留调整文字，新候选返回后使用新的推荐项', () => {
    elements(render()).find(element => element.type === 'textarea')!.props.onChange?.({ target: { value: '保留船夫身份悬念。' } })
    button('重新生成五个方向').props.onClick?.()
    expect(onRegenerate).toHaveBeenCalledOnce()
    props = { ...props, loading: true }
    expect(button('按此方向续写').props.disabled).toBe(true)
    props = { ...props, loading: false, candidates: { ...candidates, token: 'directions-2', recommendedId: 'e' } }
    render()
    expect(elements(render()).find(element => element.type === 'textarea')!.props.value).toBe('保留船夫身份悬念。')
    button('按此方向续写').props.onClick?.()
    expect(onChoose).toHaveBeenCalledWith({ token: 'directions-2', directionId: 'e', adjustment: '保留船夫身份悬念。' })
  })
})
