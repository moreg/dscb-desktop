# ai-writer 桌面应用设计（本地文件存储方案）

- 日期：2026-06-17（初稿）
- **现状同步**：2026-07-15 — 数据布局升级为 **v4 Markdown 单一真相源**（见 §5.3）；开书向导已移除；章节版本暂未开放
- 来源项目：`E:\trea\ai-writer`（Python FastAPI + React + SQLite）
- 交付物：本设计的可视化 HTML 展示页（`桌面应用设计方案.html`）
- 用户向数据说明：根目录 `README.md` · 格式契约：`docs/md-format-spec.md`

---

## 1. 背景与目标

原 `ai-writer` 是前后端分离的网文创作工具：

- 后端：Python 3.11 + FastAPI + SQLAlchemy + SQLite + Playwright
- 前端：React 19 + TypeScript + Ant Design + Vite + Zustand
- 数据：22 张 SQLite 表，章节正文已用 `content_path` 指向外部文件

本方案将其改造为 **Electron 桌面应用**，核心变化：

1. **完全去掉 Python 后端**：LLM 调用、文件 I/O、密钥加密全部由 Electron 主进程（Node）接管。
2. **存储从 SQLite 改为本地文件**：每个小说项目 = 一个可独立携带的文件夹。
3. **砍掉重 Python 依赖功能**：番茄榜单抓取（依赖 Playwright + 字体解密）、工作流引擎、Agent 配置。

## 2. 功能范围（核心 MVP）

**保留：**

| 模块 | 说明 |
|---|---|
| 项目管理 | 新建/打开/列表，项目可放任意本地路径 |
| 总纲 | CRUD + AI 生成 |
| 细纲 | 批量生成，含情绪点/爽点/钩子/角色状态 |
| 章节编辑 | 正文编辑、状态流转（版本历史 UI 暂隐藏） |
| 记忆系统 | 人物、关系、地点、伏笔、时间线、剧情点、世界观、道具（Markdown） |
| 正文写作 | AI 辅助章节生成：上下文组装、流式生成、去味润色（详见 §9） |
| 写作风格 | 风格配置 CRUD |

**明确砍掉：** 番茄榜单抓取与分析、工作流引擎、Agent 配置管理、题材公式库（可保留为静态资源，不入库）。

**不持久化：** 生成任务（`generation_tasks`）等运行时状态改内存。

## 3. 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Electron 30+ |
| 主进程 | Node.js + TypeScript |
| 渲染进程 | React 19 + Vite + Ant Design + Zustand（复用原前端） |
| 文件 I/O | Node `fs/promises` |
| 加密 | Node `crypto`，AES-256-GCM |
| 校验 | JSON Schema（ajv） |
| 打包 | electron-builder（win/mac） |

## 4. 整体架构

```
┌─────────────────────────────────────────────────────┐
│ 渲染进程（React + Vite + AntD + Zustand）            │
│   原前端几乎直接复用                                  │
│   仅把 HTTP 客户端 → 改成 window.api（IPC 封装）      │
│   砍掉番茄榜单/工作流/Agent 页面与路由               │
└────────────────────┬────────────────────────────────┘
                     │ contextBridge (preload.ts)
                     │ ipcRenderer.invoke / on
┌────────────────────▼────────────────────────────────┐
│ Electron 主进程（Node + TS）                          │
│  ├─ IpcRouter        通道路由，分发到各 Repository     │
│  ├─ FileRepository   文件读写（原子写 + 乐观锁）       │
│  ├─ LlmFactory       provider 工厂（TS 移植自 factory.py） │
│  ├─ SecretStore      API key 加密（AES-256-GCM）       │
│  └─ ProjectLibrary   项目库索引（library.json）        │
└─────────────────────────────────────────────────────┘
        无 Python 后端 / 无 SQLite / 无 Playwright
```

**核心原则**：原后端 `services/` 业务逻辑整体平移到主进程的 Repository 层；渲染进程零业务逻辑变更，只换传输层（HTTP → IPC）。

## 5. 文件存储设计

### 5.1 核心理念

> **一个小说项目 = 一个自包含、可独立携带的文件夹。**

