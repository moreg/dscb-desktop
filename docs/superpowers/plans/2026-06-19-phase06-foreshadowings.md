# Phase 06：伏笔管理（状态流转 + 看板）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地伏笔的文件存储与状态流转闭环：`memory/foreshadowings.json`，状态机 pending→planted→collected（或 missed），记录埋设/回收章节，配看板式 UI。

**Architecture:** `ForeshadowingRepository` 基于 `JsonCollectionRepository<Foreshadowing>` 做基础 CRUD，并加三个状态流转方法（plant/collect/markMissed）。`MemoryService` 扩展伏笔方法 + 审计（复用 `MemoryHistory`）。IPC `memory:foreshadowing:*`。UI 用看板（4 列按 status 分）。

**Tech Stack:** 复用 Phase 01-05，无新增依赖。

---

## File Structure

```
src/
├─ shared/types.ts                  [改] Foreshadowing/ForeshadowingStatus/Create/UpdateForeshadowingInput + RendererApi
├─ main/
│  ├─ data/
│  │  ├─ foreshadowing-repository.ts [新] 基础 CRUD + 状态流转
│  │  └─ memory-service.ts           [改] 加伏笔方法 + 审计
│  └─ ipc/memory.ts                  [改] 加 memory:foreshadowing:* 通道
├─ preload/index.ts               [改] 加伏笔方法
└─ renderer/src/
   ├─ App.tsx                     [改] view 加 foreshadowingBoard
   ├─ MemoryCenterPage.tsx        [改] 加「伏笔」卡片
   └─ ForeshadowingBoard.tsx      [新] 看板 UI
tests/
└─ foreshadowing-repository.test.ts
```

---

## Task 1：扩展共享类型

**Files:** Modify `src/shared/types.ts`

- [ ] **Step 1.1：末尾追加伏笔类型**

```ts
export type ForeshadowingStatus = 'pending' | 'planted' | 'collected' | 'missed'

export interface Foreshadowing {
  id: string
  content: string
  status: ForeshadowingStatus
  plantChapter?: number
  expectedCollect?: number
  actualCollect?: number
  note?: string
  createdAt: string
  updatedAt: string
}

export interface CreateForeshadowingInput {
  content: string
  expectedCollect?: number
  note?: string
}

export interface UpdateForeshadowingInput {
  content?: string
  expectedCollect?: number
  note?: string
}
```

- [ ] **Step 1.2：`RendererApi` 末尾（`deleteMemoryEntity` 后）追加**

```ts
  listForeshadowings: (projectId: string) => Promise<Foreshadowing[]>
  createForeshadowing: (projectId: string, input: CreateForeshadowingInput) => Promise<Foreshadowing>
  updateForeshadowing: (
    projectId: string,
    id: string,
    patch: UpdateForeshadowingInput
  ) => Promise<Foreshadowing>
  deleteForeshadowing: (projectId: string, id: string) => Promise<void>
  plantForeshadowing: (projectId: string, id: string, chapterNumber: number) => Promise<Foreshadowing>
  collectForeshadowing: (projectId: string, id: string, chapterNumber: number) => Promise<Foreshadowing>
  markForeshadowingMissed: (projectId: string, id: string) => Promise<Foreshadowing>
```

- [ ] **Step 1.3：类型检查 + 提交**

```bash
npx tsc --noEmit -p tsconfig.web.json
git add src/shared/types.ts && git commit -m "feat(types): add foreshadowing types"
```

---

## Task 2：ForeshadowingRepository（TDD）

**Files:** Create `src/main/data/foreshadowing-repository.ts`, `tests/foreshadowing-repository.test.ts`

