# 审稿检查项可编辑 / 可新增 / 可删除 设计方案

让审稿系统的检查项（当前 19 项，11 算法 + 8 LLM）支持：元数据编辑、用户新增自定义检查项、删除（内置项软删除/恢复、自定义项硬删除）。

当前检查项来自一个**硬编码常量** `REVIEW_CHECK_SECTIONS`，`ReviewCheckId` 是闭合联合类型，引擎按 checkId 硬编码分发到写死的检测函数。本方案在保留内置项检测能力的同时，引入"用户层"实现完整 CRUD。

---

## 1. 核心模型：检查项注册表双层化

把当前**单一硬编码注册表**拆成**内置定义 + 用户层**两部分。运行时统一合并成一张"活动检查项表"。

| 能力 | 内置项（19 个） | 自定义项（用户新建） |
|------|----------------|-------------------|
| 检测逻辑 | 写死的函数（不可改） | 通用引擎按 `type` 跑 |
| 开/关 | ✅ 开关 | ✅ 开关 |
| 删除 | ⚠️ **软删除/隐藏**（可恢复） | ✅ **硬删除**（真删） |
| 编辑 | ✅ 覆盖元数据（名称/说明/严重度） | ✅ 全字段编辑 |

**为什么内置项只能软删除？** 它们的检测逻辑是写死的函数（N-gram 重复、密度计算、引文交叉引用、统计占比等），无法运行时卸载。软删除 = 标记 `hidden`，引擎跳过、UI 不显示，用户可恢复。自定义项无此限制，可真正删除。

### checkId 命名约定

- 内置项继续用现有 id（`meta_break` 等）
- 自定义项用 `custom_` 前缀（如 `custom_my_words`），与内置 id 永不冲突
- `AuditViolation.ruleId` 带前缀即可天然区分，**无需改闭合联合类型**

---

## 2. 数据结构（扩展 `shared/types.ts`）

```ts
/** 自定义检查项检测类型 */
export type CustomCheckType = 'keyword' | 'regex' | 'llm'

/** 用户自定义检查项 */
export interface CustomReviewCheck {
  id: string                  // 'custom_xxx'，UI 生成，全局唯一
  label: string               // 中文名
  hint: string                // 说明
  severity: AuditSeverity     // error/warn/info
  type: CustomCheckType       // 检测类型
  group: string               // UI 分组（复用 toxic/quality/llm_review...）
  keywords?: string[]         // type=keyword: 命中词表
  pattern?: string            // type=regex: 正则源码
  prompt?: string             // type=llm: 检查指令
  enabled: boolean
}

/** 内置项元数据覆盖 */
export interface BuiltinCheckMeta {
  label?: string
  hint?: string
  severity?: AuditSeverity
}

/** ReviewRulesConfig 新增字段 */
export interface ReviewRulesConfig {
  // ...现有字段不变（enabled / autoDeepReview / checks / thresholds / wordLists）...
  builtinMeta?: Partial<Record<ReviewCheckId, BuiltinCheckMeta>>  // 内置项元数据覆盖
  hiddenBuiltin?: ReviewCheckId[]     // 软删除的内置项
  customChecks?: CustomReviewCheck[]  // 用户自定义项
}
```

新增字段全部可选，旧 settings.json 无这些字段时走默认（内置项不变、无自定义项），**向后兼容零破坏**。

---

## 3. 通用检测引擎（新增 `src/main/data/custom-check-engine.ts`）

对自定义项按 `type` 分发——**全部复用现有检测模式，不引入新检测能力**：

```
type=keyword  → content.indexOf 遍历词表        (= 现 meta_break/sensitive)
type=regex    → new RegExp(pattern).exec        (= 现破折号碎片/逗号堆叠)
type=llm      → ReviewFlowService 跑 prompt      (= 现深度审稿)
```

### 算法类（keyword / regex）

导出 `runCustomAlgorithmChecks(content, checks, out)`，在 `auditChapter` 的 `if (rules)` 块内调用，同步出结果，并入同一 `violations` 数组。

- **正则安全：** 用户 pattern 包进 try/catch，非法正则不报错只跳过（单条失败不阻断），并可选 `console.warn`
- **限频：** 每条自定义项命中上限沿用现有约定（≤5 条/项）
- **offset/snippet：** keyword 用 `indexOf` + `extractContext`；regex 用 `m.index` + `extractContext`
- **ruleId：** 用 `check.id`（带 `custom_` 前缀），category 用 `check.group`