项目文件夹可放在任意本地路径（本地磁盘 / U 盘 / 网盘同步目录）。全局 `library.json` 只保存项目路径的**指针**和轻量元信息，不存正文。这样"存本地文件"是真正落在一个可整体复制、备份、Git 管理的文件夹里。

### 5.2 全局布局

```
<userData>/                          # app.getPath('userData')
├─ config/
│  ├─ settings.json                  默认项目根目录、UI 偏好、活跃 provider
│  └─ providers.enc                  LLM 密钥（AES-256-GCM 加密）
├─ library.json                      项目库索引（项目路径 + 元信息）
└─ projects/                         默认项目根目录（用户可改）
   └─ 我的第一部小说/                ← 项目文件夹（可移动）
```

`library.json` 示例：

```json
{
  "schemaVersion": 1,
  "projects": [
    {
      "id": "uuid",
      "name": "我的第一部小说",
      "path": "C:/Users/.../projects/我的第一部小说",
      "genre": "玄幻",
      "createdAt": "2026-06-17T00:00:00Z",
      "lastOpenedAt": "2026-06-17T12:00:00Z"
    }
  ]
}
```

### 5.3 项目目录结构（v4 · 当前）

```
我的第一部小说/
├─ project.json                 项目元信息（schemaVersion / name / genre / 目标章数…）
├─ 大纲/
│  └─ 大纲.md                   主线、卷结构、逐章节奏表
├─ 细纲/
│  └─ 第01卷.md                 按卷细纲
├─ 设定/
│  ├─ 核心设定.md               细纲 AI 生成依赖
│  ├─ 题材定位.md
│  ├─ 关系.md                   关系变更日志表（fallback）
│  ├─ 角色/                     角色设定（记忆人物 fallback）
│  └─ 世界观/                   背景 / 力量体系 / 金手指…
├─ 正文/
│  └─ 第001章 标题.md           正文（兼容 第001章_标题.md / 001.md）
├─ 追踪/                        写作过程状态表
│  ├─ 伏笔.md                   伏笔唯一真相源
│  ├─ 时间线.md / 角色状态.md / 上下文.md / 问题记录.md
│  └─ 索引.md
├─ 记忆/                        app 维护的实体 Markdown
│  ├─ 人物/ · 地点/ · 世界观/ · 关系/ · 剧情点/ · 道具/ …
│  └─ 索引.md
├─ 图解/
│  └─ 节奏图谱.html
├─ 对标/                        拆文库挂载
└─ 资料/
```

> **历史路径（已废弃）**：`chapters/`、`memory/*.json`、`outlines/*.json`、`记忆系统/`。老项目可调 `memory:migrateV3ToV4`。

### 5.4 领域 → 文件映射（v4）

| 领域 | 落地位置 | 格式 |
|---|---|---|
| 项目元信息 | `project.json` | JSON |
| 章节正文 | `正文/第NNN章 标题.md` | Markdown |
| 章节版本 | （暂未实现 / IPC stub） | — |
| 总纲 / 卷纲 | `大纲/大纲.md` | Markdown |
| 细纲 | `细纲/第NN卷.md` | Markdown |
| 人物 | `记忆/人物/<名>.md` | Markdown |
| 关系 | `记忆/关系/<A>__<B>.md` | Markdown |
| 地点 / 世界观 / 道具 | `记忆/{地点,世界观,道具}/` | Markdown |
| 伏笔 | `追踪/伏笔.md` | Markdown 表 |
| 时间线 | `追踪/时间线.md` | Markdown 表 |
| 剧情点 | `记忆/剧情点/第NNN章 <标题>.md` | Markdown |
| 节奏图谱 | `图解/节奏图谱.html` | HTML + JS |
| 生成任务 | 不持久化 | — |

### 5.5 文件格式约定

- **project.json**：带 `schemaVersion` 与 `updatedAt`。
- **业务实体**：优先 Markdown（GFM 标题 / 管道表 / `- **字段**：值`）；契约见 `docs/md-format-spec.md`。
- **文件名**：用户/LLM 输入经 `sanitizeForFileName` 后再拼路径；显示名写在 H1。
- **迁移**：`src/main/data/memory/migration-v3-to-v4.ts` 将 `记忆系统/` + `chapters/` 转为 v4 结构。

