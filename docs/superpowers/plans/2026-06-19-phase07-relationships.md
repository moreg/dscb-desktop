# Phase 07：人物关系 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 落地人物关系存储与 UI：`memory/relationships.json`，关系两端引用人物 id，记录关系类型/描述/强度；关系管理页可新建（下拉选两端人物）/删除。

**Architecture:** `RelationshipRepository` 基于 `JsonCollectionRepository<Relationship>` 做 CRUD（两端是 `characterId` 引用，不做外键强约束）。`MemoryService` 扩展关系方法 + 审计。IPC `memory:relationship:*`。UI 用下拉选人物 + 类型。

**Tech Stack:** 复用 Phase 01-06，无新增依赖。

---

## Task 1：扩展共享类型

**Files:** `src/shared/types.ts`

- [ ] **Step 1.1：末尾追加**

```ts
export interface Relationship {
  id: string
  characterAId: string
  characterBId: string
  relationType: string
  description?: string
  strength?: number
  createdAt: string
  updatedAt: string
}

export interface CreateRelationshipInput {
  characterAId: string
  characterBId: string
  relationType: string
  description?: string
  strength?: number
}

export interface UpdateRelationshipInput {
  relationType?: string
  description?: string
  strength?: number
}
```

- [ ] **Step 1.2：`RendererApi` 末尾追加**

```ts
  listRelationships: (projectId: string) => Promise<Relationship[]>
  createRelationship: (projectId: string, input: CreateRelationshipInput) => Promise<Relationship>
  updateRelationship: (
    projectId: string,
    id: string,
    patch: UpdateRelationshipInput
  ) => Promise<Relationship>
  deleteRelationship: (projectId: string, id: string) => Promise<void>
```

- [ ] **Step 1.3：类型检查 + 提交**

```bash
npx tsc --noEmit -p tsconfig.web.json
git add src/shared/types.ts && git commit -m "feat(types): add relationship types"
```

---

## Task 2：RelationshipRepository（TDD）

**Files:** `src/main/data/relationship-repository.ts`, `tests/relationship-repository.test.ts`

- [ ] **Step 2.1：测试 `tests/relationship-repository.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { RelationshipRepository } from '../src/main/data/relationship-repository'

describe('RelationshipRepository', () => {
  let dir: string
  let repo: RelationshipRepository
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-rel-'))
    repo = new RelationshipRepository(dir)
  })

  it('creates a relationship', async () => {
    const r = await repo.create({ characterAId: 'a', characterBId: 'b', relationType: '师徒' })
    expect(r.id).toMatch(/.+/)
    expect(r.relationType).toBe('师徒')
  })

  it('persists to relationships.json', async () => {
    await repo.create({ characterAId: 'a', characterBId: 'b', relationType: 'X' })
    const raw = JSON.parse(await readFile(path.join(dir, 'memory', 'relationships.json'), 'utf-8'))
    expect(raw.items).toHaveLength(1)
  })

  it('updates fields', async () => {
    const r = await repo.create({ characterAId: 'a', characterBId: 'b', relationType: 'X' })
    const updated = await repo.update(r.id, { strength: 80 })
    expect(updated.strength).toBe(80)
  })

  it('deletes', async () => {
    const r = await repo.create({ characterAId: 'a', characterBId: 'b', relationType: 'X' })
    await repo.delete(r.id)
    expect(await repo.list()).toEqual([])
  })
})
```

- [ ] **Step 2.2：跑确认失败**

- [ ] **Step 2.3：实现 `src/main/data/relationship-repository.ts`**

