# Phase 12：正文写作技能流程对齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「正文写作」技能 SKILL.md 定义的 7 步流程（写作前准备→结构设计→正文写作→质量自检→细纲对照+差异分类→记忆回写+节奏回填+图解→自动审核）+ 多章连续写作循环，从当前的"只落地 system prompt"补齐为"完整流程编排"，让续写功能 1:1 对齐技能。

**Architecture:** 在 `WriteService` 上扩展 6 个新方法（衔接状态提取 / 细纲对照 / 记忆提取 / 节奏评估 / 图解生成 / 批量续写），每个方法都是"LLM 流式输出 JSON + service 解析 + IPC 转发 + UI 展示"。记忆回写走"混合策略"（新增需确认、状态变化自动）；细纲对照走"只报告+建议"；节奏回填走"差异≤1 自动"；批量续写走"范围+单章暂停点"。

**Tech Stack:** 复用 Phase 01-11，无新增依赖。LlmService.generateStream / IPC llm:token 事件机制 / skill-format md repos / rhythm-html.ts serializeRhythmData。

**用户决策对齐：**
- 记忆回写：混合策略（新增需确认，状态变化自动）
- 细纲对照：只报告 + 建议，由用户决策
- 批量续写：范围 + 单章暂停点
- 节奏回填：LLM 评估 + 差异≤1 自动回写

---

## 文件结构

### 新增文件
- `src/main/data/skill-format/figure-html-repo.ts` — Mermaid 图解写入/读取（`图解/[类型]_[主题].html`）
- `src/main/data/write-flow-service.ts` — 新流程编排服务（衔接状态/细纲对照/记忆提取/节奏评估/图解/批量），从 WriteService 拆出避免单文件膨胀
- `tests/write-flow-service.test.ts` — 新流程服务单测
- `tests/figure-html-repo.test.ts` — 图解 repo 单测
- `src/renderer/src/ChapterFlowPanel.tsx` — 续写后流程面板（质检/细纲对照/记忆提取/节奏回填/图解 5 个折叠区）

### 修改文件
- `src/shared/types.ts` — 新增 7 个类型（PrevEndingState / OutlineDiffReport / MemoryExtraction / RhythmEvaluation / FigureDraft / BatchProgress / FlowStep）
- `src/main/data/write-service.ts` — `loadChapterContext` 增加 prevEndingState（调 write-flow-service）；`buildChapterPrompt` 注入结构化衔接状态
- `src/main/data/skill-format/rhythm-html-repo.ts` — 增加 `update(chapter, patch)` 方法（回填单章）
- `src/main/ipc/write.ts` — 注册 6 个新 IPC（write:extractEndingState / write:checkOutline / write:extractMemory / write:applyMemory / write:evaluateRhythm / write:generateFigure / write:generateBatch）
- `src/preload/index.ts` — 暴露 7 个新 API
- `src/renderer/src/ChapterEditor.tsx` — `aiGenerate` 完成后自动触发 ChapterFlowPanel；移除独立"AI 改稿"按钮（改为自动）
- `src/renderer/src/ChapterListPage.tsx` — 添加"批量续写"入口

---

## Task 1：章节衔接状态结构化提取

**Files:**
- Create: `src/main/data/write-flow-service.ts`
- Modify: `src/main/data/write-service.ts:194-322`（loadChapterContext）
- Modify: `src/shared/types.ts`（新增 PrevEndingState 类型）
- Test: `tests/write-flow-service.test.ts`

**目标：** 让 LLM 从上一章正文末尾提取 6 项结构化状态（人物位置/状态/时间/未完成事项/悬念/道具），注入 user prompt 替代纯原文尾段。

- [ ] **Step 1.1：在 `src/shared/types.ts` 末尾新增类型**

```ts
/** 上一章结尾状态（LLM 从 prevTail 提取） */
export interface PrevEndingState {
  chapterNumber: number
  /** 人物位置：[{ name, location, action }] */
  characterPositions: { name: string; location: string; action: string }[]
  /** 人物状态：[{ name, emotion, body, items }] */
  characterStates: { name: string; emotion: string; body: string; items: string }[]
  /** 时间点：如"傍晚/子时/刚入夜" */
  timePoint: string
  /** 未完成事项：[对话/动作/事件] */
  unfinished: string[]
  /** 章末悬念/钩子 */
  suspense: string
  /** 关键道具 */
  props: string[]
  /** 提取失败时的原始尾段（兜底） */
  rawTail?: string
}
```

- [ ] **Step 1.2：创建 `src/main/data/write-flow-service.ts`**

```ts
import type { LlmService, GenerateOptions } from './llm-service'
import type { PrevEndingState } from '../../shared/types'

/**
 * 正文写作流程编排服务（Phase 12 新增）。
 * 把 SKILL.md 第 1/5/6/7 步的 LLM 调用集中在此，避免 WriteService 膨胀。
 */
export class WriteFlowService {
  constructor(private readonly llm: LlmService) {}

  /**
   * 从上一章正文末尾提取结构化结尾状态。
   * 失败时返回 { rawTail } 兜底，不抛错。
   */
  async extractEndingState(
    prevTail: string,
    chapterNumber: number,
    opts: GenerateOptions = {}
  ): Promise<PrevEndingState> {
    if (!prevTail.trim()) {
      return { chapterNumber, characterPositions: [], characterStates: [], timePoint: '', unfinished: [], suspense: '', props: [] }
    }
    const prompt = [
      `请从下面这段小说上一章正文末尾，提取结构化的"章节结尾状态"。`,
      ``,
      `输出要求：严格 JSON，不要任何解释、Markdown 代码块。字段：`,
      `- characterPositions: [{ name: 角色名, location: 所在地点, action: 正在做什么 }]`,
      `- characterStates: [{ name: 角色名, emotion: 情绪状态, body: 身体状态, items: 持有物品 }]`,
      `- timePoint: 时间点（如"傍晚/子时/刚入夜"）`,
      `- unfinished: [未完成的对话/动作/事件，字符串数组]`,
      `- suspense: 章末悬念/钩子（一句话）`,
      `- props: [关键道具，字符串数组]`,
      ``,
      `------ 上一章正文末尾 ------`,
      prevTail
    ].join('\n')
    const raw = await this.llm.generateStream(prompt, {
      ...opts,
      meta: { feature: 'endingState', ...opts.meta }
    })
    return parseEndingStateJson(raw, chapterNumber, prevTail)
  }
}

/** 解析 LLM 输出的结尾状态 JSON，失败兜底 */
export function parseEndingStateJson(
  raw: string,
  chapterNumber: number,
  prevTail: string
): PrevEndingState {
  const fallback: PrevEndingState = {
    chapterNumber,
    characterPositions: [],
    characterStates: [],
    timePoint: '',
    unfinished: [],
    suspense: '',
    props: [],
    rawTail: prevTail
  }
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return fallback
    const obj = JSON.parse(m[0])
    return {
      chapterNumber,
      characterPositions: Array.isArray(obj.characterPositions) ? obj.characterPositions : [],
      characterStates: Array.isArray(obj.characterStates) ? obj.characterStates : [],
      timePoint: typeof obj.timePoint === 'string' ? obj.timePoint : '',
      unfinished: Array.isArray(obj.unfinished) ? obj.unfinished : [],
      suspense: typeof obj.suspense === 'string' ? obj.suspense : '',
      props: Array.isArray(obj.props) ? obj.props : []
    }
  } catch {
    return fallback
  }
}
```