- [ ] **Step 2.1：写测试 `tests/foreshadowing-repository.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ForeshadowingRepository } from '../src/main/data/foreshadowing-repository'

describe('ForeshadowingRepository', () => {
  let dir: string
  let repo: ForeshadowingRepository
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-fs-'))
    repo = new ForeshadowingRepository(dir)
  })

  it('creates with pending status', async () => {
    const f = await repo.create({ content: '神秘玉佩', expectedCollect: 50 })
    expect(f.status).toBe('pending')
    expect(f.id).toMatch(/.+/)
  })

  it('persists to foreshadowings.json', async () => {
    await repo.create({ content: 'X' })
    const raw = JSON.parse(await readFile(path.join(dir, 'memory', 'foreshadowings.json'), 'utf-8'))
    expect(raw.items).toHaveLength(1)
  })

  it('plant sets status planted and plantChapter', async () => {
    const f = await repo.create({ content: 'X' })
    const planted = await repo.plant(f.id, 3)
    expect(planted.status).toBe('planted')
    expect(planted.plantChapter).toBe(3)
  })

  it('collect sets status collected and actualCollect', async () => {
    const f = await repo.create({ content: 'X' })
    const collected = await repo.collect(f.id, 48)
    expect(collected.status).toBe('collected')
    expect(collected.actualCollect).toBe(48)
  })

  it('markMissed sets status missed', async () => {
    const f = await repo.create({ content: 'X' })
    expect((await repo.markMissed(f.id)).status).toBe('missed')
  })

  it('deletes', async () => {
    const f = await repo.create({ content: 'X' })
    await repo.delete(f.id)
    expect(await repo.list()).toEqual([])
  })
})
```

- [ ] **Step 2.2：跑确认失败** — `npx vitest run tests/foreshadowing-repository.test.ts`（模块不存在）

- [ ] **Step 2.3：写实现 `src/main/data/foreshadowing-repository.ts`**

```ts
import { join } from 'path'
import { JsonCollectionRepository } from './json-collection-repository'
import type {
  Foreshadowing,
  CreateForeshadowingInput,
  UpdateForeshadowingInput
} from '../../shared/types'

export class ForeshadowingRepository {
  constructor(private readonly projectDir: string) {}

  private repo(): JsonCollectionRepository<Foreshadowing> {
    return new JsonCollectionRepository<Foreshadowing>(
      join(this.projectDir, 'memory', 'foreshadowings.json')
    )
  }

  list(): Promise<Foreshadowing[]> {
    return this.repo().list()
  }

  get(id: string): Promise<Foreshadowing | null> {
    return this.repo().get(id)
  }

  async create(input: CreateForeshadowingInput): Promise<Foreshadowing> {
    const now = new Date().toISOString()
    return this.repo().create({
      content: input.content,
      status: 'pending',
      expectedCollect: input.expectedCollect,
      note: input.note,
      createdAt: now,
      updatedAt: now
    })
  }

  async update(id: string, patch: UpdateForeshadowingInput): Promise<Foreshadowing> {
    return this.repo().update(id, { ...patch, updatedAt: new Date().toISOString() })
  }

  async plant(id: string, chapterNumber: number): Promise<Foreshadowing> {
    return this.repo().update(id, {
      status: 'planted',
      plantChapter: chapterNumber,
      updatedAt: new Date().toISOString()
    })
  }

  async collect(id: string, chapterNumber: number): Promise<Foreshadowing> {
    return this.repo().update(id, {
      status: 'collected',
      actualCollect: chapterNumber,
      updatedAt: new Date().toISOString()
    })
  }

  async markMissed(id: string): Promise<Foreshadowing> {
    return this.repo().update(id, { status: 'missed', updatedAt: new Date().toISOString() })
  }

  delete(id: string): Promise<void> {
    return this.repo().delete(id)
  }
}
```

- [ ] **Step 2.4：跑确认通过**（6 passed）+ **提交**

```bash
git add src/main/data/foreshadowing-repository.ts tests/foreshadowing-repository.test.ts
git commit -m "feat: add ForeshadowingRepository with status transitions"
```

---

## Task 3：MemoryService 扩展 + IPC + 接线

**Files:** Modify `src/main/data/memory-service.ts`, `src/main/ipc/memory.ts`

- [ ] **Step 3.1：在 `memory-service.ts` 顶部 import 区追加**

```ts
import { ForeshadowingRepository } from './foreshadowing-repository'
```

