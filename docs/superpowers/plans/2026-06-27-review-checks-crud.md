# 审稿检查项可编辑/可新增/可删除 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让审稿检查项支持元数据编辑、用户新增自定义检查项（keyword/regex/llm 三类）、删除（内置项软删除/恢复、自定义项硬删除）。

**Architecture:** 把单一硬编码注册表拆成「内置定义 + 用户层」。内置项（19 个）检测逻辑写死不可改，但可开关/隐藏(软删除)/恢复/改元数据；自定义项靠通用检测引擎按 `type` 跑（keyword=词表命中、regex=正则匹配、llm=prompt 调 LLM）。用户层数据存进 `ReviewRulesConfig`，复用现有 patch 持久化与 sanitize 先例。自定义 id 用 `custom_` 前缀，与内置闭合联合类型永不冲突。

**Tech Stack:** TypeScript / Electron IPC / React / Vitest / Zod

**Spec:** `docs/superpowers/specs/2026-06-27-review-checks-crud-design.md`

---

## 文件结构

**新增：**
- `src/main/data/custom-check-engine.ts` — 通用检测引擎（keyword/regex 同步检测 + 导出 sanitize 辅助）
- `tests/custom-check-engine.test.ts` — 引擎单测

**改动：**
- `src/shared/types.ts` — `CustomCheckType` / `CustomReviewCheck` / `BuiltinCheckMeta` 类型，`ReviewRulesConfig` 加 3 字段，`ReviewCheckSectionView` 加 `isCustom?`/`customType?`/`keywords?`/`pattern?`/`prompt?`，`DeepReviewContext` 加 `customLlmChecks?`
- `src/main/data/settings-repository.ts` — `sanitizeCustomChecks` / `sanitizeBuiltinMeta` / `sanitizeHiddenBuiltin` + `sanitizeReviewRules` 扩展
- `src/main/data/chapter-audit.ts` — `auditChapter` 接入自定义算法项（keyword/regex）
- `src/main/data/review-flow-service.ts` — `runDeepReview` 接入自定义 llm 项
- `src/main/data/write-service.ts` — `runDeepReview` 透传 customLlmChecks
- `src/main/ipc/settings.ts` — getReviewRules 合并展示、setReviewRules zod 扩展
- `src/renderer/src/SettingsPage.tsx` — CRUD UI（编辑/删除/新增/已隐藏区）
- `tests/review-rules.test.ts` — 扩展 sanitize 测试

---

## Task 1: 共享类型定义

为整个功能打地基。类型先于一切，后续所有任务都引用这些类型。

**Files:**
- Modify: `src/shared/types.ts:236-252`（ReviewCheckSectionView + ReviewRulesBundle）, `947-957`（ReviewRulesConfig）

- [ ] **Step 1: 在 `src/shared/types.ts` 的 `ReviewRulesConfig` 上方新增三个类型**

在 `ReviewCheckSectionView` 接口（约 236 行）之前插入：

```ts
/** 自定义检查项的检测类型（用户在 UI 选）。 */
export type CustomCheckType = 'keyword' | 'regex' | 'llm'

/**
 * 用户自定义检查项（CRUD 的"新增"产物）。
 * id 用 custom_ 前缀，与内置 ReviewCheckId 永不冲突。
 */
export interface CustomReviewCheck {
  /** 'custom_xxx'，UI 生成，全局唯一 */
  id: string
  label: string
  hint: string
  severity: AuditSeverity
  type: CustomCheckType
  /** UI 分组 + 违例 category，限定为 AuditCategory 之一（复用现有分类） */
  group: AuditCategory
  keywords?: string[]
  pattern?: string
  prompt?: string
  enabled: boolean
}

/** 内置检查项的元数据覆盖（用户编辑内置项名称/说明/严重度时写入）。 */
export interface BuiltinCheckMeta {
  label?: string
  hint?: string
  severity?: AuditSeverity
}
```

- [ ] **Step 2: 给 `ReviewRulesConfig`（约 947 行）加 3 个可选字段**

把现有：

```ts
export interface ReviewRulesConfig {
  /** 总开关：false = 跳过所有新增审稿，回到旧质检行为 */
  enabled: boolean
  /** 完整流程里是否自动跑 LLM 深度审稿（默认 false，按需点按钮触发，省 token） */
  autoDeepReview: boolean
  /** 各检查项开关；缺省=开 */
  checks: Partial<Record<ReviewCheckId, boolean>>
  thresholds: ReviewThresholds
  wordLists: ReviewWordLists
}
```

改为（仅末尾追加 3 字段）：

```ts
export interface ReviewRulesConfig {
  /** 总开关：false = 跳过所有新增审稿，回到旧质检行为 */
  enabled: boolean
  /** 完整流程里是否自动跑 LLM 深度审稿（默认 false，按需点按钮触发，省 token） */
  autoDeepReview: boolean
  /** 各检查项开关；缺省=开（key 含 custom_ 前缀的自定义项） */
  checks: Partial<Record<string, boolean>>
  thresholds: ReviewThresholds
  wordLists: ReviewWordLists
  /** 内置项元数据覆盖（编辑内置项 label/hint/severity） */
  builtinMeta?: Partial<Record<ReviewCheckId, BuiltinCheckMeta>>
  /** 软删除（隐藏）的内置项 id；可恢复 */
  hiddenBuiltin?: ReviewCheckId[]
  /** 用户自定义检查项 */
  customChecks?: CustomReviewCheck[]
}
```

> 注意：`checks` 的键类型从 `ReviewCheckId` 放宽为 `string`，因为自定义 id（custom_xxx）不是该闭合联合的成员。

- [ ] **Step 3: 给 `ReviewCheckSectionView` 加可选字段（UI 区分内置/自定义）**

把现有（约 237 行）：

```ts
export interface ReviewCheckSectionView {
  checkId: ReviewCheckId
  kind: 'algorithm' | 'llm'
  group: string
  label: string
  defaultSeverity: AuditSeverity
  hint: string
}
```

改为：

```ts
export interface ReviewCheckSectionView {
  /** 内置项用 ReviewCheckId；自定义项用 custom_ 前缀 id */
  checkId: string
  kind: 'algorithm' | 'llm'
  group: string
  label: string
  defaultSeverity: AuditSeverity
  hint: string
  /** true = 用户自定义项（UI 据此显示删除/全字段编辑） */
  isCustom?: boolean
  /** 自定义项的检测类型；内置项无此字段 */
  customType?: CustomCheckType
  /** 自定义项配置（按 type 取用），供 UI 编辑表单初始化 */
  keywords?: string[]
  pattern?: string
  prompt?: string
}
```

- [ ] **Step 4: 给 `DeepReviewContext` 加字段（透传自定义 LLM 项）**

打开 `src/main/data/review-flow-service.ts:103`，把 `DeepReviewContext` 加一个字段：

```ts
export interface DeepReviewContext {
  chapterNumber: number
  genre?: string
  enabledChecks?: ReviewCheckId[]
  characterCards?: string
  outline?: string
  /** 用户自定义的 LLM 检查项（type=llm），由调用方从 settings 透传 */
  customLlmChecks?: CustomReviewCheck[]
}
```

文件顶部 import 处补上类型（如果还没引入）：

```ts
import type { AuditSeverity, AuditViolation, ReviewCheckId, CustomReviewCheck } from '../../shared/types'
```

- [ ] **Step 5: 类型检查**

Run: `cd "E:\trea\写作桌面应用" && npx tsc --noEmit -p tsconfig.json 2>&1 | head -30`
Expected: 可能有若干 "checks 索引类型" 相关报错（因为 checks key 放宽了），后续任务会逐个修。若无新报错则 PASS。

- [ ] **Step 6: Commit**

```bash
cd "E:\trea\写作桌面应用"
git add src/shared/types.ts src/main/data/review-flow-service.ts
git commit -m "feat(review): 自定义检查项类型定义（CustomReviewCheck/BuiltinCheckMeta）"
```

---

## Task 2: 通用检测引擎（keyword / regex）+ 单测（TDD）

这是自定义算法项的核心。先写测试定义行为，再实现。

