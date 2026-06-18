# ai-writer 桌面版

Electron 桌面应用，小说存本地文件。当前为 Phase 03（项目 / 章节 / 人物）。

## 开发

```bash
npm install
npm run dev      # 启动 Electron + Vite 热更新
npm test         # 单元测试（36 个）
npm run build    # 构建产物到 out/
npx electron .   # 运行构建产物
```

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
                  contextBridge           ├─ ProjectService (建项目: 目录 + project.json + library)
                                          ├─ ChapterRepository (NNN.md + NNN.meta.json)
                                          ├─ MemoryService (characters.json + history.jsonl)
                                          ├─ LibraryRepository (library.json)
                                          └─ 原子写 (.tmp + rename)
```

记忆系统基于通用 `JsonCollectionRepository<T>`，后续实体（关系/地点/伏笔等）可复用。

- `src/main/` — 主进程：窗口、IPC、文件 Repository / Service
- `src/preload/` — contextBridge 暴露 `window.api`
- `src/renderer/` — React（项目列表 / 章节列表 / 章节编辑器 / 人物管理）
- `src/shared/` — 主进程与渲染进程共享类型

## 设计文档

- 设计方案：`桌面应用设计方案.html`
- Spec：`docs/superpowers/specs/2026-06-17-desktop-app-design.md`
- 计划：`docs/superpowers/plans/`（Phase 01/02/03）

## 下一阶段

Phase 10：正文写作增强（AI 生成组装上下文：细纲+人物+伏笔+前文摘要）；打包（electron-builder）。