并追加类型 import（合并到已有 `import type { ... } from '../../shared/types'`）：

```ts
  Foreshadowing,
  CreateForeshadowingInput,
  UpdateForeshadowingInput
```

- [ ] **Step 3.2：在 `MemoryService` 类末尾（`listHistory` 之后）追加伏笔方法**

```ts
  private async fsRepo(projectId: string): Promise<ForeshadowingRepository> {
    const dir = await this.projectService.resolveDir(projectId)
    return new ForeshadowingRepository(dir)
  }

  async listForeshadowings(projectId: string): Promise<Foreshadowing[]> {
    return (await this.fsRepo(projectId)).list()
  }

  async createForeshadowing(projectId: string, input: CreateForeshadowingInput): Promise<Foreshadowing> {
    const repo = await this.fsRepo(projectId)
    const f = await repo.create(input)
    await (await this.history(projectId)).append({
      at: new Date().toISOString(),
      type: 'foreshadowing',
      action: 'create',
      entityId: f.id,
      summary: f.content
    })
    return f
  }

  async updateForeshadowing(
    projectId: string,
    id: string,
    patch: UpdateForeshadowingInput
  ): Promise<Foreshadowing> {
    return (await this.fsRepo(projectId)).update(id, patch)
  }

  async deleteForeshadowing(projectId: string, id: string): Promise<void> {
    return (await this.fsRepo(projectId)).delete(id)
  }

  async plantForeshadowing(projectId: string, id: string, chapterNumber: number): Promise<Foreshadowing> {
    return (await this.fsRepo(projectId)).plant(id, chapterNumber)
  }

  async collectForeshadowing(projectId: string, id: string, chapterNumber: number): Promise<Foreshadowing> {
    return (await this.fsRepo(projectId)).collect(id, chapterNumber)
  }

  async markForeshadowingMissed(projectId: string, id: string): Promise<Foreshadowing> {
    return (await this.fsRepo(projectId)).markMissed(id)
  }
```

- [ ] **Step 3.3：在 `ipc/memory.ts` 的 `registerMemoryIpc` 末尾（entity 通道之后）追加伏笔通道**

```ts
  ipcMain.handle('memory:foreshadowing:list', (_e, projectId: string) =>
    service.listForeshadowings(projectId)
  )
  ipcMain.handle(
    'memory:foreshadowing:create',
    (_e, projectId: string, input: CreateForeshadowingInput) =>
      service.createForeshadowing(projectId, input)
  )
  ipcMain.handle(
    'memory:foreshadowing:update',
    (_e, projectId: string, id: string, patch: UpdateForeshadowingInput) =>
      service.updateForeshadowing(projectId, id, patch)
  )
  ipcMain.handle('memory:foreshadowing:delete', (_e, projectId: string, id: string) =>
    service.deleteForeshadowing(projectId, id)
  )
  ipcMain.handle(
    'memory:foreshadowing:plant',
    (_e, projectId: string, id: string, chapterNumber: number) =>
      service.plantForeshadowing(projectId, id, chapterNumber)
  )
  ipcMain.handle(
    'memory:foreshadowing:collect',
    (_e, projectId: string, id: string, chapterNumber: number) =>
      service.collectForeshadowing(projectId, id, chapterNumber)
  )
  ipcMain.handle('memory:foreshadowing:markMissed', (_e, projectId: string, id: string) =>
    service.markForeshadowingMissed(projectId, id)
  )
```

并在 `ipc/memory.ts` 顶部 type import 追加 `CreateForeshadowingInput, UpdateForeshadowingInput`。

- [ ] **Step 3.4：类型检查 + 提交**

```bash
npx tsc --noEmit -p tsconfig.node.json
git add src/main/data/memory-service.ts src/main/ipc/memory.ts
git commit -m "feat: wire foreshadowing service and ipc"
```

---

## Task 4：扩展 preload

**Files:** Modify `src/preload/index.ts`

- [ ] **Step 4.1：import 块追加 `CreateForeshadowingInput, UpdateForeshadowingInput`**