**Files:**
- Create: `tests/custom-check-engine.test.ts`
- Create: `src/main/data/custom-check-engine.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/custom-check-engine.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { runCustomAlgorithmChecks } from '../src/main/data/custom-check-engine'
import type { AuditViolation, CustomReviewCheck } from '../src/shared/types'

describe('runCustomAlgorithmChecks', () => {
  it('keyword 类型：命中词表即报，带 offset/snippet', () => {
    const checks: CustomReviewCheck[] = [
      {
        id: 'custom_cliche',
        label: '我的禁用词',
        hint: '',
        severity: 'warn',
        type: 'keyword',
        group: 'toxic',
        keywords: ['居然', '竟然'],
        enabled: true
      }
    ]
    const out: AuditViolation[] = []
    runCustomAlgorithmChecks('他居然笑了，竟然哭了', checks, out)
    expect(out.length).toBe(2)
    expect(out[0].ruleId).toBe('custom_cliche')
    expect(out[0].category).toBe('toxic')
    expect(out[0].severity).toBe('warn')
    expect(out[0].word).toBe('居然')
    expect(out[0].offset).toBe(1)
    expect(out[0].snippet).toContain('居然')
  })

  it('keyword 类型：关闭（enabled=false）不跑', () => {
    const checks: CustomReviewCheck[] = [
      {
        id: 'custom_x', label: '', hint: '', severity: 'warn',
        type: 'keyword', group: 'toxic', keywords: ['a'], enabled: false
      }
    ]
    const out: AuditViolation[] = []
    runCustomAlgorithmChecks('aaa', checks, out)
    expect(out).toEqual([])
  })

  it('keyword 类型：同词多次命中上限 5 条', () => {
    const checks: CustomReviewCheck[] = [
      {
        id: 'custom_x', label: '', hint: '', severity: 'warn',
        type: 'keyword', group: 'toxic', keywords: ['哈'], enabled: true
      }
    ]
    const out: AuditViolation[] = []
    runCustomAlgorithmChecks('哈哈哈哈哈哈哈哈哈哈哈', checks, out)
    expect(out.length).toBeLessThanOrEqual(5)
  })

  it('regex 类型：命中正则即报', () => {
    const checks: CustomReviewCheck[] = [
      {
        id: 'custom_re', label: '', hint: '', severity: 'error',
        type: 'regex', group: 'quality', pattern: '——[一-龥]——', enabled: true
      }
    ]
    const out: AuditViolation[] = []
    runCustomAlgorithmChecks('他——啊——走了', checks, out)
    expect(out.length).toBe(1)
    expect(out[0].ruleId).toBe('custom_re')
    expect(out[0].severity).toBe('error')
  })

  it('regex 类型：非法正则跳过不抛错', () => {
    const checks: CustomReviewCheck[] = [
      {
        id: 'custom_bad', label: '', hint: '', severity: 'warn',
        type: 'regex', group: 'quality', pattern: '[unclosed', enabled: true
      }
    ]
    const out: AuditViolation[] = []
    expect(() => runCustomAlgorithmChecks('任意文本', checks, out)).not.toThrow()
    expect(out).toEqual([])
  })

  it('regex 类型：同匹配多次命中上限 5 条', () => {
    const checks: CustomReviewCheck[] = [
      {
        id: 'custom_re', label: '', hint: '', severity: 'info',
        type: 'regex', group: 'quality', pattern: '!', enabled: true
      }
    ]
    const out: AuditViolation[] = []
    runCustomAlgorithmChecks('!!!!!!!!!!', checks, out)
    expect(out.length).toBeLessThanOrEqual(5)
  })

  it('llm 类型项被算法引擎忽略（不在算法引擎跑）', () => {
    const checks: CustomReviewCheck[] = [
      {
        id: 'custom_llm', label: '', hint: '', severity: 'warn',
        type: 'llm', group: 'llm_review', prompt: '检查X', enabled: true
      }
    ]
    const out: AuditViolation[] = []
    runCustomAlgorithmChecks('任意文本', checks, out)
    expect(out).toEqual([])
  })

  it('空 checks / 空文本不报错', () => {
    const out: AuditViolation[] = []
    runCustomAlgorithmChecks('', [], out)
    expect(out).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd "E:\trea\写作桌面应用" && npx vitest run tests/custom-check-engine.test.ts 2>&1 | tail -15`
Expected: FAIL — `Cannot find module '../src/main/data/custom-check-engine'`

- [ ] **Step 3: 实现引擎**

创建 `src/main/data/custom-check-engine.ts`：

```ts
import type { AuditViolation, CustomReviewCheck } from '../../shared/types'

/** 单条自定义项命中上限（沿用现有审稿约定）。 */
const MAX_HITS_PER_CHECK = 5

/**
 * 跑自定义算法类检查项（keyword / regex）。llm 类被跳过（由 review-flow-service 跑）。
 * 单项失败（如非法正则）只跳过不抛错，不阻断整体。
 * 结果 push 进 out，ruleId = check.id，category = check.group。
 */
export function runCustomAlgorithmChecks(
  content: string,
  checks: CustomReviewCheck[] | undefined,
  out: AuditViolation[]
): void {
  if (!checks || !content) return
  for (const check of checks) {
    if (!check.enabled) continue
    if (check.type === 'keyword') {
      runKeywordCheck(content, check, out)
    } else if (check.type === 'regex') {
      runRegexCheck(content, check, out)
    }
    // type === 'llm' 不在此跑
  }
}

function runKeywordCheck(
  content: string,
  check: CustomReviewCheck,
  out: AuditViolation[]
): void {
  const words = check.keywords ?? []
  let reported = 0
  for (const word of words) {
    if (reported >= MAX_HITS_PER_CHECK) break
    let from = 0
    while (reported < MAX_HITS_PER_CHECK) {
      const idx = content.indexOf(word, from)
      if (idx < 0) break
      out.push({
        category: check.group,
        severity: check.severity,
        message: `${check.label}：命中「${word}」`,
        snippet: extractContext(content, idx, word.length),
        offset: idx,
        ruleId: check.id,
        word,
        suggestion: check.hint || undefined
      })
      reported++
      from = idx + word.length
    }
  }
}

function runRegexCheck(
  content: string,
  check: CustomReviewCheck,
  out: AuditViolation[]
): void {
  const src = check.pattern ?? ''
  if (!src) return
  let re: RegExp
  try {
    re = new RegExp(src, 'g')
  } catch (err) {
    console.warn(`[customCheck] ${check.id} 非法正则「${src}」:`, err)
    return
  }
  let reported = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null && reported < MAX_HITS_PER_CHECK) {
    out.push({
      category: check.group,
      severity: check.severity,
      message: `${check.label}：命中「${m[0]}」`,
      snippet: extractContext(content, m.index, m[0].length),
      offset: m.index,
      ruleId: check.id,
      word: m[0],
      suggestion: check.hint || undefined
    })
    reported++
    if (m.index === re.lastIndex) re.lastIndex++ // 防零宽死循环
  }
}

/** 上下文截取（与 chapter-audit.extractContext 同构，复制以保持文件独立）。 */
function extractContext(content: string, idx: number, wordLen: number): string {
  const radius = 12
  const start = Math.max(0, idx - radius)
  const end = Math.min(content.length, idx + wordLen + radius)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  return prefix + content.slice(start, end).replace(/\s+/g, ' ') + suffix
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd "E:\trea\写作桌面应用" && npx vitest run tests/custom-check-engine.test.ts 2>&1 | tail -15`
Expected: PASS（8 个测试全过）

- [ ] **Step 5: Commit**

```bash
cd "E:\trea\写作桌面应用"
git add src/main/data/custom-check-engine.ts tests/custom-check-engine.test.ts
git commit -m "feat(review): 自定义检查项算法引擎（keyword/regex 检测 + 单测）"
```

---

## Task 3: 接入算法引擎到 chapter-audit

让自定义 keyword/regex 项在实时质检中生效。

**Files:**
- Modify: `src/main/data/chapter-audit.ts:227-237`（auditChapter 的 if(rules) 块）

- [ ] **Step 1: 找到接入点**

`src/main/data/chapter-audit.ts` 的 `auditChapter` 函数，约 228 行 `if (rules) { ... }` 块。该块末尾（`pushSensitiveViolations` 之后）追加自定义项调用。

- [ ] **Step 2: 加 import**

文件顶部 import 区（找已有的 import from '../../shared/types'）补充引擎导入。先读文件头部确认 import 风格：

打开 `src/main/data/chapter-audit.ts` 第 1-15 行，确认现有 import 结构，然后在合适位置加：

```ts
import { runCustomAlgorithmChecks } from './custom-check-engine'
```

- [ ] **Step 3: 在 if(rules) 块末尾接入**

把现有（约 227-237 行）：

```ts
  // 「正文审核」技能新增的算法检查（M2）。每项读 checks[id] !== false 决定是否跳过。
  if (rules) {
    pushMetaBreakViolations(content, voice, rules, violations)
    pushPovMixViolations(content, rules, violations)
    pushRepetitionViolations(content, thresholds, rules, violations)
    pushQuoteCountViolations(content, rules, violations)
    pushQualityViolations(content, thresholds, rules, violations)
    pushLongParagraphViolations(content, thresholds, rules, violations)
    pushDialogueTagViolations(content, rules, violations)
    pushSensitiveViolations(content, rules, violations)
  }
```

改为（仅末尾加一行）：

```ts
  // 「正文审核」技能新增的算法检查（M2）。每项读 checks[id] !== false 决定是否跳过。
  if (rules) {
    pushMetaBreakViolations(content, voice, rules, violations)
    pushPovMixViolations(content, rules, violations)
    pushRepetitionViolations(content, thresholds, rules, violations)
    pushQuoteCountViolations(content, rules, violations)
    pushQualityViolations(content, thresholds, rules, violations)
    pushLongParagraphViolations(content, thresholds, rules, violations)
    pushDialogueTagViolations(content, rules, violations)
    pushSensitiveViolations(content, rules, violations)
    // 用户自定义算法检查项（keyword/regex）
    runCustomAlgorithmChecks(content, rules.customChecks, violations)
  }
```

- [ ] **Step 4: 验证编译**

