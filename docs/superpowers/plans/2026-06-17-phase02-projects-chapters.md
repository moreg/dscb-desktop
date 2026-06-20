# Phase 02：项目目录与章节文件存储 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Phase 01 脚手架上落地「项目 = 一个文件夹」与「章节 = NNN.md + NNN.meta.json」的文件存储，提供新建项目、章节列表、章节编辑器 UI，形成最小创作闭环。

**Architecture:** 项目目录以 `projectId`（uuid）命名，放在 `<userData>/projects/<id>/`，内含 `project.json` + `chapters/`。`ProjectService` 协调「建目录 + 写 project.json + 注册 library.json」；`ProjectRepository`/`ChapterRepository` 各管一类文件的读写（复用 Phase 01 的 `atomic.ts` 原子写）。渲染进程通过扩展后的 `window.api`（projects:* / chapters:* IPC）操作，UI 用状态切换（无路由库，YAGNI）。

**Tech Stack:** 复用 Phase 01 的 Electron + electron-vite + React + TypeScript + Vitest，无新增依赖。

---

## File Structure

新增/修改文件（在 `E:/trea/写作桌面应用/` 下）：

```
src/
├─ shared/types.ts                [改] 加 ProjectData/ChapterMeta/ChapterContent/各 Input + 扩展 RendererApi
├─ main/
│  ├─ index.ts                    [改] 实例化 ProjectService、注册 projects/chapters IPC
│  ├─ data/
│  │  ├─ project-repository.ts    [新] project.json 读写
│  │  ├─ chapter-repository.ts    [新] 章节 CRUD（NNN.md + NNN.meta.json）
│  │  └─ project-service.ts       [新] 协调建项目流程 + resolveDir（projectId→目录）
│  └─ ipc/
│     ├─ projects.ts              [新] projects:create / projects:get
│     └─ chapters.ts              [新] chapters:list/get/create/updateContent/updateMeta/delete
├─ preload/index.ts               [改] 扩展 window.api
└─ renderer/src/
   ├─ App.tsx                     [改] 状态机：项目列表 ↔ 章节列表 ↔ 编辑器
   ├─ ProjectListPage.tsx         [新] 项目列表 + 新建项目对话框
   ├─ ChapterListPage.tsx         [新] 章节列表 + 新建章节
   └─ ChapterEditor.tsx           [新] 正文 textarea + 保存 + meta 显示
tests/
├─ project-repository.test.ts     [新]
├─ chapter-repository.test.ts     [新]
└─ project-service.test.ts        [新]
```

**职责边界：**
- `project-repository.ts` — 只管单个 `project.json` 的读写
- `chapter-repository.ts` — 只管单个项目 `chapters/` 目录的章节 CRUD
- `project-service.ts` — 协调「建目录 + project.json + library 注册」，并提供 `resolveDir(projectId)`
- `ipc/projects.ts` / `ipc/chapters.ts` — 把 IPC 通道接到 service/repository
- 渲染进程三个页面组件各管一个视图，App 只管视图状态切换

---

## Task 1：扩展共享类型

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1.1：在 `src/shared/types.ts` 末尾追加类型**

```ts
export type ChapterStatus = 'outline' | 'draft' | 'reviewed' | 'published'

export interface ProjectData {
  schemaVersion: number
  updatedAt: string
  id: string
  name: string
  genre?: string
  description?: string
  targetChapters?: number
  chapterWordCount?: number
  status?: string
  createdAt: string
}

export interface ChapterMeta {
  schemaVersion: number
  updatedAt: string
  chapterNumber: number
  title: string
  wordCount: number
  status: ChapterStatus
  synopsis?: string
  hook?: string
}

export interface ChapterContent {
  meta: ChapterMeta
  content: string
}

export interface CreateProjectDataInput {
  name: string
  genre?: string
  description?: string
  targetChapters?: number
  chapterWordCount?: number
}

export interface CreateChapterInput {
  title: string
}

export interface UpdateChapterMetaInput {
  title?: string
  status?: ChapterStatus
  synopsis?: string
  hook?: string
}
```

