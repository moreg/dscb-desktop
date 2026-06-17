# Phase 01：Electron 脚手架 + 项目库文件读取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `E:\trea\写作桌面应用` 搭建一个可运行的 Electron + Vite + React + TypeScript 工程，跑通「主进程创建窗口 → preload 暴露 `window.api` → 主进程读取本地 `library.json` → 渲染进程显示项目列表」全链路，并用单元测试覆盖文件读写逻辑。

**Architecture:** 采用 `electron-vite` 官方一体化工具（main / preload / renderer 三段统一构建）。主进程负责窗口与文件 I/O，渲染进程只通过 `contextBridge` 暴露的 `window.api`（IPC）与主进程通信，`contextIsolation: true`、`nodeIntegration: false` 保证安全边界。文件读写走「读 JSON → 不可变更新 → 原子写（.tmp + rename）」，与 [设计 spec §6](../specs/2026-06-17-desktop-app-design.md) 一致。共享类型放 `src/shared/`，主进程与渲染进程共用。

**Tech Stack:** Electron 31 · electron-vite 2 · Vite 5 · React 18 · TypeScript 5 · Vitest 2（单测）

---

## File Structure

执行完毕后工程结构如下（每文件单一职责）：

```
E:/trea/写作桌面应用/
├─ package.json                      依赖与 scripts（dev/build/test）
├─ electron.vite.config.ts           三段统一构建配置
├─ tsconfig.json                     根（references 汇总）
├─ tsconfig.node.json                main + preload（Node 环境）
├─ tsconfig.web.json                 renderer（DOM 环境）
├─ vitest.config.ts                  单测配置
├─ .gitignore
├─ src/
│  ├─ shared/
│  │  └─ types.ts                    共享类型：ProjectMeta / Library
│  ├─ main/
│  │  ├─ index.ts                    主进程入口：创建窗口、注册 IPC
│  │  ├─ data/
│  │  │  ├─ atomic.ts                readJson / writeJsonAtomic（原子写）
│  │  │  └─ library-repository.ts    LibraryRepository（list/create）
│  │  └─ ipc/
│  │     └─ library.ts               library:list / library:create 通道
│  ├─ preload/
│  │  ├─ index.ts                    contextBridge 暴露 window.api
│  │  └─ index.d.ts                  window.api 类型声明（渲染进程可见）
│  └─ renderer/
│     ├─ index.html                  Vite HTML 入口
│     └─ src/
│        ├─ main.tsx                 React 挂载
│        └─ App.tsx                  项目列表页（调 window.api.listProjects）
└─ tests/
   ├─ atomic.test.ts                 原子读写单测
   └─ library-repository.test.ts     LibraryRepository 单测
```

**职责边界：**
- `shared/types.ts` — 主进程与渲染进程共用的纯类型，无运行时逻辑
- `main/data/atomic.ts` — 只管「安全地读写一个 JSON 文件」，不知道任何业务
- `main/data/library-repository.ts` — 只管 library.json 的业务语义（list/create）
- `main/ipc/library.ts` — 只管把 IPC 通道接到 Repository，无业务
- `main/index.ts` — 组装：建窗口、实例化 Repository、注册 IPC
- `preload/index.ts` + `index.d.ts` — 唯一的进程间桥梁，渲染进程的唯一入口

---

## Task 1：初始化工程与依赖

**Files:**
- Create: `package.json`
- Create: `electron.vite.config.ts`
- Create: `tsconfig.json`、`tsconfig.node.json`、`tsconfig.web.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1.1：写 `package.json`**

```json
{
  "name": "ai-writer-desktop",
  "version": "0.1.0",
  "description": "ai-writer 桌面版（本地文件存储）",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "electron": "^31.0.0",
    "electron-vite": "^2.3.0",
    "typescript": "^5.5.0",
    "vite": "^5.3.0",
    "vitest": "^2.0.0"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  }
}
```

- [ ] **Step 1.2：写 `electron.vite.config.ts`**

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } }
  }
})
```

- [ ] **Step 1.3：写 `tsconfig.json`（根，仅汇总 references）**

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

- [ ] **Step 1.4：写 `tsconfig.node.json`（main + preload + tests）**

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "./out",
    "resolveJsonModule": true
  },
  "include": ["src/main/**/*", "src/preload/**/*", "src/shared/**/*", "tests/**/*", "*.config.ts"]
}
```

- [ ] **Step 1.5：写 `tsconfig.web.json`（renderer）**

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["@types/react", "@types/react-dom"],
    "resolveJsonModule": true
  },
  "include": ["src/renderer/**/*", "src/shared/**/*"]
}
```

