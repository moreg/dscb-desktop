# Phase 05：通用记忆实体（地点/世界观/时间线/剧情点）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一套通用代码接入 4 类简单记忆实体（地点/世界观/时间线/剧情点），新增实体只需一行配置；并加「记忆中心」入口统一导航。

**Architecture:** 抽象通用 `MemoryEntity`（name + category + notes + 时间戳）与 `MemoryEntityType`（决定落哪个 `memory/*.json`）。`MemoryEntityService` 按 type 路由到对应文件，复用 Phase 03 的 `JsonCollectionRepository<T>`。IPC 用一组通用通道（`memory:entity:*`，参数带 type）。UI 用一个泛型 `MemoryEntityPage`（按 type 配置渲染）+ `MemoryCenterPage` 导航。人物（Phase 03 专用页）保留，记忆中心统一入口。

**Tech Stack:** 复用 Phase 01-04 的 Electron + electron-vite + React + TypeScript + Vitest，无新增依赖。

---

## File Structure

新增/修改文件（在 `E:/trea/写作桌面应用/` 下）：

```
src/
├─ shared/types.ts                  [改] MemoryEntityType/MemoryEntity/Create/UpdateMemoryEntityInput + RendererApi entity 方法
├─ main/
│  ├─ index.ts                      [改] 实例化 MemoryEntityService、注册 entity IPC
│  ├─ data/memory-entity-service.ts [新] 通用实体 CRUD（按 type 路由文件）
│  └─ ipc/memory.ts                 [改] 加 memory:entity:list/create/update/delete
├─ preload/index.ts                 [改] 加 entity 方法
└─ renderer/src/
   ├─ App.tsx                       [改] view 加 memoryCenter / memoryEntity
   ├─ ChapterListPage.tsx           [改] 顶部加「记忆中心」入口
   ├─ MemoryCenterPage.tsx          [新] 记忆类型选择
   └─ MemoryEntityPage.tsx          [新] 通用实体管理（列表+新建+编辑+删除）
tests/
└─ memory-entity-service.test.ts    [新]
```

**职责边界：**
- `memory-entity-service.ts` — 按 `MemoryEntityType` 路由到对应 `memory/*.json`，CRUD 委托 `JsonCollectionRepository`
- `ipc/memory.ts` — 一组通用通道（带 type 参数），接到 service
- `MemoryEntityPage.tsx` — 一个泛型页面，按 type + label 配置渲染，4 类实体共用
- `MemoryCenterPage.tsx` — 列出全部记忆类型（含人物），统一入口

---

## Task 1：扩展共享类型

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1.1：在 `src/shared/types.ts` 末尾追加通用实体类型**

```ts
export type MemoryEntityType = 'location' | 'worldview' | 'timeline' | 'plot_point'

export interface MemoryEntity {
  id: string
  name: string
  category?: string
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface CreateMemoryEntityInput {
  name: string
  category?: string
  notes?: string
}

export interface UpdateMemoryEntityInput {
  name?: string
  category?: string
  notes?: string
}
```

- [ ] **Step 1.2：在 `RendererApi` 的 `rollbackChapter` 行之后追加 entity 方法**

```ts
  listMemoryEntities: (
    projectId: string,
    type: MemoryEntityType
  ) => Promise<MemoryEntity[]>
  createMemoryEntity: (
    projectId: string,
    type: MemoryEntityType,
    input: CreateMemoryEntityInput
  ) => Promise<MemoryEntity>
  updateMemoryEntity: (
    projectId: string,
    type: MemoryEntityType,
    id: string,
    patch: UpdateMemoryEntityInput
  ) => Promise<MemoryEntity>
  deleteMemoryEntity: (
    projectId: string,
    type: MemoryEntityType,
    id: string
  ) => Promise<void>
```

- [ ] **Step 1.3：类型检查**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: 通过。

- [ ] **Step 1.4：提交**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add generic memory entity types"
```

---

## Task 2：MemoryEntityService（TDD）

**Files:**
- Create: `src/main/data/memory-entity-service.ts`
- Test: `tests/memory-entity-service.test.ts`

- [ ] **Step 2.1：写失败测试 `tests/memory-entity-service.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { MemoryEntityService } from '../src/main/data/memory-entity-service'

