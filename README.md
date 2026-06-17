# ai-writer 桌面版

Electron 桌面应用，小说存本地文件。当前为 Phase 01 脚手架。

## 开发

```bash
npm install
npm run dev      # 启动 Electron + Vite 热更新
npm test         # 单元测试
npm run build    # 构建产物到 out/
npx electron .   # 运行构建产物
```

## 数据位置

项目库索引：`<userData>/library.json`
- Windows: `%APPDATA%/ai-writer-desktop/library.json`

## 架构（Phase 01）

```
渲染进程 (React)  ──window.api──▶  IPC  ──▶  主进程 (Node)
                  contextBridge           ├─ LibraryRepository (读 library.json)
                                          └─ 原子写 (.tmp + rename)
```

- `src/main/` — 主进程：窗口、IPC、文件 Repository
- `src/preload/` — contextBridge 暴露 `window.api`
- `src/renderer/` — React 项目列表页
- `src/shared/` — 主进程与渲染进程共享类型

## 设计文档

- 设计方案：`桌面应用设计方案.html`
- Spec：`docs/superpowers/specs/2026-06-17-desktop-app-design.md`
- 本阶段计划：`docs/superpowers/plans/2026-06-17-electron-scaffold.md`

## 下一阶段

Phase 02：章节 Repository（`chapters/NNN.md` + `NNN.meta.json`）、`project.json`、新建项目向导。