- [ ] **Step 1.6：写 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] }
})
```

- [ ] **Step 1.7：写 `.gitignore`**

```
node_modules/
out/
dist/
*.log
.DS_Store
```

- [ ] **Step 1.8：安装依赖**

Run: `npm install`
Expected: 安装成功，生成 `node_modules/` 与 `package-lock.json`，无错误（warnings 可忽略）。

- [ ] **Step 1.9：验证 electron-vite 可用**

Run: `npx electron-vite --version`
Expected: 打印版本号（如 `electron-vite/2.x.x`），不报错。

- [ ] **Step 1.10：初始化 git 并提交骨架**

Run:
```bash
git init
git add .
git commit -m "chore: scaffold electron-vite + react + ts project"
```
Expected: 仓库初始化并完成首次提交（`node_modules`、`out` 已被 gitignore 忽略）。

---

## Task 2：共享类型与原子读写（TDD）

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/main/data/atomic.ts`
- Test: `tests/atomic.test.ts`

- [ ] **Step 2.1：先写共享类型 `src/shared/types.ts`**

```ts
export interface ProjectMeta {
  id: string
  name: string
  path: string
  genre?: string
  createdAt: string
  lastOpenedAt: string
}

export interface Library {
  schemaVersion: number
  projects: ProjectMeta[]
}
```

- [ ] **Step 2.2：写失败测试 `tests/atomic.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { readJson, writeJsonAtomic } from '../src/main/data/atomic'

describe('atomic json io', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'aw-atomic-')) })

  it('returns fallback when file missing', async () => {
    const result = await readJson(path.join(dir, 'nope.json'), { ok: false })
    expect(result).toEqual({ ok: false })
  })

  it('writes then reads round-trip', async () => {
    const file = path.join(dir, 'data.json')
    await writeJsonAtomic(file, { a: 1, list: [1, 2] })
    const read = await readJson<{ a: number; list: number[] }>(file, { a: 0, list: [] })
    expect(read).toEqual({ a: 1, list: [1, 2] })
  })

  it('does not leave a .tmp file after write', async () => {
    const file = path.join(dir, 'data.json')
    await writeJsonAtomic(file, { x: 1 })
    const raw = await readFile(file, 'utf-8')
    expect(JSON.parse(raw)).toEqual({ x: 1 })
  })
})
```

- [ ] **Step 2.3：运行测试，确认失败**

Run: `npx vitest run tests/atomic.test.ts`
Expected: FAIL，错误为 `Cannot find module '../src/main/data/atomic'`（文件尚未创建）。

- [ ] **Step 2.4：写最小实现 `src/main/data/atomic.ts`**

```ts
import { promises as fs } from 'fs'
import path from 'path'

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return fallback
    throw err
  }
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, file)
}
```

- [ ] **Step 2.5：运行测试，确认通过**

Run: `npx vitest run tests/atomic.test.ts`
Expected: 3 个测试全部 PASS。

- [ ] **Step 2.6：提交**

```bash
git add src/shared/types.ts src/main/data/atomic.ts tests/atomic.test.ts
git commit -m "feat: add shared types and atomic json read/write"
```

---

## Task 3：LibraryRepository（TDD）

**Files:**
- Create: `src/main/data/library-repository.ts`
- Test: `tests/library-repository.test.ts`

- [ ] **Step 3.1：写失败测试 `tests/library-repository.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { LibraryRepository } from '../src/main/data/library-repository'

describe('LibraryRepository', () => {
  let dir: string
  let repo: LibraryRepository
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-lib-'))
    repo = new LibraryRepository(path.join(dir, 'library.json'))
  })

  it('lists empty when library.json absent', async () => {
    expect(await repo.list()).toEqual([])
  })

  it('creates a project with id and timestamps', async () => {
    const p = await repo.create({ name: '测试小说', path: dir })
    expect(p.id).toMatch(/.+/)
    expect(p.name).toBe('测试小说')
    expect(p.createdAt).toBeTruthy()
    expect(p.lastOpenedAt).toBeTruthy()
  })

  it('persists created project across instances', async () => {
    await repo.create({ name: '小说A', path: dir })
    const repo2 = new LibraryRepository(path.join(dir, 'library.json'))
    const list = await repo2.list()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('小说A')
  })
})
```

- [ ] **Step 3.2：运行测试，确认失败**

Run: `npx vitest run tests/library-repository.test.ts`
Expected: FAIL，`Cannot find module '../src/main/data/library-repository'`。

- [ ] **Step 3.3：写实现 `src/main/data/library-repository.ts`**

