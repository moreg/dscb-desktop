import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamHandleOf } from '../src/shared/types'
import type { BasedOn, GenerateStudioStoryboardResult, GenerationRun, ScriptProject, StoryboardUnit } from '../src/shared/script-studio'
import { SHOT_FIELDS } from '../src/shared/script-studio'
import { randomUUID } from 'crypto'
import { buildPromptPackage } from '../src/main/data/script-prompt-kit'

interface Effect { deps?: readonly unknown[]; cleanup?: () => void; run?: () => void | (() => void) }
interface HookContext { slots: unknown[]; cursor: number; effects: Map<number, Effect>; dirty: boolean; writes: number }
const hooks = vi.hoisted(() => ({ current: null as HookContext | null, contexts: new Map<string, HookContext>() }))

// 直接触发生产组件 JSX 的事件，并保留 hooks、依赖变化和 cleanup，无需 DOM 依赖。
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useMemo: <T,>(factory: () => T) => factory(),
    useState: <T,>(initial: T | (() => T)) => {
      const context = hooks.current!; const index = context.cursor++
      if (!(index in context.slots)) context.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial
      return [context.slots[index] as T, (value: T | ((prior: T) => T)) => {
        const next = typeof value === 'function' ? (value as (prior: T) => T)(context.slots[index] as T) : value
        if (!Object.is(next, context.slots[index])) { context.slots[index] = next; context.dirty = true; context.writes++ }
      }]
    },
    useRef: <T,>(initial: T) => {
      const context = hooks.current!; const index = context.cursor++
      if (!(index in context.slots)) context.slots[index] = { current: initial }
      return context.slots[index] as { current: T }
    },
    useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => {
      const context = hooks.current!; const index = context.cursor++
      const previous = context.effects.get(index)
      if (!previous || !deps || !previous.deps || deps.length !== previous.deps.length || deps.some((value, at) => !Object.is(value, previous.deps![at]))) {
        context.effects.set(index, { deps, cleanup: previous?.cleanup, run })
      }
    }
  }
})

import ScriptStudioPage from '../src/renderer/src/ScriptStudioPage'