- [ ] **Step 4.2：`api` 末尾（`deleteMemoryEntity` 后）追加**

```ts
  listForeshadowings: (id: string) => ipcRenderer.invoke('memory:foreshadowing:list', id),
  createForeshadowing: (id: string, input: CreateForeshadowingInput) =>
    ipcRenderer.invoke('memory:foreshadowing:create', id, input),
  updateForeshadowing: (id: string, fid: string, patch: UpdateForeshadowingInput) =>
    ipcRenderer.invoke('memory:foreshadowing:update', id, fid, patch),
  deleteForeshadowing: (id: string, fid: string) =>
    ipcRenderer.invoke('memory:foreshadowing:delete', id, fid),
  plantForeshadowing: (id: string, fid: string, chapterNumber: number) =>
    ipcRenderer.invoke('memory:foreshadowing:plant', id, fid, chapterNumber),
  collectForeshadowing: (id: string, fid: string, chapterNumber: number) =>
    ipcRenderer.invoke('memory:foreshadowing:collect', id, fid, chapterNumber),
  markForeshadowingMissed: (id: string, fid: string) =>
    ipcRenderer.invoke('memory:foreshadowing:markMissed', id, fid)
```

- [ ] **Step 4.3：类型检查 + 提交**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
git add src/preload/index.ts && git commit -m "feat: extend window.api with foreshadowing methods"
```

---

## Task 5：伏笔看板 UI

**Files:** Create `src/renderer/src/ForeshadowingBoard.tsx`; Modify `App.tsx`, `MemoryCenterPage.tsx`

- [ ] **Step 5.1：写 `src/renderer/src/ForeshadowingBoard.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { Foreshadowing, ForeshadowingStatus } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
}

const COLUMNS: { status: ForeshadowingStatus; label: string; color: string }[] = [
  { status: 'pending', label: '待埋', color: '#64748b' },
  { status: 'planted', label: '已埋', color: '#d97706' },
  { status: 'collected', label: '已收', color: '#059669' },
  { status: 'missed', label: '遗漏', color: '#e11d48' }
]