```ts
import { join } from 'path'
import { JsonCollectionRepository } from './json-collection-repository'
import type {
  Relationship,
  CreateRelationshipInput,
  UpdateRelationshipInput
} from '../../shared/types'

export class RelationshipRepository {
  constructor(private readonly projectDir: string) {}

  private repo(): JsonCollectionRepository<Relationship> {
    return new JsonCollectionRepository<Relationship>(
      join(this.projectDir, 'memory', 'relationships.json')
    )
  }

  list(): Promise<Relationship[]> {
    return this.repo().list()
  }

  get(id: string): Promise<Relationship | null> {
    return this.repo().get(id)
  }

  async create(input: CreateRelationshipInput): Promise<Relationship> {
    const now = new Date().toISOString()
    return this.repo().create({ ...input, createdAt: now, updatedAt: now })
  }

  async update(id: string, patch: UpdateRelationshipInput): Promise<Relationship> {
    return this.repo().update(id, { ...patch, updatedAt: new Date().toISOString() })
  }

  delete(id: string): Promise<void> {
    return this.repo().delete(id)
  }
}
```

- [ ] **Step 2.4：跑确认通过（4 passed）+ 提交**

```bash
git add src/main/data/relationship-repository.ts tests/relationship-repository.test.ts
git commit -m "feat: add RelationshipRepository"
```

---

## Task 3：MemoryService 扩展 + IPC

**Files:** `src/main/data/memory-service.ts`, `src/main/ipc/memory.ts`

- [ ] **Step 3.1：`memory-service.ts` import 加**

```ts
import { RelationshipRepository } from './relationship-repository'
```
type import 追加 `Relationship, CreateRelationshipInput, UpdateRelationshipInput`。

- [ ] **Step 3.2：类末尾（foreshadowing 方法之后）追加**

```ts
  private async relRepo(projectId: string): Promise<RelationshipRepository> {
    const dir = await this.projectService.resolveDir(projectId)
    return new RelationshipRepository(dir)
  }

  async listRelationships(projectId: string): Promise<Relationship[]> {
    return (await this.relRepo(projectId)).list()
  }

  async createRelationship(projectId: string, input: CreateRelationshipInput): Promise<Relationship> {
    const repo = await this.relRepo(projectId)
    const r = await repo.create(input)
    await (await this.history(projectId)).append({
      at: new Date().toISOString(),
      type: 'relationship',
      action: 'create',
      entityId: r.id,
      summary: r.relationType
    })
    return r
  }

  async updateRelationship(
    projectId: string,
    id: string,
    patch: UpdateRelationshipInput
  ): Promise<Relationship> {
    return (await this.relRepo(projectId)).update(id, patch)
  }

  async deleteRelationship(projectId: string, id: string): Promise<void> {
    return (await this.relRepo(projectId)).delete(id)
  }
```

- [ ] **Step 3.3：`ipc/memory.ts` 末尾追加 + type import 加**

```ts
  ipcMain.handle('memory:relationship:list', (_e, projectId: string) =>
    service.listRelationships(projectId)
  )
  ipcMain.handle(
    'memory:relationship:create',
    (_e, projectId: string, input: CreateRelationshipInput) =>
      service.createRelationship(projectId, input)
  )
  ipcMain.handle(
    'memory:relationship:update',
    (_e, projectId: string, id: string, patch: UpdateRelationshipInput) =>
      service.updateRelationship(projectId, id, patch)
  )
  ipcMain.handle('memory:relationship:delete', (_e, projectId: string, id: string) =>
    service.deleteRelationship(projectId, id)
  )
```
type import 追加 `CreateRelationshipInput, UpdateRelationshipInput`。

- [ ] **Step 3.4：类型检查 + 提交**

```bash
npx tsc --noEmit -p tsconfig.node.json
git add src/main/data/memory-service.ts src/main/ipc/memory.ts
git commit -m "feat: wire relationship service and ipc"
```

---

## Task 4：扩展 preload

**Files:** `src/preload/index.ts`

- [ ] **Step 4.1：import 加 `CreateRelationshipInput, UpdateRelationshipInput`**

- [ ] **Step 4.2：`api` 末尾追加**

