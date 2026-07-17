# 计划：续写/保存后自动同步 + 批量落盘

> 状态：已实现  

> 日期：2026-07-18  
> 前置：已合入 `8ff54bf` 设定进化、`e3b2753` 审查修复；上下文/角色状态/设定补丁链路已通

---

## 目标

用户不必每次手动点「提取记忆 / 一键同步」，写完正文后也能更新：

- `追踪/上下文.md`
- `追踪/角色状态.md`
- `追踪/时间线.md`（有情节点时）
- 人物卡 / 伏笔回收（记忆自动部分）
- 设定高置信补丁（`settingsEvolution === auto_high`）

并覆盖**单章续写**与**批量续写**两条路径。

---

## 推荐行为

| 场景 | 行为 |
|------|------|
| 单章 AI 续写完成并成功 | 后台自动：extractMemory → applyMemory 自动部分 → applySettingsPatches(onlyAuto) |
| 用户手动保存正文 | **可选**：默认不触发（避免手改一字就抽 LLM）；或仅写「完成第 N 章」确定性进度（见 P2 兜底） |
| 批量 `runFullFlowForChapter` | extract 后立刻 applyMemory + applySettingsPatches(onlyAuto)，与单章一致 |
| 设置开关 | 新增 `autoMemorySync: boolean`（默认 true）；与 `settingsEvolution` 独立 |

**不要**在每次 keystroke / 草稿自动保存时跑 LLM 提取。

---

## 实现要点

### 1. 设置

- `AppSettings.autoMemorySync?: boolean`（默认 `true`）
- IPC：`settings:getAutoMemorySync` / `setAutoMemorySync`（或并入 getAll）
- 设置页「写作节奏」：勾选「续写完成后自动同步记忆与设定」

### 2. 主进程统一入口

在 `WriteService`（或 `MemoryWriter` 旁）增加：

```ts
async syncChapterAfterWrite(
  projectId: string,
  chapterNumber: number,
  content: string,
  opts?: { skipIfDisabled?: boolean }
): Promise<{ memory: MemoryApplyResult; settings: SettingsApplyResult } | null>
```

内部：

1. 若 `autoMemorySync === false` → return null  
2. `knownCharacters` 列表（与 extractMemoryStream 相同）  
3. `flow.extractMemoryStream(content, chapterNumber, knownCharacters)`  
4. `parseMemoryExtractionJson`  
5. `MemoryWriter.applyAutomatic`  
6. `SettingsWriter` / `applySettingsPatches(onlyAuto: true)`（尊重 `settingsEvolution`）  
7. 可选：`syncMemoryIndex`  
8. 失败只 log + 返回 errors，**不阻断**续写成功结果  

### 3. 单章续写挂载点

- `ChapterEditor` 续写 `result.ok` 且 draft 已更新后  
  - 调用 `window.api.syncChapterAfterWrite(...)`（新 IPC）  
  - UI：轻量 toast「正在同步记忆…」/「已同步」/失败不弹死框  
  - 若流程面板已开，可刷新 extraction 展示（可选，避免重复 extract：可把结果经 IPC 回传）

### 4. 批量续写挂载点

- `runFullFlowForChapter` 在 memory extract 成功后：  
  - `await this.applyMemory(projectId, memory)`  
  - `await this.applySettingsPatches(projectId, memory, { onlyAuto: true })`  
- 进度回调可增加 `memoryApply` / `settingsApply` 阶段  

### 5. P1 顺带（时间允许）

- 新角色：若 extraction 有 newCharacters 且用户/批量策略允许，**可选**自动 create 再 apply 状态（默认仍确认更安全）  
- 或：`syncChapterAfterWrite` 对「仅有 state 指向未知角色」时先 create 最小人物卡  

### 6. 测试

- unit：`syncChapterAfterWrite` mock LLM 返回固定 JSON，断言 上下文.md / 角色状态 / 设定演进有行  
- `autoMemorySync: false` 不写盘  
- 批量路径 apply 被调用（spy MemoryWriter）  

---

## 明确不做（本阶段）

- 每次手动保存都跑 LLM 提取  
- 问题记录自动写  
- 撤销上次同步  
- 章末状态长期落盘（可二期）  

---

## 关键文件

| 文件 | 改动 |
|------|------|
| `src/main/data/write-service.ts` | `syncChapterAfterWrite`；批量 apply |
| `src/main/data/settings-repository.ts` | `autoMemorySync` |
| `src/main/ipc/write.ts` / `settings.ts` | IPC |
| `src/preload/index.ts` / `src/shared/types.ts` | API |
| `src/renderer/src/ChapterEditor.tsx` | 续写成功后触发 |
| `src/renderer/src/SettingsPage.tsx` | 开关 UI |
| `src/renderer/src/ChapterFlowPanel.tsx` | 可选：展示自动同步结果 |
| `tests/` | 新测 |

---

## 验收

1. 开 `autoMemorySync`，单章续写成功后，不点同步也能在 `追踪/上下文.md` 看到本章行  
2. 关 `autoMemorySync`，续写成功后文件不增加新行  
3. 批量两章后，两章均有上下文/（若有状态）角色状态  
4. `settingsEvolution=off` 时自动同步不写 `设定/`  
5. 同步失败不导致续写 UI 报失败  

---

## 新会话开场白（可复制）

```
实现 docs/superpowers/plans/2026-07-18-auto-sync-after-write.md：
1) AppSettings.autoMemorySync 默认 true + 设置页开关
2) WriteService.syncChapterAfterWrite：extract → applyMemory → applySettingsPatches(onlyAuto)
3) ChapterEditor 续写成功后调用
4) runFullFlowForChapter 提取后 apply
5) 单测覆盖 on/off 与落盘
按计划验收，做完可 commit push。
```
