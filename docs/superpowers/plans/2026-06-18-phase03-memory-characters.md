# Phase 03：记忆系统（人物管理 + 审计）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Phase 02 之上落地记忆系统的文件存储基础设施与人物管理闭环：通用集合 Repository、`memory/characters.json` 读写、`memory/history.jsonl` 审计日志、人物管理 UI（增删改查），为后续 7 类记忆实体（关系/地点/伏笔/时间线/剧情点/世界观/风格）确立可复用模式。

**Architecture:** 抽象一个泛型 `JsonCollectionRepository<T>`（`items` 数组 CRUD + 原子写，复用 Phase 01 的 `atomic.ts`），所有记忆集合型实体都基于它。`CharacterRepository` 封装人物特有逻辑（create 时补时间戳）。`MemoryHistory` 用 JSONL 追加写审计日志。`MemoryService` 协调 per-project 的 repo + history，并保证每次 CRUD 都留审计。渲染进程通过 `window.api.memory:*` IPC 操作。

**Tech Stack:** 复用 Phase 01/02 的 Electron + electron-vite + React + TypeScript + Vitest，无新增依赖。

---

## File Structure

新增/修改文件（在 `E:/trea/写作桌面应用/` 下）：

```
src/
├─ shared/types.ts                       [改] Character/Create/UpdateCharacterInput/HistoryEntry + RendererApi 扩展
├─ main/
│  ├─ index.ts                           [改] 实例化 MemoryService、注册 memory IPC
│  ├─ data/
│  │  ├─ json-collection-repository.ts   [新] 泛型 items 数组 CRUD 基类
│  │  ├─ character-repository.ts         [新] characters.json（基于基类）
│  │  ├─ memory-history.ts               [新] history.jsonl 追加写 + 读
│  │  └─ memory-service.ts               [新] 协调 repo + history，per project
│  └─ ipc/
│     └─ memory.ts                       [新] memory:character:* + memory:history:list
├─ preload/index.ts                      [改] 扩展 window.api.memory
└─ renderer/src/
   ├─ App.tsx                            [改] view 加 'characters'
   ├─ ChapterListPage.tsx                [改] 顶部加「人物管理」入口
   └─ CharacterManagerPage.tsx           [新] 人物列表 + 新建对话框 + 编辑 + 删除
tests/
├─ json-collection-repository.test.ts    [新]
├─ character-repository.test.ts          [新]
├─ memory-history.test.ts                [新]
└─ memory-service.test.ts                [新] 集成测试
```

**职责边界：**
- `json-collection-repository.ts` — 泛型 `{ items: T[] }` 的 CRUD，不知道任何业务实体
- `character-repository.ts` — 只管人物特有逻辑（时间戳补全 + 文件路径），CRUD 委托基类
- `memory-history.ts` — 只管 JSONL 追加写与读回
- `memory-service.ts` — 协调 repo + history，保证「每次人物 CRUD 必留一条审计」
- `ipc/memory.ts` — 把 IPC 通道接到 service
- 后续 7 类记忆实体可直接复用 `JsonCollectionRepository` + 同款 service 方法

---

## Task 1：扩展共享类型

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1.1：在 `src/shared/types.ts` 末尾追加类型**

```ts
export interface Character {
  id: string
  name: string
  role?: string
  identity?: string
  personality?: string
  abilities?: string
  tags?: string[]
  synopsis?: string
  createdAt: string
  updatedAt: string
}

export interface CreateCharacterInput {
  name: string
  role?: string
  identity?: string
  personality?: string
  abilities?: string
  tags?: string[]
  synopsis?: string
}

export interface UpdateCharacterInput {
  name?: string
  role?: string
  identity?: string
  personality?: string
  abilities?: string
  tags?: string[]
  synopsis?: string
}

export type MemoryAction = 'create' | 'update' | 'delete'

export interface HistoryEntry {
  at: string
  type: string
  action: MemoryAction
  entityId?: string
  summary?: string
}
```

- [ ] **Step 1.2：在 `RendererApi` 接口末尾（`deleteChapter` 之后）追加 memory 方法**