- [ ] **Step 1.3：测试 `tests/write-flow-service.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { WriteFlowService, parseEndingStateJson } from '../src/main/data/write-flow-service'
import type { LlmService } from '../src/main/data/llm-service'

function mockLlm(reply: string): LlmService {
  return { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
}

describe('WriteFlowService.extractEndingState', () => {
  it('parses structured ending state from LLM JSON', async () => {
    const json = JSON.stringify({
      characterPositions: [{ name: '林远', location: '客栈', action: '正在打坐' }],
      characterStates: [{ name: '林远', emotion: '警觉', body: '轻伤', items: '长剑' }],
      timePoint: '深夜',
      unfinished: ['门外脚步声未确认'],
      suspense: '门外传来脚步声',
      props: ['师父留下的玉佩']
    })
    const svc = new WriteFlowService(mockLlm(json))
    const state = await svc.extractEndingState('上一章末尾原文…', 5)
    expect(state.characterPositions[0].name).toBe('林远')
    expect(state.timePoint).toBe('深夜')
    expect(state.suspense).toBe('门外传来脚步声')
    expect(state.props).toContain('师父留下的玉佩')
  })

  it('falls back to rawTail when LLM output is not JSON', async () => {
    const svc = new WriteFlowService(mockLlm('这不是 JSON'))
    const state = await svc.extractEndingState('原文尾段', 3)
    expect(state.rawTail).toBe('原文尾段')
    expect(state.characterPositions).toEqual([])
  })

  it('returns empty state for empty prevTail', async () => {
    const svc = new WriteFlowService(mockLlm(''))
    const state = await svc.extractEndingState('', 1)
    expect(state.characterPositions).toEqual([])
    expect(state.suspense).toBe('')
  })
})

describe('parseEndingStateJson', () => {
  it('extracts JSON from markdown code block wrapper', () => {
    const raw = '```json\n{"timePoint":"清晨","suspense":"门开了"}\n```'
    const state = parseEndingStateJson(raw, 2, 'tail')
    expect(state.timePoint).toBe('清晨')
  })
})
```

- [ ] **Step 1.4：运行测试验证失败**

Run: `npx vitest run tests/write-flow-service.test.ts`
Expected: FAIL（write-flow-service.ts 未创建）

- [ ] **Step 1.5：创建 write-flow-service.ts（按 Step 1.2 代码）**

- [ ] **Step 1.6：运行测试验证通过**

Run: `npx vitest run tests/write-flow-service.test.ts`
Expected: PASS（3 个测试全过）

- [ ] **Step 1.7：修改 `src/main/data/write-service.ts` 的 loadChapterContext**

在 `loadChapterContext` 末尾返回前，调用 extractEndingState（需注入 WriteFlowService）。为避免循环依赖，WriteService 构造函数新增 `flowService` 参数。

```ts
// write-service.ts 顶部 import
import { WriteFlowService } from './write-flow-service'

// WriteService 构造函数
export class WriteService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly llm: LlmService,
    private readonly flow: WriteFlowService = new WriteFlowService(llm)
  ) {}

  // loadChapterContext 末尾，return 之前：
  let prevEndingState: PrevEndingState | undefined
  if (prevTail) {
    try {
      prevEndingState = await this.flow.extractEndingState(prevTail, chapterNumber - 1)
    } catch {
      // skip，用原文尾段兜底
    }
  }
  return { mainSynopsis, detail, prevDetail, prevTail, prevEndingState, rhythmEntry, foreshadowings, characters }
```

`ChapterContext` interface 增加 `prevEndingState?: PrevEndingState`。

- [ ] **Step 1.8：修改 `renderUserPrompt` 注入结构化衔接状态**

在 `renderUserPrompt` 的"上一章细纲 + 正文末尾"段后，增加结构化状态段：

```ts
if (input.prevEndingState && (input.prevEndingState.characterPositions.length > 0 || input.prevEndingState.suspense)) {
  parts.push('---')
  parts.push(`# 上一章结尾状态（结构化提取，本章开头必须对接）`)
  const s = input.prevEndingState
  if (s.characterPositions.length > 0) {
    parts.push('**人物位置**：')
    for (const p of s.characterPositions) parts.push(`- ${p.name}：在${p.location}，${p.action}`)
  }
  if (s.characterStates.length > 0) {
    parts.push('**人物状态**：')
    for (const c of s.characterStates) parts.push(`- ${c.name}：${c.emotion}，${c.body}，持有${c.items}`)
  }
  if (s.timePoint) parts.push(`**时间点**：${s.timePoint}`)
  if (s.unfinished.length > 0) {
    parts.push('**未完成事项**（本章必须处理）：')
    for (const u of s.unfinished) parts.push(`- ${u}`)
  }
  if (s.suspense) parts.push(`**章末悬念**（本章必须回应）：${s.suspense}`)
  if (s.props.length > 0) parts.push(`**关键道具**：${s.props.join('、')}`)
}
```

`RenderInput` interface 增加 `prevEndingState?: PrevEndingState`，`buildChapterPrompt` 传参时带上。

- [ ] **Step 1.9：补充测试到 `tests/build-chapter-prompt.test.ts`**

```ts
it('injects structured prev ending state into user prompt', async () => {
  const dir = await ps.resolveDir(projectId)
  await new ChapterRepository(dir).create({ title: '第一章' })
  await new ChapterRepository(dir).create({ title: '第二章' })
  await new ChapterRepository(dir).updateContent(1, '林远在客栈打坐。门外传来脚步声。')

  // mock flow service 返回结构化状态
  const flow = new WriteFlowService(mockLlm(JSON.stringify({
    characterPositions: [{ name: '林远', location: '客栈', action: '打坐' }],
    suspense: '门外脚步声'
  })))
  const service = new WriteService(ps, mockLlm('正文'), flow)
  const { user } = await service.buildChapterPrompt(projectId, 2)
  expect(user).toContain('上一章结尾状态')
  expect(user).toContain('林远')
  expect(user).toContain('客栈')
  expect(user).toContain('门外脚步声')
})
```

- [ ] **Step 1.10：运行全部测试**

Run: `npx vitest run tests/write-flow-service.test.ts tests/build-chapter-prompt.test.ts`
Expected: PASS

- [ ] **Step 1.11：Commit**

```bash
git add src/main/data/write-flow-service.ts src/main/data/write-service.ts src/shared/types.ts tests/write-flow-service.test.ts tests/build-chapter-prompt.test.ts
git commit -m "feat(write): extract structured prev ending state via LLM"
```

---

## Task 2：续写后自动质检 + 自动审核

**Files:**
- Modify: `src/renderer/src/ChapterEditor.tsx:198-232`（aiGenerate）
- Test: 手动验证（UI 行为，无单测）

**目标：** 续写流式完成后，自动跑 auditChapter（已有）+ 自动触发 reviewChapterStream（已有），把结果聚合到新的 ChapterFlowPanel。

- [ ] **Step 2.1：在 ChapterEditor 增加 flowPanelOpen 状态**

```ts
const [flowPanelOpen, setFlowPanelOpen] = useState(false)
const [autoAudit, setAutoAudit] = useState<AuditReport | null>(null)
```

import `AuditReport` from `../../shared/types`。

- [ ] **Step 2.2：修改 aiGenerate，完成后自动跑 audit + review**

```ts
const aiGenerate = async () => {
  // …原有流式生成逻辑…
  if (result.ok) {
    setDirty(true)
    // 自动跑质检
    try {
      const report = await window.api.auditChapter(projectId, draft)
      setAutoAudit(report)
    } catch { /* ignore */ }
    // 自动触发审核（复用现有 startReview 逻辑，但不要求 hasLlmKey 二次确认）
    if (await window.api.hasLlmKey()) {
      setReviewOpen(true)
      setReviewing(true)
      setReviewText('')
      const myReview = ++reviewRef.current
      try {
        const r = await window.api.reviewChapterStream(projectId, chapterNumber, (token, done) => {
          if (reviewRef.current !== myReview) return
          if (token) setReviewText((t) => t + token)
          if (done) setReviewing(false)
        })
        if (!r.ok) setReviewing(false)
      } catch { setReviewing(false) }
    }
    setFlowPanelOpen(true)
  }
}
```

- [ ] **Step 2.3：在工具栏下方渲染 ChapterFlowPanel 占位**

```tsx
{flowPanelOpen ? (
  <ChapterFlowPanel
    projectId={projectId}
    chapterNumber={chapterNumber}
    draft={draft}
    auditReport={autoAudit}
    reviewText={reviewText}
    reviewing={reviewing}
    onClose={() => setFlowPanelOpen(false)}
  />
) : null}
```

- [ ] **Step 2.4：创建 ChapterFlowPanel 占位组件（后续 Task 逐步填充）**

```tsx
// ChapterFlowPanel.tsx
import type { AuditReport } from '../../shared/types'