describe('MemoryEntityService', () => {
  let root: string
  let service: MemoryEntityService
  let projectId: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-me-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    const projectService = new ProjectService(path.join(root, 'projects'), library)
    service = new MemoryEntityService(projectService)
    projectId = (await projectService.create({ name: 'X' })).id
  })

  it('lists empty for each type', async () => {
    expect(await service.list(projectId, 'location')).toEqual([])
    expect(await service.list(projectId, 'worldview')).toEqual([])
  })

  it('creates a location in locations.json', async () => {
    const e = await service.create(projectId, 'location', { name: '青云山', category: '山脉' })
    expect(e.id).toMatch(/.+/)
    const raw = JSON.parse(
      await readFile(path.join(root, 'projects', projectId, 'memory', 'locations.json'), 'utf-8')
    )
    expect(raw.items[0].name).toBe('青云山')
  })

  it('keeps different types in separate files', async () => {
    await service.create(projectId, 'location', { name: 'A' })
    await service.create(projectId, 'worldview', { name: 'B' })
    const loc = await service.list(projectId, 'location')
    const wv = await service.list(projectId, 'worldview')
    expect(loc).toHaveLength(1)
    expect(wv).toHaveLength(1)
    expect(loc[0].name).toBe('A')
    expect(wv[0].name).toBe('B')
  })

  it('updates an entity', async () => {
    const e = await service.create(projectId, 'timeline', { name: '事件一' })
    const updated = await service.update(projectId, 'timeline', e.id, { notes: '细节' })
    expect(updated.notes).toBe('细节')
  })

  it('deletes an entity', async () => {
    const e = await service.create(projectId, 'plot_point', { name: '转折' })
    await service.delete(projectId, 'plot_point', e.id)
    expect(await service.list(projectId, 'plot_point')).toEqual([])
  })
})
```

- [ ] **Step 2.2：运行测试，确认失败**

Run: `npx vitest run tests/memory-entity-service.test.ts`
Expected: FAIL，`Cannot find module '../src/main/data/memory-entity-service'`。

- [ ] **Step 2.3：写实现 `src/main/data/memory-entity-service.ts`**

```ts
import { join } from 'path'
import { JsonCollectionRepository } from './json-collection-repository'
import type { ProjectService } from './project-service'
import type {
  MemoryEntity,
  MemoryEntityType,
  CreateMemoryEntityInput,
  UpdateMemoryEntityInput
} from '../../shared/types'

const FILE_NAMES: Record<MemoryEntityType, string> = {
  location: 'locations.json',
  worldview: 'worldview.json',
  timeline: 'timeline.json',
  plot_point: 'plot_points.json'
}

export class MemoryEntityService {
  constructor(private readonly projectService: ProjectService) {}

  private async repo(
    projectId: string,
    type: MemoryEntityType
  ): Promise<JsonCollectionRepository<MemoryEntity>> {
    const dir = await this.projectService.resolveDir(projectId)
    return new JsonCollectionRepository<MemoryEntity>(join(dir, 'memory', FILE_NAMES[type]))
  }

  async list(projectId: string, type: MemoryEntityType): Promise<MemoryEntity[]> {
    return (await this.repo(projectId, type)).list()
  }

  async create(
    projectId: string,
    type: MemoryEntityType,
    input: CreateMemoryEntityInput
  ): Promise<MemoryEntity> {
    const now = new Date().toISOString()
    return (await this.repo(projectId, type)).create({ ...input, createdAt: now, updatedAt: now })
  }

  async update(
    projectId: string,
    type: MemoryEntityType,
    id: string,
    patch: UpdateMemoryEntityInput
  ): Promise<MemoryEntity> {
    return (await this.repo(projectId, type)).update(id, {
      ...patch,
      updatedAt: new Date().toISOString()
    })
  }