```ts
  listCharacters: (projectId: string) => Promise<Character[]>
  getCharacter: (projectId: string, id: string) => Promise<Character | null>
  createCharacter: (projectId: string, input: CreateCharacterInput) => Promise<Character>
  updateCharacter: (projectId: string, id: string, patch: UpdateCharacterInput) => Promise<Character>
  deleteCharacter: (projectId: string, id: string) => Promise<void>
  listHistory: (projectId: string) => Promise<HistoryEntry[]>
```

- [ ] **Step 1.3：类型检查（此步 preload 未跟进，可能报类型不匹配，Task 6 修完再验）**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: 通过（renderer 尚未调用新方法）；node 可能因 preload 暂时报错——记下，Task 6 解决。

- [ ] **Step 1.4：提交**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add character and memory-history types"
```

---

## Task 2：JsonCollectionRepository（TDD）

**Files:**
- Create: `src/main/data/json-collection-repository.ts`
- Test: `tests/json-collection-repository.test.ts`

- [ ] **Step 2.1：写失败测试 `tests/json-collection-repository.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { JsonCollectionRepository } from '../src/main/data/json-collection-repository'

interface Item {
  id: string
  name: string
  updatedAt: string
}

describe('JsonCollectionRepository', () => {
  let file: string
  let repo: JsonCollectionRepository<Item>

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-col-'))
    file = path.join(dir, 'items.json')
    repo = new JsonCollectionRepository<Item>(file)
  })

  it('lists empty when file absent', async () => {
    expect(await repo.list()).toEqual([])
  })

  it('creates item with generated id', async () => {
    const item = await repo.create({ name: 'A', updatedAt: 'now' })
    expect(item.id).toMatch(/.+/)
    expect(item.name).toBe('A')
  })

  it('persists across instances', async () => {
    await repo.create({ name: 'A', updatedAt: 'now' })
    const repo2 = new JsonCollectionRepository<Item>(file)
    expect(await repo2.list()).toHaveLength(1)
  })

  it('updates by id', async () => {
    const item = await repo.create({ name: 'A', updatedAt: 'now' })
    const updated = await repo.update(item.id, { name: 'B' })
    expect(updated.name).toBe('B')
  })

  it('throws on update missing id', async () => {
    await expect(repo.update('nope', { name: 'X' })).rejects.toThrow(/not found/)
  })

  it('deletes by id', async () => {
    const item = await repo.create({ name: 'A', updatedAt: 'now' })
    await repo.delete(item.id)
    expect(await repo.list()).toEqual([])
  })
})
```

- [ ] **Step 2.2：运行测试，确认失败**

Run: `npx vitest run tests/json-collection-repository.test.ts`
Expected: FAIL，`Cannot find module '../src/main/data/json-collection-repository'`。

- [ ] **Step 2.3：写实现 `src/main/data/json-collection-repository.ts`**

```ts
import { randomUUID } from 'crypto'
import { readJson, writeJsonAtomic } from './atomic'

interface CollectionFile<T> {
  schemaVersion: number
  updatedAt: string
  items: T[]
}

const SCHEMA_VERSION = 1

export class JsonCollectionRepository<T extends { id: string }> {
  constructor(private readonly file: string) {}

  private async read(): Promise<CollectionFile<T>> {
    return readJson<CollectionFile<T>>(this.file, {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: '',
      items: []
    })
  }

  async list(): Promise<T[]> {
    return (await this.read()).items
  }

  async get(id: string): Promise<T | null> {
    return (await this.read()).items.find((x) => x.id === id) ?? null
  }

  async create(input: Omit<T, 'id'> & { id?: string }): Promise<T> {
    const data = await this.read()
    const item = { ...input, id: input.id ?? randomUUID() } as T
    await writeJsonAtomic(this.file, {
      ...data,
      updatedAt: new Date().toISOString(),
      items: [...data.items, item]
    })
    return item
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    const data = await this.read()
    const idx = data.items.findIndex((x) => x.id === id)
    if (idx < 0) throw new Error(`item ${id} not found`)
    const updated = { ...data.items[idx], ...patch, id } as T
    const items = [...data.items]
    items[idx] = updated
    await writeJsonAtomic(this.file, { ...data, updatedAt: new Date().toISOString(), items })
    return updated
  }

