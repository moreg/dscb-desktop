# Phase 04：章节版本历史 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每章增加版本历史（`chapters/NNN.versions.json`），支持把当前正文存为命名版本（ai/manual/reviewed）、查看历史、一键回滚，为后续 AI 写作生成的正文落版本铺路。

**Architecture:** 新增 `ChapterVersionRepository` 操作 `NNN.versions.json`（versions 数组 CRUD，复用 `atomic.ts`）。当前正文仍是 `NNN.md`（工作版本），versions 是命名快照。回滚 = 读版本 content → 走 `ChapterRepository.updateContent` 写回 md。IPC 在已有 `chapters.ts` 上扩展版本通道（无需改 main 接线）。编辑器加版本面板。

**Tech Stack:** 复用 Phase 01-03 的 Electron + electron-vite + React + TypeScript + Vitest，无新增依赖。

> **已知简化（YAGNI）**：版本 content 存全文（非 diff），长篇下 `NNN.versions.json` 会随版本数增大。Phase 04 接受这一权衡，diff 存储优化留给后续。

---

## File Structure

新增/修改文件（在 `E:/trea/写作桌面应用/` 下）：

```
src/
├─ shared/types.ts                       [改] ChapterSource/ChapterVersion/CreateChapterVersionInput + RendererApi 版本方法
├─ main/
│  ├─ data/chapter-version-repository.ts [新] NNN.versions.json 的 CRUD
│  └─ ipc/chapters.ts                    [改] 加 listVersions/getVersion/createVersion/deleteVersion/rollback
├─ preload/index.ts                      [改] 加版本方法
└─ renderer/src/ChapterEditor.tsx        [改] 版本面板（存为版本/历史/查看/回滚）
tests/
└─ chapter-version-repository.test.ts    [新]
```

**职责边界：**
- `chapter-version-repository.ts` — 只管单个章节的 `NNN.versions.json`（versions 数组 CRUD）
- `ipc/chapters.ts` — 在已有章节通道基础上扩展版本通道；rollback 协调 `ChapterVersionRepository.get` + `ChapterRepository.updateContent`
- `ChapterEditor.tsx` — 正文编辑 + 版本面板（存为版本、历史列表、查看、回滚）

---

## Task 1：扩展共享类型

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1.1：在 `src/shared/types.ts` 末尾追加版本类型**

```ts
export type ChapterSource = 'ai' | 'manual' | 'reviewed'

export interface ChapterVersion {
  versionNumber: number
  source: ChapterSource
  content: string
  wordCount: number
  note?: string
  createdAt: string
}

export interface CreateChapterVersionInput {
  source: ChapterSource
  content: string
  note?: string
}
```

- [ ] **Step 1.2：在 `RendererApi` 的 `listHistory` 行之后追加版本方法**

把 `listHistory` 那一行后追加（仍在 `RendererApi` 接口内）：

```ts
  listChapterVersions: (projectId: string, n: number) => Promise<ChapterVersion[]>
  getChapterVersion: (projectId: string, n: number, vn: number) => Promise<ChapterVersion>
  createChapterVersion: (projectId: string, n: number, input: CreateChapterVersionInput) => Promise<ChapterVersion>
  deleteChapterVersion: (projectId: string, n: number, vn: number) => Promise<void>
  rollbackChapter: (projectId: string, n: number, vn: number) => Promise<ChapterMeta>
```

- [ ] **Step 1.3：类型检查**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: 通过（renderer 尚未调用新方法）。

- [ ] **Step 1.4：提交**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add chapter version types"
```

---

## Task 2：ChapterVersionRepository（TDD）

**Files:**
- Create: `src/main/data/chapter-version-repository.ts`
- Test: `tests/chapter-version-repository.test.ts`

- [ ] **Step 2.1：写失败测试 `tests/chapter-version-repository.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ChapterVersionRepository } from '../src/main/data/chapter-version-repository'

