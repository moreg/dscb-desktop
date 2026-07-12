# 移除 AI 改稿建议侧栏、把卡片化能力迁到流程面板

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 `ChapterEditor.tsx` 中重复的「AI 改稿建议」侧栏（按钮 + ReviewPanel），把现有"原句/改写/理由"卡片渲染、一键应用、应用全部、聚焦原文四个能力整体迁到 `ChapterFlowPanel.tsx` 的"AI 审稿建议"折叠区，不丢失任何用户可见能力。

**Architecture:**
- 数据流不动：`reviewChapterStream` IPC → `reviewText` state → `useMemo(() => parseSuggestions(reviewText))` → 解析后的 `ReviewSuggestion[]` → 渲染+替换正文（经 `pushRewrite` → `rewriteHistory`）。
- 只迁渲染位置：从 `ChapterEditor.tsx` 内联的 `ReviewPanel` 移到 `ChapterFlowPanel.tsx` 的折叠区。
- 解析与 violationKey 工具 `src/shared/review-suggestions.ts` 不动。
- 自动审稿链路（续写完成后触发 `runPostGenerateReview` 自动跑、自动打开流程面板）保留。

**Tech Stack:** React 18 + TypeScript + electron-vite + Vitest。CSS 集中在 `src/renderer/src/design.css`。

## Global Constraints

- TypeScript strict：所有 props 必须显式类型，禁止隐式 `any`
- 不改 `src/shared/review-suggestions.ts` 的对外签名（`parseSuggestions` / `isRewritable` / `applyCandidate` / `buildReviewKey` / `parseReviewIndex` / `computeSuggestionPositions` / `ReviewSuggestion` 保持不变）
- 不动撤销菜单里 `isReviewKey` 返回的 `'AI 改稿建议'` badge 文案（用户决策保留）
- 保留流程面板自动打开行为（续写完成后 `setFlowPanelOpen(true)` 不动）
- 每个 task 都走 typecheck 验证

---

## Task 1：在 ChapterFlowPanel 增加卡片化 AI 审稿区域（含解析与一键应用）

**Files:**
- Modify: `src/renderer/src/ChapterFlowPanel.tsx`
  - import 块增加 `parseSuggestions, isRewritable, applyCandidate, buildReviewKey, parseReviewIndex, computeSuggestionPositions, type ReviewSuggestion`
- Test: 现有 `tests/` 不强制新增（解析与历史回填路径不变逻辑、不需要新单测；本次 typecheck 覆盖足够）

**Interfaces:**
- Consumes: 现有 `props.reviewText`（string 流式文本）、`props.draft`（string 当前正文）、`props.rewriteHistory`（应用记录数组）、`props.reviewing`（是否还在流式）、`props.onJumpToOffset`（跳转定位已存在但仅支持 offset → 需扩展为支持 quote+length）
- Produces: 折叠区里渲染 `ReviewSuggestion[]` 的卡片列表；新增三个内部 handler：`handleApplySuggestion` / `handleApplyAll` / `handleFocusSuggestion`

### Step 1.1：扩 import 与 props

在 `ChapterFlowPanel.tsx:1-19` 的 import 后追加：

```ts
import {
  parseSuggestions,
  isRewritable,
  applyCandidate,
  buildReviewKey,
  parseReviewIndex,
  computeSuggestionPositions,
  type ReviewSuggestion
} from '../../shared/review-suggestions'
```

在 `ChapterFlowPanel.tsx:60`（props interface 末尾）追加：

```ts
/** 续写应用 review 建议后跳到对应的 quote 位置（编辑器焦点定位） */
onFocusQuote?: (quote: string) => void
```

并在文件顶部的解构赋值里加上 `onFocusQuote`（props 解构按现有风格）。

### Step 1.2：迁入 useMemo 与 handler

在 `ChapterFlowPanel.tsx` 解构之后（紧跟现有 useState 区后，约 130 行附近）插入：