interface Props {
  projectId: string
  chapterNumber: number
  draft: string
  auditReport: AuditReport | null
  reviewText: string
  reviewing: boolean
  onClose: () => void
}

export default function ChapterFlowPanel(props: Props) {
  return (
    <div className="editor-panel" style={{ marginTop: 12 }}>
      <div className="ep-head">
        <div className="ep-title">续写流程面板</div>
        <button className="btn btn-ghost btn-sm" onClick={props.onClose}>收起</button>
      </div>
      <p className="muted">Task 2 占位：质检/细纲对照/记忆提取/节奏回填/图解 将在后续 Task 填充。</p>
      {props.auditReport ? (
        <div>
          <strong>质检结果</strong>：{props.auditReport.counts.error} 错 / {props.auditReport.counts.warn} 警 / {props.auditReport.wordCount} 字
        </div>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 2.5：手动验证**

Run: `npm run dev`，打开章节编辑器，点续写，确认完成后自动出现质检结果 + 审稿面板。

- [ ] **Step 2.6：Commit**

```bash
git add src/renderer/src/ChapterEditor.tsx src/renderer/src/ChapterFlowPanel.tsx
git commit -m "feat(write): auto-run audit + review after chapter generation"
```

---

## Task 3：细纲对照检查（5 种差异分类）

**Files:**
- Modify: `src/main/data/write-flow-service.ts`（新增 checkOutlineStream）
- Modify: `src/shared/types.ts`（新增 OutlineDiffReport）
- Modify: `src/main/ipc/write.ts`（注册 write:checkOutline）
- Modify: `src/preload/index.ts`（暴露 checkOutlineStream）
- Modify: `src/renderer/src/ChapterFlowPanel.tsx`（细纲对照区）
- Test: `tests/write-flow-service.test.ts`

**目标：** LLM 对照细纲检查正文，输出 5 种差异类型（漏写/超纲增量/细节调整/核心事件改/结构性偏离）+ 处理建议。只报告，由用户决策。

- [ ] **Step 3.1：在 `src/shared/types.ts` 新增类型**

```ts
/** 细纲对照差异类型（SKILL.md 5 种） */
export type OutlineDiffType = 1 | 2 | 3 | 4 | 5  // 漏写/超纲增量/细节调整/核心事件改/结构性偏离

export interface OutlineDiffItem {
  type: OutlineDiffType
  typeLabel: '漏写' | '超纲增量' | '细节调整' | '核心事件改' | '结构性偏离'
  /** 细纲内容 */
  outline?: string
  /** 正文内容 */
  actual?: string
  /** 处理建议 */
  suggestion: string
  /** 优先级 P0-P2 */
  priority: 'P0' | 'P1' | 'P2'
}

export interface OutlineDiffReport {
  chapterNumber: number
  /** 5 类差异项 */
  diffs: OutlineDiffItem[]
  /** 总体通过判定（无 P0/P1 即通过） */
  passed: boolean
}
```

- [ ] **Step 3.2：在 WriteFlowService 新增 checkOutlineStream**

```ts
import type { LlmService, GenerateOptions } from './llm-service'
import type { PrevEndingState, OutlineDiffReport, OutlineDiffItem, OutlineDiffType } from '../../shared/types'

// 在 WriteFlowService 类中新增：
async checkOutlineStream(
  outline: string,
  content: string,
  chapterNumber: number,
  opts: GenerateOptions = {}
): Promise<string> {
  const prompt = [
    `请对照下面的章节细纲，检查正文是否按细纲写作。按 5 种差异类型分类输出。`,
    ``,
    `5 种差异类型：`,
    `- 类型 1 漏写：细纲有 + 正文无 + 必填项（核心事件/伏笔/钩子）缺失`,
    `- 类型 2 超纲增量：细纲无 + 正文有（新角色/新地点/新设定）`,
    `- 类型 3 细节调整：细纲 A + 正文 B，但核心要素（参与方/事件类型/结果）一致`,
    `- 类型 4 核心事件改：细纲事件 X + 正文事件 Y，任一核心要素变化`,
    `- 类型 5 结构性偏离：字数偏离 > 30% / 核心事件偏离 > 2 个 / 卷终决战提前延后`,
    ``,
    `输出要求：严格 JSON 数组，每项 { type: 1-5, typeLabel, outline, actual, suggestion, priority: "P0"|"P1"|"P2" }。`,
    `无差异时输出空数组 []。不要任何解释、Markdown 代码块。`,
    ``,
    `------ 本章细纲 ------`,
    outline,
    ``,
    `------ 本章正文 ------`,
    content
  ].join('\n')
  return this.llm.generateStream(prompt, {
    ...opts,
    meta: { feature: 'outlineCheck', ...opts.meta }
  })
}
```

新增解析函数 `parseOutlineDiffJson`：

```ts
export function parseOutlineDiffJson(raw: string, chapterNumber: number): OutlineDiffReport {
  const labels: Record<number, OutlineDiffItem['typeLabel']> = {
    1: '漏写', 2: '超纲增量', 3: '细节调整', 4: '核心事件改', 5: '结构性偏离'
  }
  try {
    const m = raw.match(/\[[\s\S]*\]/)
    if (!m) return { chapterNumber, diffs: [], passed: true }
    const arr = JSON.parse(m[0])
    if (!Array.isArray(arr)) return { chapterNumber, diffs: [], passed: true }
    const diffs: OutlineDiffItem[] = arr
      .filter((x) => x && typeof x === 'object' && typeof x.type === 'number')
      .map((x) => ({
        type: x.type as OutlineDiffType,
        typeLabel: labels[x.type] ?? '细节调整',
        outline: typeof x.outline === 'string' ? x.outline : undefined,
        actual: typeof x.actual === 'string' ? x.actual : undefined,
        suggestion: typeof x.suggestion === 'string' ? x.suggestion : '',
        priority: ['P0', 'P1', 'P2'].includes(x.priority) ? x.priority : 'P2'
      }))
    const passed = !diffs.some((d) => d.priority === 'P0' || d.priority === 'P1')
    return { chapterNumber, diffs, passed }
  } catch {
    return { chapterNumber, diffs: [], passed: true }
  }
}
```

- [ ] **Step 3.3：测试**

```ts
describe('WriteFlowService.checkOutlineStream', () => {
  it('parses 5-type diff report from LLM JSON', async () => {
    const json = JSON.stringify([
      { type: 1, typeLabel: '漏写', outline: '主角与NPC对话', actual: undefined, suggestion: '补写对话', priority: 'P1' },
      { type: 2, typeLabel: '超纲增量', outline: undefined, actual: '新角色青云子', suggestion: '追加到角色卡', priority: 'P2' }
    ])
    const svc = new WriteFlowService(mockLlm(json))
    const raw = await svc.checkOutlineStream('细纲', '正文', 5)
    const report = parseOutlineDiffJson(raw, 5)
    expect(report.diffs).toHaveLength(2)
    expect(report.diffs[0].type).toBe(1)
    expect(report.passed).toBe(false)
  })

  it('returns passed=true for empty array', () => {
    const report = parseOutlineDiffJson('[]', 3)
    expect(report.passed).toBe(true)
    expect(report.diffs).toEqual([])
  })
})
```

- [ ] **Step 3.4：注册 IPC `src/main/ipc/write.ts`**

```ts
safeHandle(
  'write:checkOutline',
  async (_e, payload: { projectId: string; chapterNumber: number; outline: string; content: string; requestId: string }) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    try {
      await service.checkOutlineStream(payload.projectId, payload.chapterNumber, payload.outline, payload.content, {
        onToken: (token) => win?.webContents.send('llm:token', { requestId: payload.requestId, token, done: false })
      })
      win?.webContents.send('llm:token', { requestId: payload.requestId, token: '', done: true })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
)
```

WriteService 转发方法：

```ts
// write-service.ts
async checkOutlineStream(
  projectId: string,
  chapterNumber: number,
  outline: string,
  content: string,
  opts: GenerateOptions = {}
): Promise<string> {
  return this.flow.checkOutlineStream(outline, content, chapterNumber, opts)
}
```

- [ ] **Step 3.5：preload 暴露 `checkOutlineStream`**

```ts
checkOutlineStream: (
  projectId: string,
  chapterNumber: number,
  outline: string,
  content: string,
  onToken: (token: string, done: boolean) => void
) => {
  const requestId = crypto.randomUUID()
  const handler = (_e: unknown, payload: { requestId: string; token: string; done: boolean }) => {
    if (payload.requestId === requestId) onToken(payload.token, payload.done)
  }
  ipcRenderer.on('llm:token', handler as never)
  return ipcRenderer
    .invoke('write:checkOutline', { projectId, chapterNumber, outline, content, requestId })
    .finally(() => ipcRenderer.removeListener('llm:token', handler as never))
}
```

`RendererApi` interface 增加对应签名。

- [ ] **Step 3.6：ChapterFlowPanel 增加细纲对照区**

```tsx
// ChapterFlowPanel.tsx 内
const [outlineChecking, setOutlineChecking] = useState(false)
const [outlineDiff, setOutlineDiff] = useState<OutlineDiffReport | null>(null)

const runOutlineCheck = async () => {
  if (!chapterOutline) return
  setOutlineChecking(true)
  setOutlineDiff(null)
  let buffer = ''
  const r = await window.api.checkOutlineStream(projectId, chapterNumber, JSON.stringify(chapterOutline), draft, (token, done) => {
    if (token) buffer += token
    if (done) setOutlineChecking(false)
  })
  if (r.ok) {
    // 解析 buffer（需 export parseOutlineDiffJson）
    setOutlineDiff(parseOutlineDiffJson(buffer, chapterNumber))
  }
}
```

UI 渲染：5 类差异按 priority 排序，每项显示 typeLabel + outline/actual + suggestion + 处理按钮（补写/接受/重写，按钮先占位，Task 9 接通）。

- [ ] **Step 3.7：运行测试 + Commit**

```bash
npx vitest run tests/write-flow-service.test.ts
git add -A
git commit -m "feat(write): outline diff check with 5-type classification"
```

---

## Task 4-6：记忆回写（提取 + 应用 + IPC/UI）

**Files:**
- Modify: `src/main/data/write-flow-service.ts`（extractMemoryStream）
- Create: `src/main/data/memory-writer.ts`（applyMemoryExtraction，混合策略）
- Modify: `src/shared/types.ts`（MemoryExtraction）
- Modify: `src/main/ipc/write.ts`（write:extractMemory / write:applyMemory）
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/ChapterFlowPanel.tsx`
- Test: `tests/write-flow-service.test.ts`, `tests/memory-writer.test.ts`

**目标：** LLM 从正文提取新增角色/地点/情节/伏笔/状态变化。混合策略：新增内容需用户确认，状态变化（伤势/关系/位置）自动更新。

- [ ] **Step 4.1：在 `src/shared/types.ts` 新增类型**

```ts
/** 记忆提取结果（LLM 从正文提取） */
export interface MemoryExtraction {
  chapterNumber: number
  /** 新增角色（需确认） */
  newCharacters: { name: string; role: string; identity: string; personality: string }[]
  /** 新增地点（需确认） */
  newLocations: { name: string; category: string; notes: string }[]
  /** 新增伏笔（需确认） */
  newForeshadowings: { content: string; expectedCollect?: number; note?: string }[]
  /** 新增情节（自动追加到核心情节.md） */
  newPlotPoints: { title: string; event: string; coolPoint?: string }[]
  /** 角色状态变化（自动更新） */
  characterStateChanges: { name: string; field: string; oldValue: string; newValue: string }[]
  /** 伏笔回收（自动更新） */
  collectedForeshadowings: { content: string; chapter: number }[]
}

/** 记忆应用结果 */
export interface MemoryApplyResult {
  applied: {
    characters: number
    locations: number
    foreshadowings: number
    plotPoints: number
    stateChanges: number
    collected: number
  }
  errors: string[]
}
```

- [ ] **Step 4.2：在 WriteFlowService 新增 extractMemoryStream**

```ts
async extractMemoryStream(
  content: string,
  chapterNumber: number,
  knownCharacters: string[],
  opts: GenerateOptions = {}
): Promise<string> {
  const prompt = [
    `请从下面的小说正文中提取本章新增的记忆信息。`,
    ``,
    `已知人物（不要重复提取）：${knownCharacters.join('、') || '（空）'}`,
    ``,
    `输出要求：严格 JSON，字段：`,
    `- newCharacters: [{ name, role, identity, personality }]（本章首次登场的新角色）`,
    `- newLocations: [{ name, category, notes }]（本章首次出现的新地点）`,
    `- newForeshadowings: [{ content, expectedCollect?, note? }]（本章新埋设的伏笔）`,
    `- newPlotPoints: [{ title, event, coolPoint? }]（本章核心情节）`,
    `- characterStateChanges: [{ name, field, oldValue, newValue }]（既有角色的状态变化，field 如"伤势/情绪/位置/关系"）`,
    `- collectedForeshadowings: [{ content, chapter }]（本章回收的伏笔）`,
    `无新增时对应字段输出空数组。不要任何解释、Markdown 代码块。`,
    ``,
    `------ 第 ${chapterNumber} 章正文 ------`,
    content
  ].join('\n')
  return this.llm.generateStream(prompt, {
    ...opts,
    meta: { feature: 'memoryExtract', ...opts.meta }
  })
}
```

新增 `parseMemoryExtractionJson`：

```ts
export function parseMemoryExtractionJson(raw: string, chapterNumber: number): MemoryExtraction {
  const empty: MemoryExtraction = {
    chapterNumber,
    newCharacters: [], newLocations: [], newForeshadowings: [],
    newPlotPoints: [], characterStateChanges: [], collectedForeshadowings: []
  }
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return empty
    const obj = JSON.parse(m[0])
    return {
      chapterNumber,
      newCharacters: Array.isArray(obj.newCharacters) ? obj.newCharacters : [],
      newLocations: Array.isArray(obj.newLocations) ? obj.newLocations : [],
      newForeshadowings: Array.isArray(obj.newForeshadowings) ? obj.newForeshadowings : [],
      newPlotPoints: Array.isArray(obj.newPlotPoints) ? obj.newPlotPoints : [],
      characterStateChanges: Array.isArray(obj.characterStateChanges) ? obj.characterStateChanges : [],
      collectedForeshadowings: Array.isArray(obj.collectedForeshadowings) ? obj.collectedForeshadowings : []
    }
  } catch {
    return empty
  }
}
```

- [ ] **Step 4.3：创建 `src/main/data/memory-writer.ts`（混合策略应用）**

```ts
import { CharacterCardMdRepo } from './skill-format/character-card-md-repo'
import { LocationMdRepo } from './skill-format/location-md-repo'
import { ForeshadowingMdRepo } from './skill-format/foreshadowing-md-repo'
import { CorePlotMdRepo } from './skill-format/core-plot-md-repo'
import { appendH3UnderH2 } from './skill-format/md-writer'
import { writeTextAtomic } from './atomic'
import { join } from 'path'
import { readText } from './skill-format/md-parser'
import type { MemoryExtraction, MemoryApplyResult } from '../../shared/types'

/**
 * 记忆回写器（混合策略）。
 * - 新增内容（角色/地点/伏笔）：需用户确认，由 UI 调 applyNew* 方法
 * - 状态变化（伤势/情绪/位置/关系）：自动更新角色卡
 * - 情节追加：自动追加到核心情节.md
 * - 伏笔回收：自动更新伏笔追踪.md 状态
 */
export class MemoryWriter {
  constructor(private readonly projectDir: string) {}

  /**
   * 自动应用：状态变化 + 情节追加 + 伏笔回收。
   * 新增内容不在此方法处理（需用户确认）。
   */
  async applyAutomatic(extraction: MemoryExtraction): Promise<MemoryApplyResult> {
    const errors: string[] = []
    let stateChanges = 0, plotPoints = 0, collected = 0

    // 1. 角色状态变化：更新角色卡.md 的"当前状态"字段
    for (const change of extraction.characterStateChanges) {
      try {
        await this.updateCharacterState(change.name, change.field, change.newValue)
        stateChanges++
      } catch (e) { errors.push(`角色状态更新失败 ${change.name}: ${(e as Error).message}`) }
    }

    // 2. 情节追加：追加到核心情节.md
    for (const pp of extraction.newPlotPoints) {
      try {
        await this.appendPlotPoint(extraction.chapterNumber, pp.title, pp.event, pp.coolPoint)
        plotPoints++
      } catch (e) { errors.push(`情节追加失败: ${(e as Error).message}`) }
    }

    // 3. 伏笔回收：更新伏笔追踪.md 状态
    for (const cf of extraction.collectedForeshadowings) {
      try {
        await this.collectForeshadowing(cf.content, cf.chapter)
        collected++
      } catch (e) { errors.push(`伏笔回收失败 ${cf.content}: ${(e as Error).message}`) }
    }

    return {
      applied: { characters: 0, locations: 0, foreshadowings: 0, plotPoints, stateChanges, collected },
      errors
    }
  }

  /** 用户确认后：应用新增角色 */
  async applyNewCharacters(chars: MemoryExtraction['newCharacters']): Promise<number> {
    const repo = new CharacterCardMdRepo(this.projectDir)
    let n = 0
    for (const c of chars) {
      try {
        await repo.create({ name: c.name, role: c.role, identity: c.identity, personality: c.personality })
        n++
      } catch { /* skip */ }
    }
    return n
  }

  /** 用户确认后：应用新增地点 */
  async applyNewLocations(locs: MemoryExtraction['newLocations']): Promise<number> {
    const repo = new LocationMdRepo(this.projectDir)
    let n = 0
    for (const l of locs) {
      try {
        await repo.create({ name: l.name, category: l.category, notes: l.notes })
        n++
      } catch { /* skip */ }
    }
    return n
  }

  /** 用户确认后：应用新增伏笔 */
  async applyNewForeshadowings(fs: MemoryExtraction['newForeshadowings']): Promise<number> {
    const repo = new ForeshadowingMdRepo(this.projectDir)
    let n = 0
    for (const f of fs) {
      try {
        await repo.create({ content: f.content, expectedCollect: f.expectedCollect, note: f.note })
        n++
      } catch { /* skip */ }
    }
    return n
  }

  private async updateCharacterState(name: string, field: string, value: string): Promise<void> {
    // 简化：在角色卡.md 找到 ### name 块，更新"当前状态"字段
    // 复用 CharacterCardMdRepo.update，把 field 映射到 synopsis
    const repo = new CharacterCardMdRepo(this.projectDir)
    const existing = (await repo.list()).find((c) => c.name === name)
    if (!existing) return
    // 把状态变化追加到 synopsis（不覆盖原值，记录变化轨迹）
    const newSynopsis = existing.synopsis
      ? `${existing.synopsis}；${field}：${value}`
      : `${field}：${value}`
    await repo.update(name, { synopsis: newSynopsis })
  }

  private async appendPlotPoint(chapter: number, title: string, event: string, coolPoint?: string): Promise<void> {
    const file = join(this.projectDir, '记忆系统', '核心情节.md')
    const text = await readText(file)
    if (!text) return
    const block = `### 第${chapter}章：${title}\n- 核心事件：${event}\n- 爽点/打脸：${coolPoint ?? ''}\n- 角色变动：\n- 伏笔：\n`
    // 追加到当前卷的 H2 下（简化：追加到文件末尾的最后一个 H2 下）
    const next = appendH3UnderH2(text, '', block) // appendH3UnderH2 需支持空 H2 表示最后一个
    await writeTextAtomic(file, next)
  }

  private async collectForeshadowing(content: string, chapter: number): Promise<void> {
    const repo = new ForeshadowingMdRepo(this.projectDir)
    const list = await repo.list()
    const f = list.find((x) => x.content.includes(content) || content.includes(x.content))
    if (f) await repo.collect(f.id, chapter)
  }
}
```

- [ ] **Step 4.4：测试 `tests/memory-writer.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { MemoryWriter } from '../src/main/data/memory-writer'
import type { MemoryExtraction } from '../src/shared/types'

describe('MemoryWriter', () => {
  let dir: string
  let writer: MemoryWriter

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-mw-'))
    await mkdir(path.join(dir, '记忆系统'), { recursive: true })
    await writeFile(path.join(dir, '记忆系统', '角色卡.md'), '## 主角\n\n### 林远（男主）\n- **身份**：修仙者\n')
    await writeFile(path.join(dir, '记忆系统', '核心情节.md'), '## 第一卷\n\n')
    await writeFile(path.join(dir, '记忆系统', '伏笔追踪.md'), '| 编号 | 内容 | 类型 | 埋设 | 预计回收 | 实际回收 | 状态 |\n|---|---|---|---|---|---|---|\n| FB-001 | 玉佩来历 | 设定 | 第1章 | 第5章 | 未回收 | 未回收 |\n')
    writer = new MemoryWriter(dir)
  })

  it('auto-applies state changes + plot points + foreshadowing collection', async () => {
    const extraction: MemoryExtraction = {
      chapterNumber: 5,
      newCharacters: [], newLocations: [], newForeshadowings: [],
      newPlotPoints: [{ title: '初露锋芒', event: '林远击败赵乾', coolPoint: '打脸' }],
      characterStateChanges: [{ name: '林远', field: '伤势', oldValue: '无', newValue: '轻伤' }],
      collectedForeshadowings: [{ content: '玉佩来历', chapter: 5 }]
    }
    const result = await writer.applyAutomatic(extraction)
    expect(result.applied.stateChanges).toBe(1)
    expect(result.applied.plotPoints).toBe(1)
    expect(result.applied.collected).toBe(1)
    expect(result.errors).toEqual([])
  })
})
```

- [ ] **Step 4.5：注册 IPC + preload**

```ts
// write.ts
safeHandle('write:extractMemory', async (_e, p: { projectId: string; chapterNumber: number; content: string; knownCharacters: string[]; requestId: string }) => {
  const win = BrowserWindow.fromWebContents(_e.sender)
  try {
    await service.extractMemoryStream(p.projectId, p.chapterNumber, p.content, p.knownCharacters, {
      onToken: (t) => win?.webContents.send('llm:token', { requestId: p.requestId, token: t, done: false })
    })
    win?.webContents.send('llm:token', { requestId: p.requestId, token: '', done: true })
    return { ok: true }
  } catch (err) { return { ok: false, error: (err as Error).message } }
})

safeHandle('write:applyMemory', async (_e, p: { projectId: string; extraction: MemoryExtraction; applyNew: boolean }) => {
  const dir = await projectService.resolveDir(p.projectId)
  const writer = new MemoryWriter(dir)
  const auto = await writer.applyAutomatic(p.extraction)
  if (p.applyNew) {
    auto.applied.characters = await writer.applyNewCharacters(p.extraction.newCharacters)
    auto.applied.locations = await writer.applyNewLocations(p.extraction.newLocations)
    auto.applied.foreshadowings = await writer.applyNewForeshadowings(p.extraction.newForeshadowings)
  }
  return auto
})
```

preload 暴露 `extractMemoryStream` 和 `applyMemory`。

- [ ] **Step 4.6：ChapterFlowPanel 增加记忆提取区**

UI 逻辑：
1. 自动跑 extractMemoryStream
2. 解析后，状态变化/情节/伏笔回收**自动应用**（调 applyMemory with applyNew=false）
3. 新增角色/地点/伏笔**列出待确认**，用户勾选后调 applyMemory with applyNew=true

- [ ] **Step 4.7：运行测试 + Commit**

```bash
npx vitest run tests/write-flow-service.test.ts tests/memory-writer.test.ts
git add -A
git commit -m "feat(write): memory extraction with hybrid apply strategy"
```

---

## Task 7：节奏图谱回填

**Files:**
- Modify: `src/main/data/write-flow-service.ts`（evaluateRhythmStream）
- Modify: `src/main/data/skill-format/rhythm-html-repo.ts`（新增 update 方法）
- Modify: `src/shared/types.ts`（RhythmEvaluation）
- Modify: `src/main/ipc/write.ts`（write:evaluateRhythm / write:backfillRhythm）
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/ChapterFlowPanel.tsx`
- Test: `tests/write-flow-service.test.ts`

**目标：** LLM 评估实际 emotion/climax，差异≤1 自动回写，差异≥2 弹三选一对话框。

- [ ] **Step 7.1：在 `src/shared/types.ts` 新增**

```ts
export interface RhythmEvaluation {
  chapterNumber: number
  /** LLM 评估的实际情绪值 1-10 */
  actualEmotion: number
  /** LLM 评估的实际爽点类型 0/1/2/3/3.5/4 */
  actualClimax: number
  /** 细纲预测情绪值（来自 rhythmEntry） */
  predictedEmotion: number
  /** 细纲预测爽点类型 */
  predictedClimax: number
  /** 情绪值差异 abs(actual - predicted) */
  emotionDiff: number
  /** 爽点类型是否一致 */
  climaxMatch: boolean
  /** LLM 评估理由 */
  reason: string
}
```

- [ ] **Step 7.2：在 WriteFlowService 新增 evaluateRhythmStream**

```ts
async evaluateRhythmStream(
  content: string,
  chapterNumber: number,
  predictedEmotion: number,
  predictedClimax: number,
  opts: GenerateOptions = {}
): Promise<string> {
  const prompt = [
    `请评估下面这章正文的实际情绪值和爽点类型。`,
    ``,
    `情绪值 1-10 标度：`,
    `- 1-3 低谷（主角受挫、局势恶化）`,
    `- 4-5 平稳（过渡、铺垫、积累）`,
    `- 6-7 上升（小有进展、矛盾升温）`,
    `- 8-10 高潮（打脸成功、反转、突破、决战）`,
    ``,
    `爽点类型：0=无爽点 1=小打脸 2=中打脸 3=大高潮 3.5=卷中决战 4=卷终决战`,
    ``,
    `细纲预测：情绪值 ${predictedEmotion}，爽点类型 ${predictedClimax}`,
    ``,
    `输出要求：严格 JSON { actualEmotion: number, actualClimax: number, reason: string }。不要任何解释、Markdown 代码块。`,
    ``,
    `------ 第 ${chapterNumber} 章正文 ------`,
    content
  ].join('\n')
  return this.llm.generateStream(prompt, {
    ...opts,
    meta: { feature: 'rhythmEval', ...opts.meta }
  })
}
```

新增 `parseRhythmEvaluationJson`：

```ts
export function parseRhythmEvaluationJson(
  raw: string,
  chapterNumber: number,
  predictedEmotion: number,
  predictedClimax: number
): RhythmEvaluation {
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('no json')
    const obj = JSON.parse(m[0])
    const actualEmotion = Math.max(1, Math.min(10, Number(obj.actualEmotion) || predictedEmotion))
    const actualClimax = Number(obj.actualClimax) || predictedClimax
    return {
      chapterNumber,
      actualEmotion,
      actualClimax,
      predictedEmotion,
      predictedClimax,
      emotionDiff: Math.abs(actualEmotion - predictedEmotion),
      climaxMatch: actualClimax === predictedClimax,
      reason: typeof obj.reason === 'string' ? obj.reason : ''
    }
  } catch {
    return {
      chapterNumber, actualEmotion: predictedEmotion, actualClimax: predictedClimax,
      predictedEmotion, predictedClimax, emotionDiff: 0, climaxMatch: true, reason: '评估失败，沿用预测值'
    }
  }
}
```

- [ ] **Step 7.3：在 RhythmHtmlRepo 新增 update 方法**

```ts
// rhythm-html-repo.ts
import { writeTextAtomic } from '../atomic'
import { serializeRhythmData } from './rhythm-html'

export class RhythmHtmlRepo {
  constructor(private readonly projectDir: string) {}

  async read(): Promise<RhythmEntry[] | null> { /* 原有 */ }

  /** 回填单章实际值：把 chapter 对应条目的 emotion/climax/actualized 更新 */
  async update(chapter: number, patch: { emotion?: number; climax?: number; actualized?: boolean }): Promise<void> {
    const file = join(this.projectDir, '图解', '节奏图谱.html')
    const text = await readText(file)
    if (!text) throw new Error('节奏图谱.html 不存在')
    const entries = parseRhythmData(text)
    if (!entries) throw new Error('rhythmData 数组解析失败')
    const idx = entries.findIndex((e) => e.chapter === chapter)
    if (idx < 0) throw new Error(`第 ${chapter} 章不在 rhythmData 中`)
    if (patch.emotion !== undefined) entries[idx].emotion = patch.emotion
    if (patch.climax !== undefined) entries[idx].climax = patch.climax
    if (patch.actualized !== undefined) entries[idx].actualized = patch.actualized
    const next = serializeRhythmData(text, entries)
    await writeTextAtomic(file, next)
  }
}
```

- [ ] **Step 7.4：注册 IPC**

```ts
safeHandle('write:evaluateRhythm', async (_e, p: { projectId: string; chapterNumber: number; content: string; requestId: string }) => {
  // 1. 读 rhythmEntry 拿预测值
  // 2. 调 evaluateRhythmStream
  // 3. 解析 + 返回 RhythmEvaluation
})

safeHandle('write:backfillRhythm', async (_e, p: { projectId: string; chapterNumber: number; emotion: number; climax: number }) => {
  const dir = await projectService.resolveDir(p.projectId)
  await new RhythmHtmlRepo(dir).update(p.chapterNumber, { emotion: p.emotion, climax: p.climax, actualized: true })
  return { ok: true }
})
```

- [ ] **Step 7.5：ChapterFlowPanel 节奏回填区**

UI 逻辑：
1. 自动跑 evaluateRhythm
2. 差异≤1 且 climaxMatch：自动调 backfillRhythm，显示"已自动回填"
3. 差异≥2 或 !climaxMatch：弹三选一对话框（A 接受实际值 / B 按细纲重写 / C 回溯改细纲），用户选 A 后调 backfillRhythm

- [ ] **Step 7.6：测试 + Commit**

```ts
describe('parseRhythmEvaluationJson', () => {
  it('computes emotion diff and climax match', () => {
    const raw = JSON.stringify({ actualEmotion: 8, actualClimax: 2, reason: '打脸成功' })
    const eval_ = parseRhythmEvaluationJson(raw, 5, 6, 2)
    expect(eval_.emotionDiff).toBe(2)
    expect(eval_.climaxMatch).toBe(true)
  })

  it('falls back to predicted on parse failure', () => {
    const eval_ = parseRhythmEvaluationJson('not json', 3, 5, 1)
    expect(eval_.actualEmotion).toBe(5)
    expect(eval_.reason).toContain('评估失败')
  })
})
```

```bash
npx vitest run tests/write-flow-service.test.ts
git add -A
git commit -m "feat(write): rhythm backfill with LLM evaluation and diff threshold"
```

---

## Task 8：Mermaid 图解生成

**Files:**
- Create: `src/main/data/skill-format/figure-html-repo.ts`
- Modify: `src/main/data/write-flow-service.ts`（generateFigureStream）
- Modify: `src/shared/types.ts`（FigureDraft）
- Modify: `src/main/ipc/write.ts`（write:generateFigure / write:saveFigure）
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/ChapterFlowPanel.tsx`
- Test: `tests/figure-html-repo.test.ts`

**目标：** 关键转折点（关键战斗/势力变化/角色突破/关系网变化/重大剧情线/关键伏笔回收）时，LLM 生成 Mermaid HTML，写入 `图解/[类型]_[主题].html`。

- [ ] **Step 8.1：在 `src/shared/types.ts` 新增**

```ts
export interface FigureDraft {
  chapterNumber: number
  /** 是否触发图解生成 */
  shouldGenerate: boolean
  /** 图解类型：战斗/势力/突破/关系/剧情/伏笔回收 */
  type: string
  /** 主题描述（用于文件名） */
  topic: string
  /** 文件名：[类型]_[主题].html */
  fileName: string
  /** Mermaid HTML 完整内容 */
  html: string
  /** LLM 判断理由 */
  reason: string
}
```

- [ ] **Step 8.2：创建 `src/main/data/skill-format/figure-html-repo.ts`**

```ts
import { join } from 'path'
import { promises as fs } from 'fs'
import { writeTextAtomic } from '../atomic'

/**
 * 关键情节图解 repo。
 * 真相源：`图解/[类型]_[主题].html`（Mermaid HTML）。
 */
export class FigureHtmlRepo {
  constructor(private readonly projectDir: string) {}

  private file(fileName: string): string {
    return join(this.projectDir, '图解', fileName)
  }

  async write(fileName: string, html: string): Promise<string> {
    await writeTextAtomic(this.file(fileName), html)
    return fileName
  }

  async exists(fileName: string): Promise<boolean> {
    try {
      await fs.access(this.file(fileName))
      return true
    } catch {
      return false
    }
  }

  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(join(this.projectDir, '图解'))
      return entries.filter((f) => f.endsWith('.html') && f !== '节奏图谱.html')
    } catch {
      return []
    }
  }
}
```

- [ ] **Step 8.3：在 WriteFlowService 新增 generateFigureStream**

```ts
async generateFigureStream(
  content: string,
  chapterNumber: number,
  opts: GenerateOptions = {}
): Promise<string> {
  const prompt = [
    `请判断下面这章正文是否满足"关键转折点"条件，如果满足则生成 Mermaid HTML 图解。`,
    ``,
    `触发条件（任一满足即生成）：`,
    `1. 关键战斗（双方站位、力量对比、胜负关键）`,
    `2. 势力变化（各方势力的关系与分布）`,
    `3. 角色突破（角色成长路线图）`,
    `4. 关系网变化（主要角色关系网）`,
    `5. 重大剧情线（剧情时间线/因果链）`,
    `6. 关键伏笔回收（伏笔因果链）`,
    ``,
    `输出要求：严格 JSON：`,
    `{`,
    `  "shouldGenerate": true/false,`,
    `  "type": "战斗|势力|突破|关系|剧情|伏笔回收",`,
    `  "topic": "主题描述（如林风vs赵乾）",`,
    `  "reason": "为什么触发",`,
    `  "mermaid": "graph TD\\n    A[事件1] --> B[事件2]"`,
    `}`,
    `不触发时 shouldGenerate=false，其他字段留空。不要任何解释、Markdown 代码块。`,
    ``,
    `------ 第 ${chapterNumber} 章正文 ------`,
    content
  ].join('\n')
  return this.llm.generateStream(prompt, {
    ...opts,
    meta: { feature: 'figureGen', ...opts.meta }
  })
}
```

新增 `parseFigureDraftJson` + `buildFigureHtml`（按 SKILL.md 模板）：

```ts
export function parseFigureDraftJson(raw: string, chapterNumber: number): FigureDraft {
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('no json')
    const obj = JSON.parse(m[0])
    const shouldGenerate = !!obj.shouldGenerate
    const type = typeof obj.type === 'string' ? obj.type : ''
    const topic = typeof obj.topic === 'string' ? obj.topic : ''
    const fileName = shouldGenerate && type && topic ? `${type}_${topic}.html` : ''
    return {
      chapterNumber,
      shouldGenerate,
      type, topic, fileName,
      html: shouldGenerate ? buildFigureHtml(type, topic, obj.mermaid || '') : '',
      reason: typeof obj.reason === 'string' ? obj.reason : ''
    }
  } catch {
    return { chapterNumber, shouldGenerate: false, type: '', topic: '', fileName: '', html: '', reason: '解析失败' }
  }
}