- [ ] **Step 1.2：替换 `RendererApi`，扩展 projects/channels 方法**

把现有 `RendererApi` 接口整体替换为：

```ts
export interface RendererApi {
  listProjects: () => Promise<ProjectMeta[]>
  createProject: (input: CreateProjectDataInput) => Promise<ProjectMeta>
  getProject: (projectId: string) => Promise<ProjectData>
  listChapters: (projectId: string) => Promise<ChapterMeta[]>
  getChapter: (projectId: string, n: number) => Promise<ChapterContent>
  createChapter: (projectId: string, input: CreateChapterInput) => Promise<ChapterMeta>
  updateChapterContent: (projectId: string, n: number, content: string) => Promise<ChapterMeta>
  updateChapterMeta: (projectId: string, n: number, patch: UpdateChapterMetaInput) => Promise<ChapterMeta>
  deleteChapter: (projectId: string, n: number) => Promise<void>
}
```

> 注意：`createProject` 的入参类型从 Phase 01 的 `CreateProjectInput`（含 path）改为 `CreateProjectDataInput`（不含 path，由 service 决定）。`CreateProjectInput` 保留给 `LibraryRepository` 内部用。

- [ ] **Step 1.3：类型检查**

Run: `npx tsc --noEmit -p tsconfig.web.json && npx tsc --noEmit -p tsconfig.node.json`
Expected: 无错误（preload/index.ts 的 `createProject` 暂时还用旧 `CreateProjectInput` 类型——下一步 Task 6 会改，此刻可能报错；若报错先跳过，Task 6 修完再验）。

- [ ] **Step 1.4：提交**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add project/chapter data types and extend renderer api"
```

---

## Task 2：ProjectRepository（TDD）

**Files:**
- Create: `src/main/data/project-repository.ts`
- Test: `tests/project-repository.test.ts`

- [ ] **Step 2.1：写失败测试 `tests/project-repository.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectRepository } from '../src/main/data/project-repository'
import type { ProjectData } from '../src/shared/types'

describe('ProjectRepository', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-proj-'))
  })

  it('returns null when project.json absent', async () => {
    const repo = new ProjectRepository(dir)
    expect(await repo.read()).toBeNull()
  })

  it('writes then reads project data', async () => {
    const repo = new ProjectRepository(dir)
    const data: ProjectData = {
      schemaVersion: 1,
      updatedAt: '2026-06-17T00:00:00.000Z',
      id: 'p1',
      name: '示范小说',
      genre: '玄幻',
      createdAt: '2026-06-17T00:00:00.000Z'
    }
    await repo.write(data)
    const read = await repo.read()
    expect(read).toEqual(data)
  })
})
```

- [ ] **Step 2.2：运行测试，确认失败**

Run: `npx vitest run tests/project-repository.test.ts`
Expected: FAIL，`Cannot find module '../src/main/data/project-repository'`。

- [ ] **Step 2.3：写实现 `src/main/data/project-repository.ts`**

```ts
import { join } from 'path'
import { readJson, writeJsonAtomic } from './atomic'
import type { ProjectData } from '../../shared/types'

export class ProjectRepository {
  constructor(private readonly projectDir: string) {}

  async read(): Promise<ProjectData | null> {
    return readJson<ProjectData | null>(join(this.projectDir, 'project.json'), null)
  }

  async write(data: ProjectData): Promise<void> {
    await writeJsonAtomic(join(this.projectDir, 'project.json'), data)
  }
}
```

- [ ] **Step 2.4：运行测试，确认通过**

Run: `npx vitest run tests/project-repository.test.ts`
Expected: 2 passed。

- [ ] **Step 2.5：提交**

```bash
git add src/main/data/project-repository.ts tests/project-repository.test.ts
git commit -m "feat: add ProjectRepository for project.json"
```

---

## Task 3：ChapterRepository（TDD）

**Files:**
- Create: `src/main/data/chapter-repository.ts`
- Test: `tests/chapter-repository.test.ts`

- [ ] **Step 3.1：写失败测试 `tests/chapter-repository.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ChapterRepository } from '../src/main/data/chapter-repository'