Run: `cd "E:\trea\写作桌面应用" && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: 无新报错（customChecks 字段已在 Task 1 加入 ReviewRulesConfig）

- [ ] **Step 5: 跑现有审稿测试确认无回归**

Run: `cd "E:\trea\写作桌面应用" && npx vitest run tests/chapter-audit-review.test.ts 2>&1 | tail -10`
Expected: PASS（现有测试不受影响）

- [ ] **Step 6: Commit**

```bash
cd "E:\trea\写作桌面应用"
git add src/main/data/chapter-audit.ts
git commit -m "feat(review): chapter-audit 接入自定义算法检查项"
```

---

## Task 4: 接入自定义 LLM 项到 review-flow-service

让自定义 llm 项在深度审稿中生效。

**Files:**
- Modify: `src/main/data/review-flow-service.ts:123-156`（runDeepReview）

- [ ] **Step 1: 找到 runDeepReview 的循环结构**

`review-flow-service.ts` 的 `runDeepReview`（约 123 行）：先算 `want`（内置 LLM 项），再 for 循环跑。我们要在循环后追加自定义 llm 项。

- [ ] **Step 2: 修改 runDeepReview，循环后追加自定义项**

把现有（约 133-156 行）：

```ts
    const all: AuditViolation[] = []
    for (const checkId of want) {
      const spec = CHECK_SPECS[checkId]
      if (!spec || !spec.instruction) continue
      try {
        const findings = await this.runOneCheck(spec, content, ctx, opts)
        for (const f of findings) {
          all.push({
            category: 'llm_review',
            severity: f.severity,
            message: f.message,
            snippet: f.snippet,
            offset: f.offset,
            ruleId: f.checkId,
            suggestion: f.suggestion
          })
        }
      } catch (err) {
        // 单项失败不影响其他项；继续
        console.warn(`[runDeepReview] check ${checkId} failed:`, err)
      }
    }
    return all
```

改为（循环后追加自定义 llm 项）：

```ts
    const all: AuditViolation[] = []
    for (const checkId of want) {
      const spec = CHECK_SPECS[checkId]
      if (!spec || !spec.instruction) continue
      try {
        const findings = await this.runOneCheck(spec, content, ctx, opts)
        for (const f of findings) {
          all.push({
            category: 'llm_review',
            severity: f.severity,
            message: f.message,
            snippet: f.snippet,
            offset: f.offset,
            ruleId: f.checkId,
            suggestion: f.suggestion
          })
        }
      } catch (err) {
        // 单项失败不影响其他项；继续
        console.warn(`[runDeepReview] check ${checkId} failed:`, err)
      }
    }
    // 用户自定义 LLM 检查项（type=llm，由调用方透传）
    const customLlm = ctx.customLlmChecks ?? []
    for (const check of customLlm) {
      if (!check.enabled || !check.prompt) continue
      const spec: CheckSpec = { checkId: check.id as ReviewCheckId, instruction: check.prompt }
      try {
        const findings = await this.runOneCheck(spec, content, ctx, opts)
        for (const f of findings) {
          all.push({
            category: 'llm_review',
            severity: f.severity,
            message: f.message,
            snippet: f.snippet,
            offset: f.offset,
            ruleId: check.id,
            suggestion: f.suggestion
          })
        }
      } catch (err) {
        console.warn(`[runDeepReview] custom check ${check.id} failed:`, err)
      }
    }
    return all
```

> 注：`runOneCheck` 内部 prompt 模板里有 `"checkId": "${spec.checkId}"`，自定义 id 填进去不影响 JSON 解析（parseFindingsJson 用 fallbackCheckId 兜底）。

- [ ] **Step 3: 验证编译**

Run: `cd "E:\trea\写作桌面应用" && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: 无新报错

- [ ] **Step 4: 跑现有 review-flow 测试确认无回归**

Run: `cd "E:\trea\写作桌面应用" && npx vitest run tests/review-flow-service.test.ts 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd "E:\trea\写作桌面应用"
git add src/main/data/review-flow-service.ts
git commit -m "feat(review): runDeepReview 接入自定义 LLM 检查项"
```

---

## Task 5: write-service 透传 customLlmChecks

让 settings 里的自定义 llm 项能传到 review-flow-service。

**Files:**
- Modify: `src/main/data/write-service.ts:215-291`（runDeepReview）

- [ ] **Step 1: 在 read reviewRules 处读出自定义 llm 项**

`write-service.ts` 的 `runDeepReview`（约 215 行）。当前 `if (this.settings)` 块（约 233-256 行）里读了 `rules`。我们在此块内同时收集自定义 llm 项，并在最后传给 `reviewFlow.runDeepReview`。

把现有（约 222-256 行相关部分）：

```ts
    let genre: string | undefined
    let enabledChecks: ReviewCheckId[] | undefined
    let characterCards = ''
    let outline = ''
    const dir = await this.projectService.resolveDir(projectId).catch(() => null)
```

改为（加一个 `customLlmChecks` 变量）：

```ts
    let genre: string | undefined
    let enabledChecks: ReviewCheckId[] | undefined
    let characterCards = ''
    let outline = ''
    let customLlmChecks: CustomReviewCheck[] | undefined
    const dir = await this.projectService.resolveDir(projectId).catch(() => null)
```

- [ ] **Step 2: 在 settings 读取块内收集自定义 llm 项**

把现有（约 233-256 行）：

```ts
    // 启用项：只跑 settings 里未关闭的 LLM 类检查
    if (this.settings) {
      try {
        const rules = await this.settings.getReviewRules()
        if (rules.enabled) {
          enabledChecks = (
            [
              'character_breakdown',
              'logic_hole',
              'low_iq_plot',
              'emotion_cliff',
              'hook_grade',
              'style_match',
              'cool_point',
              'quote_contradiction'
            ] as ReviewCheckId[]
          ).filter((c) => rules.checks[c] !== false)
        } else {
          // 审稿总开关关 → 不跑
          return []
        }
      } catch (err) {
        console.warn('[runDeepReview] Failed to read reviewRules:', err)
      }
    }
```

改为（在 enabledChecks 赋值后追加自定义 llm 项收集）：

```ts
    // 启用项：只跑 settings 里未关闭的 LLM 类检查
    if (this.settings) {
      try {
        const rules = await this.settings.getReviewRules()
        if (rules.enabled) {
          enabledChecks = (
            [
              'character_breakdown',
              'logic_hole',
              'low_iq_plot',
              'emotion_cliff',
              'hook_grade',
              'style_match',
              'cool_point',
              'quote_contradiction'
            ] as ReviewCheckId[]
          ).filter((c) => rules.checks[c] !== false)
          // 自定义 LLM 项：只取 enabled 且开关未关的
          customLlmChecks = (rules.customChecks ?? []).filter(
            (c) => c.type === 'llm' && c.enabled && rules.checks[c.id] !== false
          )
        } else {
          // 审稿总开关关 → 不跑
          return []
        }
      } catch (err) {
        console.warn('[runDeepReview] Failed to read reviewRules:', err)
      }
    }
```

- [ ] **Step 3: 在最终调用处透传**

把现有（约 286-290 行）：

```ts
    return this.reviewFlow.runDeepReview(
      content,
      { chapterNumber, genre, enabledChecks, characterCards, outline },
      { ...opts, meta: { feature: 'deepReview', projectId, ...opts.meta } }
    )
```

改为：

```ts
    return this.reviewFlow.runDeepReview(
      content,
      { chapterNumber, genre, enabledChecks, characterCards, outline, customLlmChecks },
      { ...opts, meta: { feature: 'deepReview', projectId, ...opts.meta } }
    )
```

- [ ] **Step 4: 补 import**

在 `write-service.ts` 顶部 import（找 `from '../../shared/types'`）确保 `CustomReviewCheck` 已导入，若无则加入现有类型 import 列表。

Run: `cd "E:\trea\写作桌面应用" && grep -n "from '../../shared/types'" src/main/data/write-service.ts`
读该行，把 `CustomReviewCheck` 加入 import 类型列表。

- [ ] **Step 5: 验证编译**

