# ai-writer 桌面版

Electron 桌面应用，小说存本地文件。当前为 Phase 02（项目与章节）。

## 开发

```bash
npm install
npm run dev      # 启动 Electron + Vite 热更新
npm test         # 单元测试（20 个）
npm run build    # 构建产物到 out/
npx electron .   # 运行构建产物
```

## 数据位置

- 项目库索引：`<userData>/library.json`
- 项目目录：`<userData>/projects/<projectId>/`，内含 `project.json` + `chapters/`
- 章节：`chapters/NNN.md`（正文）+ `NNN.meta.json`（元数据）
- Windows `<userData>`：`%APPDATA%/ai-writer-desktop/`

## 架构

```
渲染进程 (React)  ──window.api──▶  IPC  ──▶  主进程 (Node)
                  contextBridge           ├─ ProjectService (建项目: 目录 + project.json + library)
                                          ├─ ChapterRepository (NNN.md + NNN.meta.json)
                                          ├─ LibraryRepository (library.json)
                                          └─ 原子写 (.tmp + rename)
```

- `src/main/` — 主进程：窗口、IPC、文件 Repository / Service
- `src/preload/` — contextBridge 暴露 `window.api`
- `src/renderer/` — React（项目列表 / 章节列表 / 章节编辑器）
- `src/shared/` — 主进程与渲染进程共享类型

## 设计文档

- 设计方案：`桌面应用设计方案.html`
- Spec：`docs/superpowers/specs/2026-06-17-desktop-app-design.md`
- 计划：`docs/superpowers/plans/`（Phase 01 脚手架、Phase 02 项目与章节）

## 下一阶段

Phase 03：章节版本历史（`NNN.versions.json`）、记忆系统 Repository（人物/关系/地点/伏笔/时间线/世界观）、记忆审计 `history.jsonl`。