describe('ChapterRepository', () => {
  let dir: string
  let repo: ChapterRepository
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-chap-'))
    repo = new ChapterRepository(dir)
  })

  it('lists empty when no chapters', async () => {
    expect(await repo.list()).toEqual([])
  })

  it('creates chapter 1 with zero word count', async () => {
    const meta = await repo.create({ title: '第一章' })
    expect(meta.chapterNumber).toBe(1)
    expect(meta.wordCount).toBe(0)
    expect(meta.status).toBe('outline')
  })

  it('creates sequential chapter numbers', async () => {
    await repo.create({ title: '一' })
    await repo.create({ title: '二' })
    const list = await repo.list()
    expect(list.map((m) => m.chapterNumber)).toEqual([1, 2])
  })

  it('updateContent writes md and updates word count', async () => {
    await repo.create({ title: '一' })
    const meta = await repo.updateContent(1, '林远觉醒了金符文。')
    expect(meta.wordCount).toBe(9)
    const md = await readFile(path.join(dir, 'chapters', '001.md'), 'utf-8')
    expect(md).toBe('林远觉醒了金符文。')
  })

  it('get returns meta and content', async () => {
    await repo.create({ title: '一' })
    await repo.updateContent(1, '正文内容')
    const got = await repo.get(1)
    expect(got.meta.title).toBe('一')
    expect(got.content).toBe('正文内容')
  })

  it('delete removes both md and meta', async () => {
    await repo.create({ title: '一' })
    await repo.delete(1)
    expect(await repo.list()).toEqual([])
  })

  it('uses zero-padded 3-digit filenames', async () => {
    await repo.create({ title: '一' })
    const raw = await readFile(path.join(dir, 'chapters', '001.meta.json'), 'utf-8')
    expect(JSON.parse(raw).chapterNumber).toBe(1)
  })
})
```

- [ ] **Step 3.2：运行测试，确认失败**

Run: `npx vitest run tests/chapter-repository.test.ts`
Expected: FAIL，`Cannot find module '../src/main/data/chapter-repository'`。

- [ ] **Step 3.3：写实现 `src/main/data/chapter-repository.ts`**

```ts
import { promises as fs } from 'fs'
import { join } from 'path'
import { readJson, writeJsonAtomic } from './atomic'
import type {
  ChapterMeta,
  ChapterContent,
  CreateChapterInput,
  UpdateChapterMetaInput
} from '../../shared/types'

const PAD = 3

function chapterFile(projectDir: string, n: number, ext: string): string {
  return join(projectDir, 'chapters', `${String(n).padStart(PAD, '0')}.${ext}`)
}

function countWords(text: string): number {
  return text.replace(/\s/g, '').length
}

export class ChapterRepository {
  constructor(private readonly projectDir: string) {}

  async list(): Promise<ChapterMeta[]> {
    const chaptersDir = join(this.projectDir, 'chapters')
    let files: string[]
    try {
      files = await fs.readdir(chaptersDir)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      throw err
    }
    const metas: ChapterMeta[] = []
    for (const f of files.sort()) {
      if (!f.endsWith('.meta.json')) continue
      const meta = await readJson<ChapterMeta | null>(join(chaptersDir, f), null)
      if (meta) metas.push(meta)
    }
    return metas.sort((a, b) => a.chapterNumber - b.chapterNumber)
  }

  async get(n: number): Promise<ChapterContent> {
    const meta = await readJson<ChapterMeta | null>(chapterFile(this.projectDir, n, 'meta.json'), null)
    if (!meta) throw new Error(`chapter ${n} meta not found`)
    let content = ''
    try {
      content = await fs.readFile(chapterFile(this.projectDir, n, 'md'), 'utf-8')
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') throw err
    }
    return { meta, content }
  }

  async create(input: CreateChapterInput): Promise<ChapterMeta> {
    const list = await this.list()
    const nextNumber = list.length === 0 ? 1 : Math.max(...list.map((m) => m.chapterNumber)) + 1
    const now = new Date().toISOString()
    const meta: ChapterMeta = {
      schemaVersion: 1,
      updatedAt: now,
      chapterNumber: nextNumber,
      title: input.title,
      wordCount: 0,
      status: 'outline'
    }
    await writeJsonAtomic(chapterFile(this.projectDir, nextNumber, 'meta.json'), meta)
    await writeJsonAtomic(chapterFile(this.projectDir, nextNumber, 'md'), '')
    return meta
  }