Run: `cd "E:\trea\写作桌面应用" && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: 无新报错

- [ ] **Step 6: Commit**

```bash
cd "E:\trea\写作桌面应用"
git add src/main/data/write-service.ts
git commit -m "feat(review): write-service 透传自定义 LLM 检查项到深度审稿"
```

---

## Task 6: settings-repository sanitize 扩展（TDD）

持久化层的清洗逻辑。先写测试。

**Files:**
- Modify: `tests/review-rules.test.ts`
- Modify: `src/main/data/settings-repository.ts:155-184`（sanitizeReviewRules）

- [ ] **Step 1: 扩展测试文件**

打开 `tests/review-rules.test.ts`，在文件末尾（最后一个 describe 之后）追加新的 describe 块：

```ts
describe('SettingsRepository custom checks / builtinMeta / hiddenBuiltin', () => {
  let repo: SettingsRepository

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-cc-'))
    repo = new SettingsRepository(path.join(dir, 'settings.json'))
  })

  it('持久化 customChecks（合法项）', async () => {
    const saved = await repo.setReviewRules({
      customChecks: [
        {
          id: 'custom_words',
          label: '我的禁用词',
          hint: '命中提醒',
          severity: 'warn',
          type: 'keyword',
          group: 'toxic',
          keywords: ['居然', '竟然'],
          enabled: true
        }
      ]
    })
    expect(saved.customChecks?.length).toBe(1)
    expect(saved.customChecks?.[0].id).toBe('custom_words')
    expect(saved.customChecks?.[0].keywords).toEqual(['居然', '竟然'])
    expect(await repo.getReviewRules()).toEqual(saved)
  })

  it('丢弃非法 custom id（非 custom_ 前缀）', async () => {
    const saved = await repo.setReviewRules({
      customChecks: [
        { id: 'badid', label: 'x', hint: '', severity: 'warn', type: 'keyword', group: 'toxic', keywords: ['a'], enabled: true },
        { id: 'custom_ok', label: 'y', hint: '', severity: 'warn', type: 'keyword', group: 'toxic', keywords: ['b'], enabled: true }
      ]
    })
    expect(saved.customChecks?.length).toBe(1)
    expect(saved.customChecks?.[0].id).toBe('custom_ok')
  })

  it('丢弃非法正则的 regex 项', async () => {
    const saved = await repo.setReviewRules({
      customChecks: [
        { id: 'custom_bad', label: 'x', hint: '', severity: 'warn', type: 'regex', group: 'quality', pattern: '[unclosed', enabled: true },
        { id: 'custom_ok', label: 'y', hint: '', severity: 'warn', type: 'regex', group: 'quality', pattern: 'abc', enabled: true }
      ]
    })
    expect(saved.customChecks?.length).toBe(1)
    expect(saved.customChecks?.[0].id).toBe('custom_ok')
  })

  it('custom id 去重', async () => {
    const saved = await repo.setReviewRules({
      customChecks: [
        { id: 'custom_dup', label: 'a', hint: '', severity: 'warn', type: 'keyword', group: 'toxic', keywords: ['x'], enabled: true },
        { id: 'custom_dup', label: 'b', hint: '', severity: 'warn', type: 'keyword', group: 'toxic', keywords: ['y'], enabled: true }
      ]
    })
    expect(saved.customChecks?.length).toBe(1)
  })

  it('持久化 builtinMeta（编辑内置项元数据）', async () => {
    const saved = await repo.setReviewRules({
      builtinMeta: { meta_break: { label: '改名', severity: 'warn' } }
    })
    expect(saved.builtinMeta?.meta_break?.label).toBe('改名')
    expect(saved.builtinMeta?.meta_break?.severity).toBe('warn')
  })

  it('builtinMeta 仅保留白名单 checkId', async () => {
    const saved = await repo.setReviewRules({
      builtinMeta: { bogus_id: { label: 'x' } as never, meta_break: { label: 'y' } }
    })
    expect((saved.builtinMeta as Record<string, unknown>).bogus_id).toBeUndefined()
    expect(saved.builtinMeta?.meta_break?.label).toBe('y')
  })

  it('持久化 hiddenBuiltin（软删除内置项）', async () => {
    const saved = await repo.setReviewRules({
      hiddenBuiltin: ['meta_break', 'pov_mix']
    })
    expect(saved.hiddenBuiltin).toEqual(['meta_break', 'pov_mix'])
  })

  it('hiddenBuiltin 仅保留白名单 id 并去重', async () => {
    const saved = await repo.setReviewRules({
      hiddenBuiltin: ['meta_break', 'meta_break', 'bogus' as never]
    })
    expect(saved.hiddenBuiltin).toEqual(['meta_break'])
  })

  it('checks 白名单含 custom id', async () => {
    // 先建一个自定义项
    await repo.setReviewRules({
      customChecks: [
        { id: 'custom_c', label: 'x', hint: '', severity: 'warn', type: 'keyword', group: 'toxic', keywords: ['a'], enabled: true }
      ]
    })
    // 再关掉它
    const saved = await repo.setReviewRules({ checks: { custom_c: false } })
    expect(saved.checks.custom_c).toBe(false)
  })

  it('空/缺省时 customChecks/builtinMeta/hiddenBuiltin 返回默认（[]/{}/[]）', async () => {
    const cfg = await repo.getReviewRules()
    expect(cfg.customChecks).toEqual([])
    expect(cfg.builtinMeta).toEqual({})
    expect(cfg.hiddenBuiltin).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd "E:\trea\写作桌面应用" && npx vitest run tests/review-rules.test.ts 2>&1 | tail -20`
Expected: 新增测试 FAIL（customChecks 等字段未实现 / 返回 undefined）

- [ ] **Step 3: 实现 sanitize 辅助函数**

打开 `src/main/data/settings-repository.ts`，在 `sanitizeReviewRules` 函数（约 155 行）之前插入三个辅助函数：

```ts
function sanitizeCustomChecks(raw: unknown): CustomReviewCheck[] {
  if (!Array.isArray(raw)) return []
  const out: CustomReviewCheck[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Partial<CustomReviewCheck>
    // id：必须 custom_ 前缀 + 合法字符，且唯一
    const id = typeof r.id === 'string' ? r.id.trim() : ''
    if (!/^custom_[a-z0-9_]+$/.test(id) || seen.has(id)) continue
    const label = typeof r.label === 'string' ? r.label.trim() : ''
    const hint = typeof r.hint === 'string' ? r.hint.trim() : ''
    if (!label) continue
    const severity = r.severity === 'error' || r.severity === 'warn' || r.severity === 'info' ? r.severity : 'warn'
    const type = r.type === 'keyword' || r.type === 'regex' || r.type === 'llm' ? r.type : 'keyword'
    const group = typeof r.group === 'string' ? (r.group as AuditCategory) : 'toxic'
    const check: CustomReviewCheck = {
      id, label, hint, severity, type, group, enabled: typeof r.enabled === 'boolean' ? r.enabled : true
    }
    // 类型相关配置校验
    if (type === 'keyword') {
      const kw = sanitizeWordList(r.keywords)
      if (kw.length === 0) continue // 关键词项无词表 = 无意义，丢弃
      check.keywords = kw.slice(0, 500)
    } else if (type === 'regex') {
      const pat = typeof r.pattern === 'string' ? r.pattern.trim() : ''
      if (!pat) continue
      try {
        new RegExp(pat) // 非法正则抛错 → 丢弃
      } catch {
        continue
      }
      check.pattern = pat.slice(0, 500)
    } else {
      // llm
      const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : ''
      if (!prompt) continue
      check.prompt = prompt.slice(0, 2000)
    }
    seen.add(id)
    out.push(check)
    if (out.length >= 50) break // 上限 50 条
  }
  return out
}

function sanitizeBuiltinMeta(raw: unknown): Partial<Record<ReviewCheckId, BuiltinCheckMeta>> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Partial<Record<ReviewCheckId, BuiltinCheckMeta>> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!REVIEW_CHECK_KEYS.has(k as ReviewCheckId)) continue
    if (!v || typeof v !== 'object') continue
    const r = v as Partial<BuiltinCheckMeta>
    const meta: BuiltinCheckMeta = {}
    if (typeof r.label === 'string' && r.label.trim()) meta.label = r.label.trim().slice(0, 100)
    if (typeof r.hint === 'string') meta.hint = r.hint.trim().slice(0, 300)
    if (r.severity === 'error' || r.severity === 'warn' || r.severity === 'info') meta.severity = r.severity
    out[k as ReviewCheckId] = meta
  }
  return out
}