```ts
// 解析流式 review 文本为结构化卡片
const reviewSuggestions = useMemo(
  () => (reviewText ? parseSuggestions(reviewText) : []),
  [reviewText]
)

// 从 rewriteHistory 反推已应用的建议索引（与 ChapterEditor 现有实现一致）
const appliedReviewIndexes = useMemo(() => {
  const set = new Set<number>()
  for (const e of rewriteHistory ?? []) {
    if (!e.violationKey) continue
    const idx = parseReviewIndex(e.violationKey)
    if (idx != null) set.add(idx)
  }
  return set
}, [rewriteHistory])

// 同 quote 多条建议依次匹配 draft 下一处
const suggestionPositions = useMemo(
  () => computeSuggestionPositions(reviewSuggestions, draft, appliedReviewIndexes),
  [reviewSuggestions, draft, appliedReviewIndexes]
)
```

如果 `props.rewriteHistory` 类型未带 `violationKey` 字段——查询 `RewriteHistoryEntry` 类型定义，把现有 `ChapterEditor.tsx:1581-1589` 块的归集条件原样复制过来。

### Step 1.3：迁入 handler

紧接上一段 useMemo 之后插入：

```ts
const handleApplyReviewSuggestion = (quote: string, candidate: string, index: number) => {
  if (!quote || !onApplyRewrite) {
    return
  }
  const check = isRewritable(candidate, quote)
  if (!check.ok) {
    return
  }
  const pos = suggestionPositions[index] ?? -1
  if (pos === -1) return
  onApplyRewrite(quote, candidate, buildReviewKey(index, pos))
}

const handleApplyAllReviewSuggestions = () => {
  if (!onApplyRewrite) return
  let appliedCount = 0
  const finalList = [...reviewSuggestions]
    .map((s, i) => {
      const candidate = applyCandidate(s)
      return { s, candidate, originalIndex: i, pos: suggestionPositions[i] ?? -1 }
    })
    .filter(
      (item) =>
        !!item.s.quote &&
        item.pos !== -1 &&
        !!item.candidate &&
        isRewritable(item.candidate, item.s.quote).ok
    )
    .sort((a, b) => a.pos - b.pos || b.s.quote.length - a.s.quote.length)
  let lastEnd = -1
  for (let i = 0; i < finalList.length; i++) {
    const item = finalList[i]
    if (item.pos < lastEnd) {
      finalList.splice(i, 1)
      i--
      continue
    }
    lastEnd = item.pos + item.s.quote.length
  }
  finalList.sort((a, b) => b.pos - a.pos)
  for (const item of finalList) {
    onApplyRewrite(item.s.quote, item.candidate as string, buildReviewKey(item.originalIndex, item.pos))
    appliedCount++
  }
  return appliedCount
}

const handleFocusReviewQuote = (quote: string) => {
  if (!quote || !onFocusQuote) return
  onFocusQuote(quote)
}
```

### Step 1.4：替换折叠区 UI

`ChapterFlowPanel.tsx:495-513` 现在的 `<pre>{reviewText}</pre>` 替换为：