export default function ForeshadowingBoard({ projectId, onBack }: Props) {
  const [items, setItems] = useState<Foreshadowing[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = () => {
    setLoading(true)
    void window.api.listForeshadowings(projectId).then((list) => {
      setItems(list)
      setLoading(false)
    })
  }

  useEffect(refresh, [projectId])

  const create = async () => {
    const content = window.prompt('伏笔内容')
    if (!content) return
    const expected = window.prompt('预期回收章节（可留空）', '')
    await window.api.createForeshadowing(projectId, {
      content,
      expectedCollect: expected ? Number(expected) : undefined
    })
    refresh()
  }

  const plant = async (f: Foreshadowing) => {
    const n = window.prompt('埋设章节号', String(f.plantChapter ?? 1))
    if (!n) return
    await window.api.plantForeshadowing(projectId, f.id, Number(n))
    refresh()
  }

  const collect = async (f: Foreshadowing) => {
    const n = window.prompt('回收章节号', String(f.expectedCollect ?? f.plantChapter ?? 1))
    if (!n) return
    await window.api.collectForeshadowing(projectId, f.id, Number(n))
    refresh()
  }

  const markMissed = async (f: Foreshadowing) => {
    if (!window.confirm('标记为遗漏？')) return
    await window.api.markForeshadowingMissed(projectId, f.id)
    refresh()
  }

  const remove = async (f: Foreshadowing) => {
    if (!window.confirm('删除该伏笔？')) return
    await window.api.deleteForeshadowing(projectId, f.id)
    refresh()
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={onBack}>← 返回记忆中心</button>
        <button onClick={create}>+ 新建伏笔</button>
      </div>
      <h2>伏笔看板</h2>
      {loading ? (
        <p>加载中…</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {COLUMNS.map((col) => {
            const list = items.filter((f) => f.status === col.status)
            return (
              <div key={col.status} style={{ background: '#f8fafc', borderRadius: 10, padding: 10 }}>
                <div style={{ fontWeight: 700, color: col.color, marginBottom: 8 }}>
                  {col.label}（{list.length}）
                </div>
                {list.map((f) => (
                  <div
                    key={f.id}
                    style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, marginBottom: 8 }}
                  >
                    <div style={{ fontSize: 14 }}>{f.content}</div>
                    <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 4 }}>
                      {f.plantChapter ? `埋:${f.plantChapter} ` : ''}
                      {f.expectedCollect ? `预收:${f.expectedCollect} ` : ''}
                      {f.actualCollect ? `实收:${f.actualCollect}` : ''}
                    </div>
                    <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {f.status === 'pending' ? (
                        <button onClick={() => plant(f)}>埋设</button>
                      ) : null}
                      {f.status === 'planted' ? (
                        <>
                          <button onClick={() => collect(f)}>回收</button>
                          <button onClick={() => markMissed(f)}>遗漏</button>
                        </>
                      ) : null}
                      <button onClick={() => remove(f)}>删除</button>
                    </div>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 5.2：`App.tsx` View 加 `foreshadowingBoard`，并在 `memoryCenter` 分支后追加渲染**

View 联合类型加：

```ts
  | { kind: 'foreshadowingBoard'; projectId: string }
```

在 `memoryCenter` 分支后、最后的 `memoryEntity` 兜底分支前插入：

```tsx
      ) : view.kind === 'foreshadowingBoard' ? (
        <ForeshadowingBoard
          projectId={view.projectId}
          onBack={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
        />
      ) : (
```

顶部 import 加：

```ts
import ForeshadowingBoard from './ForeshadowingBoard'
```

- [ ] **Step 5.3：`MemoryCenterPage.tsx` 加「伏笔」卡片入口**

Props 加 `onOpenForeshadowings: () => void`，解构加入；在 `ENTITIES` 之后、`<Card label="人物"...>` 同级处加：

```tsx
        <Card label="伏笔" desc="埋设与回收，状态看板" onClick={onOpenForeshadowings} />
```

- [ ] **Step 5.4：`App.tsx` 的 `memoryCenter` 分支传入新回调**

```tsx
          onOpenForeshadowings={() =>
            setView({ kind: 'foreshadowingBoard', projectId: view.projectId })
          }
```

- [ ] **Step 5.5：类型检查 + 提交**

```bash
npx tsc --noEmit -p tsconfig.web.json
git add src/renderer/src/ForeshadowingBoard.tsx src/renderer/src/App.tsx src/renderer/src/MemoryCenterPage.tsx
git commit -m "feat: foreshadowing kanban board"
```

---

## Task 6：端到端验证 + 收尾

- [ ] **Step 6.1：全量测试 + 类型 + 构建**

```bash
npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npm run build
```
Expected: 54 测试通过（48 + 6），类型/构建无错。

- [ ] **Step 6.2：冒烟**（临时在 `main/index.ts` `registerMemoryIpc` 后加）

```ts
void projectService.create({ name: '冒烟伏笔项目' }).then(async (m) => {
  const f = await memoryService.createForeshadowing(m.id, { content: '冒烟伏笔' })
  const planted = await memoryService.plantForeshadowing(m.id, f.id, 1)
  console.log('[smoke] foreshadowing:', planted.status, planted.plantChapter)
})
```
`npm run build && npx electron .` → 预期 `[smoke] foreshadowing: planted 1`。

- [ ] **Step 6.3：回滚日志 + 清理 `<userData>/projects` 与 `library.json` + 确认测试仍绿**

- [ ] **Step 6.4：README 数据位置加 `foreshadowings.json`；下一阶段改为**

```
Phase 07：人物关系（relationships）；LLM 基础设施（provider 工厂 + 密钥加密 + 流式）。
```

- [ ] **Step 6.5：提交** `git commit -m "docs: update readme for phase 06"`

---

## 完成标准

- [ ] 54 测试全绿，类型/构建通过
- [ ] `npm run dev`：记忆中心 → 伏笔 → 新建/埋设/回收/遗漏/删除，看板按状态分列
- [ ] `memory/foreshadowings.json` 落地