function sanitizeHiddenBuiltin(raw: unknown): ReviewCheckId[] {
  if (!Array.isArray(raw)) return []
  const out: ReviewCheckId[] = []
  const seen = new Set<string>()
  for (const id of raw) {
    if (typeof id !== 'string') continue
    if (!REVIEW_CHECK_KEYS.has(id as ReviewCheckId)) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id as ReviewCheckId)
  }
  return out
}
```

确认文件顶部 import 区已引入所需类型。读取 `src/main/data/settings-repository.ts` 第 1-15 行，确保 import 包含：

```ts
import type {
  // ...现有...
  AuditCategory,
  BuiltinCheckMeta,
  CustomReviewCheck,
  ReviewCheckId
} from '../../shared/types'
```

并在文件顶部确认 `REVIEW_CHECK_KEYS` 已 import（来自 skill-prompts）。

- [ ] **Step 4: 修改 sanitizeReviewRules 接入新字段 + checks 白名单扩展**

把现有（约 155-184 行）：

```ts
function sanitizeReviewRules(raw: unknown): ReviewRulesConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReviewRulesConfig>
  const checks: Partial<Record<ReviewCheckId, boolean>> = {}
  if (r.checks && typeof r.checks === 'object') {
    for (const [k, v] of Object.entries(r.checks)) {
      if (REVIEW_CHECK_KEYS.has(k as ReviewCheckId) && typeof v === 'boolean') {
        checks[k as ReviewCheckId] = v
      }
    }
  }
  const thresholds = clampThresholds(r.thresholds)
  const wordLists: ReviewWordLists = {
    metaBreak: sanitizeWordList(r.wordLists?.metaBreak).length
      ? sanitizeWordList(r.wordLists?.metaBreak)
      : [...DEFAULT_REVIEW_WORD_LISTS.metaBreak],
    sensitive: sanitizeWordList(r.wordLists?.sensitive).length
      ? sanitizeWordList(r.wordLists?.sensitive)
      : [...DEFAULT_REVIEW_WORD_LISTS.sensitive]
  }
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_REVIEW_RULES.enabled,
    autoDeepReview:
      typeof r.autoDeepReview === 'boolean'
        ? r.autoDeepReview
        : DEFAULT_REVIEW_RULES.autoDeepReview,
    checks,
    thresholds,
    wordLists
  }
}
```

改为（先 sanitize customChecks，用其结果扩展 checks 白名单，再返回新字段）：

```ts
function sanitizeReviewRules(raw: unknown): ReviewRulesConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReviewRulesConfig>
  // 先清洗自定义项（checks 白名单要含 custom id）
  const customChecks = sanitizeCustomChecks(r.customChecks)
  const customIds = new Set(customChecks.map((c) => c.id))
  const allCheckKeys = new Set<string>([...REVIEW_CHECK_KEYS, ...customIds])
  const checks: Partial<Record<string, boolean>> = {}
  if (r.checks && typeof r.checks === 'object') {
    for (const [k, v] of Object.entries(r.checks)) {
      if (allCheckKeys.has(k) && typeof v === 'boolean') {
        checks[k] = v
      }
    }
  }
  const thresholds = clampThresholds(r.thresholds)
  const wordLists: ReviewWordLists = {
    metaBreak: sanitizeWordList(r.wordLists?.metaBreak).length
      ? sanitizeWordList(r.wordLists?.metaBreak)
      : [...DEFAULT_REVIEW_WORD_LISTS.metaBreak],
    sensitive: sanitizeWordList(r.wordLists?.sensitive).length
      ? sanitizeWordList(r.wordLists?.sensitive)
      : [...DEFAULT_REVIEW_WORD_LISTS.sensitive]
  }
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_REVIEW_RULES.enabled,
    autoDeepReview:
      typeof r.autoDeepReview === 'boolean'
        ? r.autoDeepReview
        : DEFAULT_REVIEW_RULES.autoDeepReview,
    checks,
    thresholds,
    wordLists,
    builtinMeta: sanitizeBuiltinMeta(r.builtinMeta),
    hiddenBuiltin: sanitizeHiddenBuiltin(r.hiddenBuiltin),
    customChecks
  }
}
```

- [ ] **Step 5: 修改 setReviewRules 增量合并新字段**

`setReviewRules`（约 319 行）当前合并 checks。补上 builtinMeta/hiddenBuiltin/customChecks 的合并。

把现有（约 330-338 行）：

```ts
    const merged: Partial<ReviewRulesConfig> = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      autoDeepReview:
        typeof patch.autoDeepReview === 'boolean' ? patch.autoDeepReview : current.autoDeepReview,
      checks: mergedChecks,
      thresholds: patch.thresholds ? { ...current.thresholds, ...patch.thresholds } : current.thresholds,
      wordLists: patch.wordLists ? { ...current.wordLists, ...patch.wordLists } : current.wordLists
    }
    await this.update({ reviewRules: merged })
    return this.getReviewRules()
```

改为：

```ts
    const merged: Partial<ReviewRulesConfig> = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      autoDeepReview:
        typeof patch.autoDeepReview === 'boolean' ? patch.autoDeepReview : current.autoDeepReview,
      checks: mergedChecks,
      thresholds: patch.thresholds ? { ...current.thresholds, ...patch.thresholds } : current.thresholds,
      wordLists: patch.wordLists ? { ...current.wordLists, ...patch.wordLists } : current.wordLists,
      // builtinMeta 浅合并（同 key 覆盖）
      builtinMeta: patch.builtinMeta
        ? { ...current.builtinMeta, ...patch.builtinMeta }
        : current.builtinMeta,
      // hiddenBuiltin / customChecks 整体替换（CRUD 语义清晰）
      hiddenBuiltin: patch.hiddenBuiltin !== undefined ? patch.hiddenBuiltin : current.hiddenBuiltin,
      customChecks: patch.customChecks !== undefined ? patch.customChecks : current.customChecks
    }
    await this.update({ reviewRules: merged })
    return this.getReviewRules()
```

- [ ] **Step 6: 修复默认值类型兼容**

`DEFAULTS`（约 84-92 行）里 `reviewRules: DEFAULT_REVIEW_RULES`。`DEFAULT_REVIEW_RULES` 在 review-checks.ts 定义。打开 `src/main/data/skill-prompts/review-checks.ts:285-294`，给默认对象补 3 字段（避免 sanitize 返回 {} 而默认值 undefined）：

把现有：

```ts
export const DEFAULT_REVIEW_RULES = {
  enabled: true,
  autoDeepReview: false,
  checks: {} as Partial<Record<ReviewCheckId, boolean>>,
  thresholds: { ...DEFAULT_REVIEW_THRESHOLDS },
  wordLists: {
    metaBreak: [...DEFAULT_REVIEW_WORD_LISTS.metaBreak],
    sensitive: [...DEFAULT_REVIEW_WORD_LISTS.sensitive]
  }
}
```

改为：

```ts
export const DEFAULT_REVIEW_RULES = {
  enabled: true,
  autoDeepReview: false,
  checks: {} as Partial<Record<string, boolean>>,
  thresholds: { ...DEFAULT_REVIEW_THRESHOLDS },
  wordLists: {
    metaBreak: [...DEFAULT_REVIEW_WORD_LISTS.metaBreak],
    sensitive: [...DEFAULT_REVIEW_WORD_LISTS.sensitive]
  },
  builtinMeta: {} as Partial<Record<ReviewCheckId, BuiltinCheckMeta>>,
  hiddenBuiltin: [] as ReviewCheckId[],
  customChecks: [] as CustomReviewCheck[]
}
```

并确认该文件顶部 import 补上 `BuiltinCheckMeta, CustomReviewCheck`（来自 shared/types）：

```ts
import type { AuditSeverity, ReviewCheckId, ReviewThresholds, ReviewWordLists, BuiltinCheckMeta, CustomReviewCheck } from '../../../shared/types'
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd "E:\trea\写作桌面应用" && npx vitest run tests/review-rules.test.ts 2>&1 | tail -20`
Expected: PASS（全部测试，含原有 + 新增）

- [ ] **Step 8: 验证编译**

Run: `cd "E:\trea\写作桌面应用" && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: 无报错

- [ ] **Step 9: Commit**

```bash
cd "E:\trea\写作桌面应用"
git add src/main/data/settings-repository.ts src/main/data/skill-prompts/review-checks.ts tests/review-rules.test.ts
git commit -m "feat(review): 持久化层支持自定义检查项/元数据覆盖/软删除（sanitize+TDD）"
```

---

## Task 7: IPC 层 getReviewRules 合并展示 + setReviewRules zod 扩展

让前端能拿到合并后的检查项清单（内置+自定义、应用元数据覆盖、过滤隐藏项），并能提交 CRUD patch。

**Files:**
- Modify: `src/main/ipc/settings.ts:201-248`

- [ ] **Step 1: 改 getReviewRules handler 合并展示**

打开 `src/main/ipc/settings.ts:201-215`。把现有：

```ts
  /** 审稿规则：读取检查项清单（含默认信息）+ 当前配置 */
  safeHandle('settings:getReviewRules', async () => {
    const config = await repo.getReviewRules()
    return {
      sections: REVIEW_CHECK_SECTIONS.map((s) => ({
        checkId: s.checkId,
        kind: s.kind,
        group: s.group,
        label: s.label,
        defaultSeverity: s.defaultSeverity,
        hint: s.hint
      })),
      config
    }
  })
```

改为（应用 builtinMeta 覆盖、过滤 hiddenBuiltin、追加 customChecks）：

```ts
  /** 审稿规则：读取检查项清单（内置应用元数据覆盖 + 自定义）+ 当前配置 */
  safeHandle('settings:getReviewRules', async () => {
    const config = await repo.getReviewRules()
    const hidden = new Set(config.hiddenBuiltin ?? [])
    const meta = config.builtinMeta ?? {}
    const builtinSections = REVIEW_CHECK_SECTIONS.filter((s) => !hidden.has(s.checkId)).map(
      (s) => {
        const m = meta[s.checkId]
        return {
          checkId: s.checkId,
          kind: s.kind,
          group: s.group,
          label: m?.label ?? s.label,
          defaultSeverity: m?.severity ?? s.defaultSeverity,
          hint: m?.hint ?? s.hint,
          isCustom: false as const
        }
      }
    )
    const customSections = (config.customChecks ?? []).map((c) => ({
      checkId: c.id,
      kind: c.type === 'llm' ? ('llm' as const) : ('algorithm' as const),
      group: c.group,
      label: c.label,
      defaultSeverity: c.severity,
      hint: c.hint,
      isCustom: true as const,
      customType: c.type,
      keywords: c.keywords,
      pattern: c.pattern,
      prompt: c.prompt
    }))
    return {
      sections: [...builtinSections, ...customSections],
      config
    }
  })
```

- [ ] **Step 2: 改 setReviewRules zod schema 支持新字段**

把现有（约 218-248 行）：