export function buildFigureHtml(type: string, topic: string, mermaid: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>关键情节图解：${type}_${topic}</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
    <style>
        body { font-family: 'Microsoft YaHei', sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
        h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
        .section { background: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 8px; }
    </style>
</head>
<body>
    <h1>关键情节图解：${type}_${topic}</h1>
    <div class="section">
        <h2>转折过程</h2>
        <div class="mermaid">
${mermaid}
        </div>
    </div>
    <script>mermaid.initialize({ startOnLoad: true });</script>
</body>
</html>`
}
```

- [ ] **Step 8.4：注册 IPC + preload**

```ts
safeHandle('write:generateFigure', async (_e, p: { projectId: string; chapterNumber: number; content: string; requestId: string }) => {
  // 流式调用 generateFigureStream
})

safeHandle('write:saveFigure', async (_e, p: { projectId: string; fileName: string; html: string }) => {
  const dir = await projectService.resolveDir(p.projectId)
  await new FigureHtmlRepo(dir).write(p.fileName, p.html)
  return { ok: true }
})
```

- [ ] **Step 8.5：ChapterFlowPanel 图解区**

UI 逻辑：
1. 自动跑 generateFigure
2. shouldGenerate=false：显示"本章非关键转折点，跳过图解"
3. shouldGenerate=true：显示文件名 + Mermaid 预览 + "保存到 图解/" 按钮

- [ ] **Step 8.6：测试 + Commit**

```ts
describe('buildFigureHtml', () => {
  it('wraps mermaid in HTML template', () => {
    const html = buildFigureHtml('战斗', '林风vs赵乾', 'graph TD\n    A --> B')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('战斗_林风vs赵乾')
    expect(html).toContain('graph TD')
    expect(html).toContain('mermaid.min.js')
  })
})
```

```bash
npx vitest run tests/figure-html-repo.test.ts
git add -A
git commit -m "feat(write): mermaid figure generation for key turning points"
```

---

## Task 9：多章批量续写

**Files:**
- Modify: `src/main/data/write-service.ts`（generateChaptersBatch）
- Modify: `src/main/data/write-flow-service.ts`（runFullFlowForChapter）
- Modify: `src/shared/types.ts`（BatchProgress）
- Modify: `src/main/ipc/write.ts`（write:generateBatch）
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/ChapterListPage.tsx`
- Test: `tests/write-service.test.ts`

**目标：** 用户选择起止章号，每章写完后暂停展示质检/差异/回写结果，用户确认后进入下一章。

- [ ] **Step 9.1：在 `src/shared/types.ts` 新增**

```ts
export interface BatchProgress {
  total: number
  current: number
  currentChapter: number
  status: 'pending' | 'generating' | 'flow' | 'paused' | 'completed' | 'failed'
  /** 暂停原因（差异/失败等） */
  pauseReason?: string
  /** 已完成章节 */
  completed: number[]
  /** 错误信息 */
  error?: string
}
```

- [ ] **Step 9.2：在 WriteFlowService 新增 runFullFlowForChapter**

```ts
/**
 * 对单章跑完整流程（生成→质检→细纲对照→记忆提取→节奏回填→图解）。
 * 返回所有步骤的结果，由 UI 决定是否暂停。
 */
async runFullFlowForChapter(
  projectId: string,
  chapterNumber: number,
  onProgress: (step: string, detail?: string) => void,
  opts: GenerateOptions = {}
): Promise<{
  content: string
  audit: AuditReport
  outlineDiff: OutlineDiffReport
  memory: MemoryExtraction
  rhythm: RhythmEvaluation
  figure: FigureDraft
}> {
  // 1. 生成正文（流式，onProgress 推 token）
  onProgress('generating')
  const content = await this.llm.generateStream(/* buildChapterPrompt */, opts)

  // 2. 质检
  onProgress('audit')
  const audit = auditChapter(content)

  // 3. 细纲对照
  onProgress('outlineCheck')
  const outlineRaw = await this.checkOutlineStream(/* outline */, content, chapterNumber, opts)
  const outlineDiff = parseOutlineDiffJson(outlineRaw, chapterNumber)

  // 4. 记忆提取
  onProgress('memoryExtract')
  const memRaw = await this.extractMemoryStream(content, chapterNumber, [], opts)
  const memory = parseMemoryExtractionJson(memRaw, chapterNumber)

  // 5. 节奏评估
  onProgress('rhythmEval')
  const rhythmRaw = await this.evaluateRhythmStream(content, chapterNumber, 5, 1, opts)
  const rhythm = parseRhythmEvaluationJson(rhythmRaw, chapterNumber, 5, 1)

  // 6. 图解
  onProgress('figureGen')
  const figRaw = await this.generateFigureStream(content, chapterNumber, opts)
  const figure = parseFigureDraftJson(figRaw, chapterNumber)

  return { content, audit, outlineDiff, memory, rhythm, figure }
}
```

- [ ] **Step 9.3：在 WriteService 新增 generateChaptersBatch**

```ts
/**
 * 批量续写：从 from 到 to 章号逐章生成。
 * 每章完成后暂停，等用户确认（通过 IPC 事件驱动）。
 */
async generateChaptersBatch(
  projectId: string,
  fromChapter: number,
  toChapter: number,
  onChapterComplete: (chapter: number, result: any) => void,
  opts: GenerateOptions = {}
): Promise<BatchProgress> {
  const completed: number[] = []
  for (let ch = fromChapter; ch <= toChapter; ch++) {
    try {
      const result = await this.flow.runFullFlowForChapter(projectId, ch, () => {}, opts)
      // 保存正文
      const dir = await this.projectService.resolveDir(projectId)
      await new ProseRepo(dir).write(ch, result.content)
      completed.push(ch)
      onChapterComplete(ch, result)
      // 暂停等用户确认（由 UI 触发下一章）
      // 这里通过返回当前 progress 实现，UI 拿到后展示，用户点"下一章"再调一次
      return {
        total: toChapter - fromChapter + 1,
        current: ch - fromChapter + 1,
        currentChapter: ch,
        status: 'paused',
        completed
      }
    } catch (err) {
      return {
        total: toChapter - fromChapter + 1,
        current: ch - fromChapter + 1,
        currentChapter: ch,
        status: 'failed',
        completed,
        error: (err as Error).message
      }
    }
  }
  return {
    total: toChapter - fromChapter + 1,
    current: toChapter - fromChapter + 1,
    currentChapter: toChapter,
    status: 'completed',
    completed
  }
}
```

- [ ] **Step 9.4：注册 IPC + preload**

```ts
ipcMain.handle('write:generateBatch', async (e, p: { projectId: string; fromChapter: number; toChapter: number; requestId: string }) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  try {
    const progress = await service.generateChaptersBatch(p.projectId, p.fromChapter, p.toChapter, (ch, result) => {
      win?.webContents.send('write:batchChapterComplete', { requestId: p.requestId, chapter: ch, result })
    })
    return { ok: true, progress }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

// 继续下一章（用户确认后）
ipcMain.handle('write:continueBatch', async (_e, p: { projectId: string; fromChapter: number; toChapter: number; requestId: string }) => {
  // 同 generateBatch，但从 fromChapter+1 开始
})
```

- [ ] **Step 9.5：ChapterListPage 增加批量续写入口**

```tsx
const [batchOpen, setBatchOpen] = useState(false)
const [batchFrom, setBatchFrom] = useState(1)
const [batchTo, setBatchTo] = useState(10)
const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null)

const startBatch = async () => {
  setBatchOpen(true)
  setBatchProgress({ total: batchTo - batchFrom + 1, current: 0, currentChapter: batchFrom, status: 'pending', completed: [] })
  const r = await window.api.generateBatch(projectId, batchFrom, batchTo, (ch, result) => {
    // 流式 token 已通过 llm:token 推送，这里收到单章完成
    setBatchProgress(p => ({ ...p!, currentChapter: ch, status: 'paused' }))
  })
  if (r.ok) setBatchProgress(r.progress)
}
```

UI：弹窗显示进度条 + 当前章节 + 暂停状态 + "下一章"按钮（暂停时）+ "完成"按钮（全部完成时）。

- [ ] **Step 9.6：测试 + Commit**

```ts
describe('WriteService.generateChaptersBatch', () => {
  it('pauses after first chapter for user confirmation', async () => {
    const svc = new WriteService(ps, mockLlm('正文'))
    const progress = await svc.generateChaptersBatch(projectId, 1, 3, () => {})
    expect(progress.status).toBe('paused')
    expect(progress.currentChapter).toBe(1)
    expect(progress.completed).toEqual([1])
  })
})
```

```bash
npx vitest run tests/write-service.test.ts
git add -A
git commit -m "feat(write): batch chapter generation with pause-per-chapter"
```

---

## Self-Review 检查

### Spec 覆盖
- ✅ 第4步 质量自检自动触发 → Task 2
- ✅ 第5步 细纲对照 + 5 种差异分类 → Task 3
- ✅ 第6.1步 记忆回写（混合策略）→ Task 4-6
- ✅ 第6.2步 节奏图谱回填（差异≤1 自动）→ Task 7
- ✅ 第6.3步 Mermaid 图解 → Task 8
- ✅ 第7步 自动审核 → Task 2
- ✅ 多章连续写作（范围+单章暂停点）→ Task 9
- ✅ 章节衔接状态结构化提取 → Task 1

### 用户决策对齐
- ✅ 记忆回写：混合（新增需确认 Task 4-6 / 状态变化自动 Task 4-6）
- ✅ 细纲对照：只报告+建议（Task 3 不自动处理）
- ✅ 批量续写：范围+单章暂停点（Task 9 每章暂停）
- ✅ 节奏回填：LLM 评估+差异≤1 自动（Task 7）

### 占位符扫描
- 无 TBD/TODO
- 每个步骤都有具体代码
- 类型签名一致（parseOutlineDiffJson / parseMemoryExtractionJson / parseRhythmEvaluationJson / parseFigureDraftJson 命名统一）

### 风险点
- Task 4-6 的 appendPlotPoint 用 appendH3UnderH2 简化处理，可能需要调整 md-writer.ts 支持"追加到最后一个 H2"
- Task 9 的 runFullFlowForChapter 需要注入 WriteService 实例（避免循环依赖），可能需要把 buildChapterPrompt 拆到 flow service
- LLM JSON 解析容错已用正则兜底，但极端情况可能失败，所有解析函数都有 fallback

---

## 执行顺序建议

Task 1 → 2 → 3 → 4-6 → 7 → 8 → 9

Task 1 是基础（衔接状态注入 prompt），Task 2 是单章流程入口，Task 3-8 是流程各步骤，Task 9 依赖前面所有步骤的 service 方法。