### LLM 类（llm）

在 `ReviewFlowService.runDeepReview` 里，除了现有 8 个 LLM_CHECK_IDS，再遍历 `enabledChecks` 中带 `custom_` 前缀且 type=llm 的项，用 `check.prompt` 作 instruction 调用 `runOneCheck`（把 CheckSpec.instruction 换成用户 prompt）。返回的 findings ruleId 即 `check.id`。

### 接入点

- 算法类：`chapter-audit.ts` 的 `auditChapter` —— `if (rules)` 块末尾追加 `runCustomAlgorithmChecks(content, rules, violations)`
- LLM 类：`review-flow-service.ts` 的 `runDeepReview` —— 在 `LLM_CHECK_IDS` 循环后追加自定义 llm 项循环
- LLM 类需要从 settings 读 customChecks：调用方（IPC 层 / write-service）把 `rules.customChecks` 透传进 `DeepReviewContext`

---

## 4. 持久化与清洗（`src/main/data/settings-repository.ts`）

复用 `writingRequirementTemplates` 的成熟先例。

### 新增 `sanitizeCustomChecks(raw)`

- 校验每条：id 匹配 `^custom_[a-z0-9_]+$`、唯一（重复去重）、label/hint 非空 trim、severity ∈ {error,warn,info}、type ∈ {keyword,regex,llm}、group 非空
- 按类型校验配置：keyword→keywords 非空数组（trim 去空去重，≤500）；regex→pattern 非空且 `new RegExp()` 不抛（非法项丢弃）；llm→prompt 非空（≤2000 字）
- 整体限数：≤50 条
- enabled 缺省 true

### `sanitizeBuiltinMeta(raw)`

- 仅保留 `REVIEW_CHECK_KEYS` 内的 key
- 每项只保留 label/hint/severity，trim + severity 校验

### `sanitizeHiddenBuiltin(raw)`

- 仅保留 `REVIEW_CHECK_KEYS` 内的 id，去重

### `REVIEW_CHECK_KEYS` 白名单扩展

`REVIEW_CHECK_KEYS` 是闭合的内置集合。`checks` 开关表要同时支持自定义 id，因此在 `sanitizeReviewRules` 里构造一个**运行时合并集合**：

```ts
const allKeys = new Set([...REVIEW_CHECK_KEYS, ...customChecks.map(c => c.id)])
// checks 清洗用 allKeys 而非静态 REVIEW_CHECK_KEYS
```

注意顺序：必须先 sanitize customChecks，再用其结果清洗 checks。

### `sanitizeReviewRules` 增量

```ts
return {
  enabled, autoDeepReview,
  checks,                  // 用 allKeys 清洗
  thresholds, wordLists,
  builtinMeta: sanitizeBuiltinMeta(r.builtinMeta),
  hiddenBuiltin: sanitizeHiddenBuiltin(r.hiddenBuiltin),
  customChecks: sanitizeCustomChecks(r.customChecks)
}
```

---

## 5. IPC 扩展（`src/main/ipc/settings.ts`）

**不新增 IPC 通道**，复用现有 patch 语义。

### `settings:getReviewRules`

返回 `sections` 时：
1. 遍历内置 `REVIEW_CHECK_SECTIONS`，应用 `builtinMeta` 覆盖（label/hint/severity），过滤掉 `hiddenBuiltin`
2. 追加 `customChecks`（转成同构的 `ReviewCheckSectionView`，新增 `isCustom: true` 标记 + `type` 字段）
3. config 透传

### `settings:setReviewRules`

zod 校验 object 增加可选字段：
- `builtinMeta: z.record(checkIdEnum, z.object({label/hint/severity 可选})).optional()`
- `hiddenBuiltin: z.array(checkIdEnum).optional()`
- `customChecks: z.array(customCheckSchema).optional()`（customCheckSchema 校验 id/label/type 等；id 正则与去重规则同第 4 节 `sanitizeCustomChecks`）

`repo.setReviewRules` 已是增量合并语义（checks 合并、其他字段 patch），新增字段同样走增量合并（builtinMeta 浅合并、hiddenBuiltin/ customChecks 整体替换）。

---

## 6. UI（`src/renderer/src/SettingsPage.tsx` 审稿规则页）