```ts
  /** 保存审稿规则配置（开关/阈值/词表）；非白名单 checkId 由 repo 层清洗丢弃 */
  safeHandle('settings:setReviewRules', async (_e, patch) => {
    const checkIdEnum = z.custom<ReviewCheckId>(
      (v): v is ReviewCheckId => typeof v === 'string' && REVIEW_CHECK_KEYS.has(v as ReviewCheckId),
      '非法 checkId'
    )
    const validated = validateInput(
      z.object({
        enabled: z.boolean().optional(),
        autoDeepReview: z.boolean().optional(),
        checks: z.record(checkIdEnum, z.boolean()).optional(),
        thresholds: z
          .object({
            minWords: z.number().int().min(1).max(100000).optional(),
            maxWords: z.number().int().min(1).max(100000).optional(),
            maxParagraphLen: z.number().int().min(1).max(10000).optional(),
            dashDensityPer100: z.number().min(0).max(100).optional(),
            repetitionLen: z.number().int().min(1).max(1000).optional(),
            maxSentenceLen: z.number().int().min(1).max(10000).optional()
          })
          .optional(),
        wordLists: z
          .object({
            metaBreak: z.array(z.string().max(100)).max(1000).optional(),
            sensitive: z.array(z.string().max(100)).max(1000).optional()
          })
          .optional()
      }),
      patch
    )
    return repo.setReviewRules(validated)
  })
```

改为（checks key 放宽为 string，新增 builtinMeta/hiddenBuiltin/customChecks）：

```ts
  /** 保存审稿规则配置（开关/阈值/词表/自定义项/元数据/软删除） */
  safeHandle('settings:setReviewRules', async (_e, patch) => {
    const checkIdEnum = z.custom<ReviewCheckId>(
      (v): v is ReviewCheckId => typeof v === 'string' && REVIEW_CHECK_KEYS.has(v as ReviewCheckId),
      '非法 checkId'
    )
    const validated = validateInput(
      z.object({
        enabled: z.boolean().optional(),
        autoDeepReview: z.boolean().optional(),
        // checks key 放宽为 string（含 custom_ 前缀），repo 层用运行时白名单清洗
        checks: z.record(z.string(), z.boolean()).optional(),
        thresholds: z
          .object({
            minWords: z.number().int().min(1).max(100000).optional(),
            maxWords: z.number().int().min(1).max(100000).optional(),
            maxParagraphLen: z.number().int().min(1).max(10000).optional(),
            dashDensityPer100: z.number().min(0).max(100).optional(),
            repetitionLen: z.number().int().min(1).max(1000).optional(),
            maxSentenceLen: z.number().int().min(1).max(10000).optional()
          })
          .optional(),
        wordLists: z
          .object({
            metaBreak: z.array(z.string().max(100)).max(1000).optional(),
            sensitive: z.array(z.string().max(100)).max(1000).optional()
          })
          .optional(),
        builtinMeta: z
          .record(
            checkIdEnum,
            z.object({
              label: z.string().max(100).optional(),
              hint: z.string().max(300).optional(),
              severity: z.enum(['error', 'warn', 'info']).optional()
            })
          )
          .optional(),
        hiddenBuiltin: z.array(checkIdEnum).max(50).optional(),
        customChecks: z
          .array(
            z.object({
              id: z.string().min(1).max(60),
              label: z.string().min(1).max(100),
              hint: z.string().max(300),
              severity: z.enum(['error', 'warn', 'info']),
              type: z.enum(['keyword', 'regex', 'llm']),
              group: z.string().min(1).max(40),
              keywords: z.array(z.string().max(100)).max(500).optional(),
              pattern: z.string().max(500).optional(),
              prompt: z.string().max(2000).optional(),
              enabled: z.boolean()
            })
          )
          .max(50)
          .optional()
      }),
      patch
    )
    return repo.setReviewRules(validated)
  })
```

- [ ] **Step 3: 验证编译**