  async updateContent(n: number, content: string): Promise<ChapterMeta> {
    const meta = await readJson<ChapterMeta | null>(
      chapterFile(this.projectDir, n, 'meta.json'),
      null
    )
    if (!meta) throw new Error(`chapter ${n} meta not found`)
    await writeJsonAtomic(chapterFile(this.projectDir, n, 'md'), content)
    const next: ChapterMeta = {
      ...meta,
      wordCount: countWords(content),
      updatedAt: new Date().toISOString()
    }
    await writeJsonAtomic(chapterFile(this.projectDir, n, 'meta.json'), next)
    return next
  }

  async updateMeta(n: number, patch: UpdateChapterMetaInput): Promise<ChapterMeta> {
    const meta = await readJson<ChapterMeta | null>(
      chapterFile(this.projectDir, n, 'meta.json'),
      null
    )
    if (!meta) throw new Error(`chapter ${n} meta not found`)
    const next: ChapterMeta = { ...meta, ...patch, updatedAt: new Date().toISOString() }
    await writeJsonAtomic(chapterFile(this.projectDir, n, 'meta.json'), next)
    return next
  }

  async delete(n: number): Promise<void> {
    await fs.unlink(chapterFile(this.projectDir, n, 'md')).catch(() => undefined)
    await fs.unlink(chapterFile(this.projectDir, n, 'meta.json')).catch(() => undefined)
  }
}
```

- [ ] **Step 3.4：运行测试，确认通过**

Run: `npx vitest run tests/chapter-repository.test.ts`
Expected: 7 passed。

- [ ] **Step 3.5：提交**

```bash
git add src/main/data/chapter-repository.ts tests/chapter-repository.test.ts
git commit -m "feat: add ChapterRepository for NNN.md + NNN.meta.json"
```

---

## Task 4：ProjectService（TDD）

**Files:**
- Create: `src/main/data/project-service.ts`
- Test: `tests/project-service.test.ts`

- [ ] **Step 4.1：写失败测试 `tests/project-service.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'

describe('ProjectService', () => {
  let root: string
  let service: ProjectService
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-svc-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    service = new ProjectService(path.join(root, 'projects'), library)
  })

  it('create makes a project dir with chapters/ and project.json', async () => {
    const meta = await service.create({ name: '示范小说', genre: '玄幻' })
    const dirStat = await stat(meta.path)
    expect(dirStat.isDirectory()).toBe(true)
    const chaptersStat = await stat(path.join(meta.path, 'chapters'))
    expect(chaptersStat.isDirectory()).toBe(true)
    const pj = JSON.parse(await readFile(path.join(meta.path, 'project.json'), 'utf-8'))
    expect(pj.name).toBe('示范小说')
    expect(pj.genre).toBe('玄幻')
  })

  it('create registers the project in library', async () => {
    const meta = await service.create({ name: 'X' })
    const list = await service['library'].list()
    expect(list.find((p) => p.id === meta.id)).toBeTruthy()
  })

  it('resolveDir throws for unknown project', async () => {
    await expect(service.resolveDir('nope')).rejects.toThrow(/not found/)
  })

  it('getProjectData returns the written project data', async () => {
    const meta = await service.create({ name: 'X', description: 'desc' })
    const data = await service.getProjectData(meta.id)
    expect(data.name).toBe('X')
    expect(data.description).toBe('desc')
  })
})
```

- [ ] **Step 4.2：运行测试，确认失败**

Run: `npx vitest run tests/project-service.test.ts`
Expected: FAIL，`Cannot find module '../src/main/data/project-service'`。

- [ ] **Step 4.3：写实现 `src/main/data/project-service.ts`**

```ts
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { LibraryRepository } from './library-repository'
import { ProjectRepository } from './project-repository'
import { writeJsonAtomic } from './atomic'
import type { ProjectData, ProjectMeta, CreateProjectDataInput } from '../../shared/types'