describe('ChapterVersionRepository', () => {
  let dir: string
  let repo: ChapterVersionRepository
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-cv-'))
    repo = new ChapterVersionRepository(dir)
  })

  it('lists empty when versions file absent', async () => {
    expect(await repo.list(1)).toEqual([])
  })

  it('creates version 1 with word count', async () => {
    const v = await repo.create(1, { source: 'manual', content: '林远觉醒了金符文。' })
    expect(v.versionNumber).toBe(1)
    expect(v.source).toBe('manual')
    expect(v.wordCount).toBe(9)
    expect(v.createdAt).toBeTruthy()
  })

  it('creates sequential version numbers', async () => {
    await repo.create(1, { source: 'manual', content: 'A' })
    await repo.create(1, { source: 'ai', content: 'B' })
    const list = await repo.list(1)
    expect(list.map((v) => v.versionNumber)).toEqual([1, 2])
    expect(list.map((v) => v.source)).toEqual(['manual', 'ai'])
  })

  it('get returns the version', async () => {
    await repo.create(1, { source: 'manual', content: 'X' })
    const v = await repo.get(1, 1)
    expect(v.content).toBe('X')
  })

  it('get throws on missing version', async () => {
    await expect(repo.get(1, 99)).rejects.toThrow(/not found/)
  })

  it('persists to NNN.versions.json', async () => {
    await repo.create(1, { source: 'manual', content: 'X' })
    const raw = await readFile(path.join(dir, 'chapters', '001.versions.json'), 'utf-8')
    expect(JSON.parse(raw).versions).toHaveLength(1)
  })

  it('deletes a version', async () => {
    await repo.create(1, { source: 'manual', content: 'A' })
    await repo.create(1, { source: 'ai', content: 'B' })
    await repo.delete(1, 1)
    const list = await repo.list(1)
    expect(list.map((v) => v.versionNumber)).toEqual([2])
  })
})
```

- [ ] **Step 2.2：运行测试，确认失败**

Run: `npx vitest run tests/chapter-version-repository.test.ts`
Expected: FAIL，`Cannot find module '../src/main/data/chapter-version-repository'`。

- [ ] **Step 2.3：写实现 `src/main/data/chapter-version-repository.ts`**

```ts
import { join } from 'path'
import { readJson, writeJsonAtomic } from './atomic'
import type { ChapterVersion, CreateChapterVersionInput } from '../../shared/types'

interface VersionsFile {
  schemaVersion: number
  updatedAt: string
  versions: ChapterVersion[]
}

const PAD = 3
const EMPTY: VersionsFile = { schemaVersion: 1, updatedAt: '', versions: [] }

function versionsFile(projectDir: string, n: number): string {
  return join(projectDir, 'chapters', `${String(n).padStart(PAD, '0')}.versions.json`)
}

function countWords(text: string): number {
  return text.replace(/\s/g, '').length
}

export class ChapterVersionRepository {
  constructor(private readonly projectDir: string) {}

  async list(n: number): Promise<ChapterVersion[]> {
    const data = await readJson<VersionsFile>(versionsFile(this.projectDir, n), EMPTY)
    return data.versions
  }

  async get(n: number, vn: number): Promise<ChapterVersion> {
    const data = await readJson<VersionsFile>(versionsFile(this.projectDir, n), EMPTY)
    const v = data.versions.find((x) => x.versionNumber === vn)
    if (!v) throw new Error(`version ${vn} of chapter ${n} not found`)
    return v
  }

  async create(n: number, input: CreateChapterVersionInput): Promise<ChapterVersion> {
    const data = await readJson<VersionsFile>(versionsFile(this.projectDir, n), EMPTY)
    const nextNumber =
      data.versions.length === 0 ? 1 : Math.max(...data.versions.map((v) => v.versionNumber)) + 1
    const version: ChapterVersion = {
      versionNumber: nextNumber,
      source: input.source,
      content: input.content,
      wordCount: countWords(input.content),
      note: input.note,
      createdAt: new Date().toISOString()
    }
    const next: VersionsFile = {
      ...data,
      updatedAt: new Date().toISOString(),
      versions: [...data.versions, version]
    }
    await writeJsonAtomic(versionsFile(this.projectDir, n), next)
    return version
  }