  async delete(projectId: string, type: MemoryEntityType, id: string): Promise<void> {
    return (await this.repo(projectId, type)).delete(id)
  }
}
```

- [ ] **Step 2.4：运行测试，确认通过**

Run: `npx vitest run tests/memory-entity-service.test.ts`
Expected: 5 passed。

- [ ] **Step 2.5：提交**

```bash
git add src/main/data/memory-entity-service.ts tests/memory-entity-service.test.ts
git commit -m "feat: add generic MemoryEntityService"
```

---

## Task 3：IPC + 主进程接线

**Files:**
- Modify: `src/main/ipc/memory.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 3.1：在 `src/main/ipc/memory.ts` 顶部 import 区追加**

```ts
import { MemoryEntityService } from '../data/memory-entity-service'
import type {
  CreateCharacterInput,
  UpdateCharacterInput,
  MemoryEntityType,
  CreateMemoryEntityInput,
  UpdateMemoryEntityInput
} from '../../shared/types'
```

（即把原有 `CreateCharacterInput, UpdateCharacterInput` 那行替换为上面这块；若原 import 已含 character 类型，则合并。）

- [ ] **Step 3.2：改 `registerMemoryIpc` 签名，增加 `entityService` 参数并在末尾追加通道**

把函数签名与末尾改为：

```ts
export function registerMemoryIpc(
  service: MemoryService,
  entityService: MemoryEntityService
): void {
  // ...原有 character / history 通道保持不变...

  ipcMain.handle('memory:entity:list', (_e, projectId: string, type: MemoryEntityType) =>
    entityService.list(projectId, type)
  )
  ipcMain.handle(
    'memory:entity:create',
    (_e, projectId: string, type: MemoryEntityType, input: CreateMemoryEntityInput) =>
      entityService.create(projectId, type, input)
  )
  ipcMain.handle(
    'memory:entity:update',
    (_e, projectId: string, type: MemoryEntityType, id: string, patch: UpdateMemoryEntityInput) =>
      entityService.update(projectId, type, id, patch)
  )
  ipcMain.handle(
    'memory:entity:delete',
    (_e, projectId: string, type: MemoryEntityType, id: string) =>
      entityService.delete(projectId, type, id)
  )
}
```

- [ ] **Step 3.3：改 `src/main/index.ts` 接线**

顶部 import 区追加：

```ts
import { MemoryEntityService } from './data/memory-entity-service'
```

把 `registerMemoryIpc(memoryService)` 那行替换为：

```ts
  const memoryEntityService = new MemoryEntityService(projectService)
  registerMemoryIpc(memoryService, memoryEntityService)
```

- [ ] **Step 3.4：类型检查**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: 无错误。

- [ ] **Step 3.5：提交**

```bash
git add src/main/ipc/memory.ts src/main/index.ts
git commit -m "feat: wire generic memory entity ipc"
```

---

## Task 4：扩展 preload 桥

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 4.1：在 import 块追加类型**

```ts
import type {
  CreateProjectDataInput,
  CreateChapterInput,
  UpdateChapterMetaInput,
  CreateCharacterInput,
  UpdateCharacterInput,
  CreateChapterVersionInput,
  MemoryEntityType,
  CreateMemoryEntityInput,
  UpdateMemoryEntityInput
} from '../shared/types'
```

- [ ] **Step 4.2：在 `api` 对象末尾（`rollbackChapter` 之后）追加 entity 方法**

```ts
  listMemoryEntities: (id: string, type: MemoryEntityType) =>
    ipcRenderer.invoke('memory:entity:list', id, type),
  createMemoryEntity: (id: string, type: MemoryEntityType, input: CreateMemoryEntityInput) =>
    ipcRenderer.invoke('memory:entity:create', id, type, input),
  updateMemoryEntity: (
    id: string,
    type: MemoryEntityType,
    entityId: string,
    patch: UpdateMemoryEntityInput
  ) => ipcRenderer.invoke('memory:entity:update', id, type, entityId, patch),
  deleteMemoryEntity: (id: string, type: MemoryEntityType, entityId: string) =>
    ipcRenderer.invoke('memory:entity:delete', id, type, entityId)
```

- [ ] **Step 4.3：类型检查**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: 无错误。

- [ ] **Step 4.4：提交**

```bash
git add src/preload/index.ts
git commit -m "feat: extend window.api with generic memory entity methods"
```

---

## Task 5：记忆中心 + 通用实体页 UI