export class ProjectService {
  constructor(
    private readonly projectsRoot: string,
    private readonly library: LibraryRepository
  ) {}

  async create(input: CreateProjectDataInput): Promise<ProjectMeta> {
    const id = randomUUID()
    const dir = join(this.projectsRoot, id)
    const now = new Date().toISOString()
    await fs.mkdir(join(dir, 'chapters'), { recursive: true })
    const data: ProjectData = {
      schemaVersion: 1,
      updatedAt: now,
      id,
      name: input.name,
      genre: input.genre,
      description: input.description,
      targetChapters: input.targetChapters,
      chapterWordCount: input.chapterWordCount,
      status: 'outline',
      createdAt: now
    }
    await writeJsonAtomic(join(dir, 'project.json'), data)
    return this.library.create({ name: input.name, path: dir, genre: input.genre })
  }

  async resolveDir(projectId: string): Promise<string> {
    const projects = await this.library.list()
    const p = projects.find((x) => x.id === projectId)
    if (!p) throw new Error(`project not found: ${projectId}`)
    return p.path
  }

  async getProjectData(projectId: string): Promise<ProjectData> {
    const dir = await this.resolveDir(projectId)
    const repo = new ProjectRepository(dir)
    const data = await repo.read()
    if (!data) throw new Error(`project.json missing in ${dir}`)
    return data
  }
}
```

- [ ] **Step 4.4：运行测试，确认通过**

Run: `npx vitest run tests/project-service.test.ts`
Expected: 4 passed。

- [ ] **Step 4.5：跑全量测试**

Run: `npx vitest run`
Expected: 全部测试通过（atomic 3 + library 3 + project-repo 2 + chapter-repo 7 + project-service 4 = 19）。

- [ ] **Step 4.6：提交**

```bash
git add src/main/data/project-service.ts tests/project-service.test.ts
git commit -m "feat: add ProjectService to orchestrate project creation"
```

---

## Task 5：IPC 与主进程接线

**Files:**
- Create: `src/main/ipc/projects.ts`
- Create: `src/main/ipc/chapters.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 5.1：写 `src/main/ipc/projects.ts`**

```ts
import { ipcMain } from 'electron'
import { ProjectService } from '../data/project-service'
import type { CreateProjectDataInput } from '../../shared/types'

export function registerProjectsIpc(service: ProjectService): void {
  ipcMain.handle('projects:create', (_e, input: CreateProjectDataInput) => service.create(input))
  ipcMain.handle('projects:get', (_e, id: string) => service.getProjectData(id))
}
```

- [ ] **Step 5.2：写 `src/main/ipc/chapters.ts`**

```ts
import { ipcMain } from 'electron'
import { ProjectService } from '../data/project-service'
import { ChapterRepository } from '../data/chapter-repository'
import type { CreateChapterInput, UpdateChapterMetaInput } from '../../shared/types'

export function registerChaptersIpc(service: ProjectService): void {
  const repoFor = async (id: string): Promise<ChapterRepository> => {
    const dir = await service.resolveDir(id)
    return new ChapterRepository(dir)
  }
  ipcMain.handle('chapters:list', async (_e, id: string) => (await repoFor(id)).list())
  ipcMain.handle('chapters:get', async (_e, id: string, n: number) => (await repoFor(id)).get(n))
  ipcMain.handle('chapters:create', async (_e, id: string, input: CreateChapterInput) =>
    (await repoFor(id)).create(input)
  )
  ipcMain.handle('chapters:updateContent', async (_e, id: string, n: number, content: string) =>
    (await repoFor(id)).updateContent(n, content)
  )
  ipcMain.handle('chapters:updateMeta', async (_e, id: string, n: number, patch: UpdateChapterMetaInput) =>
    (await repoFor(id)).updateMeta(n, patch)
  )
  ipcMain.handle('chapters:delete', async (_e, id: string, n: number) =>
    (await repoFor(id)).delete(n)
  )
}
```

- [ ] **Step 5.3：改 `src/main/index.ts`，接线 ProjectService 与新 IPC**