Run: `cd "E:\trea\写作桌面应用" && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: 无报错

- [ ] **Step 4: Commit**

```bash
cd "E:\trea\写作桌面应用"
git add src/main/ipc/settings.ts
git commit -m "feat(review): IPC 层合并检查项展示 + 自定义项 zod 校验"
```

---

## Task 8: 前端 UI — 检查项卡片编辑/删除/隐藏

让每条检查项可编辑元数据、可删除（内置软删/自定义硬删）。这是 UI 的第一部分。

**Files:**
- Modify: `src/renderer/src/SettingsPage.tsx:1117-1177`（检查项清单区）

- [ ] **Step 1: 在组件内加编辑/删除状态**

打开 `src/renderer/src/SettingsPage.tsx`，找到检查项清单渲染处（约 1117 行 `<h4>检查项</h4>`）。先在组件函数体顶部（找现有 useState 区，约 122 行 `reviewSections` 附近）加状态：

```ts
  // 编辑中的检查项 checkId（null = 无）；CRUD 状态
  const [editingCheckId, setEditingCheckId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<{ label: string; hint: string; severity: 'error' | 'warn' | 'info' }>({
    label: '', hint: '', severity: 'warn'
  })
  // 待确认删除的自定义项 id（二次确认）
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
```

- [ ] **Step 2: 改造检查项清单渲染（每项加编辑/删除按钮）**

把现有检查项清单区（约 1117-1177 行整段，从 `<h4>检查项</h4>` 到该 grid div 结束）替换为：

```tsx
              {/* 检查项清单：算法 / LLM 分组 */}
              <h4 className="sub" style={{ marginTop: 18, fontSize: 13.5 }}>
                检查项
              </h4>
              <div style={{ display: 'grid', gap: 12, marginTop: 10 }}>
                {(['algorithm', 'llm'] as const).map((kind) => {
                  const list = reviewSections.filter((s) => s.kind === kind)
                  if (list.length === 0) return null
                  return (
                    <div
                      key={kind}
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        padding: 10
                      }}
                    >
                      <div className="meta" style={{ marginBottom: 8, fontSize: 12 }}>
                        {kind === 'algorithm' ? '算法检查（实时，不调 LLM）' : 'LLM 深度审稿（按需）'}
                      </div>
                      <div style={{ display: 'grid', gap: 8 }}>
                        {list.map((s) => {
                          const on = reviewCfg.checks[s.checkId] !== false
                          const pill =
                            s.defaultSeverity === 'error'
                              ? '🚨'
                              : s.defaultSeverity === 'warn'
                                ? '⚠'
                                : '💡'
                          const isEditing = editingCheckId === s.checkId
                          return (
                            <div key={s.checkId} style={{ borderBottom: '1px dashed var(--border-soft)', paddingBottom: 6 }}>
                              <label className="row" style={{ gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
                                <input
                                  type="checkbox"
                                  checked={on && reviewCfg.enabled}
                                  disabled={!reviewCfg.enabled}
                                  style={{ marginTop: 2 }}
                                  onChange={async (e) => {
                                    const next = await window.api.setReviewRules({
                                      checks: { [s.checkId]: e.target.checked }
                                    })
                                    setReviewCfg(next)
                                  }}
                                />
                                <span style={{ flex: 1 }}>
                                  {pill} <strong>{s.label}</strong>
                                  {s.isCustom && (
                                    <span className="meta" style={{ marginLeft: 6, fontSize: 11 }}>
                                      [{s.customType}]
                                    </span>
                                  )}
                                  <span className="meta" style={{ marginLeft: 6 }}>{s.hint}</span>
                                </span>
                              </label>
                              {/* 编辑/删除按钮 */}
                              <div className="row" style={{ gap: 6, marginTop: 4, marginLeft: 24 }}>
                                {!isEditing && (
                                  <>
                                    <button
                                      className="btn btn-ghost btn-sm"
                                      style={{ padding: '1px 6px', fontSize: 11 }}
                                      onClick={() => {
                                        setEditingCheckId(s.checkId)
                                        setEditDraft({
                                          label: s.label,
                                          hint: s.hint,
                                          severity: s.defaultSeverity
                                        })
                                      }}
                                    >
                                      ✎ 编辑
                                    </button>
                                    {s.isCustom ? (
                                      <button
                                        className="btn btn-ghost btn-sm"
                                        style={{ padding: '1px 6px', fontSize: 11, color: 'var(--vermilion)' }}
                                        onClick={() => {
                                          if (pendingDeleteId === s.checkId) {
                                            // 二次确认 → 硬删
                                            const next = (reviewCfg.customChecks ?? []).filter(
                                              (c) => c.id !== s.checkId
                                            )
                                            void window.api.setReviewRules({ customChecks: next }).then((cfg) => {
                                              setReviewCfg(cfg)
                                              // 同步刷新 sections
                                              void window.api.getReviewRules().then((b) => setReviewSections(b.sections))
                                            })
                                            setPendingDeleteId(null)
                                          } else {
                                            setPendingDeleteId(s.checkId)
                                          }
                                        }}
                                      >
                                        {pendingDeleteId === s.checkId ? '⚠ 确认删除？' : '🗑 删除'}
                                      </button>
                                    ) : (
                                      <button
                                        className="btn btn-ghost btn-sm"
                                        style={{ padding: '1px 6px', fontSize: 11 }}
                                        title="隐藏此项（可在下方「已隐藏」区恢复）"
                                        onClick={async () => {
                                          const next = [...(reviewCfg.hiddenBuiltin ?? []), s.checkId as ReviewCheckId]
                                          const cfg = await window.api.setReviewRules({ hiddenBuiltin: next })
                                          setReviewCfg(cfg)
                                          void window.api.getReviewRules().then((b) => {
                                            setReviewSections(b.sections)
                                            setHiddenSections(b.hiddenSections ?? [])
                                          })
                                        }}
                                      >
                                        🗑 隐藏
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>
                              {/* 编辑表单 */}
                              {isEditing && (
                                <div style={{ marginTop: 6, marginLeft: 24, padding: 8, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--surface-2)' }}>
                                  <div className="field" style={{ marginBottom: 6 }}>
                                    <label style={{ fontSize: 11.5 }}>名称</label>
                                    <input
                                      className="input"
                                      value={editDraft.label}
                                      onChange={(e) => setEditDraft((d) => ({ ...d, label: e.target.value }))}
                                    />
                                  </div>
                                  <div className="field" style={{ marginBottom: 6 }}>
                                    <label style={{ fontSize: 11.5 }}>说明</label>
                                    <input
                                      className="input"
                                      value={editDraft.hint}
                                      onChange={(e) => setEditDraft((d) => ({ ...d, hint: e.target.value }))}
                                    />
                                  </div>
                                  <div className="field" style={{ marginBottom: 8 }}>
                                    <label style={{ fontSize: 11.5 }}>严重度</label>
                                    <select
                                      className="input"
                                      value={editDraft.severity}
                                      onChange={(e) => setEditDraft((d) => ({ ...d, severity: e.target.value as 'error' | 'warn' | 'info' }))}
                                    >
                                      <option value="error">🚨 错误（error）</option>
                                      <option value="warn">⚠ 提醒（warn）</option>
                                      <option value="info">💡 建议（info）</option>
                                    </select>
                                  </div>
                                  <div className="row" style={{ gap: 6 }}>
                                    <button
                                      className="btn btn-sm"
                                      onClick={async () => {
                                        // 内置项 → builtinMeta 覆盖；自定义项 → 改 customChecks
                                        if (s.isCustom) {
                                          const next = (reviewCfg.customChecks ?? []).map((c) =>
                                            c.id === s.checkId
                                              ? { ...c, label: editDraft.label, hint: editDraft.hint, severity: editDraft.severity }
                                              : c
                                          )
                                          const cfg = await window.api.setReviewRules({ customChecks: next })
                                          setReviewCfg(cfg)
                                        } else {
                                          const cfg = await window.api.setReviewRules({
                                            builtinMeta: { [s.checkId]: { label: editDraft.label, hint: editDraft.hint, severity: editDraft.severity } }
                                          })
                                          setReviewCfg(cfg)
                                        }
                                        void window.api.getReviewRules().then((b) => setReviewSections(b.sections))
                                        setEditingCheckId(null)
                                      }}
                                    >
                                      保存
                                    </button>
                                    <button className="btn btn-ghost btn-sm" onClick={() => setEditingCheckId(null)}>
                                      取消
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* 已隐藏的内置项（可恢复）— 渲染数据来自后端 hiddenSections，见 Step 3 */}
              {hiddenSections.length > 0 && (
                <div style={{ marginTop: 10, padding: 10, border: '1px dashed var(--border)', borderRadius: 6 }}>
                  <div className="meta" style={{ fontSize: 12, marginBottom: 6 }}>已隐藏（点恢复）</div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {hiddenSections.map((h) => (
                      <button
                        key={h.checkId}
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 11 }}
                        onClick={async () => {
                          const next = (reviewCfg.hiddenBuiltin ?? []).filter((x) => x !== h.checkId)
                          const cfg = await window.api.setReviewRules({ hiddenBuiltin: next })
                          setReviewCfg(cfg)
                          void window.api.getReviewRules().then((b) => {
                            setReviewSections(b.sections)
                            setHiddenSections(b.hiddenSections ?? [])
                          })
                        }}
                      >
                        ↩ 恢复「{h.label}」
                      </button>
                    ))}
                  </div>
                </div>
              )}
```

> 注：`hiddenSections` 来自后端返回（见 Step 3），避免前端 import main 常量。`hiddenSections` state 在 Step 3 声明——实现时请把 Step 3 的 state 声明（`const [hiddenSections, setHiddenSections] = useState<...>([])`）提前到 Step 1 一起加，否则本步渲染会报未定义。

- [ ] **Step 3: 让已隐藏项也能拿到 label（调整后端返回）**

为避免前端 import main 常量，调整 `src/main/ipc/settings.ts` 的 getReviewRules，额外返回被隐藏项的 `{ checkId, label }`（用默认 label，不应用覆盖）。把 Step 1（Task 7）里返回的对象补一个 `hiddenSections`：

在 `src/main/ipc/settings.ts` 的 getReviewRules handler，`return { sections: [...builtinSections, ...customSections], config }` 改为：

```ts
    const hiddenSections = REVIEW_CHECK_SECTIONS.filter((s) => hidden.has(s.checkId)).map((s) => ({
      checkId: s.checkId,
      label: meta[s.checkId]?.label ?? s.label
    }))
    return {
      sections: [...builtinSections, ...customSections],
      hiddenSections,
      config
    }
```

然后前端把 Step 2 里"已隐藏区"用 `hiddenSections` 而非 `REVIEW_CHECK_SECTIONS`。前端需存这个状态：在组件顶部加：

```ts
  const [hiddenSections, setHiddenSections] = useState<{ checkId: string; label: string }[]>([])
```

并把 getReviewRules 的 then 回调（约 149 行 `setReviewSections(bundle.sections)`）补一行：

```ts
      setReviewSections(bundle.sections)
      setHiddenSections(bundle.hiddenSections ?? [])
```

最后更新 `src/shared/types.ts` 的 `ReviewRulesBundle`（约 249 行）加 hiddenSections 字段，否则 TS 报缺字段：

```ts
export interface ReviewRulesBundle {
  sections: ReviewCheckSectionView[]
  hiddenSections: { checkId: string; label: string }[]
  config: ReviewRulesConfig
}
```

（已隐藏区的渲染代码已在 Step 2 用 `hiddenSections` 写好，无需在此重复。）

> 同时更新 `src/shared/types.ts` 的 `RendererApi.getReviewRules` 返回类型与 `ReviewRulesBundle`：把 `ReviewRulesBundle`（约 249 行）改为：
> ```ts
> export interface ReviewRulesBundle {
>   sections: ReviewCheckSectionView[]
>   hiddenSections: { checkId: string; label: string }[]
>   config: ReviewRulesConfig
> }
> ```

- [ ] **Step 4: 验证编译**

Run: `cd "E:\trea\写作桌面应用" && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: 无报错

- [ ] **Step 5: 启动应用手动验证**

Run: `cd "E:\trea\写作桌面应用" && npm run dev` （在另一个终端，或后台）
手动验证：设置 → 审稿规则 → 检查项
- 点某内置项「✎ 编辑」→ 改名称/说明/严重度 → 保存 → 名称更新
- 点某内置项「🗑 隐藏」→ 从列表消失，出现在「已隐藏」区
- 点「↩ 恢复」→ 回到列表
- 验证关闭后重启应用，改动持久化

- [ ] **Step 6: Commit**

```bash
cd "E:\trea\写作桌面应用"
git add src/renderer/src/SettingsPage.tsx src/main/ipc/settings.ts src/shared/types.ts
git commit -m "feat(review): 检查项 UI 支持编辑元数据/隐藏(软删)/恢复"
```

---

## Task 9: 前端 UI — 新增自定义检查项

让用户能新建 keyword/regex/llm 三类检查项。UI 第二部分。

**Files:**
- Modify: `src/renderer/src/SettingsPage.tsx`（检查项区底部）

- [ ] **Step 1: 加新增表单状态**

在组件顶部 state 区（Task 8 加的状态之后）追加：

```ts
  // 新增自定义检查项表单
  const [showAddForm, setShowAddForm] = useState(false)
  const [addDraft, setAddDraft] = useState<{
    label: string
    hint: string
    severity: 'error' | 'warn' | 'info'
    type: 'keyword' | 'regex' | 'llm'
    group: string
    keywords: string  // textarea 文本
    pattern: string
    prompt: string
  }>({
    label: '', hint: '', severity: 'warn', type: 'keyword',
    group: 'toxic', keywords: '', pattern: '', prompt: ''
  })
  const [regexValid, setRegexValid] = useState<{ ok: boolean; err?: string }>({ ok: true })
```

- [ ] **Step 2: 在检查项列表下方加「+ 新增」按钮与表单**

在 Task 8 渲染的"已隐藏区"之后、`</div>`（card 收尾）之前插入：

```tsx
              {/* 新增自定义检查项 */}
              <div className="row" style={{ marginTop: 12, gap: 8 }}>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setShowAddForm((v) => !v)
                    setAddDraft({
                      label: '', hint: '', severity: 'warn', type: 'keyword',
                      group: 'toxic', keywords: '', pattern: '', prompt: ''
                    })
                    setRegexValid({ ok: true })
                  }}
                >
                  {showAddForm ? '取消新增' : '＋ 新增检查项'}
                </button>
              </div>

              {showAddForm && (
                <div style={{ marginTop: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface-2)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 12.5 }}>名称</label>
                      <input
                        className="input"
                        value={addDraft.label}
                        onChange={(e) => setAddDraft((d) => ({ ...d, label: e.target.value }))}
                        placeholder="如：我的专属禁用词"
                      />
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 12.5 }}>严重度</label>
                      <select
                        className="input"
                        value={addDraft.severity}
                        onChange={(e) => setAddDraft((d) => ({ ...d, severity: e.target.value as 'error' | 'warn' | 'info' }))}
                      >
                        <option value="error">🚨 错误</option>
                        <option value="warn">⚠ 提醒</option>
                        <option value="info">💡 建议</option>
                      </select>
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 12.5 }}>检测类型</label>
                      <select
                        className="input"
                        value={addDraft.type}
                        onChange={(e) => setAddDraft((d) => ({ ...d, type: e.target.value as 'keyword' | 'regex' | 'llm' }))}
                      >
                        <option value="keyword">关键词命中（词表，实时）</option>
                        <option value="regex">正则匹配（实时）</option>
                        <option value="llm">LLM 语义（按需调 AI）</option>
                      </select>
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 12.5 }}>分类（结果分组）</label>
                      <select
                        className="input"
                        value={addDraft.group}
                        onChange={(e) => setAddDraft((d) => ({ ...d, group: e.target.value }))}
                      >
                        <option value="toxic">毒点</option>
                        <option value="quality">成文质量</option>
                        <option value="quote">引文一致性</option>
                        <option value="paragraph">段落长度</option>
                        <option value="dialogue">对话标签</option>
                        <option value="sensitive">敏感词</option>
                        <option value="llm_review">深度审稿</option>
                      </select>
                    </div>
                  </div>
                  <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
                    <label style={{ fontSize: 12.5 }}>说明（命中时显示）</label>
                    <input
                      className="input"
                      value={addDraft.hint}
                      onChange={(e) => setAddDraft((d) => ({ ...d, hint: e.target.value }))}
                      placeholder="一句话说明这条查什么"
                    />
                  </div>
                  {/* 类型相关字段 */}
                  {addDraft.type === 'keyword' && (
                    <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
                      <label style={{ fontSize: 12.5 }}>触发词（每行一个）</label>
                      <textarea
                        className="textarea"
                        style={{ minHeight: 80 }}
                        value={addDraft.keywords}
                        onChange={(e) => setAddDraft((d) => ({ ...d, keywords: e.target.value }))}
                        placeholder={'居然\n竟然\n忍不住'}
                      />
                    </div>
                  )}
                  {addDraft.type === 'regex' && (
                    <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
                      <label style={{ fontSize: 12.5 }}>正则表达式（如 ——[一-龥]——）</label>
                      <input
                        className="input"
                        value={addDraft.pattern}
                        style={{ borderColor: regexValid.ok ? undefined : 'var(--vermilion)' }}
                        onChange={(e) => {
                          const pat = e.target.value
                          setAddDraft((d) => ({ ...d, pattern: pat }))
                          if (!pat) { setRegexValid({ ok: true }); return }
                          try {
                            new RegExp(pat)
                            setRegexValid({ ok: true })
                          } catch (err) {
                            setRegexValid({ ok: false, err: (err as Error).message })
                          }
                        }}
                        placeholder="——[一-龥]——"
                      />
                      {!regexValid.ok && (
                        <span style={{ color: 'var(--vermilion)', fontSize: 11 }}>⚠ 非法正则：{regexValid.err}</span>
                      )}
                    </div>
                  )}
                  {addDraft.type === 'llm' && (
                    <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
                      <label style={{ fontSize: 12.5 }}>检查指令（告诉 AI 这项查什么）</label>
                      <textarea
                        className="textarea"
                        style={{ minHeight: 80 }}
                        value={addDraft.prompt}
                        onChange={(e) => setAddDraft((d) => ({ ...d, prompt: e.target.value }))}
                        placeholder={'检查是否有过度堆砌形容词，列出明显段落'}
                      />
                    </div>
                  )}
                  <div className="row" style={{ marginTop: 10, gap: 8 }}>
                    <button
                      className="btn btn-sm"
                      disabled={
                        !addDraft.label.trim() ||
                        (addDraft.type === 'keyword' && !addDraft.keywords.trim()) ||
                        (addDraft.type === 'regex' && (!addDraft.pattern.trim() || !regexValid.ok)) ||
                        (addDraft.type === 'llm' && !addDraft.prompt.trim())
                      }
                      onClick={async () => {
                        // 生成唯一 id：custom_ + slug + 短随机
                        const slug = addDraft.label
                          .replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '')
                          .slice(0, 12)
                          .toLowerCase() || 'rule'
                        const id = `custom_${slug}_${Math.random().toString(36).slice(2, 6)}`
                        const newCheck = {
                          id,
                          label: addDraft.label.trim(),
                          hint: addDraft.hint.trim(),
                          severity: addDraft.severity,
                          type: addDraft.type,
                          group: addDraft.group,
                          enabled: true,
                          keywords: addDraft.type === 'keyword' ? addDraft.keywords.split('\n') : undefined,
                          pattern: addDraft.type === 'regex' ? addDraft.pattern : undefined,
                          prompt: addDraft.type === 'llm' ? addDraft.prompt : undefined
                        }
                        const next = [...(reviewCfg.customChecks ?? []), newCheck]
                        const cfg = await window.api.setReviewRules({ customChecks: next })
                        setReviewCfg(cfg)
                        void window.api.getReviewRules().then((b) => {
                          setReviewSections(b.sections)
                          setHiddenSections(b.hiddenSections ?? [])
                        })
                        setShowAddForm(false)
                        setMsg({ kind: 'ok', text: `已新增「${newCheck.label}」` })
                      }}
                    >
                      创建
                    </button>
                  </div>
                </div>
              )}
```

- [ ] **Step 3: 验证编译**

Run: `cd "E:\trea\写作桌面应用" && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: 无报错

- [ ] **Step 4: 手动验证端到端**

Run: `cd "E:\trea\写作桌面应用" && npm run dev`
手动验证：
- 点「＋ 新增检查项」→ 选关键词类型 → 填名称"测试禁用词"、词表"居然/竟然"→ 创建 → 列表出现新项
- 写一章含"居然"的正文 → 质检 → 看到"测试禁用词：命中「居然」"
- 选正则类型 → 填非法正则 → 红字提示、创建按钮禁用
- 选 LLM 类型 → 填指令 → 创建 → 点 AI 深度审稿 → 该项被执行

- [ ] **Step 5: Commit**

```bash
cd "E:\trea\写作桌面应用"
git add src/renderer/src/SettingsPage.tsx
git commit -m "feat(review): UI 支持新增自定义检查项（keyword/regex/llm）"
```

---

## Task 10: 全量回归测试 + 文档更新

收尾：确保所有测试通过、README 更新。

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 跑全量测试**

Run: `cd "E:\trea\写作桌面应用" && npx vitest run 2>&1 | tail -25`
Expected: 全部 PASS（含原有 + custom-check-engine + 扩展后的 review-rules）

- [ ] **Step 2: 类型检查**

Run: `cd "E:\trea\写作桌面应用" && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: 无报错

- [ ] **Step 3: 更新 README 审稿系统章节**

打开 `README.md`，找到审稿系统章节（最近提交 `533f1be` 增加的）。在该章节末尾追加"检查项自定义"小节：

```markdown
### 检查项自定义（CRUD）

设置 → 审稿规则，检查项支持完整编辑：

- **编辑**：每项（含内置 19 项）可改名称/说明/严重度
- **隐藏/恢复**：内置项点「隐藏」软删除（可恢复），不丢检测逻辑
- **删除**：自定义项点「删除」二次确认后硬删
- **新增**：点「＋ 新增检查项」，支持三种类型：
  - **关键词命中**：维护触发词表，实时检测（同敏感词模型）
  - **正则匹配**：填正则，实时检测（同破折号碎片模型）
  - **LLM 语义**：填检查指令，点「AI 深度审稿」时按需执行（同深度审稿模型）

自定义项 id 带 `custom_` 前缀，与内置项互不冲突。
```

- [ ] **Step 4: Commit**

```bash
cd "E:\trea\写作桌面应用"
git add README.md
git commit -m "docs(review): README 增加检查项自定义（CRUD）章节"
```

---

## Self-Review 备忘

实现时注意：
1. **checks key 类型放宽**：Task 1 把 `checks` 从 `Partial<Record<ReviewCheckId, boolean>>` 改为 `Partial<Record<string, boolean>>`，下游所有读 `checks[ReviewCheckId]` 的地方 TS 不会报错（string 是父类型），但写的地方要确认仍兼容。
2. **runOneCheck 的 prompt 模板**：自定义 id 填进 `"checkId": "${spec.checkId}"` 是字符串字面量，LLM 若原样回传，parseFindingsJson 用 fallbackCheckId 兜底，无影响。
3. **group 字段**：自定义项 group 限定 AuditCategory 11 值之一，确保 `AuditViolation.category` 合法、`groupViolations` 能正常分组。
4. **DEFAULT_REVIEW_RULES 加字段**：Task 6 Step 6 必做，否则旧 settings 无新字段时 `get()` 合并默认值会缺字段。
