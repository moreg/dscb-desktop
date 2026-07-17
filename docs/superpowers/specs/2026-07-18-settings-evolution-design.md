# 设定随书进化设计

> 状态：MVP 已实现（按推荐项）  
> 日期：2026-07-18  
> 范围：续写 / 记忆同步后，如何让 `设定/` 与故事进展对齐，同时避免污染「长期底稿」

**已拍板：** A 类增量 append only · 高置信默认自动 · world 地点双写地理 · 日志 `追踪/设定演进.md`

---

## 1. 问题

当前三层数据职责：

| 层 | 路径 | 同步是否写 | 续写是否读 | 语义 |
|----|------|------------|------------|------|
| 设定 | `设定/` | ❌ | ✅ | 长期底稿（题材/世界观/势力/规则） |
| 追踪 | `追踪/` | ✅ | ✅ | 过程态（进度/状态/时间线/伏笔） |
| 记忆 | `记忆/` | ✅ | ✅（人物等） | 实体卡与剧情点 |

矛盾：

- 正文里会出现**设定级增量**（新境界、金手指新规则、新势力、地理新点）
- 这些现在最多进细纲对照「超纲增量」提示，或进 `记忆/地点`，**不会回写 `设定/`**
- 下章续写读到的仍是旧设定 → 模型容易「忘了已揭晓的体系」

目标：

1. **能进化**：章内确认过的设定增量写入 `设定/`
2. **不乱改**：题材定位、核心卖点等「硬底稿」默认只读
3. **可追溯**：每次变更可审计、可回滚
4. **接现有流程**：挂在流程面板「记忆提取 / 一键同步」旁，而不是另起炉灶

---

## 2. 设计原则

### 2.1 两层设定，而不是「一切都改底稿」

```
设定/
  ├─ （底稿 Canon）题材定位.md、核心设定.md …
  │     · 默认只读；极少自动改；改必须高确认
  └─ （进化层 Evolving）
        世界观/*.md、势力/*.md、关系.md、自创规则.md
        · 允许结构化补丁写入
        · 正文揭晓 → 提取 → 预览 → 确认/自动 → 落盘
```

补充「演进日志」（新建，推荐）：

```
追踪/设定演进.md
```

记录每次补丁：章节、类型、目标文件、摘要、是否已应用。  
续写可注入「近期设定演进」3～5 条，比每次重读全量设定更省 token、更贴当前进度。

### 2.2 三类变更，三种信任度

| 类型 | 示例 | 默认策略 |
|------|------|----------|
| **A. 增量补丁** | 新势力条目、地理新地点、力量体系多一个境界 | 预览后可自动应用（与情节/状态同级） |
| **B. 修订补丁** | 修正金手指代价、改写已有规则段落 | **必须确认**（易误伤底稿） |
| **C. 底稿级** | 题材定位、核心梗、读者画像 | **永不自动**；仅提示「建议手改」 |

### 2.3 单一写入契约

- 真相源仍是 markdown 文件（与现有一致）
- 写入用**补丁**（append H2 / upsert 字段 / 追加表格行），禁止整文件 LLM 重写
- 与 `MemoryWriter` 同风格：预览 diff → apply

---

## 3. 数据模型

### 3.1 提取结果扩展

在现有 `MemoryExtraction` 旁增加（或并入）`SettingsExtraction`：