把 `app.whenReady().then(() => { ... })` 回调改为（替换原有的 repo 注册段落）：

```ts
app.whenReady().then(() => {
  const userData = app.getPath('userData')
  const libraryFile = join(userData, 'library.json')
  const projectsRoot = join(userData, 'projects')
  const libraryRepo = new LibraryRepository(libraryFile)
  const projectService = new ProjectService(projectsRoot, libraryRepo)

  registerLibraryIpc(libraryRepo)
  registerProjectsIpc(projectService)
  registerChaptersIpc(projectService)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
```

并在文件顶部 import 区追加：

```ts
import { ProjectService } from './data/project-service'
import { registerProjectsIpc } from './ipc/projects'
import { registerChaptersIpc } from './ipc/chapters'
```

- [ ] **Step 5.4：类型检查主进程**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: 无错误。

- [ ] **Step 5.5：提交**

```bash
git add src/main/ipc/projects.ts src/main/ipc/chapters.ts src/main/index.ts
git commit -m "feat: wire projects and chapters ipc"
```

---

## Task 6：扩展 preload 桥

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 6.1：整体替换 `src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron'
import type {
  CreateProjectDataInput,
  CreateChapterInput,
  UpdateChapterMetaInput
} from '../shared/types'

const api = {
  listProjects: () => ipcRenderer.invoke('library:list'),
  createProject: (input: CreateProjectDataInput) => ipcRenderer.invoke('projects:create', input),
  getProject: (id: string) => ipcRenderer.invoke('projects:get', id),
  listChapters: (id: string) => ipcRenderer.invoke('chapters:list', id),
  getChapter: (id: string, n: number) => ipcRenderer.invoke('chapters:get', id, n),
  createChapter: (id: string, input: CreateChapterInput) =>
    ipcRenderer.invoke('chapters:create', id, input),
  updateChapterContent: (id: string, n: number, content: string) =>
    ipcRenderer.invoke('chapters:updateContent', id, n, content),
  updateChapterMeta: (id: string, n: number, patch: UpdateChapterMetaInput) =>
    ipcRenderer.invoke('chapters:updateMeta', id, n, patch),
  deleteChapter: (id: string, n: number) => ipcRenderer.invoke('chapters:delete', id, n)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
```

> preload 从 `../shared/types` 直接 import 类型（不再经 main），彻底切断对 main/crypto 的连带依赖。

- [ ] **Step 6.2：类型检查两个项目**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: 无错误。

- [ ] **Step 6.3：提交**

```bash
git add src/preload/index.ts
git commit -m "feat: extend window.api with projects and chapters methods"
```

---

## Task 7：UI — 项目列表页 + 新建项目对话框

**Files:**
- Create: `src/renderer/src/ProjectListPage.tsx`

- [ ] **Step 7.1：写 `src/renderer/src/ProjectListPage.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { ProjectMeta } from '../../shared/types'

interface Props {
  onOpenProject: (projectId: string) => void
}

export default function ProjectListPage({ onOpenProject }: Props) {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)

  const refresh = () => {
    setLoading(true)
    void window.api.listProjects().then((list) => {
      setProjects(list)
      setLoading(false)
    })
  }

  useEffect(refresh, [])

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>我的项目</h2>
        <button onClick={() => setShowNew(true)}>+ 新建项目</button>
      </div>
      {loading ? (
        <p>加载中…</p>
      ) : projects.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>暂无项目，点击右上角新建。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {projects.map((p) => (
            <li
              key={p.id}
              style={{ padding: '12px', border: '1px solid #e2e8f0', borderRadius: 8, margin: '8px 0', cursor: 'pointer' }}
              onClick={() => onOpenProject(p.id)}
            >
              <strong>{p.name}</strong>
              {p.genre ? <span style={{ color: '#64748b' }}> · {p.genre}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {showNew ? (
        <NewProjectDialog
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [genre, setGenre] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      await window.api.createProject({ name: name.trim(), genre: genre.trim() || undefined, description: description.trim() || undefined })
      onCreated()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', padding: 24, borderRadius: 12, width: 380 }}>
        <h3 style={{ marginTop: 0 }}>新建项目</h3>
        <p>
          名称：<input value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} />
        </p>
        <p>
          题材：<input value={genre} onChange={(e) => setGenre(e.target.value)} placeholder="玄幻/都市/科幻…" style={{ width: '100%' }} />
        </p>
        <p>
          简介：<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} style={{ width: '100%' }} />
        </p>
        <div style={{ textAlign: 'right' }}>
          <button onClick={onClose} style={{ marginRight: 8 }}>取消</button>
          <button onClick={submit} disabled={saving || !name.trim()}>创建</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 7.2：类型检查**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: 无错误。

- [ ] **Step 7.3：提交**

```bash
git add src/renderer/src/ProjectListPage.tsx
git commit -m "feat: project list page with new-project dialog"
```

---

## Task 8：UI — 章节列表页

**Files:**
- Create: `src/renderer/src/ChapterListPage.tsx`

- [ ] **Step 8.1：写 `src/renderer/src/ChapterListPage.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { ChapterMeta } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
  onOpenChapter: (n: number) => void
}