**Files:**
- Create: `src/renderer/src/MemoryCenterPage.tsx`
- Create: `src/renderer/src/MemoryEntityPage.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/ChapterListPage.tsx`

- [ ] **Step 5.1：写 `src/renderer/src/MemoryCenterPage.tsx`**

```tsx
import type { MemoryEntityType } from '../../shared/types'

interface Props {
  onBack: () => void
  onOpenCharacters: () => void
  onOpenEntity: (type: MemoryEntityType) => void
}

const ENTITIES: { type: MemoryEntityType; label: string; desc: string }[] = [
  { type: 'location', label: '地点', desc: '城市、山脉、门派、场所' },
  { type: 'worldview', label: '世界观', desc: '体系、势力、规则、设定' },
  { type: 'timeline', label: '时间线', desc: '按章节的关键事件' },
  { type: 'plot_point', label: '剧情点', desc: '故事弧、转折点' }
]

export default function MemoryCenterPage({ onBack, onOpenCharacters, onOpenEntity }: Props) {
  return (
    <div>
      <button onClick={onBack}>← 返回章节列表</button>
      <h2>记忆中心</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <Card label="人物" desc="角色档案、性格、能力" onClick={onOpenCharacters} />
        {ENTITIES.map((e) => (
          <Card key={e.type} label={e.label} desc={e.desc} onClick={() => onOpenEntity(e.type)} />
        ))}
      </div>
    </div>
  )
}

function Card({ label, desc, onClick }: { label: string; desc: string; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: 16,
        border: '1px solid #e2e8f0',
        borderRadius: 10,
        cursor: 'pointer'
      }}
    >
      <strong style={{ fontSize: 16 }}>{label}</strong>
      <div style={{ color: '#64748b', fontSize: 13, marginTop: 4 }}>{desc}</div>
    </div>
  )
}
```

- [ ] **Step 5.2：写 `src/renderer/src/MemoryEntityPage.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { MemoryEntity, MemoryEntityType, CreateMemoryEntityInput } from '../../shared/types'

interface Props {
  projectId: string
  type: MemoryEntityType
  label: string
  onBack: () => void
}

const EMPTY: CreateMemoryEntityInput = { name: '', category: '', notes: '' }

export default function MemoryEntityPage({ projectId, type, label, onBack }: Props) {
  const [items, setItems] = useState<MemoryEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ id: string; input: CreateMemoryEntityInput } | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = () => {
    setLoading(true)
    void window.api.listMemoryEntities(projectId, type).then((list) => {
      setItems(list)
      setLoading(false)
    })
  }

  useEffect(refresh, [projectId, type])

  const remove = async (e: MemoryEntity) => {
    if (!window.confirm(`删除「${e.name}」？`)) return
    await window.api.deleteMemoryEntity(projectId, type, e.id)
    refresh()
  }

  return (
    <div>
      <button onClick={onBack}>← 返回记忆中心</button>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>{label}</h2>
        <button onClick={() => setCreating(true)}>+ 新建</button>
      </div>
      {loading ? (
        <p>加载中…</p>
      ) : items.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>暂无{label}。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {items.map((e) => (
            <li
              key={e.id}
              style={{ padding: 12, border: '1px solid #e2e8f0', borderRadius: 8, margin: '8px 0' }}
            >
              <strong>{e.name}</strong>
              {e.category ? <span style={{ color: '#64748b' }}> · {e.category}</span> : null}
              {e.notes ? <div style={{ color: '#475569', fontSize: 14, marginTop: 4 }}>{e.notes}</div> : null}
              <div style={{ marginTop: 8 }}>
                <button
                  onClick={() =>
                    setEditing({
                      id: e.id,
                      input: { name: e.name, category: e.category ?? '', notes: e.notes ?? '' }
                    })
                  }
                  style={{ marginRight: 8 }}
                >
                  编辑
                </button>
                <button onClick={() => remove(e)}>删除</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating ? (
        <EntityDialog
          title={`新建${label}`}
          initial={EMPTY}
          onClose={() => setCreating(false)}
          onSubmit={async (input) => {
            await window.api.createMemoryEntity(projectId, type, trim(input))
            setCreating(false)
            refresh()
          }}
        />
      ) : null}
      {editing ? (
        <EntityDialog
          title={`编辑${label}`}
          initial={editing.input}
          onClose={() => setEditing(null)}
          onSubmit={async (input) => {
            await window.api.updateMemoryEntity(projectId, type, editing.id, trim(input))
            setEditing(null)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function trim(input: CreateMemoryEntityInput): CreateMemoryEntityInput {
  return {
    name: input.name.trim(),
    category: input.category?.trim() || undefined,
    notes: input.notes?.trim() || undefined
  }
}

function EntityDialog({
  title,
  initial,
  onClose,
  onSubmit
}: {
  title: string
  initial: CreateMemoryEntityInput
  onClose: () => void
  onSubmit: (input: CreateMemoryEntityInput) => Promise<void>
}) {
  const [input, setInput] = useState<CreateMemoryEntityInput>(initial)
  const [saving, setSaving] = useState(false)
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
          名称：<input value={input.name} onChange={(e) => setInput({ ...input, name: e.target.value })} style={{ width: '100%' }} />
        </p>
        <p>
          分类：<input value={input.category} onChange={(e) => setInput({ ...input, category: e.target.value })} style={{ width: '100%' }} />
        </p>
        <p>
          详情：
          <textarea value={input.notes} onChange={(e) => setInput({ ...input, notes: e.target.value })} rows={4} style={{ width: '100%' }} />
        </p>
        <div style={{ textAlign: 'right' }}>
          <button onClick={onClose} style={{ marginRight: 8 }}>取消</button>
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

- [ ] **Step 5.3：整体替换 `src/renderer/src/App.tsx`**

```tsx
import { useState } from 'react'
import ProjectListPage from './ProjectListPage'
import ChapterListPage from './ChapterListPage'
import ChapterEditor from './ChapterEditor'
import CharacterManagerPage from './CharacterManagerPage'
import MemoryCenterPage from './MemoryCenterPage'
import MemoryEntityPage from './MemoryEntityPage'
import type { MemoryEntityType } from '../../shared/types'