```tsx
<div style={{ marginTop: 10 }}>
  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
    <strong style={{ fontSize: 13 }}>AI 审稿建议</strong>
    {reviewSuggestions.length > 0 && !reviewing && onApplyRewrite && (
      <button className="btn btn-sm" onClick={handleApplyAllReviewSuggestions}>
        应用全部
      </button>
    )}
  </div>
  {reviewing && reviewSuggestions.length === 0 ? (
    <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
      审稿中…
    </p>
  ) : reviewSuggestions.length === 0 && !reviewText ? (
    <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
      暂无审稿结果（续写完成后会自动生成）。
    </p>
  ) : reviewSuggestions.length === 0 ? (
    <pre
      className="body"
      style={{ whiteSpace: 'pre-wrap', marginTop: 4, fontSize: 12.5, maxHeight: 240, overflow: 'auto' }}
    >
      {reviewText}
    </pre>
  ) : (
    <div className="review-suggestion-list">
      {reviewSuggestions.map((s, i) => {
        const candidate = applyCandidate(s)
        const rewritable = !!candidate && isRewritable(candidate, s.quote).ok
        const copyText = [candidate, s.why].filter(Boolean).join('\n\n')
        const applied = appliedReviewIndexes.has(i)
        return (
          <div
            key={i}
            className={`review-suggestion ${applied ? 'review-suggestion-applied' : ''}`}
            onClick={() => handleFocusReviewQuote(s.quote)}
            style={{ cursor: s.quote ? 'pointer' : 'default' }}
          >
            {s.quote ? <div className="quote">「{s.quote}」</div> : null}
            {s.rewrite ? (
              <div style={{ fontWeight: 600, marginBottom: 4 }}>改写 · {s.rewrite}</div>
            ) : s.advice ? (
              <div style={{ fontWeight: 600, marginBottom: 4 }}>说明 · {s.advice}</div>
            ) : null}
            {s.why ? <div className="why">理由 · {s.why}</div> : null}
            {(rewritable || copyText) && (
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                {applied ? (
                  <span className="audit-applied-badge" title="已应用到正文。撤销请用编辑器顶部「↶ 撤销」。">
                    ✓ 已应用
                  </span>
                ) : rewritable && s.quote ? (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleApplyReviewSuggestion(s.quote, candidate!, i)
                    }}
                  >
                    应用
                  </button>
                ) : (
                  <button
                    className="btn btn-ghost btn-sm"
                    title="无法自动应用，复制说明后手动修改"
                    onClick={(e) => {
                      e.stopPropagation()
                      void navigator.clipboard.writeText(copyText).catch(() => {})
                    }}
                  >
                    复制说明
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
      {reviewing ? (
        <div className="review-streaming muted" style={{ fontSize: 12 }}>
          ▍ 还在收尾…
        </div>
      ) : null}
    </div>
  )}
</div>
```

### Step 1.5：运行 typecheck

跑：
```
npm run typecheck:web
```
预期：PASS，无新增报错。如果 props 类型不匹配，按错误提示调整；不允许用 `any` 兜底。

### Step 1.6：Commit

```bash
git add src/renderer/src/ChapterFlowPanel.tsx
git commit -m "feat(flow-panel): 在 AI 审稿建议折叠区渲染卡片并支持一键应用"
```

---

## Task 2：ChapterEditor 接入 onFocusQuote，删按钮、ReviewPanel、未用 state/handler/import

**Files:**
- Modify: `src/renderer/src/ChapterEditor.tsx`
  - 删除 `import` 块中 `parseSuggestions / isRewritable / applyCandidate / buildReviewKey / parseReviewIndex / computeSuggestionPositions / ReviewSuggestion`
  - 删除 `useState` 中的 `reviewOpen`
  - 删除 `startReview` 函数
  - 删除 `runPostGenerateReview` 中的 `setReviewOpen(true)` 这一行
  - 删除 `ChapterFlowPanel` 渲染处的"`review-open`"类
  - 删除工具栏 `✎ AI 改稿` 按钮
  - 删除 `{reviewOpen ? <ReviewPanel/> : null}` 整块
  - 删除 `function ReviewPanel() {...}` 整块组件（3212-3329）
  - 删除 `suggestions / appliedReviewIndexes / suggestionPositions` 三个 useMemo
  - 删除 `handleApplySuggestion / handleApplyAllSuggestions / handleFocusSuggestion` 三个 handler
  - 给 `<ChapterFlowPanel>` 新增 `onFocusQuote={...}` prop，指向 textarea 定位实现

### Step 2.1：删除 import

`ChapterEditor.tsx:30-37` 的整块 `import { parseSuggestions, ... } from '../../shared/review-suggestions'` 删除。

### Step 2.2：删 useState reviewOpen

`ChapterEditor.tsx:308` 删除：
```ts
const [reviewOpen, setReviewOpen] = useState(false)
```

### Step 2.3：删除 startReview

`ChapterEditor.tsx:1245-1273` 整段 `const startReview = async () => { ... }` 删掉。

### Step 2.4：清理 runPostGenerateReview 里的 setReviewOpen

`ChapterEditor.tsx:1169` 把 `setReviewOpen(true)` 这一行删掉，保留 `setReviewing(true) / setReviewText('')` 等。

### Step 2.5：删 review-open 类分支