```ts
interface SettingsExtraction {
  chapterNumber: number
  /** A 类：新增条目 */
  patches: SettingsPatch[]
  /** B 类：修订已有（需确认） */
  revisions: SettingsRevision[]
  /** C 类：仅建议，不自动写 */
  suggestions: SettingsSuggestion[]
}

interface SettingsPatch {
  /** 目标：worldview | faction | relation | customRule | geography */
  target:
    | 'worldview'      // 设定/世界观/{file}.md
    | 'faction'        // 设定/势力/{name}.md
    | 'relation'       // 设定/关系.md
    | 'customRule'     // 设定/{name}.md 顶层规则
    | 'geography'      // 设定/世界观/地理.md 或 记忆/地点 双写策略见下
  fileName: string     // 如「力量体系」「青帮」
  /** append_h2 | append_bullet | upsert_field | append_table_row */
  op: 'append_h2' | 'append_bullet' | 'upsert_field' | 'append_table_row'
  sectionTitle?: string  // 追加到哪个 H2；空则文件末尾
  title?: string         // 新 H2/条目标题
  content: string        // 补丁正文（短，≤500 字）
  reason: string         // 依据（引用正文现象，≤80 字）
  confidence: 'high' | 'medium' | 'low'
}

interface SettingsRevision {
  target: SettingsPatch['target']
  fileName: string
  sectionTitle: string
  oldHint: string        // 要改的旧句/旧段摘要（匹配用）
  newContent: string
  reason: string
}

interface SettingsSuggestion {
  topic: string
  reason: string
  /** 建议手改路径提示 */
  suggestedPath: string
}
```

### 3.2 地理双写策略（地点）

| 情况 | 写入 |
|------|------|
| 一次性场景点（茶馆、巷口） | 仅 `记忆/地点/`（现状） |
| 常驻地理/势力范围（天津法租界、某山脉） | `记忆/地点/` + 可选 `设定/世界观/地理.md` 表格行 |
| 判定 | 提取字段 `scope: 'scene' \| 'world'`；仅 `world` 进设定 |

### 3.3 演进日志行格式

`追踪/设定演进.md`：

```md
# 设定演进

| 日期 | 章节 | 类型 | 目标文件 | 摘要 | 状态 |
|---|---|---|---|---|---|
| 2026-07-18 | 第 12 章 | 增量 | 世界观/力量体系.md | 新增「暗劲圆满」境界 | 已应用 |
```

---

## 4. 流程设计

### 4.1 与记忆提取的关系

**方案：一次 LLM 调用扩字段（推荐 MVP）**

在现有 `extractMemoryStream` prompt 中增加 `settingsPatches / settingsRevisions / settingsSuggestions`，与角色状态同一次抽。

优点：少一次请求、与「一键同步」同拍。  
缺点：prompt 变长；需控制 JSON schema 清晰。

**方案 B：独立 `extractSettingsStream`**

设定复杂项目再拆；MVP 不做。

### 4.2 应用策略（混合）

| 项 | 策略 |
|----|------|
| `patches` 且 `confidence=high` | 可自动应用（同状态/情节） |
| `patches` medium/low | 预览后默认勾选，用户一点「应用设定补丁」 |
| `revisions` | 必须确认（diff 高亮 old→new） |
| `suggestions` | 只展示，点「打开文件」 |

流程面板新增一节 **「设定演进」**：

```
设定演进
  [自动] 高置信增量 3 项     [已应用 / 应用]
  [确认] 修订 1 项           [查看 diff] [应用]
  [建议] 题材向建议 1 项     （仅提示）
  预览 diff
    力量体系.md · append_bullet
    （无） → 暗劲圆满：可短时外放…
```

### 4.3 写入实现（SettingsWriter）

新模块 `src/main/data/settings-writer.ts`，风格对齐 `MemoryWriter`：

- `preview(patches)` → `SettingsApplyPreview`
- `applyPatches(patches)` / `applyRevisions(revisions)`
- 底层复用 `md-writer` 的 appendH2 / 表格 upsert
- `ensureFile(fileName)`：目标文件不存在则按开书模板建空壳再补丁
- **禁止**对 `题材定位.md`、`核心设定.md` 自动 apply（C 类硬拦）

安全：

- `fileName` 白名单字符 + 路径不得 `..`
- `content` 长度上限（如 800 字）
- 同章节同 title 补丁幂等（已存在则 skip 或更新演进日志为「已存在」）

### 4.4 续写读取增强