### 检查项列表卡片改造

每条检查项（含内置与自定义）卡片新增：
- **✎ 编辑**：弹表单编辑 label/hint/severity
  - 内置项：保存到 `builtinMeta[checkId]`（覆盖），清空字段 = 恢复默认
  - 自定义项：直接改 `customChecks` 对应项
- **🗑 删除**：
  - 内置项 → 写入 `hiddenBuiltin`，从活动列表移除
  - 自定义项 → 二次确认（弹确认框）后从 `customChecks` 移除（硬删）
- **开关**：保持现有逻辑（注意自定义项开关走 `checks[custom_xxx]`）

### 底部「＋ 新增检查项」

- 选 type（关键词/正则/LLM）
- 填表单（label/hint/severity/group + 类型相关字段）
- 表单字段按 type 动态切换：
  - keyword → 词表 textarea（每行一个）
  - regex → pattern 输入框 + **实时正则校验**（输入即 try `new RegExp`，非法红字提示）
  - llm → prompt textarea
- 生成 id：`custom_` + 基于 label 的 slug + 短随机后缀，保证唯一
- 保存即写入 `customChecks`

### 「已隐藏」区

- 列出 `hiddenBuiltin` 里的内置项（显示默认 label）
- 每项带「恢复」按钮 → 从 `hiddenBuiltin` 移除

### 状态管理

`reviewSections` 已是 state。CRUD 操作统一调用 `setReviewRules(patch)`，用返回值更新 `reviewSections` + `reviewCfg`，与现有"保存即落盘"模式一致。

---

## 7. 引擎接入的数据流

自定义项要让引擎跑，需在检测时拿到 customChecks。两条路径：

- **算法类**：`auditChapter` 已接收 `opts.reviewRules`（含 customChecks），直接用。调用方（chapter-service / write-service）已传 reviewRules，无需改。
- **LLM 类**：`runDeepReview` 的 `DeepReviewContext` 增加 `customLlmChecks?: CustomReviewCheck[]` 字段；IPC 层 `runDeepReview` handler 从 settings 读 customChecks，过滤 type=llm 透传。

---

## 8. 向后兼容与边界

- 旧 settings.json 无新字段 → 全部走默认，内置项行为不变，零破坏
- `AuditViolation.ruleId` 已是 `string | undefined`（见 types.ts），自定义 `custom_xxx` 无需扩类型
- `ChapterAuditPanel` 的 `groupViolations` 按 category 动态分组 + 未知 category 兜底末尾，自定义项 group 复用现有 category 即可正常展示；若用户新 group 则兜底展示
- 正则/关键词自定义项失败不阻断主流程（沿用现有"单项失败继续"原则）

---

## 9. 测试计划

- `review-rules.test.ts` 扩展：customChecks sanitize（非法正则丢弃、id 去重、限数）、builtinMeta/hiddenBuiltin 持久化与增量合并、checks 白名单含 custom id
- 新增 `custom-check-engine.test.ts`：keyword 命中/未命中、regex 命中/非法正则跳过、限频、offset/snippet 正确性
- 现有测试全绿（回归保护）

---

## 10. 工程范围

**新增文件：**
- `src/main/data/custom-check-engine.ts`（通用检测引擎 + 单测）

**改动文件：**
- `src/shared/types.ts`：`CustomCheckType` / `CustomReviewCheck` / `BuiltinCheckMeta` 类型，`ReviewRulesConfig` 加 3 字段，`ReviewCheckSectionView` 加 `isCustom?` / `customType?`，`DeepReviewContext` 加 `customLlmChecks?`
- `src/main/data/skill-prompts/review-checks.ts`：合并导出（可选 helper，便于 UI 取内置默认）
- `src/main/data/settings-repository.ts`：3 个 sanitize 函数 + `sanitizeReviewRules` 扩展
- `src/main/data/chapter-audit.ts`：`auditChapter` 接入 `runCustomAlgorithmChecks`
- `src/main/data/review-flow-service.ts`：`runDeepReview` 接入自定义 llm 项
- `src/main/ipc/settings.ts`：getReviewRules 合并展示、setReviewRules zod 扩展、runDeepReview handler 透传
- `src/renderer/src/SettingsPage.tsx`：CRUD UI（编辑/删除/新增/已隐藏区）
- `tests/review-rules.test.ts`：扩展