```ts
  listRelationships: (id: string) => ipcRenderer.invoke('memory:relationship:list', id),
  createRelationship: (id: string, input: CreateRelationshipInput) =>
    ipcRenderer.invoke('memory:relationship:create', id, input),
  updateRelationship: (id: string, rid: string, patch: UpdateRelationshipInput) =>
    ipcRenderer.invoke('memory:relationship:update', id, rid, patch),
  deleteRelationship: (id: string, rid: string) =>
    ipcRenderer.invoke('memory:relationship:delete', id, rid)
```

- [ ] **Step 4.3：类型检查 + 提交**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
git add src/preload/index.ts && git commit -m "feat: extend window.api with relationship methods"
```

---

## Task 5：关系管理 UI

**Files:** `src/renderer/src/RelationshipPage.tsx`（新）；`App.tsx`、`MemoryCenterPage.tsx`（改）

- [ ] **Step 5.1：`src/renderer/src/RelationshipPage.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { Character, Relationship } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
}

export default function RelationshipPage({ projectId, onBack }: Props) {
  const [relationships, setRelationships] = useState<Relationship[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const refresh = () => {
    setLoading(true)
    void Promise.all([
      window.api.listRelationships(projectId),
      window.api.listCharacters(projectId)
    ]).then(([rels, chars]) => {
      setRelationships(rels)
      setCharacters(chars)
      setLoading(false)
    })
  }

  useEffect(refresh, [projectId])

  const nameOf = (id: string) => characters.find((c) => c.id === id)?.name ?? '（已删除）'

  const remove = async (r: Relationship) => {
    if (!window.confirm('删除该关系？')) return
    await window.api.deleteRelationship(projectId, r.id)
    refresh()
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={onBack}>← 返回记忆中心</button>
        <button onClick={() => setCreating(true)} disabled={characters.length < 2}>
          + 新建关系
        </button>
      </div>
      <h2>人物关系</h2>
      {characters.length < 2 ? (
        <p style={{ color: '#d97706' }}>至少需要 2 个人物才能建立关系。</p>
      ) : null}
      {loading ? (
        <p>加载中…</p>
      ) : relationships.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>暂无关系。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {relationships.map((r) => (
            <li
              key={r.id}
              style={{ padding: 12, border: '1px solid #e2e8f0', borderRadius: 8, margin: '8px 0' }}
            >
              <strong>
                {nameOf(r.characterAId)} ↔ {nameOf(r.characterBId)}
              </strong>
              <span style={{ color: '#64748b' }}> · {r.relationType}</span>
              {r.strength != null ? <span style={{ color: '#94a3b8' }}> · 强度 {r.strength}</span> : null}
              {r.description ? (
                <div style={{ color: '#475569', fontSize: 14, marginTop: 4 }}>{r.description}</div>
              ) : null}
              <div style={{ marginTop: 8 }}>
                <button onClick={() => remove(r)}>删除</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating ? (
        <Dialog
          characters={characters}
          onClose={() => setCreating(false)}
          onSubmit={async (input) => {
            await window.api.createRelationship(projectId, input)
            setCreating(false)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function Dialog({
  characters,
  onClose,
  onSubmit
}: {
  characters: Character[]
  onClose: () => void
  onSubmit: (input: {
    characterAId: string
    characterBId: string
    relationType: string
    description?: string
    strength?: number
  }) => Promise<void>
}) {
  const [a, setA] = useState(characters[0]?.id ?? '')
  const [b, setB] = useState(characters[1]?.id ?? '')
  const [relationType, setRelationType] = useState('')
  const [description, setDescription] = useState('')
  const [strength, setStrength] = useState('')
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
        <h3 style={{ marginTop: 0 }}>新建关系</h3>
        <p>
          人物A：
          <select value={a} onChange={(e) => setA(e.target.value)} style={{ width: '100%' }}>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </p>
        <p>
          人物B：
          <select value={b} onChange={(e) => setB(e.target.value)} style={{ width: '100%' }}>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </p>
        <p>
          关系类型：
          <input
            value={relationType}
            onChange={(e) => setRelationType(e.target.value)}
            placeholder="师徒/敌对/恋人/兄弟…"
            style={{ width: '100%' }}
          />
        </p>
        <p>
          描述：
          <input value={description} onChange={(e) => setDescription(e.target.value)} style={{ width: '100%' }} />
        </p>
        <p>
          强度（0-100，可留空）：
          <input value={strength} onChange={(e) => setStrength(e.target.value)} style={{ width: '100%' }} />
        </p>
        <div style={{ textAlign: 'right' }}>
          <button onClick={onClose} style={{ marginRight: 8 }}>
            取消
          </button>
          <button
            disabled={saving || !a || !b || a === b || !relationType.trim()}
            onClick={async () => {
              setSaving(true)
              try {
                await onSubmit({
                  characterAId: a,
                  characterBId: b,
                  relationType: relationType.trim(),
                  description: description.trim() || undefined,
                  strength: strength ? Number(strength) : undefined
                })
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

- [ ] **Step 5.2：`App.tsx` View 加 `relationships` + import + 分支 + memoryCenter 传 `onOpenRelationships`**

View 联合类型加 `{ kind: 'relationships'; projectId: string }`，import `RelationshipPage`，在 `memoryEntity` 分支后插入：

```tsx
      ) : view.kind === 'relationships' ? (
        <RelationshipPage
          projectId={view.projectId}
          onBack={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
        />
      ) : (
```
（注意：原本 `foreshadowingBoard` 是兜底 `: (`，现在它改为显式分支，最后由 `relationships` 兜底——或调整顺序使 `relationships` 在最后兜底前。简单做法：把 relationships 分支插在 foreshadowingBoard 之后作为新的兜底。）

memoryCenter 分支加：

```tsx
          onOpenRelationships={() => setView({ kind: 'relationships', projectId: view.projectId })}
```

- [ ] **Step 5.3：`MemoryCenterPage.tsx` 加「人物关系」卡片**

Props 加 `onOpenRelationships: () => void`，在卡片列表里加：

```tsx
<Card label="人物关系" desc="角色之间的关系网" onClick={onOpenRelationships} />
```

- [ ] **Step 5.4：类型检查 + 提交**

```bash
npx tsc --noEmit -p tsconfig.web.json
git add src/renderer/src/RelationshipPage.tsx src/renderer/src/App.tsx src/renderer/src/MemoryCenterPage.tsx
git commit -m "feat: relationship management page"
```

---

## Task 6：端到端验证 + 收尾

- [ ] **Step 6.1：全量测试 + 类型 + 构建**

```bash
npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npm run build
```
Expected: 58 测试通过（54 + 4）。

- [ ] **Step 6.2：冒烟**（`main/index.ts` `registerMemoryIpc` 后加，需先建 2 个人物）

```ts
void projectService.create({ name: '冒烟关系项目' }).then(async (m) => {
  const a = await memoryService.createCharacter(m.id, { name: '张三' })
  const b = await memoryService.createCharacter(m.id, { name: '李四' })
  const r = await memoryService.createRelationship(m.id, {
    characterAId: a.id,
    characterBId: b.id,
    relationType: '挚友'
  })
  console.log('[smoke] relationship:', r.relationType, r.id ? 'ok' : 'fail')
})
```
`npm run build && npx electron .` → 预期 `[smoke] relationship: 挚友 ok`。

- [ ] **Step 6.3：回滚日志 + 清理 `<userData>/projects` 与 `library.json` + 确认测试绿**

- [ ] **Step 6.4：README**：数据位置加 `relationships.json`；下一阶段改为

```
Phase 08：LLM 基础设施（provider 工厂 + AES 密钥加密 + SSE 流式，需 API key 实测）。
```

- [ ] **Step 6.5：提交** `git commit -m "docs: update readme for phase 07"`

---

## 完成标准

- [ ] 58 测试全绿，类型/构建通过
- [ ] `npm run dev`：记忆中心 → 人物关系 → 选两端人物 + 类型 → 新建/删除
- [ ] `memory/relationships.json` 落地；人物不足 2 个时禁用新建