  async delete(id: string): Promise<void> {
    const data = await this.read()
    const items = data.items.filter((x) => x.id !== id)
    await writeJsonAtomic(this.file, { ...data, updatedAt: new Date().toISOString(), items })
  }
}
```

- [ ] **Step 2.4：运行测试，确认通过**

Run: `npx vitest run tests/json-collection-repository.test.ts`
Expected: 6 passed。

- [ ] **Step 2.5：提交**

```bash
git add src/main/data/json-collection-repository.ts tests/json-collection-repository.test.ts
git commit -m "feat: add generic JsonCollectionRepository"
```

---

## Task 3：CharacterRepository（TDD）

**Files:**
- Create: `src/main/data/character-repository.ts`
- Test: `tests/character-repository.test.ts`

- [ ] **Step 3.1：写失败测试 `tests/character-repository.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { CharacterRepository } from '../src/main/data/character-repository'

describe('CharacterRepository', () => {
  let dir: string
  let repo: CharacterRepository
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-char-'))
    repo = new CharacterRepository(dir)
  })

  it('lists empty when absent', async () => {
    expect(await repo.list()).toEqual([])
  })

  it('creates with timestamps in memory/characters.json', async () => {
    const c = await repo.create({ name: '林远', role: '主角' })
    expect(c.id).toMatch(/.+/)
    expect(c.createdAt).toBeTruthy()
    expect(c.updatedAt).toBeTruthy()
    const raw = await readFile(path.join(dir, 'memory', 'characters.json'), 'utf-8')
    expect(JSON.parse(raw).items[0].name).toBe('林远')
  })

  it('updates fields and bumps updatedAt', async () => {
    const c = await repo.create({ name: '林远' })
    const updated = await repo.update(c.id, { personality: '坚毅' })
    expect(updated.personality).toBe('坚毅')
    expect(updated.updatedAt).not.toBe(c.updatedAt)
  })

  it('deletes', async () => {
    const c = await repo.create({ name: '林远' })
    await repo.delete(c.id)
    expect(await repo.list()).toEqual([])
  })
})
```

- [ ] **Step 3.2：运行测试，确认失败**

Run: `npx vitest run tests/character-repository.test.ts`
Expected: FAIL，`Cannot find module '../src/main/data/character-repository'`。

- [ ] **Step 3.3：写实现 `src/main/data/character-repository.ts`**

```ts
import { join } from 'path'
import { JsonCollectionRepository } from './json-collection-repository'
import type { Character, CreateCharacterInput, UpdateCharacterInput } from '../../shared/types'

export class CharacterRepository {
  constructor(private readonly projectDir: string) {}

  private repo(): JsonCollectionRepository<Character> {
    return new JsonCollectionRepository<Character>(
      join(this.projectDir, 'memory', 'characters.json')
    )
  }

  list(): Promise<Character[]> {
    return this.repo().list()
  }

  get(id: string): Promise<Character | null> {
    return this.repo().get(id)
  }

  async create(input: CreateCharacterInput): Promise<Character> {
    const now = new Date().toISOString()
    return this.repo().create({ ...input, createdAt: now, updatedAt: now })
  }

  async update(id: string, patch: UpdateCharacterInput): Promise<Character> {
    return this.repo().update(id, { ...patch, updatedAt: new Date().toISOString() })
  }

  delete(id: string): Promise<void> {
    return this.repo().delete(id)
  }
}
```

- [ ] **Step 3.4：运行测试，确认通过**

Run: `npx vitest run tests/character-repository.test.ts`
Expected: 4 passed。

- [ ] **Step 3.5：提交**

```bash
git add src/main/data/character-repository.ts tests/character-repository.test.ts
git commit -m "feat: add CharacterRepository"
```

---

## Task 4：MemoryHistory（TDD）

**Files:**
- Create: `src/main/data/memory-history.ts`
- Test: `tests/memory-history.test.ts`

- [ ] **Step 4.1：写失败测试 `tests/memory-history.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { MemoryHistory } from '../src/main/data/memory-history'