  async delete(n: number, vn: number): Promise<void> {
    const data = await readJson<VersionsFile>(versionsFile(this.projectDir, n), EMPTY)
    const versions = data.versions.filter((v) => v.versionNumber !== vn)
    await writeJsonAtomic(versionsFile(this.projectDir, n), {
      ...data,
      updatedAt: new Date().toISOString(),
      versions
    })
  }
}
```

- [ ] **Step 2.4：运行测试，确认通过**

Run: `npx vitest run tests/chapter-version-repository.test.ts`
Expected: 7 passed。

- [ ] **Step 2.5：提交**

```bash
git add src/main/data/chapter-version-repository.ts tests/chapter-version-repository.test.ts
git commit -m "feat: add ChapterVersionRepository"
```

---

## Task 3：扩展 chapters IPC 加版本通道

**Files:**
- Modify: `src/main/ipc/chapters.ts`

- [ ] **Step 3.1：在 `src/main/ipc/chapters.ts` 顶部 import 区追加**

```ts
import { ChapterVersionRepository } from '../data/chapter-version-repository'
import type { CreateChapterVersionInput } from '../../shared/types'
```

- [ ] **Step 3.2：在 `registerChaptersIpc` 函数末尾（`chapters:delete` 之后）追加版本通道**

```ts
  const versionRepoFor = async (id: string): Promise<ChapterVersionRepository> => {
    const dir = await service.resolveDir(id)
    return new ChapterVersionRepository(dir)
  }
  ipcMain.handle('chapters:listVersions', async (_e, id: string, n: number) =>
    (await versionRepoFor(id)).list(n)
  )
  ipcMain.handle('chapters:getVersion', async (_e, id: string, n: number, vn: number) =>
    (await versionRepoFor(id)).get(n, vn)
  )
  ipcMain.handle(
    'chapters:createVersion',
    async (_e, id: string, n: number, input: CreateChapterVersionInput) =>
      (await versionRepoFor(id)).create(n, input)
  )
  ipcMain.handle('chapters:deleteVersion', async (_e, id: string, n: number, vn: number) =>
    (await versionRepoFor(id)).delete(n, vn)
  )
  ipcMain.handle('chapters:rollback', async (_e, id: string, n: number, vn: number) => {
    const dir = await service.resolveDir(id)
    const version = await new ChapterVersionRepository(dir).get(n, vn)
    return new ChapterRepository(dir).updateContent(n, version.content)
  })
```

- [ ] **Step 3.3：类型检查**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: 无错误。

- [ ] **Step 3.4：提交**

```bash
git add src/main/ipc/chapters.ts
git commit -m "feat: add chapter version ipc channels and rollback"
```

---

## Task 4：扩展 preload 桥

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 4.1：在 import 块追加类型**

把 import 段改为（追加 `CreateChapterVersionInput`）：

```ts
import type {
  CreateProjectDataInput,
  CreateChapterInput,
  UpdateChapterMetaInput,
  CreateCharacterInput,
  UpdateCharacterInput,
  CreateChapterVersionInput
} from '../shared/types'
```

- [ ] **Step 4.2：在 `api` 对象末尾（`listHistory` 之后）追加版本方法**

```ts
  listChapterVersions: (id: string, n: number) => ipcRenderer.invoke('chapters:listVersions', id, n),
  getChapterVersion: (id: string, n: number, vn: number) =>
    ipcRenderer.invoke('chapters:getVersion', id, n, vn),
  createChapterVersion: (id: string, n: number, input: CreateChapterVersionInput) =>
    ipcRenderer.invoke('chapters:createVersion', id, n, input),
  deleteChapterVersion: (id: string, n: number, vn: number) =>
    ipcRenderer.invoke('chapters:deleteVersion', id, n, vn),
  rollbackChapter: (id: string, n: number, vn: number) =>
    ipcRenderer.invoke('chapters:rollback', id, n, vn)