```ts
import { randomUUID } from 'crypto'
import { readJson, writeJsonAtomic } from './atomic'
import type { Library, ProjectMeta } from '../../shared/types'

const EMPTY: Library = { schemaVersion: 1, projects: [] }

export interface CreateProjectInput {
  name: string
  path: string
  genre?: string
}

export class LibraryRepository {
  constructor(private readonly libraryFile: string) {}

  async list(): Promise<ProjectMeta[]> {
    const lib = await readJson<Library>(this.libraryFile, EMPTY)
    return lib.projects
  }

  async create(input: CreateProjectInput): Promise<ProjectMeta> {
    const lib = await readJson<Library>(this.libraryFile, EMPTY)
    const now = new Date().toISOString()
    const project: ProjectMeta = {
      id: randomUUID(),
      name: input.name,
      path: input.path,
      genre: input.genre,
      createdAt: now,
      lastOpenedAt: now
    }
    const next: Library = { ...lib, projects: [...lib.projects, project] }
    await writeJsonAtomic(this.libraryFile, next)
    return project
  }
}
```

- [ ] **Step 3.4：运行测试，确认通过**

Run: `npx vitest run tests/library-repository.test.ts`
Expected: 3 个测试全部 PASS。

- [ ] **Step 3.5：跑全量测试**

Run: `npx vitest run`
Expected: `atomic` + `library-repository` 共 6 个测试全部 PASS。

- [ ] **Step 3.6：提交**

```bash
git add src/main/data/library-repository.ts tests/library-repository.test.ts
git commit -m "feat: add LibraryRepository for library.json"
```

---

## Task 4：IPC 通道与主进程入口

**Files:**
- Create: `src/main/ipc/library.ts`
- Create: `src/main/index.ts`

- [ ] **Step 4.1：写 IPC 注册 `src/main/ipc/library.ts`**

```ts
import { ipcMain } from 'electron'
import { LibraryRepository, type CreateProjectInput } from '../data/library-repository'
import type { ProjectMeta } from '../../shared/types'

export function registerLibraryIpc(repo: LibraryRepository): void {
  ipcMain.handle('library:list', async (): Promise<ProjectMeta[]> => repo.list())
  ipcMain.handle('library:create', async (_e, input: CreateProjectInput): Promise<ProjectMeta> =>
    repo.create(input)
  )
}
```

- [ ] **Step 4.2：写主进程入口 `src/main/index.ts`**

```ts
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { LibraryRepository } from './data/library-repository'
import { registerLibraryIpc } from './ipc/library'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const libraryFile = join(app.getPath('userData'), 'library.json')
  const repo = new LibraryRepository(libraryFile)
  registerLibraryIpc(repo)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 4.3：类型检查主进程代码**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: 无错误。

- [ ] **Step 4.4：提交**

```bash
git add src/main/ipc/library.ts src/main/index.ts
git commit -m "feat: wire up main process with library ipc"
```

---

## Task 5：Preload 桥与渲染进程类型

**Files:**
- Create: `src/preload/index.ts`
- Create: `src/preload/index.d.ts`

- [ ] **Step 5.1：写 preload `src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron'
import type { CreateProjectInput } from '../main/data/library-repository'