`ChapterEditor.tsx:1869` 把：
```tsx
<div className={`chapter-editor-shell${reviewOpen ? ' review-open' : ''}`}>
```
改为：
```tsx
<div className="chapter-editor-shell">
```

### Step 2.6：删工具栏按钮

`ChapterEditor.tsx:1997-1999` 删：
```tsx
<button className="btn btn-sm" onClick={startReview} disabled={reviewing}>
  {reviewing ? '审稿中…' : '✎ AI 改稿'}
</button>
```

### Step 2.7：删三个 useMemo

`ChapterEditor.tsx:1573-1595` 整段（含 `suggestions / appliedReviewIndexes / suggestionPositions`）删掉。

### Step 2.8：删三个 handler

`ChapterEditor.tsx:1597-1680` 整段（含 `handleApplySuggestion / handleApplyAllSuggestions / handleFocusSuggestion`）删掉。**注意**：`handleFocusSuggestion` 内部用到了 `textareaRef.current` 和 `setSelectionRange`——这逻辑要搬到下面 Step 2.10 的 `onFocusQuote` 实现里。

### Step 2.9：删 ReviewPanel 调用点和组件定义

`ChapterEditor.tsx:2964-2978` 整块 `{reviewOpen ? <ReviewPanel .../> : null}` 删掉。

`ChapterEditor.tsx:3212-3329` 整段 `function ReviewPanel(props) { ... }` 删掉。

### Step 2.10：把 textarea 定位功能挪到 ChapterEditor 端，作为给 FlowPanel 的回调

在删除 `handleFocusSuggestion` 之前先记住其实现，现替换为一个通过 prop 暴露给 ChapterFlowPanel 的小 handler。在 `<ChapterFlowPanel>` 渲染处（约 2280 行附近）追加：

```tsx
onFocusQuote={(quote) => {
  const el = textareaRef.current
  if (!el || !quote) return
  const pos = draft.indexOf(quote)
  if (pos === -1) return
  el.focus()
  el.setSelectionRange(pos, pos + quote.length)
  const row = draft.slice(0, pos).split('\n').length
  const lineHeight = 32
  el.scrollTop = Math.max(0, (row - 5) * lineHeight)
}}
```

注意：原实现里的 `suggestionPositions` 优先匹配逻辑不再需要——流程面板自己计算位置后调用 `onApplyRewrite`，UI 只需要最朴素地"跳到首处"即可。如果以后要多位置精确跳转，可以再扩。

### Step 2.11：删 stale imports / 未用的 setter

确认 `setReviewText` 仍在被 `runPostGenerateReview` 调用——保留。`setReviewing` 同理。

### Step 2.12：运行 typecheck

```
npm run typecheck:web
```
预期：PASS。如有 `reviewing` / `reviewText` 被设为 unused（外层没引用了但仍在传 FlowPanel），检查：传给 FlowPanel 是用 `reviewing={reviewing} reviewText={reviewText}`——确认这两个 prop 还在 2283-2284 行被传给 FlowPanel，**不删 state**。

### Step 2.13：Commit

```bash
git add src/renderer/src/ChapterEditor.tsx
git commit -m "refactor(editor): 移除 AI 改稿建议侧栏与重复按钮"
```

---

## Task 3：清理 design.css 里的 review-panel*/review-open/侧栏样式

**Files:**
- Modify: `src/renderer/src/design.css`
  - 删除 `2405-2482` 整段（"AI 改稿侧栏"小节 + `@keyframes caret`）
  - 删除 `1560-1562` 整段（`.chapter-editor-shell.review-open`）
  - 保留 `3241` 处的 `.audit-applied-badge`（ChapterAuditPanel 还在用）

### Step 3.1：删除 1560-1562

`design.css:1558-1564` 删：
```css
}

.chapter-editor-shell.review-open {
  padding-right: 396px;
}

.chapter-workbench {
```
替换为：
```css
}

.chapter-workbench {
```

### Step 3.2：删除 2405-2482

整段连同小节分隔注释 `/* AI 改稿侧栏 */` 一起删，直到 `/* 联动高亮预览 */` 之前的空行为止。