## 6. 数据访问层（Repository Pattern）

每个领域一个 Repository，接口一致：

```typescript
interface Repository<T> {
  list(projectId: string): Promise<T[]>
  get(projectId: string, id: string): Promise<T | null>
  create(projectId: string, data: CreateDto): Promise<T>
  update(projectId: string, id: string, data: UpdateDto): Promise<T>
  delete(projectId: string, id: string): Promise<void>
}
```

写入流程（原子写，防崩溃损坏）：

```
load → JSON.parse → Schema 校验(ajv) → 不可变更新 →
  JSON.stringify → 写到 .tmp 临时文件 → fs.rename 覆盖原文件 → 更新 index.json
```

- **原子写**：`fs.writeFile(path + '.tmp')` 成功后 `fs.rename` 替换，保证文件永不被写一半。
- **Schema 校验**：每个文件类型有 JSON Schema，损坏/格式错时降级提示"文件损坏，是否从版本历史恢复"。
- **不可变更新**：遵循项目编码规范，绝不原地修改对象。
- **审计**：记忆类增删改追加一条到 `memory/history.jsonl`。

## 7. IPC 设计

通道命名：`<域>:<动作>`，如 `chapters:list`、`memory:character:create`、`llm:generate`、`library:list`。

`preload.ts` 通过 `contextBridge` 暴露 `window.api`，与原 HTTP 客户端同形：

```typescript
// 渲染进程调用（与原 fetch 客户端几乎同形，便于平滑替换）
const list = await window.api.chapters.list(projectId)
const unsub = window.api.llm.generateStream(prompt, { onToken })
```

主进程 `ipcMain.handle` 注册各通道，内部调用对应 Repository。

## 8. LLM 集成

- **Provider 工厂**：从原 `backend/app/llm/factory.py` 移植到 TS。支持 OpenAI / Claude(Anthropic) / DeepSeek / MiniMax / Qwen / Codex（OpenAI 兼容）。
- **调用链**：渲染进程 `invoke('llm:generate', {...})` → 主进程读 `providers.enc` 解密取 key → `fetch` 调 API → 解析 SSE → `webContents.send` 逐 token 推回渲染进程。
- **限流**：移植原 Token Bucket（默认 0.1 req/s，burst=2）。
- **密钥加密存储**：
  - 文件：`<userData>/config/providers.enc`
  - 算法：AES-256-GCM（替代 Python Fernet）
  - 密钥派生：机器特征（如 macOS IOPlatformUUID / Windows MachineGuid）+ 用户可选主密码，PBKDF2 派生。
- **复用外部配置**（可选增强）：检测 `~/.claude/settings.json`、`~/.cc-switch/cc-switch.db`、环境变量，自动导入 key。

## 9. 正文写作（AI 辅助章节生成）

整个应用最核心的创作闭环。在章节编辑器内，基于「细纲 + 记忆 + 风格」组装上下文，调 LLM 流式生成正文，支持去味润色与多版本对比。提示词模板从原 `backend/app/prompts/` 移植到主进程，作为可编辑资源。

### 9.1 上下文组装（Prompt 工程）

正文生成的输入由主进程从各 Repository 实时聚合：

| 输入 | 来源 |
|---|---|
| 本章细纲 | `细纲/第NN卷.md`（情绪 / 爽点 / 钩子 / 角色出场 / 剧情概要） |
| 出场人物档案 | `记忆/人物/*.md` 或 `设定/角色/`（按本章登场过滤） |
| 伏笔任务 | `追踪/伏笔.md`（pending / planted 且本章相关） |
| 角色状态 / 上下文 | `追踪/角色状态.md`、`追踪/上下文.md` |
| 写作风格 | 项目风格配置 / StyleProfile |
| 前文衔接 | 前章正文或摘要链 |
| 世界观 / 设定 | `设定/`、`记忆/世界观/` |

### 9.2 生成流程

1. 编辑器点「生成本章」→ 主进程按 9.1 组装上下文  
2. 选 provider + 风格 + 目标字数 → 流式生成（token 经 IPC 推送）  
3. 用户可打断 / 局部重写 / 去 AI 味  
4. 保存写入 `正文/第NNN章 标题.md`  