`SettingsMdRepo.read()` 保持读全量设定；额外：

```ts
// TrackingMdRepo 或 SettingsMdRepo
readRecentSettingsEvolution(limit = 5): EvolutionEntry[]
```

`renderSettingsSection` 末尾追加：

```md
## 近期设定演进（以正文已揭晓为准，优先于旧底稿冲突项）
- 第 12 章 · 力量体系：新增暗劲圆满
- 第 11 章 · 势力/青帮：出现「码头分舵」
```

冲突规则写进 system/user 提示一句：

> 若「近期设定演进」与旧世界观正文冲突，以演进（更新章节更大）为准。

---

## 5. MVP 范围（建议一期）

**做：**

1. 提取扩展：`settingsPatches`（仅 A 类）+ `settingsSuggestions`（C 类提示）
2. `SettingsWriter`：支持  
   - `世界观/{力量体系,背景设定,金手指,地理}.md` 的 `append_h2` / `append_bullet`  
   - `势力/{name}.md` 新建或 append  
   - `关系.md` append 行/条  
3. 流程面板「设定演进」区块 + diff 预览  
4. 高置信自动应用；其余确认  
5. `追踪/设定演进.md` 日志  
6. 续写注入最近 5 条演进  

**不做（二期）：**

- B 类修订自动/半自动（oldHint 匹配脆弱）  
- 改 `题材定位.md` / `核心设定.md`  
- 设定全文 LLM 重写  
- 与 `记忆/地点` 的复杂双向合并 UI  

---

## 6. 与现有模块边界

```
正文
  → extractMemoryStream（扩 settings* 字段）
  → MemoryWriter.applyAutomatic     // 状态/情节/伏笔/上下文（已有）
  → SettingsWriter.applyPatches     // 设定补丁（新建）
  → 追踪/设定演进.md

续写
  → SettingsMdRepo.read()           // 底稿
  → readRecentSettingsEvolution()   // 演进
  → TrackingMdRepo + Memory         // 过程态
```

索引：`syncMemoryIndex` 可扩展扫描设定演进，或单独不进记忆索引（设定仍在 `设定/`）。

---

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| LLM 乱改金手指规则 | 修订类强制确认；增量只 append 不删旧文 |
| 文件膨胀 | 单补丁长度上限；同 title 幂等 |
| 与细纲「超纲增量」重复 | 设定提取专注「可复用设定」；一次性情节仍走记忆/细纲 |
| 用户不想动设定 | 设置项：`settingsEvolution: off \| confirm_all \| auto_high` |
| 旧项目无势力目录 | ensure 目录 + 空文件模板 |

---

## 8. 验收标准

1. 正文写明「新境界 X」→ 同步后 `设定/世界观/力量体系.md` 出现对应条，且演进日志有行  
2. 续写下章 prompt 含「近期设定演进」且含该条  
3. 题材定位.md 在任何自动路径下字节不变  
4. 关闭 `settingsEvolution` 时行为与现网一致  
5. 单测：SettingsWriter append 幂等、路径越界拒绝、preview/apply 一致  

---

## 9. 实现分期

| 阶段 | 内容 | 预估 |
|------|------|------|
| **PR1** | 类型 + SettingsWriter + 演进日志 + 单测 | 0.5～1d |
| **PR2** | extract prompt/parser + 流程面板 UI + 自动/确认 | 1d |
| **PR3** | 续写注入演进 + 设置开关 + 联调 | 0.5d |

---

## 10. 待你拍板

1. **MVP 是否只做 A 类增量 append？**（推荐：是）  
2. **高置信是否默认同状态一起自动应用？**（推荐：是，可设置关掉）  
3. **新地点默认只写记忆，还是 `world` 级双写地理设定？**（推荐：仅标记 `world` 才双写）  
4. **演进日志放 `追踪/设定演进.md` 是否同意？**（推荐：是）

确认后按 PR1→PR3 实现。