type View =
  | { kind: 'projects' }
  | { kind: 'chapters'; projectId: string }
  | { kind: 'editor'; projectId: string; chapterNumber: number }
  | { kind: 'characters'; projectId: string }
  | { kind: 'memoryCenter'; projectId: string }
  | { kind: 'memoryEntity'; projectId: string; entityType: MemoryEntityType }

const ENTITY_LABELS: Record<MemoryEntityType, string> = {
  location: '地点',
  worldview: '世界观',
  timeline: '时间线',
  plot_point: '剧情点'
}

export default function App() {
  const [view, setView] = useState<View>({ kind: 'projects' })

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 820, margin: '40px auto', padding: '0 20px' }}>
      <h1>ai-writer 桌面版</h1>
      <p style={{ color: '#64748b' }}>Phase 05 · 项目 / 章节 / 记忆中心（本地文件存储）</p>
      <hr />
      {view.kind === 'projects' ? (
        <ProjectListPage onOpenProject={(id) => setView({ kind: 'chapters', projectId: id })} />
      ) : view.kind === 'chapters' ? (
        <ChapterListPage
          projectId={view.projectId}
          onBack={() => setView({ kind: 'projects' })}
          onOpenChapter={(n) =>
            setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })
          }
          onOpenCharacters={() => setView({ kind: 'characters', projectId: view.projectId })}
          onOpenMemoryCenter={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
        />
      ) : view.kind === 'editor' ? (
        <ChapterEditor
          projectId={view.projectId}
          chapterNumber={view.chapterNumber}
          onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
        />
      ) : view.kind === 'characters' ? (
        <CharacterManagerPage
          projectId={view.projectId}
          onBack={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
        />
      ) : view.kind === 'memoryCenter' ? (
        <MemoryCenterPage
          onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
          onOpenCharacters={() => setView({ kind: 'characters', projectId: view.projectId })}
          onOpenEntity={(t) =>
            setView({ kind: 'memoryEntity', projectId: view.projectId, entityType: t })
          }
        />
      ) : (
        <MemoryEntityPage
          projectId={view.projectId}
          type={view.entityType}
          label={ENTITY_LABELS[view.entityType]}
          onBack={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 5.4：改 `src/renderer/src/ChapterListPage.tsx`，把人物入口换成「记忆中心」**

把 `Props` 改为（用 `onOpenMemoryCenter` 替换 `onOpenCharacters`）：

```ts
interface Props {
  projectId: string
  onBack: () => void
  onOpenChapter: (n: number) => void
  onOpenMemoryCenter: () => void
}
```

解构改为：

```ts
export default function ChapterListPage({
  projectId,
  onBack,
  onOpenChapter,
  onOpenMemoryCenter
}: Props) {
```

按钮容器改为（一个入口）：

```tsx
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={onBack}>← 返回项目列表</button>
        <button onClick={onOpenMemoryCenter}>🧠 记忆中心</button>
      </div>
```

（记忆中心内再进入人物管理，避免章节列表按钮过多。）

- [ ] **Step 5.5：类型检查**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: 无错误。

- [ ] **Step 5.6：提交**

```bash
git add src/renderer/src/MemoryCenterPage.tsx src/renderer/src/MemoryEntityPage.tsx src/renderer/src/App.tsx src/renderer/src/ChapterListPage.tsx
git commit -m "feat: memory center and generic entity pages"
```

---

## Task 6：端到端验证 + 收尾

**Files:** 无新增（验证 + 文档）

- [ ] **Step 6.1：最终全量测试与类型检查**

Run:
```bash
npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
```
Expected: 全部测试通过（48 个：Phase 04 的 43 + memory-entity 5 = 48），类型检查无错误。

- [ ] **Step 6.2：构建**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 6.3：临时加冒烟日志验证通用链路**

临时修改 `src/main/index.ts`，在 `registerMemoryIpc(memoryService, memoryEntityService)` 之后加：

```ts
void projectService
  .create({ name: '冒烟实体项目' })
  .then(async (m) => {
    const e = await memoryEntityService.create(m.id, 'worldview', { name: '冒烟设定' })
    console.log('[smoke] entity created:', e.id, e.name)
  })
```

构建并运行：

```bash
npm run build && npx electron .
```

Expected: 控制台输出 `[smoke] entity created: <id> 冒烟设定`。

- [ ] **Step 6.4：回滚临时日志、清理冒烟数据**

- 删除 `src/main/index.ts` 里 Step 6.3 加的那段
- `rm -rf "<userData>/projects/"* "<userData>/library.json"`
Run: `npx tsc --noEmit -p tsconfig.node.json` 与 `npx vitest run` 确认仍全绿。

- [ ] **Step 6.5：更新 README**

把「数据位置」章节里 `memory/` 那行扩充为：

```
- 记忆：`memory/characters.json`（人物）、`locations.json`（地点）、`worldview.json`（世界观）、`timeline.json`（时间线）、`plot_points.json`（剧情点）、`history.jsonl`（审计）
```

把「下一阶段」改为：

```
Phase 06：人物关系（relationships）与伏笔（foreshadowings，含状态流转/章节关联）；LLM 基础设施（provider 工厂 + 密钥加密 + 流式）。
```

- [ ] **Step 6.6：提交收尾**

```bash
git add README.md
git commit -m "docs: update readme for phase 05"
```

---

## 完成标准（Definition of Done）

- [ ] `npm test` 48 个单测全绿
- [ ] `tsc --noEmit` 两个项目均无错误
- [ ] `npm run dev` 可：章节列表 → 「🧠 记忆中心」→ 选地点/世界观/时间线/剧情点 → 新建/编辑/删除 → 文件落在对应 `memory/*.json`
- [ ] 通用模式就绪：新增记忆实体只需在 `FILE_NAMES` + `ENTITY_LABELS` + 记忆中心 `ENTITIES` 各加一行
- [ ] 所有改动已分任务提交

## 下一阶段（不在本 plan 范围）

- **Phase 06**：人物关系（relationships，a/b 人物引用）与伏笔（foreshadowings，status 流转 + 章节关联 + chain）；LLM 基础设施（provider 工厂 + AES 密钥 + SSE 流式）
- 后续正文写作 / 大纲 / 打包见 [spec §14](../specs/2026-06-17-desktop-app-design.md)