const api = {
  listProjects: () => ipcRenderer.invoke('library:list'),
  createProject: (input: CreateProjectInput) => ipcRenderer.invoke('library:create', input)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
```

- [ ] **Step 5.2：写类型声明 `src/preload/index.d.ts`**

```ts
import type { Api } from './index'
import type { ProjectMeta } from '../shared/types'

declare global {
  interface Window {
    api: Api
  }
}

export {}
```

- [ ] **Step 5.3：类型检查**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: 无错误。

- [ ] **Step 5.4：提交**

```bash
git add src/preload/index.ts src/preload/index.d.ts
git commit -m "feat: expose window.api via contextBridge"
```

---

## Task 6：渲染进程（项目列表页）

**Files:**
- Create: `src/renderer/index.html`
- Create: `src/renderer/src/main.tsx`
- Create: `src/renderer/src/App.tsx`

- [ ] **Step 6.1：写 `src/renderer/index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ai-writer 桌面版</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6.2：写 `src/renderer/src/main.tsx`**

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

- [ ] **Step 6.3：写 `src/renderer/src/App.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { ProjectMeta } from '../../../shared/types'

export default function App() {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void window.api.listProjects().then((list) => {
      setProjects(list)
      setLoading(false)
    })
  }, [])

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 720, margin: '40px auto', padding: '0 20px' }}>
      <h1>ai-writer 桌面版</h1>
      <p style={{ color: '#64748b' }}>Phase 01 脚手架 · 项目库（读取本地 library.json）</p>
      <h2>我的项目</h2>
      {loading ? (
        <p>加载中…</p>
      ) : projects.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>暂无项目（首次启动，library.json 还没创建）</p>
      ) : (
        <ul>
          {projects.map((p) => (
            <li key={p.id}>
              <strong>{p.name}</strong>
              {p.genre ? <span style={{ color: '#64748b' }}> · {p.genre}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 6.4：类型检查渲染进程**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: 无错误。

- [ ] **Step 6.5：提交**

```bash
git add src/renderer/
git commit -m "feat: render project list from window.api"
```

---

## Task 7：端到端启动验证

**Files:** 无新增（验证已有代码可运行）

- [ ] **Step 7.1：启动开发模式**

Run: `npm run dev`
Expected: Electron 窗口弹出，标题「ai-writer 桌面版」，正文显示「Phase 01 脚手架…」与「暂无项目（首次启动，library.json 还没创建）」。无控制台报错。

> 若窗口空白：打开开发者工具（Ctrl+Shift+I）查看 Console 报错；常见原因是 `__dirname` 指向或 preload 路径不对——确认 `electron.vite.config.ts` 的 preload input 与 `main/index.ts` 里 `join(__dirname, '../preload/index.js')` 一致。

- [ ] **Step 7.2：手动写入测试数据验证读取链路**

保持应用运行。在另一个终端找到 userData 目录并写入 `library.json`：
- Windows 路径形如：`C:\Users\<你>\AppData\Roaming\ai-writer-desktop\library.json`

写入内容：
```json
{
  "schemaVersion": 1,
  "projects": [
    {
      "id": "test-1",
      "name": "示范小说",
      "path": "C:/tmp/demo",
      "genre": "玄幻",
      "createdAt": "2026-06-17T00:00:00.000Z",
      "lastOpenedAt": "2026-06-17T00:00:00.000Z"
    }
  ]
}
```
然后在应用里刷新（Ctrl+R）。Expected: 列表显示「示范小说 · 玄幻」。

> 这一步证明「主进程读本地文件 → IPC → 渲染显示」全链路打通，正是 spec §5「存本地文件」核心目标的最小验证。

- [ ] **Step 7.3：删除测试数据恢复干净状态**

删除 userData 目录下的 `library.json`，刷新应用，确认回到「暂无项目」。

- [ ] **Step 7.4：提交验证记录（可选 README）**

```bash
git commit --allow-empty -m "chore: phase 01 scaffold verified end-to-end"
```

---

## Task 8：收尾

**Files:**
- Create: `README.md`（仅启动说明，简短）

- [ ] **Step 8.1：写 `README.md`**

```markdown
# ai-writer 桌面版

Electron 桌面应用，小说存本地文件。当前为 Phase 01 脚手架。

## 开发

\`\`\`bash
npm install
npm run dev      # 启动 Electron + Vite 热更新
npm test         # 单元测试
npm run build    # 构建产物到 out/
\`\`\`

## 数据位置

项目库索引：\`<userData>/library.json\`
- Windows: \`%APPDATA%/ai-writer-desktop/library.json\`

## 设计文档

- 设计方案：\`桌面应用设计方案.html\`
- Spec：\`docs/superpowers/specs/2026-06-17-desktop-app-design.md\`
- 本阶段计划：\`docs/superpowers/plans/2026-06-17-electron-scaffold.md\`
```

- [ ] **Step 8.2：最终全量测试与类型检查**

Run: `npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: 全部测试 PASS，类型检查无错误。

- [ ] **Step 8.3：提交**

```bash
git add README.md
git commit -m "docs: add readme for phase 01 scaffold"
```

---

## 完成标准（Definition of Done）

- [ ] `npm run dev` 能弹出窗口并显示项目列表页
- [ ] `npm test` 6 个单测全绿
- [ ] `tsc --noEmit` 两个项目均无错误
- [ ] 手动写入 `library.json` 后刷新能看到项目，证明「读本地文件→渲染」链路通
- [ ] 所有改动已分任务提交

## 下一阶段（不在本 plan 范围）

- **Phase 02**：章节 Repository（`chapters/NNN.md` + `NNN.meta.json` 读写）、`project.json`、ProjectLibrary 索引、新建项目向导
- **Phase 03**：章节编辑器 UI 打通（基于 Phase 02 的 Repository）
- 后续阶段见 [spec §14](../specs/2026-06-17-desktop-app-design.md)