describe('MemoryHistory', () => {
  let dir: string
  let history: MemoryHistory
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-hist-'))
    history = new MemoryHistory(dir)
  })

  it('lists empty when absent', async () => {
    expect(await history.list()).toEqual([])
  })

  it('appends entries and reads them back', async () => {
    await history.append({
      at: '2026-06-18T00:00:00.000Z',
      type: 'character',
      action: 'create',
      entityId: 'c1',
      summary: '林远'
    })
    await history.append({
      at: '2026-06-18T00:00:01.000Z',
      type: 'character',
      action: 'delete',
      entityId: 'c1'
    })
    const list = await history.list()
    expect(list).toHaveLength(2)
    expect(list[0].summary).toBe('林远')
    expect(list[1].action).toBe('delete')
  })

  it('writes one json object per line', async () => {
    await history.append({ at: 't1', type: 'character', action: 'create' })
    await history.append({ at: 't2', type: 'character', action: 'delete' })
    const raw = await readFile(path.join(dir, 'memory', 'history.jsonl'), 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).action).toBe('create')
  })
})
```

- [ ] **Step 4.2：运行测试，确认失败**

Run: `npx vitest run tests/memory-history.test.ts`
Expected: FAIL，`Cannot find module '../src/main/data/memory-history'`。

- [ ] **Step 4.3：写实现 `src/main/data/memory-history.ts`**

```ts
import { promises as fs } from 'fs'
import { join } from 'path'
import type { HistoryEntry } from '../../shared/types'

export class MemoryHistory {
  constructor(private readonly projectDir: string) {}

  private file(): string {
    return join(this.projectDir, 'memory', 'history.jsonl')
  }

  async append(entry: HistoryEntry): Promise<void> {
    await fs.mkdir(join(this.projectDir, 'memory'), { recursive: true })
    await fs.appendFile(this.file(), JSON.stringify(entry) + '\n', 'utf-8')
  }

  async list(): Promise<HistoryEntry[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.file(), 'utf-8')
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      throw err
    }
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as HistoryEntry)
  }
}
```

- [ ] **Step 4.4：运行测试，确认通过**

Run: `npx vitest run tests/memory-history.test.ts`
Expected: 3 passed。

- [ ] **Step 4.5：提交**

```bash
git add src/main/data/memory-history.ts tests/memory-history.test.ts
git commit -m "feat: add MemoryHistory jsonl audit log"
```

---

## Task 5：MemoryService（TDD 集成）+ IPC + 主进程接线

**Files:**
- Create: `src/main/data/memory-service.ts`
- Create: `src/main/ipc/memory.ts`
- Modify: `src/main/index.ts`
- Test: `tests/memory-service.test.ts`

- [ ] **Step 5.1：写失败测试 `tests/memory-service.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { MemoryService } from '../src/main/data/memory-service'

