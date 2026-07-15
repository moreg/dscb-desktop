# 大神持笔 桌面版（ai-writer-desktop）

Electron 桌面应用：小说以**本地 Markdown 文件**存储，支持大纲 / 细纲 / 正文写作 / 记忆中心 / 去 AI 味 / 扫榜等。

当前数据布局为 **v4**（Markdown 单一真相源），兼容从 v3 `记忆系统/` 的一次性迁移。

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

产物：`release/大神持笔 桌面版 Setup <version>.exe`（NSIS；亦可能见 `ai-writer Setup` 别名产物）。

## 数据位置

- 项目库索引：`<userData>/library.json`
- 默认项目根：`<userData>/projects/<projectId>/`（可在设置中改）
- Windows `<userData>`：`%APPDATA%/ai-writer-desktop/`

### 项目目录（v4）

```
<project>/
├─ project.json                 # 项目元信息（schemaVersion / 题材 / 目标章数等）
├─ 大纲/
│  └─ 大纲.md                   # 主线、卷结构、逐章节奏表
├─ 细纲/
│  └─ 第01卷.md                 # 按卷细纲
├─ 设定/
│  ├─ 核心设定.md               # 细纲 AI 生成依赖
│  ├─ 题材定位.md
│  ├─ 关系.md                   # 关系变更日志表（fallback）
│  ├─ 角色/                     # 角色设定（记忆人物 fallback）
│  └─ 世界观/                   # 背景 / 力量体系 / 金手指…
├─ 正文/
│  └─ 第001章 标题.md           # 正文（亦兼容 第001章_标题.md / 001.md）
├─ 追踪/                        # 写作过程状态（表格式）
│  ├─ 伏笔.md                   # 伏笔单一真相源
│  ├─ 时间线.md
│  ├─ 角色状态.md
│  ├─ 上下文.md                 # 日更进度摘要
│  ├─ 问题记录.md
│  └─ 索引.md
├─ 记忆/                        # app 维护的实体 Markdown
│  ├─ 人物/<名>.md
│  ├─ 地点/<名>.md
│  ├─ 世界观/<名>.md
│  ├─ 关系/<A>__<B>.md
│  ├─ 剧情点/第NNN章 <标题>.md
│  ├─ 道具/<名>.md
│  ├─ 时间线/                   # 派生缓存（主源在 追踪/时间线.md）
│  ├─ 伏笔/                     # 可选详情
│  └─ 索引.md
├─ 图解/
│  └─ 节奏图谱.html
├─ 对标/                        # 拆文库挂载
└─ 资料/
```

> **已移除 / 暂未开放**  
> - 开书向导（脑洞 → 设定/大纲/细纲一键生成）：已下线；设定与大纲请手写或用大纲页「生成细纲」。  
> - 章节版本历史（`chapters/NNN.versions.json`）：IPC 仍为 stub，编辑器 UI 已隐藏。  
> - 旧 JSON 记忆（`memory/characters.json` 等）：由 `记忆/*.md` + `追踪/*.md` 取代。  
> - 旧 v3 目录 `记忆系统/`、`chapters/`：新建项目不再创建；老项目可用 `memory:migrateV3ToV4` 迁移。

## 架构

```
渲染进程 (React)  ──window.api──▶  IPC  ──▶  主进程 (Node)
                  contextBridge           ├─ ProjectService（建项目骨架 / library）
                                          ├─ ChapterService + ProseRepo（正文）
                                          ├─ MemoryService / MemoryEntityService
                                          │    └─ 记忆/*-repo + 追踪/伏笔
                                          ├─ OutlineService（大纲 / 细纲 + AI）
                                          ├─ WriteService / WriteFlowService
                                          ├─ DeslopService（去 AI 味）
                                          ├─ LlmService + SecretStore
                                          └─ 原子写 (.tmp + rename)
```

- `src/main/` — 主进程：窗口、IPC、文件 Repository / Service  
- `src/preload/` — contextBridge 暴露 `window.api`  
- `src/renderer/` — React UI  
- `src/shared/` — 共享类型  

记忆与追踪以 **Markdown 文件** 为单一真相源（`src/main/data/memory/*`、`skill-format/*`），不再依赖 `JsonCollectionRepository` 存业务实体。

## 审稿系统

按「正文审核」技能集成，分两层，可在「设置 → 审稿规则」配置：

- **算法层**（实时、纯函数）：`src/main/data/chapter-audit.ts`
- **LLM 层**（按需、流式）：`src/main/data/review-flow-service.ts`

检查项注册表：`src/main/data/skill-prompts/review-checks.ts`。自定义检查引擎：`custom-check-engine.ts`。

## 设计文档

| 文档 | 说明 |
|------|------|
| `桌面应用设计方案.html` | 可视化总览（已同步 v4 目录） |
| `docs/md-format-spec.md` | Markdown 硬性格式规范（解析器契约） |
| `docs/superpowers/specs/2026-06-17-desktop-app-design.md` | 原始设计 Spec（§5 已更新为 v4） |
| `docs/superpowers/plans/` | **历史**分阶段实现日志（路径可能仍写 v1/v3，以本 README 为准） |

## 下一阶段

本地创作闭环已可用。可继续：章节版本存储重做、macOS 打包、更多 LLM provider、导入向导增强等。