```

- [ ] **Step 4.3：类型检查**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: 无错误。

- [ ] **Step 4.4：提交**

```bash
git add src/preload/index.ts
git commit -m "feat: extend window.api with chapter version methods"
```

---

## Task 5：ChapterEditor 版本面板

**Files:**
- Modify: `src/renderer/src/ChapterEditor.tsx`

- [ ] **Step 5.1：整体替换 `src/renderer/src/ChapterEditor.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { ChapterContent, ChapterVersion, ChapterSource } from '../../shared/types'

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
  const [versions, setVersions] = useState<ChapterVersion[]>([])
  const [showVersions, setShowVersions] = useState(false)
  const [savingVersion, setSavingVersion] = useState(false)
  const [viewing, setViewing] = useState<ChapterVersion | null>(null)

  const refreshVersions = () => {
    void window.api.listChapterVersions(projectId, chapterNumber).then(setVersions)
  }

  useEffect(() => {
    void window.api.getChapter(projectId, chapterNumber).then((c) => {
      setData(c)
      setDraft(c.content)
      setDirty(false)
    })
    refreshVersions()
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

  const saveAsVersion = async () => {
    const source = window.prompt(
      '版本来源（输入：manual / ai / reviewed）',
      'manual'
    ) as ChapterSource | null
    if (!source) return
    const note = window.prompt('备注（可留空）', '') ?? ''
    setSavingVersion(true)
    try {
      await window.api.createChapterVersion(projectId, chapterNumber, {
        source,
        content: draft,
        note: note.trim() || undefined
      })
      refreshVersions()
    } finally {
      setSavingVersion(false)
    }
  }

  const rollback = async (v: ChapterVersion) => {
    if (!window.confirm(`回滚到版本 ${v.versionNumber}（${v.source}）？当前正文将被覆盖。`)) return
    const meta = await window.api.rollbackChapter(projectId, chapterNumber, v.versionNumber)
    setDraft(v.content)
    setData({ meta, content: v.content })
    setDirty(false)
    setViewing(null)
  }

  const removeVersion = async (v: ChapterVersion) => {
    if (!window.confirm(`删除版本 ${v.versionNumber}？`)) return
    await window.api.deleteChapterVersion(projectId, chapterNumber, v.versionNumber)
    refreshVersions()
  }

  if (!data) return <p>加载中…</p>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <button onClick={onBack}>← 返回章节列表</button>
        <span style={{ color: '#94a3b8' }}>
          第 {data.meta.chapterNumber} 章 · {data.meta.title} · {data.meta.wordCount} 字 ·{' '}
          {versions.length} 个版本
        </span>
        <div>
          <button onClick={save} disabled={!dirty || saving}>
            {saving ? '保存中…' : dirty ? '保存 *' : '已保存'}
          </button>
          <button onClick={saveAsVersion} disabled={savingVersion} style={{ marginLeft: 8 }}>
            存为版本
          </button>
          <button onClick={() => setShowVersions((s) => !s)} style={{ marginLeft: 8 }}>
            {showVersions ? '收起历史' : '版本历史'}
          </button>
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setDirty(true)
        }}
        style={{
          width: '100%',
          height: '50vh',
          marginTop: 12,
          fontFamily: 'inherit',
          fontSize: 15,
          padding: 12
        }}
        placeholder="在此输入正文……"
      />

      {showVersions ? (
        <div style={{ marginTop: 16, border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>版本历史（{versions.length}）</h3>
          {versions.length === 0 ? (
            <p style={{ color: '#94a3b8' }}>暂无版本，点「存为版本」创建。</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {[...versions].reverse().map((v) => (
                <li
                  key={v.versionNumber}
                  style={{
                    padding: 10,
                    borderBottom: '1px solid #f1f5f9',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8
                  }}
                >
                  <div>
                    <strong>#{v.versionNumber}</strong>{' '}
                    <span style={{ color: sourceColor(v.source) }}>{v.source}</span>{' '}
                    <span style={{ color: '#94a3b8' }}>
                      {v.wordCount} 字 · {v.createdAt.replace('T', ' ').slice(0, 19)}
                    </span>
                    {v.note ? <div style={{ color: '#64748b', fontSize: 13 }}>{v.note}</div> : null}
                  </div>
                  <div>
                    <button onClick={() => setViewing(v)}>查看</button>
                    <button onClick={() => rollback(v)} style={{ marginLeft: 6 }}>
                      回滚
                    </button>
                    <button onClick={() => removeVersion(v)} style={{ marginLeft: 6 }}>
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {viewing ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10
          }}
          onClick={() => setViewing(null)}
        >
          <div
            style={{ background: '#fff', padding: 20, borderRadius: 12, width: 640, maxHeight: '80vh', overflow: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>
              版本 #{viewing.versionNumber} · {viewing.source} · {viewing.wordCount} 字
            </h3>
            <pre
              style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, color: '#334155' }}
            >
              {viewing.content}
            </pre>
            <div style={{ textAlign: 'right', marginTop: 12 }}>
              <button onClick={() => setViewing(null)} style={{ marginRight: 8 }}>
                关闭
              </button>
              <button onClick={() => rollback(viewing)}>回滚到此版本</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function sourceColor(source: ChapterSource): string {
  if (source === 'ai') return '#7c3aed'
  if (source === 'reviewed') return '#059669'
  return '#475569'
}
```

- [ ] **Step 5.2：类型检查**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: 无错误。

- [ ] **Step 5.3：提交**

```bash
git add src/renderer/src/ChapterEditor.tsx
git commit -m "feat: chapter editor version panel (save/view/rollback)"
```

---

## Task 6：端到端验证 + 收尾

**Files:** 无新增（验证 + 文档）

- [ ] **Step 6.1：最终全量测试与类型检查**

Run:
```bash
npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
```
Expected: 全部测试通过（43 个：Phase 03 的 36 + chapter-version 7 = 43），类型检查无错误。

- [ ] **Step 6.2：构建**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 6.3：临时加冒烟日志验证版本链路**

临时修改 `src/main/index.ts`，在 `registerMemoryIpc(memoryService)` 之后加：

```ts
void projectService
  .create({ name: '冒烟版本项目' })
  .then(async (m) => {
    const dir = await projectService.resolveDir(m.id)
    const { ChapterRepository } = await import('./data/chapter-repository')
    const { ChapterVersionRepository } = await import('./data/chapter-version-repository')
    await new ChapterRepository(dir).create({ title: '第一章' })
    const v = await new ChapterVersionRepository(dir).create(1, {
      source: 'manual',
      content: '冒烟正文'
    })
    console.log('[smoke] version created:', v.versionNumber, v.wordCount)
  })
```

构建并运行：

```bash
npm run build && npx electron .
```

Expected: 控制台输出 `[smoke] version created: 1 4`（"冒烟正文" 非空白字符 4 个），证明版本链路接通。

- [ ] **Step 6.4：回滚临时日志、清理冒烟数据**

- 删除 `src/main/index.ts` 里 Step 6.3 加的那段
- 删除冒烟产生的项目：`rm -rf "<userData>/projects/"* "<userData>/library.json"`（冒烟项目的 id 不确定，清空 projects 目录与 library.json 最稳）
Run: `npx tsc --noEmit -p tsconfig.node.json` 确认无错误，`npx vitest run` 确认仍全绿。

- [ ] **Step 6.5：更新 README**

把 `README.md` 的「数据位置」章节里 `memory/` 那行下方加：

```
- 章节版本：`chapters/NNN.versions.json`（命名快照，含 ai/manual/reviewed 三类来源）
```

并把「下一阶段」改为：

```
Phase 05：其余记忆实体（关系/地点/伏笔/时间线/剧情点/世界观/风格）基于 JsonCollectionRepository 批量接入；LLM 基础设施（provider 工厂 + 密钥加密 + 流式）。
```

- [ ] **Step 6.6：提交收尾**

```bash
git add README.md
git commit -m "docs: update readme for phase 04"
```

---

## 完成标准（Definition of Done）

- [ ] `npm test` 43 个单测全绿
- [ ] `tsc --noEmit` 两个项目均无错误
- [ ] `npm run dev` / `npx electron .` 可：进入章节编辑器 → 写正文 → 存为版本 → 查看历史 → 回滚 → 文件落在 `chapters/NNN.versions.json`
- [ ] 所有改动已分任务提交

## 下一阶段（不在本 plan 范围）

- **Phase 05**：其余记忆实体（关系/地点/伏笔/时间线/剧情点/世界观/风格）基于 `JsonCollectionRepository` 批量接入；LLM 基础设施（provider 工厂 + AES 密钥 + SSE 流式）
- 后续正文写作 / 大纲 / 打包见 [spec §14](../specs/2026-06-17-desktop-app-design.md)