### 9.3 去味润色（deslop）

`DeslopService`：扫描 AI 味句式 / 毒点等，输出问题清单 + 改写；规则可在设置中分节编辑。

### 9.4 版本管理

**暂未开放**。原设计中的 `chapters/NNN.versions.json` 与三类 source（ai/manual/reviewed）未在 v4 落地；IPC 为 stub，编辑器 UI 已隐藏。后续若重做，应挂在 `正文/` 旁或独立版本目录，避免回退到已删除的 `chapters/`。

## 10. 前端改造（最小化）

| 改动 | 内容 |
|---|---|
| 删除 | `services/api/*`（HTTP 客户端） |
| 新增 | `preload` 暴露的 `window.api`（IPC 封装），保持同形接口 |
| 砍页面 | FanqieChartPage / Workflow* / Agent* / IdeasPage / RuleManager / GenreFormulas |
| 路由 | 裁剪对应路由，保留创作闭环 |
| Store | Zustand 几乎不变（只换数据来源） |
| 设置页 | 改为本地密钥管理 + 默认项目路径 |

## 11. 数据迁移（可选）

提供"导入旧项目"功能（一次性脚本或应用内入口）：

```
读 backend/data/db/ai_writer.db (SQLite)
  → 遍历 projects
  → 按第 5.4 节映射写成本地文件夹结构
  → 注册进 library.json
```

覆盖核心 MVP 涉及的 13 张表。番茄/工作流/Agent 数据跳过。

## 12. 错误处理

- 文件读写失败：捕获并向上抛带上下文的可读错误（项目编码规范）。
- JSON 损坏：Schema 校验失败 → 降级提示 + 从 `.versions.json` / 备份恢复选项。
- 写冲突：乐观锁检测到 `updatedAt` 不匹配 → 提示外部修改，让用户选择覆盖/保留两份。
- LLM 失败：重试 + 限流 + 友好错误信息，不泄露 key。
- 密钥错误：解密失败 → 提示重设主密码。

## 13. 测试策略

- **单元**：Repository（用临时目录测 load/save/原子写/Schema 校验）、加密、provider 工厂（mock fetch）、正文写作上下文组装。
- **集成**：IPC 端到端（主+渲染，临时 userData 目录）。
- **E2E**：Playwright 驱动 Electron，覆盖"新建项目→写章节→AI 生成正文→存文件→重开→数据还在"等关键流程。
- 目标覆盖率 80%+（遵循项目测试规范）。

## 14. 实现阶段

1. **脚手架**：Electron + 复用原前端工程 + preload IPC 骨架 + TypeScript。
2. **文件层**：FileRepository 基类（原子写/乐观锁/Schema）+ ProjectLibrary。
3. **章节读写闭环**：章节读写 + 编辑器打通（验证「存本地文件」核心）。
4. **记忆系统**：Markdown 实体 repo（人物/关系/地点…）+ 追踪表 + v3→v4 迁移。
5. **LLM 基础设施**：多 provider + 密钥加密 + 流式通道。
6. **正文写作** ⭐：上下文组装 + 流式生成 + 去味润色（核心创作闭环）。
7. **大纲 / 细纲**：`大纲/` `细纲/` Markdown + AI 区间生成（开书向导已移除）。
8. **打包**：electron-builder 出 Windows 安装包（macOS 可选后续）。

## 15. 风险与对策

| 风险 | 对策 |
|---|---|
| 大量章节时目录扫描慢 | `index.json` 缓存章节列表，启动时增量校对 |
| 用户外部改文件导致不一致 | 启动/聚焦时基于 mtime 增量重读 + 乐观锁 |
| 密钥丢了打不开 | 主密码可重置（重置后需重填 key），提供明文导出警告 |
| 跨平台路径/编码问题 | 统一用 `path.join`，文件名做安全化（去非法字符） |
| 网盘同步冲突 | 乐观锁 + 冲突文件保留两份提示 |
| 正文上下文超 token 上限 | 前文摘要链按章节数自适应截断 + 记忆按相关性检索 |

---

**实现**：按第 14 节 8 阶段推进。可视化方案见 `桌面应用设计方案.html`。