### Step 3.3：检查残留引用

跑：
```
grep -n "review-panel\|review-suggestion\|review-empty\|review-streaming\|review-open" src/
```
预期：仅 `ChapterFlowPanel.tsx` 与 `ChapterAuditPanel.tsx`（用 `audit-applied-badge`）、以及 `design.css` 里 review-suggestion 类被保留（卡片还要渲染）。
如发现 `ChapterFlowPanel.tsx` 没用到 `.review-open`，则该选择器已无引用——安全删除。

### Step 3.4：typecheck + grep

```
npm run typecheck:web
```
预期 PASS。

### Step 3.5：Commit

```bash
git add src/renderer/src/design.css
git commit -m "style(css): 移除已下线的 AI 改稿建议侧栏样式"
```

---

## Task 4：更新设计文档

**Files:**
- Modify: `docs/superpowers/specs/2026-06-23-writing-page-features-design.md`
  - 第 12 行 / 26-29 行 / 73 行 中所有"AI 改稿建议"侧栏描述
  - 改为：续写流程面板里的"AI 审稿建议"折叠区直接渲染卡片并支持一键应用

### Step 4.1：替换描述

找到文档里所有提到"AI 改稿建议"侧栏/面板/Rewrite button 的段落，按上下文改为：

> AI 审稿建议：续写完成后自动触发 `reviewChapterStream`，流式文本经 `parseSuggestions` 解析为 `ReviewSuggestion[]`，在**续写流程面板的「AI 审稿建议」折叠区**渲染成卡片（原句 / 改写 / 理由）。每条卡片可点击定位到正文、可单独"应用"、可一键"应用全部"。Undo 栈里来自审稿建议的应用通过 violationKey 前缀 `ai-review-` 标记，撤销菜单显示来源为"AI 改稿建议"。

### Step 4.2：Commit

```bash
git add docs/superpowers/specs/2026-06-23-writing-page-features-design.md
git commit -m "docs(spec): 把 AI 改稿建议侧栏合并到流程面板折叠区"
```

---

## Task 5：最终验证

### Step 5.1：跑 typecheck
```
npm run typecheck:web
npm run typecheck:node
```
预期：均 PASS。

### Step 5.2：跑测试
```
npm test
```
预期：所有现存测试 PASS。如有与 `ChapterEditor.startReview`/`ReviewPanel`/`reviewOpen` 相关的旧测试，需要同步更新——查 `tests/` 目录：
```
grep -rn "startReview\|ReviewPanel\|reviewOpen\|startReview" tests/
```
如果存在，按测试期望把"侧栏显示"改为"流程面板折叠区显示"。

### Step 5.3：手动验证清单（dev 模式）
- 打开任意章节 → 工具栏**无 ✎ AI 改稿 按钮**
- 点"续写"，等待生成完成 → 流程面板**自动打开**，"AI 审稿建议"折叠区出现卡片
- 点单条"应用" → 正文替换为改写，撤销菜单里这条来源是"AI 改稿建议"
- 点"应用全部" → 正文批量替换，卡片状态变 "✓ 已应用"
- 点卡片「原句」→ 编辑器焦点跳到对应位置
- 点"复制说明"（如卡片无法自动应用）→ 内容写入剪贴板

### Step 5.4：Commit（聚合）

如果上一步手动验证通过且无遗漏代码改动，无需新 commit。如果在 typecheck 或测试中改了东西，按改动提交：

```bash
git add -A
git commit -m "chore: 移除 AI 改稿建议侧栏后的连带修复"
```

---

## 自我审查

- [x] Spec 覆盖率：每个要求（删按钮/侧栏/迁卡片/保留撤销 badge）都有 Task 对应
- [x] Placeholder 扫描：每个 Step 都给了具体代码，不是"TBD"
- [x] 类型一致性：`ReviewSuggestion` / `parseSuggestions` 等签名在两个文件中一致使用同一份 import，无重命名
- [x] 边界：CSS 删除集中在两段；`audit-applied-badge` 因 ChapterAuditPanel 复用而保留