describe('MemoryService', () => {
  let root: string
  let memory: MemoryService
  let projectId: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-mem-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    const projectService = new ProjectService(path.join(root, 'projects'), library)
    memory = new MemoryService(projectService)
    const project = await projectService.create({ name: 'X' })
    projectId = project.id
  })

  it('createCharacter writes characters.json and appends history', async () => {
    const c = await memory.createCharacter(projectId, { name: '林远', role: '主角' })
    expect(c.id).toMatch(/.+/)
    const chars = JSON.parse(
      await readFile(path.join(root, 'projects', projectId, 'memory', 'characters.json'), 'utf-8')
    )
    expect(chars.items).toHaveLength(1)
    const history = await memory.listHistory(projectId)
    expect(history).toHaveLength(1)
    expect(history[0].action).toBe('create')
    expect(history[0].summary).toBe('林远')
  })

  it('deleteCharacter removes item and logs', async () => {
    const c = await memory.createCharacter(projectId, { name: '林远' })
    await memory.deleteCharacter(projectId, c.id)
    expect(await memory.listCharacters(projectId)).toEqual([])
    const actions = (await memory.listHistory(projectId)).map((h) => h.action)
    expect(actions).toEqual(['create', 'delete'])
  })

  it('updateCharacter writes history with new summary', async () => {
    const c = await memory.createCharacter(projectId, { name: '林远' })
    await memory.updateCharacter(projectId, c.id, { name: '林远之' })
    const actions = (await memory.listHistory(projectId)).map((h) => h.action)
    expect(actions).toEqual(['create', 'update'])
  })
})
```

- [ ] **Step 5.2：运行测试，确认失败**

Run: `npx vitest run tests/memory-service.test.ts`
Expected: FAIL，`Cannot find module '../src/main/data/memory-service'`。

- [ ] **Step 5.3：写实现 `src/main/data/memory-service.ts`**

```ts
import { CharacterRepository } from './character-repository'
import { MemoryHistory } from './memory-history'
import type { ProjectService } from './project-service'
import type {
  Character,
  CreateCharacterInput,
  UpdateCharacterInput,
  HistoryEntry
} from '../../shared/types'

export class MemoryService {
  constructor(private readonly projectService: ProjectService) {}

  private async charRepo(projectId: string): Promise<CharacterRepository> {
    const dir = await this.projectService.resolveDir(projectId)
    return new CharacterRepository(dir)
  }

  private async history(projectId: string): Promise<MemoryHistory> {
    const dir = await this.projectService.resolveDir(projectId)
    return new MemoryHistory(dir)
  }

  async listCharacters(projectId: string): Promise<Character[]> {
    return (await this.charRepo(projectId)).list()
  }

  async getCharacter(projectId: string, id: string): Promise<Character | null> {
    return (await this.charRepo(projectId)).get(id)
  }

  async createCharacter(projectId: string, input: CreateCharacterInput): Promise<Character> {
    const repo = await this.charRepo(projectId)
    const c = await repo.create(input)
    await (await this.history(projectId)).append({
      at: new Date().toISOString(),
      type: 'character',
      action: 'create',
      entityId: c.id,
      summary: c.name
    })
    return c
  }

  async updateCharacter(
    projectId: string,
    id: string,
    patch: UpdateCharacterInput
  ): Promise<Character> {
    const repo = await this.charRepo(projectId)
    const c = await repo.update(id, patch)
    await (await this.history(projectId)).append({
      at: new Date().toISOString(),
      type: 'character',
      action: 'update',
      entityId: c.id,
      summary: c.name
    })
    return c
  }

  async deleteCharacter(projectId: string, id: string): Promise<void> {
    const repo = await this.charRepo(projectId)
    const existing = await repo.get(id)
    await repo.delete(id)
    await (await this.history(projectId)).append({
      at: new Date().toISOString(),
      type: 'character',
      action: 'delete',
      entityId: id,
      summary: existing?.name
    })
  }

  async listHistory(projectId: string): Promise<HistoryEntry[]> {
    return (await this.history(projectId)).list()
  }
}
```

- [ ] **Step 5.4：运行测试，确认通过**

Run: `npx vitest run tests/memory-service.test.ts`
Expected: 3 passed。

- [ ] **Step 5.5：写 `src/main/ipc/memory.ts`**

```ts
import { ipcMain } from 'electron'
import { MemoryService } from '../data/memory-service'
import type { CreateCharacterInput, UpdateCharacterInput } from '../../shared/types'

