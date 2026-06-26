# ai-writer 桌面版

Electron 桌面应用，小说存本地文件。当前为 Phase 03（项目 / 章节 / 人物）。

## 开发

```bash
npm install
npm run dev      # 启动 Electron + Vite 热更新
npm test         # 单元测试
npm run build    # 构建产物到 out/
npx electron .   # 运行构建产物
```

## 打包

```bash
npm run package      # 构建并打包成 Windows 安装包（release/*.exe）
```

产物：`release/ai-writer Setup <version>.exe`（NSIS 安装包）。

## 数据位置

- 项目库索引：`<userData>/library.json`
- 项目目录：`<userData>/projects/<projectId>/`，内含 `project.json` + `chapters/` + `memory/`
- 章节：`chapters/NNN.md`（正文）+ `NNN.meta.json`（元数据）+ `NNN.versions.json`（版本历史）
- 大纲：`outlines/main.json`（总纲）+ `outlines/detailed.json`（细纲，按章）
- 记忆：`memory/characters.json`（人物）、`relationships.json`（人物关系）、`locations.json`（地点）、`worldview.json`（世界观）、`timeline.json`（时间线）、`plot_points.json`（剧情点）、`foreshadowings.json`（伏笔）、`history.jsonl`（审计）
- Windows `<userData>`：`%APPDATA%/ai-writer-desktop/`

## 架构

```
渲染进程 (React)  ──window.api──▶  IPC  ──▶  主进程 (Node)
                  contextBridge           ├─ ProjectService / ChapterRepository / ChapterVersion
                                          ├─ MemoryService (人物/关系/伏笔/地点/世界观/时间线/剧情点)
                                          ├─ OutlineService (总纲/细纲 + AI 生成)
                                          ├─ WriteService (组装上下文 → AI 写正文)
                                          ├─ LlmService (MiniMax 流式) + SecretStore (AES-256-GCM)
                                          └─ 原子写 (.tmp + rename)
```

记忆系统基于通用 `JsonCollectionRepository<T>`，后续实体（关系/地点/伏笔等）可复用。

- `src/main/` — 主进程：窗口、IPC、文件 Repository / Service
- `src/preload/` — contextBridge 暴露 `window.api`
- `src/renderer/` — React（项目列表 / 章节列表 / 章节编辑器 / 人物管理）
- `src/shared/` — 主进程与渲染进程共享类型

## 审稿系统

按「正文审核」技能集成，分两层，全部可在「设置 → 审稿规则」配置：

- **算法层**（实时、纯函数、不调 LLM）：打破第四面墙🚨、视角混乱、水字数重复、引文字数一致性🚨、破折号碎片化🚨、超长句/逗号堆叠/省略号滥用、段落过长、对话标签单一、敏感词提醒。位于 `src/main/data/chapter-audit.ts`。
- **LLM 层**（按需、流式）：角色崩坏、逻辑漏洞/断层、剧情降智、情绪断崖、钩子强度分级、文风匹配度、爽点分析、引文语气矛盾。默认手动触发（面板「🔍 AI 深度审稿」按钮），可在设置开「续写完自动跑」省去手动操作。位于 `src/main/data/review-flow-service.ts`。

配置模型 `ReviewRulesConfig`：总开关 + 各检查项开关 + 阈值（字数上下限/段落/破折号密度等）+ 自定义词表（第四面墙触发词/敏感词）。检查项注册表 `src/main/data/skill-prompts/review-checks.ts` 是 UI 与引擎的单一事实源。

### 检查项自定义（CRUD）

设置 → 审稿规则，检查项支持完整编辑：

- **编辑**：每项（含内置 19 项）可改名称/说明/严重度
- **隐藏/恢复**：内置项点「隐藏」软删除（可恢复），不丢检测逻辑
- **删除**：自定义项点「删除」二次确认后硬删
- **新增**：点「＋ 新增检查项」，支持三种类型：
  - **关键词命中**：维护触发词表，实时检测（同敏感词模型）
  - **正则匹配**：填正则，实时检测（同破折号碎片模型）
  - **LLM 语义**：填检查指令，点「AI 深度审稿」时按需执行（同深度审稿模型）

自定义项 id 带 `custom_` 前缀，与内置项互不冲突；通用检测引擎 `src/main/data/custom-check-engine.ts` 复用现有检测模式，不引入新检测能力。

strict 模式下任何 error 级违例（含 🚨 项）阻断保存，直到修复。

## 设计文档

- 设计方案：`桌面应用设计方案.html`
- Spec：`docs/superpowers/specs/2026-06-17-desktop-app-design.md`
- 计划：`docs/superpowers/plans/`（Phase 01/02/03）

## 下一阶段

应用已完整：本地创作 + 记忆 + 大纲 + AI 写作 + 可打包分发。后续可扩展去味润色、更多 LLM provider、macOS 打包等。