function render<P>(name: string, component: (props: P) => React.ReactElement, props: P): React.ReactElement {
  let context = hooks.contexts.get(name)
  if (!context) { context = { slots: [], cursor: 0, effects: new Map(), dirty: false, writes: 0 }; hooks.contexts.set(name, context) }
  let tree: React.ReactElement
  let rounds = 0
  do {
    context.cursor = 0; context.dirty = false; hooks.current = context
    tree = component(props)
    for (const effect of context.effects.values()) {
      if (!effect.run) continue
      const run = effect.run; effect.run = undefined
      effect.cleanup?.(); effect.cleanup = run() || undefined
    }
    if (++rounds > 10) throw new Error('组件未能稳定渲染')
  } while (context.dirty)
  hooks.current = null
  return tree
}
function unmount(name: string): void {
  const context = hooks.contexts.get(name)
  for (const effect of context?.effects.values() ?? []) effect.cleanup?.()
  hooks.contexts.delete(name)
}
function content(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(content).join('')
  return React.isValidElement<{ children?: React.ReactNode }>(node) ? content(node.props.children) : ''
}
function elements(node: React.ReactNode, predicate: (element: React.ReactElement<Record<string, unknown>>) => boolean): React.ReactElement<Record<string, unknown>>[] {
  if (!React.isValidElement<Record<string, unknown>>(node)) return []
  return [...(predicate(node) ? [node] : []), ...React.Children.toArray(node.props.children as React.ReactNode).flatMap(child => elements(child, predicate))]
}
function button(tree: React.ReactNode, label: string, index = 0): React.ReactElement<{ onClick: () => unknown; disabled?: boolean }> {
  const match = elements(tree, element => element.type === 'button' && content(element.props.children as React.ReactNode).endsWith(label))[index]
  if (!match) throw new Error(`缺少按钮 ${label}`)
  return match as React.ReactElement<{ onClick: () => unknown; disabled?: boolean }>
}
function field(tree: React.ReactNode, name: string): React.ReactElement<{ value: string; disabled?: boolean; onChange: (event: { target: { value: string } }) => void }> {
  const match = elements(tree, element => element.props.id === name || element.props.placeholder === name || element.props['aria-label'] === name)[0]
  if (!match) throw new Error(`缺少字段 ${name}`)
  return match as React.ReactElement<{ value: string; disabled?: boolean; onChange: (event: { target: { value: string } }) => void }>
}
function expand(node: React.ReactNode): React.ReactNode {
  if (Array.isArray(node)) return node.map(expand)
  if (!React.isValidElement<Record<string, unknown>>(node)) return node
  if (typeof node.type === 'function') {
    const component = node.type as (props: Record<string, unknown>) => React.ReactElement
    return expand(render(component.name, component, node.props))
  }
  return React.cloneElement(node, {}, ...React.Children.toArray(node.props.children as React.ReactNode).map(expand))
}
function screen(): React.ReactNode { return expand(render('page', ScriptStudioPage, {})) }
async function settled(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function makeProject(): ScriptProject {
  const id = randomUUID(); const versionId = randomUUID(); const fingerprint = 'a'.repeat(64)
  return {
    id, title: id, schemaVersion: 1, revision: 2, createdAt: '', updatedAt: '',
    settings: { format: 'short', platform: '抖音', aspectRatio: '9:16', targetDurationSec: 90,
      visualStyle: '暂定', adaptStrength: 'medium', paceTier: 'short-high', resolution: '1080p', extraRequirements: '' },
    source: { kind: 'pasteScript', text: 'SC1 日 内 书房\n林远\n把账册给我。', ranges: [{ kind: 'paste', label: '剧本' }],
      outlineHint: '', sourceFingerprint: fingerprint, truncated: false, charCount: 20, createdAt: '' },
    candidate: null, scriptVersions: [{ id: versionId, number: 1, body: 'SC1 日 内 书房\n林远\n把账册给我。',
      note: '', sourceFingerprint: fingerprint, createdAt: '' }], activeVersionId: versionId,
    storyboard: null, contentFingerprint: fingerprint, scriptFingerprint: fingerprint
  }
}
function basis(project: ScriptProject): BasedOn {
  return { projectId: project.id, projectName: project.title, versionId: project.activeVersionId!, versionNumber: 1,
    scriptRevision: project.revision, scriptFingerprint: project.scriptFingerprint, contentFingerprint: project.contentFingerprint,
    sourceFingerprint: project.source.sourceFingerprint, storyboardFingerprint: 'b'.repeat(64), unitId: '', stale: false, generatedAt: '' }
}
function units(): StoryboardUnit[] {
  return [{ id: 'unit-1', index: 1, durationSec: 8, emotion: '紧张', dramaticAction: '交出账册', paceTier: 'short-high',
    paceReason: '推进', suggestedShotCount: 1, firstFrame: '持账册', lastFrame: '交账册', continuity: '账册位置不变',
    characterPositions: '林远左侧', assetRefs: [],
    shots: [Object.fromEntries(SHOT_FIELDS.map(key => [key, key === 'dialogueAndTone' ? '无对白' : '可执行描述'])) as StoryboardUnit['shots'][number]] }]
}
function withStoryboard(project: ScriptProject, basedOn = basis(project)): ScriptProject {
  return { ...project, storyboard: { units: units(), basedOn, storyboardFingerprint: basedOn.storyboardFingerprint, savedAt: '' } }
}
let project: ScriptProject
let other: ScriptProject
let api: Record<string, ReturnType<typeof vi.fn>>
async function open(id: string): Promise<void> {
  field(screen(), '已有剧本项目').props.onChange({ target: { value: id } })
  await settled()
  screen()
  await settled()
}
function step(label: string): React.ReactNode {
  button(screen(), label).props.onClick()
  return screen()
}
function startStoryboard() {
  const result = deferred<GenerateStudioStoryboardResult>()
  const abort = vi.fn().mockResolvedValue({ ok: true })
  const handle: StreamHandleOf<GenerateStudioStoryboardResult> = Object.assign(result.promise, { requestId: randomUUID(), abort })
  api.generateStudioStoryboard.mockReturnValue(handle)
  return { ...result, handle, abort }
}
beforeEach(() => {
  hooks.contexts.clear()
  vi.stubGlobal('React', React)
  project = makeProject(); other = makeProject()
  api = {
    listScriptProjects: vi.fn().mockResolvedValue([]), listProjects: vi.fn().mockResolvedValue([]),
    listShortStories: vi.fn().mockResolvedValue([]),
    getScriptProject: vi.fn().mockImplementation(async id => structuredClone(id === project.id ? project : other)),
    recoverStudioRuns: vi.fn().mockResolvedValue({ ok: true, recovered: 0, runs: [] }),
    saveScriptStoryboard: vi.fn().mockImplementation(async () => ({ ok: true, project: withStoryboard(project) })),
    saveScriptProject: vi.fn(), createScriptProject: vi.fn(), generateStudioStoryboard: vi.fn(),
    getShortStory: vi.fn()
  }
  vi.stubGlobal('window', { api })
})
afterEach(() => {
  for (const name of [...hooks.contexts.keys()]) unmount(name)
  vi.unstubAllGlobals()
})

describe('剧本工作台真实组件事件回归', () => {
  it('正式稿修改后，旧分镜不能重新保存或仅重生成一段来洗掉过期状态', async () => {
    project = withStoryboard(project, { ...basis(project), scriptFingerprint: 'c'.repeat(64) })
    await open(project.id)
    button(step('视频分镜'), '保存分镜').props.onClick()
    await settled()
    expect(api.saveScriptStoryboard).not.toHaveBeenCalled()
    expect(content(screen())).toContain('已过期，请重新生成全部分镜')
    button(screen(), '按段重生成').props.onClick()
    await settled()
    expect(api.generateStudioStoryboard).not.toHaveBeenCalled()
  })

  it('新分镜保存使用返回的生成依据，并可正常完成保存', async () => {
    await open(project.id)
    const pending = startStoryboard()
    button(step('视频分镜'), '生成 / 重新生成分镜').props.onClick()
    pending.resolve({ ok: true, units: units(), basedOn: basis(project) })
    await settled()
    button(screen(), '保存分镜').props.onClick()
    await settled()
    expect(api.saveScriptStoryboard).toHaveBeenCalledWith({ projectId: project.id, units: units(),
      expectedRevision: project.revision, expectedVersionId: project.activeVersionId,
      expectedScriptFingerprint: project.scriptFingerprint, expectedSourceFingerprint: project.source.sourceFingerprint })
    expect(content(screen())).toContain('分镜已显式保存')
  })

  it('在页面编辑正式稿并保存新版本后，保留的旧分镜不能再被保存为最新', async () => {
    project = withStoryboard(project)
    api.saveScriptProject.mockImplementation(async ({ project: draft }) => ({ ok: true,
      project: { ...draft, revision: project.revision + 1, scriptFingerprint: 'c'.repeat(64) } }))
    await open(project.id)
    field(step('剧本'), 'ss-version-edit').props.onChange({ target: { value: '新版本正式稿。' } })
    button(screen(), '保存为新版本').props.onClick()
    await settled()
    expect(api.saveScriptProject).toHaveBeenCalledTimes(1)
    button(step('视频分镜'), '保存分镜').props.onClick()
    await settled()
    expect(api.saveScriptStoryboard).not.toHaveBeenCalled()
    expect(content(screen())).toContain('已过期，请重新生成全部分镜')
  })

  it('生成期间项目选择禁用，旧事件处理器也无法切换到另一个项目', async () => {
    await open(project.id)
    const selector = field(screen(), '已有剧本项目')
    const pending = startStoryboard()
    button(step('视频分镜'), '生成 / 重新生成分镜').props.onClick()
    expect(field(screen(), '已有剧本项目').props.disabled).toBe(true)
    selector.props.onChange({ target: { value: other.id } })
    await settled()
    expect(api.getScriptProject).toHaveBeenCalledTimes(1)
    pending.resolve({ ok: true, units: units(), basedOn: basis(project) })
    await settled()
    expect(field(screen(), '已有剧本项目').props.value).toBe(project.id)
  })

  it('卸载后旧请求晚到，不会回写下一个工作台的分镜', async () => {
    await open(project.id)
    const pending = startStoryboard()
    button(step('视频分镜'), '生成 / 重新生成分镜').props.onClick()
    unmount('page')
    expect(pending.abort).toHaveBeenCalledTimes(1)
    await open(other.id)
    pending.resolve({ ok: true, units: units(), basedOn: basis(project) })
    await settled()
    expect(field(screen(), '已有剧本项目').props.value).toBe(other.id)
    expect(content(step('视频分镜'))).toContain('从正式稿开始拆分镜头')
    expect(api.saveScriptStoryboard).not.toHaveBeenCalled()
  })

  it('旧项目的历史恢复响应晚到，也不能展示在新项目中', async () => {
    const pending = deferred<{ ok: true; recovered: number; runs: GenerationRun[] }>()
    api.recoverStudioRuns.mockImplementation(({ projectId }) => projectId === project.id
      ? pending.promise : Promise.resolve({ ok: true, recovered: 0, runs: [] }))
    await open(project.id)
    await open(other.id)
    pending.resolve({ ok: true, recovered: 1, runs: [{ runId: randomUUID(), projectId: project.id, kind: 'storyboard',
      status: 'interrupted', partialText: '旧项目内容', requestId: randomUUID(), feature: '', startedAt: '', updatedAt: '' }] })
    await settled()
    expect(content(screen())).not.toContain('可恢复的生成记录')
    expect(content(screen())).not.toContain('旧项目内容')
    expect(field(screen(), '已有剧本项目').props.value).toBe(other.id)
  })

  it.each(['script', 'storyboard'] as const)('重新打开后能恢复历史 %s 原始文本并复制', async kind => {
    const text = kind === 'script' ? '已收到的剧本正文。' : '{"units":[{"id":"未完成'
    const record = { runId: randomUUID(), projectId: project.id, kind, status: 'interrupted', partialText: text,
      requestId: randomUUID(), feature: '', startedAt: '', updatedAt: '' } satisfies GenerationRun
    api.recoverStudioRuns.mockResolvedValue({ ok: true, recovered: 1, runs: [record] })
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await open(project.id)
    button(screen(), '恢复此记录文本').props.onClick()
    expect(field(screen(), 'ss-recovered-text').props.value).toBe(text)
    button(screen(), '复制恢复文本').props.onClick()
    await settled()
    expect(writeText).toHaveBeenCalledWith(text)
    if (kind === 'script') {
      const candidates = elements(step('剧本'), e => e.type === 'textarea' && e.props.value === text && !e.props.readOnly)
      expect(candidates).toHaveLength(1)
    }
  })

  it('当前中断的分镜也可显示完整原始文本，而非只显示恢复提示', async () => {
    await open(project.id)
    const pending = startStoryboard()
    button(step('视频分镜'), '生成 / 重新生成分镜').props.onClick()
    pending.resolve({ ok: false, error: '解析失败', retainedText: '{"units":[半成品' })
    await settled()
    button(screen(), '恢复已收到文本').props.onClick()
    expect(field(screen(), 'ss-recovered-text').props.value).toBe('{"units":[半成品')
  })

  it('中短篇 60 节全文选材从页面创建项目时不丢失范围', async () => {
    const sections = Array.from({ length: 60 }, (_, i) => ({ number: i + 1, title: `节${i + 1}`, content: `正文${i + 1}。` }))
    api.listShortStories.mockResolvedValue([{ id: 'short-id', title: '完整短篇' }])
    api.getShortStory.mockResolvedValue({ title: '完整短篇', sections })
    api.createScriptProject.mockResolvedValue(makeProject())
    field(screen(), 'ss-source-kind').props.onChange({ target: { value: 'short' } })
    field(screen(), 'ss-short-story').props.onChange({ target: { value: 'short-id' } })
    await settled()
    button(screen(), '创建并进入剧本').props.onClick()
    await settled()
    const input = api.createScriptProject.mock.calls[0][0]
    expect(input.sourceRanges).toHaveLength(60)
    expect(input.sourceRanges[59]).toMatchObject({ sectionNumber: 60, storyId: 'short-id' })
    for (const section of sections) expect(input.sourceText).toContain(section.content)
  })

  it('设置与节奏档案可编辑并显式保存，保存后旧分镜过期', async () => {
    project = withStoryboard(project)
    api.saveScriptProject.mockImplementation(async ({ project: draft }) => ({ ok: true,
      project: { ...draft, revision: draft.revision + 1, scriptFingerprint: 'c'.repeat(64) } }))
    await open(project.id)
    step('选材与设置')
    field(screen(), 'ss-audience').props.onChange({ target: { value: '悬疑观众' } })
    field(screen(), 'ss-pace-mode').props.onChange({ target: { value: 'auto' } })
    field(screen(), 'ss-duration').props.onChange({ target: { value: '45' } })
    field(screen(), 'ss-rhythm-first3').props.onChange({ target: { value: '先露出印记' } })
    button(screen(), '保存当前项目设置').props.onClick()
    await settled()
    expect(api.saveScriptProject).toHaveBeenCalledWith({ project: expect.objectContaining({
      settings: expect.objectContaining({ targetAudience: '悬疑观众', paceMode: 'auto', targetDurationSec: 45,
        rhythmProfile: expect.objectContaining({ first3: '先露出印记' }) }) }) })
    expect(button(step('视频分镜'), '保存分镜').props.disabled).toBe(true)
  })

  it('单元时长与节奏覆盖可保存，非法时长立即阻断保存', async () => {
    project = withStoryboard(project)
    project.storyboard!.units[0].paceExecution = '旧节奏执行'
    await open(project.id)
    step('视频分镜')
    field(screen(), 'unit-1 节奏档位').props.onChange({ target: { value: 'slow-info' } })
    expect(field(screen(), 'unit-1 节奏执行').props.value).toBe('')
    field(screen(), 'unit-1 节奏执行').props.onChange({ target: { value: '停顿读清印记，再抬眼' } })
    field(screen(), 'unit-1 慢镜头功能').props.onChange({ target: { value: '揭示印记' } })
    field(screen(), 'unit-1 时长').props.onChange({ target: { value: '16' } })
    expect(button(screen(), '保存分镜').props.disabled).toBe(true)
    field(screen(), 'unit-1 时长').props.onChange({ target: { value: '10.5' } })
    button(screen(), '保存分镜').props.onClick()
    await settled()
    expect(api.saveScriptStoryboard).toHaveBeenCalledWith(expect.objectContaining({ units: [expect.objectContaining({
      durationSec: 10.5, paceTier: 'slow-info', paceReason: '用户指定本段节奏档位',
      paceExecution: '停顿读清印记，再抬眼', slowMotionPurpose: '揭示印记' })] }))
  })


  it('单元与镜头切换只显示当前编辑器，编辑草稿跨切换保留并整体保存', async () => {
    project = withStoryboard(project)
    const first = project.storyboard!.units[0]
    first.shots.push({ ...first.shots[0] })
    project.storyboard!.units.push({ ...structuredClone(first), id: 'unit-2', index: 2 })
    api.saveScriptStoryboard.mockImplementation(async input => ({ ok: true,
      project: { ...project, storyboard: { ...project.storyboard!, units: input.units } } }))
    await open(project.id)
    step('视频分镜')
    expect(elements(screen(), e => e.type === 'textarea' && String(e.props['aria-label']).includes('unit-1 镜头 1'))).toHaveLength(11)
    expect(elements(screen(), e => String(e.props['aria-label']).includes('unit-2 镜头'))).toHaveLength(0)
    field(screen(), 'unit-1 镜头 1 主体动作与表情').props.onChange({ target: { value: '右手翻开账册。' } })
    button(screen(), '镜头 2').props.onClick()
    field(screen(), 'unit-1 镜头 2 台词与语气').props.onChange({ target: { value: '无对白，屏息。' } })
    button(screen(), '下一单元').props.onClick()
    field(screen(), 'unit-2 时长').props.onChange({ target: { value: '10.5' } })
    button(screen(), '上一单元').props.onClick()
    expect(field(screen(), 'unit-1 镜头 1 主体动作与表情').props.value).toBe('右手翻开账册。')
    button(screen(), '镜头 2').props.onClick()
    expect(field(screen(), 'unit-1 镜头 2 台词与语气').props.value).toBe('无对白，屏息。')
    expect(content(screen())).toContain('有未保存修改')
    button(screen(), '保存分镜').props.onClick()
    await settled()
    const saved = api.saveScriptStoryboard.mock.calls[0][0].units as StoryboardUnit[]
    expect(saved[0].shots[0].subjectActionExpression).toBe('右手翻开账册。')
    expect(saved[0].shots[1].dialogueAndTone).toBe('无对白，屏息。')
    expect(saved[1].durationSec).toBe(10.5)
    expect(content(screen())).toContain('与已保存分镜一致')
  })

  it('问题定位打开对应单元和镜头，并聚焦具体字段', async () => {
    project = withStoryboard(project)
    const broken = structuredClone(project.storyboard!.units[0])
    broken.id = 'unit-2'; broken.index = 2
    broken.shots.push({ ...broken.shots[0], aperture: '' })
    project.storyboard!.units.push(broken)
    const focus = vi.fn(); const getElementById = vi.fn().mockReturnValue({ focus })
    vi.stubGlobal('document', { getElementById })
    await open(project.id)
    step('视频分镜')
    const issue = elements(screen(), e => String(e.props.className).includes('ss-issue-target') && content(e.props.children as React.ReactNode).includes('aperture'))[0]
    expect(issue).toBeTruthy()
    ;(issue.props.onClick as () => void)()
    expect(field(screen(), 'unit-2 镜头 2 光圈').props.value).toBe('')
    expect(getElementById).toHaveBeenCalledWith('ss-shot-unit-2-1-aperture')
    expect(focus).toHaveBeenCalled()
    const focusCount = focus.mock.calls.length
    ;(issue.props.onClick as () => void)()
    screen()
    expect(focus).toHaveBeenCalledTimes(focusCount + 1)
    expect(button(screen(), '保存分镜').props.disabled).toBe(true)
    field(screen(), 'unit-2 镜头 2 光圈').props.onChange({ target: { value: 'f/2.8' } })
    expect(button(screen(), '保存分镜').props.disabled).toBe(false)
  })

  it('剧本可切换专注视图，隐藏另一侧时保留未保存草稿', async () => {
    await open(project.id)
    step('剧本')
    field(screen(), 'ss-candidate-edit').props.onChange({ target: { value: '候选编辑草稿。' } })
    field(screen(), 'ss-version-edit').props.onChange({ target: { value: '正式稿编辑草稿。' } })
    button(screen(), '专注正式稿').props.onClick()
    const panes = elements(screen(), e => String(e.props.className).includes('ss-script-pane'))
    expect(panes[0].props.hidden).toBe(true)
    expect(panes[1].props.hidden).toBe(false)
    button(screen(), '并排对照').props.onClick()
    expect(field(screen(), 'ss-candidate-edit').props.value).toBe('候选编辑草稿。')
    expect(field(screen(), 'ss-version-edit').props.value).toBe('正式稿编辑草稿。')
    expect(content(screen())).toContain('有未保存修改')
  })

  it('模板在导出页选择，仅影响构建，变更后清空旧预览且不修改项目', async () => {
    project = withStoryboard(project)
    api.buildStudioPromptPackage = vi.fn().mockImplementation(async ({ promptMode }) => ({ ok: true, stale: false,
      packages: [buildPromptPackage(project.storyboard!.units[0], { ...project.settings, promptMode }, basis(project))] }))
    await open(project.id)
    step('提示词导出')
    field(screen(), 'ss-prompt-mode').props.onChange({ target: { value: 'A' } })
    button(screen(), '构建 / 刷新提示词包').props.onClick()
    await settled()
    expect(api.buildStudioPromptPackage).toHaveBeenCalledWith({ projectId: project.id, promptMode: 'A' })
    expect(content(screen())).toContain('模板 A')
    expect(field(screen(), 'ss-body-unit-1').props.value).toContain('景深与焦点锁：')
    field(screen(), 'ss-prompt-mode').props.onChange({ target: { value: 'B' } })
    expect(content(screen())).toContain('提示词正文将在这里预览')
    expect(button(screen(), '导出 Markdown').props.disabled).toBe(true)
    expect(api.saveScriptProject).not.toHaveBeenCalled()
    expect(api.generateStudioStoryboard).not.toHaveBeenCalled()
  })

  it('编辑分镜清空旧提示词并阻止以未保存分镜构建', async () => {
    project = withStoryboard(project)
    api.buildStudioPromptPackage = vi.fn().mockResolvedValue({ ok: true, stale: false,
      packages: [buildPromptPackage(project.storyboard!.units[0], project.settings, basis(project))] })
    await open(project.id)
    button(step('提示词导出'), '构建 / 刷新提示词包').props.onClick()
    await settled()
    expect(content(screen())).toContain('提示词正文')
    step('视频分镜')
    field(screen(), 'unit-1 镜头 1 主体动作与表情').props.onChange({ target: { value: '林远把账册翻到最后一页。' } })
    step('提示词导出')
    expect(content(screen())).toContain('分镜有未保存修改，请先保存分镜')
    const build = button(screen(), '构建 / 刷新提示词包')
    expect(build.props.disabled).toBe(true)
    build.props.onClick()
    await settled()
    expect(api.buildStudioPromptPackage).toHaveBeenCalledTimes(1)
    expect(button(screen(), '导出 Markdown').props.disabled).toBe(true)
  })


  it('只预览选中提示词，复制整包与导出仍包含全部分段', async () => {
    project = withStoryboard(project)
    const second = { ...structuredClone(project.storyboard!.units[0]), id: 'unit-2', index: 2, dramaticAction: '守门人关上书房门。' }
    project.storyboard!.units.push(second)
    const packages = project.storyboard!.units.map(unit => buildPromptPackage(unit, project.settings, basis(project)))
    api.buildStudioPromptPackage = vi.fn().mockResolvedValue({ ok: true, stale: false, packages })
    api.exportStudioMarkdown = vi.fn().mockResolvedValue({ ok: true, mode: 'file', path: 'export.md', text: '', fileName: 'export.md' })
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await open(project.id)
    button(step('提示词导出'), '构建 / 刷新提示词包').props.onClick()
    await settled()
    const directory = elements(screen(), e => e.props['aria-label'] === '提示词分段目录')[0]
    const secondButton = elements(directory, e => e.type === 'button')[1]
    ;(secondButton.props.onClick as () => void)()
    expect(field(screen(), 'ss-body-unit-2').props.value).toBe(packages[1].body)
    expect(elements(screen(), e => e.props.id === 'ss-body-unit-1')).toHaveLength(0)
    button(screen(), '仅复制本段正文').props.onClick()
    await settled()
    expect(writeText).toHaveBeenLastCalledWith(packages[1].body)
    button(screen(), '复制整包正文').props.onClick()
    await settled()
    expect(writeText).toHaveBeenLastCalledWith(packages.map(p => p.body).join('\n\n---\n\n'))
    button(screen(), '导出 Markdown').props.onClick()
    await settled()
    expect(api.exportStudioMarkdown).toHaveBeenCalledWith(expect.objectContaining({ packages }))
  })

})