export function registerMemoryIpc(service: MemoryService): void {
  ipcMain.handle('memory:character:list', (_e, projectId: string) =>
    service.listCharacters(projectId)
  )
  ipcMain.handle('memory:character:get', (_e, projectId: string, id: string) =>
    service.getCharacter(projectId, id)
  )
  ipcMain.handle(
    'memory:character:create',
    (_e, projectId: string, input: CreateCharacterInput) =>
      service.createCharacter(projectId, input)
  )
  ipcMain.handle(
    'memory:character:update',
    (_e, projectId: string, id: string, patch: UpdateCharacterInput) =>
      service.updateCharacter(projectId, id, patch)
  )
  ipcMain.handle('memory:character:delete', (_e, projectId: string, id: string) =>
    service.deleteCharacter(projectId, id)
  )
  ipcMain.handle('memory:history:list', (_e, projectId: string) => service.listHistory(projectId))
}
```

- [ ] **Step 5.6：改 `src/main/index.ts`，接线 MemoryService**

在顶部 import 区追加：

```ts
import { MemoryService } from './data/memory-service'
import { registerMemoryIpc } from './ipc/memory'
```

在 `app.whenReady().then(() => { ... })` 回调中，于 `registerChaptersIpc(projectService)` 之后追加：

```ts
  const memoryService = new MemoryService(projectService)
  registerMemoryIpc(memoryService)
```

- [ ] **Step 5.7：类型检查**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: 无错误。

- [ ] **Step 5.8：跑全量测试**

Run: `npx vitest run`
Expected: 全部通过（累计 33 个：Phase 02 的 20 + 本 Phase 的 json-col 6 + char 4 + history 3 + memory-service 3 = 36）。

- [ ] **Step 5.9：提交**

```bash
git add src/main/data/memory-service.ts src/main/ipc/memory.ts src/main/index.ts tests/memory-service.test.ts
git commit -m "feat: add MemoryService and wire memory ipc"
```

---

## Task 6：扩展 preload 桥

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 6.1：在 `src/preload/index.ts` 的 import 块追加类型**

把 import 段改为（在 `UpdateChapterMetaInput` 后追加新类型）：

```ts
import type {
  CreateProjectDataInput,
  CreateChapterInput,
  UpdateChapterMetaInput,
  CreateCharacterInput,
  UpdateCharacterInput
} from '../shared/types'
```

- [ ] **Step 6.2：在 `api` 对象末尾（`deleteChapter` 之后）追加 memory 方法**

```ts
  listCharacters: (id: string) => ipcRenderer.invoke('memory:character:list', id),
  getCharacter: (id: string, cid: string) => ipcRenderer.invoke('memory:character:get', id, cid),
  createCharacter: (id: string, input: CreateCharacterInput) =>
    ipcRenderer.invoke('memory:character:create', id, input),
  updateCharacter: (id: string, cid: string, patch: UpdateCharacterInput) =>
    ipcRenderer.invoke('memory:character:update', id, cid, patch),
  deleteCharacter: (id: string, cid: string) => ipcRenderer.invoke('memory:character:delete', id, cid),
  listHistory: (id: string) => ipcRenderer.invoke('memory:history:list', id)
```

- [ ] **Step 6.3：类型检查**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: 无错误。

- [ ] **Step 6.4：提交**

```bash
git add src/preload/index.ts
git commit -m "feat: extend window.api with memory methods"
```

---

## Task 7：UI 人物管理页 + App 路由

**Files:**
- Create: `src/renderer/src/CharacterManagerPage.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/ChapterListPage.tsx`

- [ ] **Step 7.1：写 `src/renderer/src/CharacterManagerPage.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { Character, CreateCharacterInput } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
}

const EMPTY: CreateCharacterInput = { name: '', role: '', identity: '', personality: '' }