export default function ChapterListPage({ projectId, onBack, onOpenChapter }: Props) {
  const [chapters, setChapters] = useState<ChapterMeta[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = () => {
    setLoading(true)
    void window.api.listChapters(projectId).then((list) => {
      setChapters(list)
      setLoading(false)
    })
  }

  useEffect(refresh, [projectId])

  const createChapter = async () => {
    const title = window.prompt('章节标题', `第 ${chapters.length + 1} 章`)
    if (!title) return
    await window.api.createChapter(projectId, { title })
    refresh()
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={onBack}>← 返回项目列表</button>
        <button onClick={createChapter}>+ 新建章节</button>
      </div>
      <h2>章节列表</h2>
      {loading ? (
        <p>加载中…</p>
      ) : chapters.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>暂无章节，点击右上角新建。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {chapters.map((c) => (
            <li
              key={c.chapterNumber}
              style={{ padding: '10px', border: '1px solid #e2e8f0', borderRadius: 8, margin: '6px 0', cursor: 'pointer' }}
              onClick={() => onOpenChapter(c.chapterNumber)}
            >
              <strong>第 {c.chapterNumber} 章 · {c.title}</strong>
              <span style={{ color: '#94a3b8', marginLeft: 12 }}>{c.wordCount} 字 · {c.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 8.2：类型检查**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: 无错误。

- [ ] **Step 8.3：提交**

```bash
git add src/renderer/src/ChapterListPage.tsx
git commit -m "feat: chapter list page"
```

---

## Task 9：UI — 章节编辑器 + App 状态机

**Files:**
- Create: `src/renderer/src/ChapterEditor.tsx`
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 9.1：写 `src/renderer/src/ChapterEditor.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { ChapterContent } from '../../shared/types'

interface Props {
  projectId: string
  chapterNumber: number
  onBack: () => void
}

export default function ChapterEditor({ projectId, chapterNumber, onBack }: Props) {
  const [data, setData] = useState<ChapterContent | null>(null)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.api.getChapter(projectId, chapterNumber).then((c) => {
      setData(c)
      setDraft(c.content)
      setDirty(false)
    })
  }, [projectId, chapterNumber])

  const save = async () => {
    setSaving(true)
    try {
      const meta = await window.api.updateChapterContent(projectId, chapterNumber, draft)
      setData({ meta, content: draft })
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  if (!data) return <p>加载中…</p>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={onBack}>← 返回章节列表</button>
        <span style={{ color: '#94a3b8' }}>
          第 {data.meta.chapterNumber} 章 · {data.meta.title} · {data.meta.wordCount} 字
        </span>
        <button onClick={save} disabled={!dirty || saving}>
          {saving ? '保存中…' : dirty ? '保存 *' : '已保存'}
        </button>
      </div>
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setDirty(true)
        }}
        style={{ width: '100%', height: '60vh', marginTop: 12, fontFamily: 'inherit', fontSize: 15, padding: 12 }}
        placeholder="在此输入正文……"
      />
    </div>
  )
}
```

- [ ] **Step 9.2：整体替换 `src/renderer/src/App.tsx` 为状态机**

```tsx
import { useState } from 'react'
import ProjectListPage from './ProjectListPage'
import ChapterListPage from './ChapterListPage'
import ChapterEditor from './ChapterEditor'

type View =
  | { kind: 'projects' }
  | { kind: 'chapters'; projectId: string }
  | { kind: 'editor'; projectId: string; chapterNumber: number }

export default function App() {
  const [view, setView] = useState<View>({ kind: 'projects' })

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 820, margin: '40px auto', padding: '0 20px' }}>
      <h1>ai-writer 桌面版</h1>
      <p style={{ color: '#64748b' }}>Phase 02 · 项目与章节（本地文件存储）</p>
      <hr />
      {view.kind === 'projects' ? (
        <ProjectListPage onOpenProject={(id) => setView({ kind: 'chapters', projectId: id })} />
      ) : view.kind === 'chapters' ? (
        <ChapterListPage
          projectId={view.projectId}
          onBack={() => setView({ kind: 'projects' })}
          onOpenChapter={(n) => setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })}
        />
      ) : (
        <ChapterEditor
          projectId={view.projectId}
          chapterNumber={view.chapterNumber}
          onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 9.3：类型检查**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: 无错误。

- [ ] **Step 9.4：提交**

```bash
git add src/renderer/src/ChapterEditor.tsx src/renderer/src/App.tsx
git commit -m "feat: chapter editor and app view state machine"
```

---

## Task 10：端到端验证 + 收尾

**Files:** 无新增（验证 + 文档）

- [ ] **Step 10.1：最终全量测试与类型检查**

Run:
```bash
npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
```
Expected: 全部测试通过（19 个），类型检查无错误。

- [ ] **Step 10.2：构建**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 10.3：临时加启动日志验证端到端**

临时修改 `src/main/index.ts`，在 `registerChaptersIpc(projectService)` 之后加一行：

```ts
void projectService.create({ name: '冒烟测试' }).then((m) => console.log('[smoke] created', m.id, m.path))
```

构建并运行：

```bash
npm run build && npx electron .
```

Expected: 控制台输出 `[smoke] created <id> <path>`，且退出后在 `<userData>/projects/<id>/` 下存在 `project.json` 与空的 `chapters/` 目录。

- [ ] **Step 10.4：回滚临时日志、清理冒烟测试数据**

- 删除 `src/main/index.ts` 里 Step 10.3 加的那行
- 删除冒烟测试产生的项目：`<userData>/projects/` 下对应目录 + 从 `<userData>/library.json` 移除「冒烟测试」条目
Run: `npx vitest run` 确认仍全绿，`npx tsc --noEmit -p tsconfig.node.json` 无错误。

- [ ] **Step 10.5：更新 README 的架构图与下一阶段**

把 `README.md` 里 `## 下一阶段` 改为：

```
Phase 03：章节编辑器增强（版本历史 NNN.versions.json）、记忆系统 Repository（人物/伏笔/时间线等）。
```

并在架构图补一句 `ChapterRepository (NNN.md + NNN.meta.json)`。

- [ ] **Step 10.6：提交收尾**

```bash
git add README.md
git commit -m "docs: update readme for phase 02"
```

---

## 完成标准（Definition of Done）

- [ ] `npm test` 19 个单测全绿
- [ ] `tsc --noEmit` 两个项目均无错误
- [ ] `npm run dev` / `npx electron .` 可：新建项目 → 进入章节列表 → 新建章节 → 编辑正文 → 保存 → 重开数据还在
- [ ] 文件落地：`<userData>/projects/<id>/project.json` + `chapters/NNN.md` + `NNN.meta.json`
- [ ] 所有改动已分任务提交

## 下一阶段（不在本 plan 范围）

- **Phase 03**：章节版本历史（`NNN.versions.json`）、记忆系统 Repository（人物/关系/地点/伏笔/时间线/世界观）、记忆审计 `history.jsonl`
- 后续 LLM / 正文写作 / 大纲 / 打包见 [spec §14](../specs/2026-06-17-desktop-app-design.md)