export default function CharacterManagerPage({ projectId, onBack }: Props) {
  const [characters, setCharacters] = useState<Character[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ id: string; input: CreateCharacterInput } | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = () => {
    setLoading(true)
    void window.api.listCharacters(projectId).then((list) => {
      setCharacters(list)
      setLoading(false)
    })
  }

  useEffect(refresh, [projectId])

  const startEdit = (c: Character) =>
    setEditing({
      id: c.id,
      input: {
        name: c.name,
        role: c.role ?? '',
        identity: c.identity ?? '',
        personality: c.personality ?? ''
      }
    })

  const remove = async (c: Character) => {
    if (!window.confirm(`删除人物「${c.name}」？`)) return
    await window.api.deleteCharacter(projectId, c.id)
    refresh()
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={onBack}>← 返回章节列表</button>
        <button onClick={() => setCreating(true)}>+ 新建人物</button>
      </div>
      <h2>人物管理</h2>
      {loading ? (
        <p>加载中…</p>
      ) : characters.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>暂无人物。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {characters.map((c) => (
            <li
              key={c.id}
              style={{ padding: 12, border: '1px solid #e2e8f0', borderRadius: 8, margin: '8px 0' }}
            >
              <strong>{c.name}</strong>
              {c.role ? <span style={{ color: '#64748b' }}> · {c.role}</span> : null}
              {c.identity ? <div style={{ color: '#475569', fontSize: 14 }}>{c.identity}</div> : null}
              {c.personality ? (
                <div style={{ color: '#64748b', fontSize: 14 }}>性格：{c.personality}</div>
              ) : null}
              <div style={{ marginTop: 8 }}>
                <button onClick={() => startEdit(c)} style={{ marginRight: 8 }}>
                  编辑
                </button>
                <button onClick={() => remove(c)}>删除</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating ? (
        <CharacterDialog
          title="新建人物"
          initial={EMPTY}
          onClose={() => setCreating(false)}
          onSubmit={async (input) => {
            await window.api.createCharacter(projectId, trimInput(input))
            setCreating(false)
            refresh()
          }}
        />
      ) : null}
      {editing ? (
        <CharacterDialog
          title="编辑人物"
          initial={editing.input}
          onClose={() => setEditing(null)}
          onSubmit={async (input) => {
            await window.api.updateCharacter(projectId, editing.id, trimInput(input))
            setEditing(null)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function trimInput(input: CreateCharacterInput): CreateCharacterInput {
  return {
    name: input.name.trim(),
    role: input.role?.trim() || undefined,
    identity: input.identity?.trim() || undefined,
    personality: input.personality?.trim() || undefined
  }
}

function CharacterDialog({
  title,
  initial,
  onClose,
  onSubmit
}: {
  title: string
  initial: CreateCharacterInput
  onClose: () => void
  onSubmit: (input: CreateCharacterInput) => Promise<void>
}) {
  const [input, setInput] = useState<CreateCharacterInput>(initial)
  const [saving, setSaving] = useState(false)
  const field = (key: keyof CreateCharacterInput) => ({
    value: (input[key] as string) ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setInput({ ...input, [key]: e.target.value })
  })
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <div style={{ background: '#fff', padding: 24, borderRadius: 12, width: 420 }}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <p>
          名称：<input {...field('name')} style={{ width: '100%' }} />
        </p>
        <p>
          角色：
          <input {...field('role')} placeholder="主角/配角/反派" style={{ width: '100%' }} />
        </p>
        <p>
          身份：<input {...field('identity')} style={{ width: '100%' }} />
        </p>
        <p>
          性格：<input {...field('personality')} style={{ width: '100%' }} />
        </p>
        <div style={{ textAlign: 'right' }}>
          <button onClick={onClose} style={{ marginRight: 8 }}>
            取消
          </button>
          <button
            disabled={saving || !input.name.trim()}
            onClick={async () => {
              setSaving(true)
              try {
                await onSubmit(input)
              } finally {
                setSaving(false)
              }
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 7.2：改 `src/renderer/src/App.tsx`，view 加 characters**

把 `View` 联合类型改为：

```ts
type View =
  | { kind: 'projects' }
  | { kind: 'chapters'; projectId: string }
  | { kind: 'editor'; projectId: string; chapterNumber: number }
  | { kind: 'characters'; projectId: string }
```

在 `App` 组件的渲染分支里，`chapters` 分支与 `editor` 分支之间插入 `characters` 分支：

```tsx
      ) : view.kind === 'characters' ? (
        <CharacterManagerPage
          projectId={view.projectId}
          onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
        />
      ) : (
```

并在文件顶部 import 区追加：

```ts
import CharacterManagerPage from './CharacterManagerPage'
```

- [ ] **Step 7.3：改 `src/renderer/src/ChapterListPage.tsx`，加「人物管理」入口**

在 `Props` 中新增回调：

```ts
interface Props {
  projectId: string
  onBack: () => void
  onOpenChapter: (n: number) => void
  onOpenCharacters: () => void
}
```

解构参数加上 `onOpenCharacters`：

```ts
export default function ChapterListPage({ projectId, onBack, onOpenChapter, onOpenCharacters }: Props) {
```

在顶部「返回项目列表」与「新建章节」按钮所在的 flex 容器里，插入人物入口（放在两个按钮之间）：

```tsx
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={onBack}>← 返回项目列表</button>
        <div>
          <button onClick={onOpenCharacters} style={{ marginRight: 8 }}>
            📝 人物管理
          </button>
          <button onClick={createChapter}>+ 新建章节</button>
        </div>
      </div>
```

- [ ] **Step 7.4：改 `src/renderer/src/App.tsx` 中 `chapters` 分支，传入新回调**

把渲染 `ChapterListPage` 的地方改为：

```tsx
        <ChapterListPage
          projectId={view.projectId}
          onBack={() => setView({ kind: 'projects' })}
          onOpenChapter={(n) =>
            setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })
          }
          onOpenCharacters={() => setView({ kind: 'characters', projectId: view.projectId })}
        />
```

- [ ] **Step 7.5：类型检查**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: 无错误。

- [ ] **Step 7.6：提交**

```bash
git add src/renderer/src/CharacterManagerPage.tsx src/renderer/src/App.tsx src/renderer/src/ChapterListPage.tsx
git commit -m "feat: character manager page and navigation"
```

---

## Task 8：端到端验证 + 收尾

**Files:** 无新增（验证 + 文档）

- [ ] **Step 8.1：最终全量测试与类型检查**

Run:
```bash
npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
```
Expected: 全部测试通过（36 个），类型检查无错误。

- [ ] **Step 8.2：构建**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 8.3：临时加冒烟日志验证端到端**

临时修改 `src/main/index.ts`，在 `registerMemoryIpc(memoryService)` 之后加：

```ts
void memoryService
  .createCharacter('smoke', { name: '冒烟人物' })
  .catch((e) => console.log('[smoke] memory (expected reject before project exists):', String(e)))
```

构建并运行：

```bash
npm run build && npx electron .
```

Expected: 控制台输出 `[smoke] memory (expected reject before project exists): ...not found` —— 证明 MemoryService 已接线且被调用（因 `'smoke'` 项目不存在，预期走到 resolveDir 抛错路径，这恰恰验证了完整链路接通）。

- [ ] **Step 8.4：回滚临时日志**

删除 Step 8.3 加的那行，运行 `npx tsc --noEmit -p tsconfig.node.json` 确认无错误。

- [ ] **Step 8.5：更新 README**

把 `README.md` 的「下一阶段」改为：

```
Phase 04：章节版本历史（NNN.versions.json）、其余记忆实体（关系/地点/伏笔/时间线/世界观/风格）基于 JsonCollectionRepository 批量接入。
```

并在架构图 `ChapterRepository` 行下方加一行：

```
                                          ├─ MemoryService (characters.json + history.jsonl)
```

- [ ] **Step 8.6：提交收尾**

```bash
git add README.md
git commit -m "docs: update readme for phase 03"
```

---

## 完成标准（Definition of Done）

- [ ] `npm test` 36 个单测全绿
- [ ] `tsc --noEmit` 两个项目均无错误
- [ ] `npm run dev` / `npx electron .` 可：进入项目 → 章节列表 → 点「人物管理」→ 新建/编辑/删除人物 → 文件落在 `memory/characters.json` + `memory/history.jsonl`
- [ ] 通用 `JsonCollectionRepository` 就绪，后续记忆实体可复用
- [ ] 所有改动已分任务提交

## 下一阶段（不在本 plan 范围）

- **Phase 04**：章节版本历史（`NNN.versions.json`，ai/manual/reviewed 三类版本 + diff + 回滚）；其余记忆实体（relationships/locations/foreshadowings/timeline/plot_points/worldview/styles）基于 `JsonCollectionRepository` 批量接入
- 后续 LLM / 正文写作 / 大纲 / 打包见 [spec §14](../specs/2026-06-17-desktop-app-design.md)
