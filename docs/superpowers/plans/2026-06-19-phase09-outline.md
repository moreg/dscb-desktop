# Phase 09：大纲系统（存储 + AI 生成）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: executing-plans.

**Goal:** 落地大纲文件存储与 AI 生成：`outlines/main.json`（总纲，单例）、`outlines/detailed.json`（细纲，按章列表）；基于项目信息 AI 生成总纲、基于总纲+章号 AI 生成本章细纲；大纲页 UI。

**Architecture:** `OutlineRepository` 操作两个文件（main 单例 / detailed items 列表）。`OutlineService` 协调 repo + `LlmService`（main 端收集完整文本后写文件，返回结果）。IPC `outline:*`。UI 大纲页（总纲区 + 细纲列表，每章一个 AI 生成按钮）。入口在章节列表页「📋 大纲」。

**Tech Stack:** 复用 Phase 01-08，无新增依赖。

> AI 生成需先在设置页配置 MiniMax key。

---

## Task 1：扩展共享类型

**Files:** `src/shared/types.ts`

- [ ] **Step 1.1：末尾追加**

```ts
export interface MainOutline {
  schemaVersion: number
  updatedAt: string
  synopsis: string
  theme?: string
  mainLine?: string
}

export interface DetailedOutlineItem {
  chapterNumber: number
  plotSummary: string
  emotionPoint?: string
  coolPoint?: string
  hook?: string
}

export interface DetailedOutline {
  schemaVersion: number
  updatedAt: string
  items: DetailedOutlineItem[]
}
```

- [ ] **Step 1.2：`RendererApi` 末尾追加**

```ts
  getMainOutline: (projectId: string) => Promise<MainOutline | null>
  generateMainOutline: (projectId: string) => Promise<MainOutline>
  listDetailedOutline: (projectId: string) => Promise<DetailedOutlineItem[]>
  generateDetailedOutline: (projectId: string, chapterNumber: number) => Promise<DetailedOutlineItem>
```

- [ ] **Step 1.3：类型检查 + 提交**

```bash
npx tsc --noEmit -p tsconfig.web.json
git add src/shared/types.ts && git commit -m "feat(types): add outline types"
```

---

## Task 2：OutlineRepository（TDD）

**Files:** `src/main/data/outline-repository.ts`, `tests/outline-repository.test.ts`

- [ ] **Step 2.1：测试 `tests/outline-repository.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { OutlineRepository } from '../src/main/data/outline-repository'

describe('OutlineRepository', () => {
  let dir: string
  let repo: OutlineRepository
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-ol-'))
    repo = new OutlineRepository(dir)
  })

  it('main returns null when absent', async () => {
    expect(await repo.readMain()).toBeNull()
  })

  it('writes and reads main outline', async () => {
    await repo.writeMain({ schemaVersion: 1, updatedAt: 't', synopsis: '故事简介' })
    expect((await repo.readMain())?.synopsis).toBe('故事简介')
  })

  it('detailed lists empty when absent', async () => {
    expect(await repo.listDetailed()).toEqual([])
  })

  it('upserts detailed item by chapterNumber', async () => {
    await repo.upsertDetailed({ chapterNumber: 1, plotSummary: 'A' })
    await repo.upsertDetailed({ chapterNumber: 1, plotSummary: 'B' })
    const list = await repo.listDetailed()
    expect(list).toHaveLength(1)
    expect(list[0].plotSummary).toBe('B')
  })

  it('persists detailed to detailed.json', async () => {
    await repo.upsertDetailed({ chapterNumber: 2, plotSummary: 'X' })
    const raw = JSON.parse(await readFile(path.join(dir, 'outlines', 'detailed.json'), 'utf-8'))
    expect(raw.items).toHaveLength(1)
  })
})
```

- [ ] **Step 2.2：跑确认失败**

- [ ] **Step 2.3：实现 `src/main/data/outline-repository.ts`**

```ts
import { join } from 'path'
import { readJson, writeJsonAtomic } from './atomic'
import type { MainOutline, DetailedOutline, DetailedOutlineItem } from '../../shared/types'

const EMPTY_DETAILED: DetailedOutline = { schemaVersion: 1, updatedAt: '', items: [] }

export class OutlineRepository {
  constructor(private readonly projectDir: string) {}

  async readMain(): Promise<MainOutline | null> {
    return readJson<MainOutline | null>(join(this.projectDir, 'outlines', 'main.json'), null)
  }

  async writeMain(data: MainOutline): Promise<void> {
    await writeJsonAtomic(join(this.projectDir, 'outlines', 'main.json'), data)
  }

  async listDetailed(): Promise<DetailedOutlineItem[]> {
    const data = await readJson<DetailedOutline>(
      join(this.projectDir, 'outlines', 'detailed.json'),
      EMPTY_DETAILED
    )
    return data.items
  }

  async upsertDetailed(item: DetailedOutlineItem): Promise<DetailedOutlineItem> {
    const file = join(this.projectDir, 'outlines', 'detailed.json')
    const data = await readJson<DetailedOutline>(file, EMPTY_DETAILED)
    const idx = data.items.findIndex((x) => x.chapterNumber === item.chapterNumber)
    const items = [...data.items]
    if (idx >= 0) items[idx] = item
    else items.push(item)
    items.sort((a, b) => a.chapterNumber - b.chapterNumber)
    await writeJsonAtomic(file, { ...data, updatedAt: new Date().toISOString(), items })
    return item
  }
}
```

- [ ] **Step 2.4：跑确认通过（5 passed）+ 提交**

```bash
git add src/main/data/outline-repository.ts tests/outline-repository.test.ts
git commit -m "feat: add OutlineRepository"
```

---

## Task 3：OutlineService（AI 生成，TDD）

**Files:** `src/main/data/outline-service.ts`, `tests/outline-service.test.ts`

- [ ] **Step 3.1：测试 `tests/outline-service.test.ts`（mock LlmService）**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { OutlineService } from '../src/main/data/outline-service'
import type { LlmService } from '../src/main/data/llm-service'

function mockLlm(reply: string): LlmService {
  return { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
}

describe('OutlineService', () => {
  let root: string
  let projectId: string
  let llm: LlmService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-ols-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    const projectService = new ProjectService(path.join(root, 'projects'), library)
    projectId = (await projectService.create({ name: '青云志', genre: '玄幻' })).id
    llm = mockLlm('这是一个关于少年的修仙故事。')
  })

  it('generateMain writes main outline from llm reply', async () => {
    const service = new OutlineService(
      new ProjectService(path.join(root, 'projects'), new LibraryRepository(path.join(root, 'library.json'))),
      llm
    )
    const main = await service.generateMain(projectId)
    expect(main.synopsis).toBe('这是一个关于少年的修仙故事。')
    expect(main.updatedAt).toBeTruthy()
  })

  it('generateDetailed writes a detailed item by chapter', async () => {
    const ps = new ProjectService(path.join(root, 'projects'), new LibraryRepository(path.join(root, 'library.json')))
    const service = new OutlineService(ps, mockLlm('第3章细纲：林远觉醒。'))
    const item = await service.generateDetailed(projectId, 3)
    expect(item.chapterNumber).toBe(3)
    expect(item.plotSummary).toContain('林远觉醒')
  })
})
```

- [ ] **Step 3.2：跑确认失败**

- [ ] **Step 3.3：实现 `src/main/data/outline-service.ts`**

```ts
import { OutlineRepository } from './outline-repository'
import type { ProjectService } from './project-service'
import type { LlmService } from './llm-service'
import type { MainOutline, DetailedOutlineItem } from '../../shared/types'

export class OutlineService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly llm: LlmService
  ) {}

  private async repo(projectId: string): Promise<OutlineRepository> {
    const dir = await this.projectService.resolveDir(projectId)
    return new OutlineRepository(dir)
  }

  async getMain(projectId: string) {
    return (await this.repo(projectId)).readMain()
  }

  async generateMain(projectId: string): Promise<MainOutline> {
    const data = await this.projectService.getProjectData(projectId)
    const repo = await this.repo(projectId)
    const prompt = `请为小说《${data.name}》（题材：${data.genre ?? '未指定'}）写一段约 300 字的故事总纲，包含主线和核心冲突。直接输出总纲正文，不要标题或解释。`
    const synopsis = await this.llm.generateStream(prompt)
    const main: MainOutline = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      synopsis
    }
    await repo.writeMain(main)
    return main
  }

  async listDetailed(projectId: string): Promise<DetailedOutlineItem[]> {
    return (await this.repo(projectId)).listDetailed()
  }

  async generateDetailed(projectId: string, chapterNumber: number): Promise<DetailedOutlineItem> {
    const repo = await this.repo(projectId)
    const main = await repo.readMain()
    const synopsis = main?.synopsis ?? '（无总纲）'
    const prompt = `小说总纲：${synopsis}\n\n请为第 ${chapterNumber} 章写一段细纲（约 200 字），包含剧情概要、情绪点、爽点和章末钩子。直接输出细纲正文。`
    const plotSummary = await this.llm.generateStream(prompt)
    const item: DetailedOutlineItem = { chapterNumber, plotSummary }
    await repo.upsertDetailed(item)
    return item
  }
}
```

- [ ] **Step 3.4：跑确认通过（2 passed）+ 提交**

```bash
git add src/main/data/outline-service.ts tests/outline-service.test.ts
git commit -m "feat: add OutlineService with AI generation"
```

---

## Task 4：IPC + 主进程接线

**Files:** `src/main/ipc/outline.ts`（新）, `src/main/index.ts`

- [ ] **Step 4.1：`src/main/ipc/outline.ts`**

```ts
import { ipcMain } from 'electron'
import { OutlineService } from '../data/outline-service'

export function registerOutlineIpc(service: OutlineService): void {
  ipcMain.handle('outline:getMain', (_e, projectId: string) => service.getMain(projectId))
  ipcMain.handle('outline:generateMain', (_e, projectId: string) => service.generateMain(projectId))
  ipcMain.handle('outline:listDetailed', (_e, projectId: string) => service.listDetailed(projectId))
  ipcMain.handle(
    'outline:generateDetailed',
    (_e, projectId: string, chapterNumber: number) => service.generateDetailed(projectId, chapterNumber)
  )
}
```

- [ ] **Step 4.2：`src/main/index.ts` 接线**

import 加：
```ts
import { OutlineService } from './data/outline-service'
import { registerOutlineIpc } from './ipc/outline'
```
`whenReady` 中（`registerLlmIpc(...)` 之后）加：
```ts
  const outlineService = new OutlineService(projectService, llmService)
  registerOutlineIpc(outlineService)
```

- [ ] **Step 4.3：类型检查 + 提交**

```bash
npx tsc --noEmit -p tsconfig.node.json
git add src/main/ipc/outline.ts src/main/index.ts
git commit -m "feat: wire outline ipc"
```

---

## Task 5：扩展 preload

**Files:** `src/preload/index.ts`

- [ ] **Step 5.1：`api` 末尾追加**

```ts
  getMainOutline: (id: string) => ipcRenderer.invoke('outline:getMain', id),
  generateMainOutline: (id: string) => ipcRenderer.invoke('outline:generateMain', id),
  listDetailedOutline: (id: string) => ipcRenderer.invoke('outline:listDetailed', id),
  generateDetailedOutline: (id: string, n: number) =>
    ipcRenderer.invoke('outline:generateDetailed', id, n)
```

- [ ] **Step 5.2：类型检查 + 提交**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
git add src/preload/index.ts && git commit -m "feat: expose outline methods on window.api"
```

---

## Task 6：大纲页 UI

**Files:** `src/renderer/src/OutlinePage.tsx`（新）, `src/renderer/src/App.tsx`, `src/renderer/src/ChapterListPage.tsx`

- [ ] **Step 6.1：`src/renderer/src/OutlinePage.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { MainOutline, DetailedOutlineItem } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
}

export default function OutlinePage({ projectId, onBack }: Props) {
  const [main, setMain] = useState<MainOutline | null>(null)
  const [items, setItems] = useState<DetailedOutlineItem[]>([])
  const [loadingMain, setLoadingMain] = useState(false)
  const [genChapter, setGenChapter] = useState<number | null>(null)

  const refresh = () => {
    void window.api.getMainOutline(projectId).then(setMain)
    void window.api.listDetailedOutline(projectId).then(setItems)
  }

  useEffect(refresh, [projectId])

  const genMain = async () => {
    setLoadingMain(true)
    try {
      setMain(await window.api.generateMainOutline(projectId))
    } finally {
      setLoadingMain(false)
    }
  }

  const genDetailed = async (n: number) => {
    setGenChapter(n)
    try {
      await window.api.generateDetailedOutline(projectId, n)
      setItems(await window.api.listDetailedOutline(projectId))
    } finally {
      setGenChapter(null)
    }
  }

  return (
    <div>
      <button onClick={onBack}>← 返回章节列表</button>
      <h2>大纲</h2>
      <h3>总纲</h3>
      {main ? (
        <pre style={{ whiteSpace: 'pre-wrap', background: '#f8fafc', padding: 12, borderRadius: 8 }}>
          {main.synopsis}
        </pre>
      ) : (
        <p style={{ color: '#94a3b8' }}>暂无总纲。</p>
      )}
      <button onClick={genMain} disabled={loadingMain}>
        {loadingMain ? '生成中…' : main ? '重新生成总纲' : '✨ AI 生成总纲'}
      </button>

      <h3 style={{ marginTop: 24 }}>细纲</h3>
      {items.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>暂无细纲。先创建章节，再为每章生成细纲。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {items.map((it) => (
            <li
              key={it.chapterNumber}
              style={{ padding: 12, border: '1px solid #e2e8f0', borderRadius: 8, margin: '8px 0' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>第 {it.chapterNumber} 章</strong>
                <button onClick={() => genDetailed(it.chapterNumber)} disabled={genChapter === it.chapterNumber}>
                  {genChapter === it.chapterNumber ? '生成中…' : '重新生成'}
                </button>
              </div>
              <pre style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', fontSize: 14, color: '#334155' }}>
                {it.plotSummary}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 6.2：`App.tsx` 加 `outline` view + import + 分支**

View 加 `{ kind: 'outline'; projectId: string }`，import `OutlinePage`，在 `relationships` 分支后插入：
```tsx
      ) : view.kind === 'outline' ? (
        <OutlinePage
          projectId={view.projectId}
          onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
        />
      ) : (
```

- [ ] **Step 6.3：`ChapterListPage.tsx` 加「📋 大纲」入口**

Props 加 `onOpenOutline: () => void`，解构加入；按钮容器加（与「记忆中心」并列）：
```tsx
          <button onClick={onOpenOutline} style={{ marginRight: 8 }}>
            📋 大纲
          </button>
```

- [ ] **Step 6.4：`App.tsx` 的 `chapters` 分支传 `onOpenOutline`**

```tsx
          onOpenOutline={() => setView({ kind: 'outline', projectId: view.projectId })}
```

- [ ] **Step 6.5：类型检查 + 提交**

```bash
npx tsc --noEmit -p tsconfig.web.json
git add src/renderer/src/OutlinePage.tsx src/renderer/src/App.tsx src/renderer/src/ChapterListPage.tsx
git commit -m "feat: outline page with AI generation"
```

---

## Task 7：端到端验证 + 收尾

- [ ] **Step 7.1：全量测试 + 类型 + 构建**

```bash
npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npm run build
```
Expected: 70 测试通过（63 + outline-repo 5 + outline-service 2）。

- [ ] **Step 7.2：真实 key 冒烟（生成总纲）**

临时在 `main/index.ts` `registerOutlineIpc(...)` 后加（用真实 key，冒烟后必删）：
```ts
void secret.write({ activeProvider: 'minimax', providers: { minimax: { apiKey: '<key>' } } })
  .then(() => outlineService.generateMain(projectId /* 需先建项目 */))
```
简化做法：先建冒烟项目再生成。或直接验证 `outlineService.generateMain` 在已有项目上。为简洁，冒烟可跳过真实调用（LlmService 已在 Phase 08 验证），只确认接线：`npm run build && npx electron .` 无报错启动即可。

- [ ] **Step 7.3：回滚任何临时代码 + 清理 `<userData>` 测试数据 + 确认绿**

- [ ] **Step 7.4：README**：数据位置加 `outlines/main.json` + `outlines/detailed.json`；下一阶段改为

```
Phase 10：正文写作增强（AI 生成组装上下文：细纲+人物+伏笔+前文摘要）；打包。
```

- [ ] **Step 7.5：提交** `git commit -m "docs: update readme for phase 09"`

---

## 完成标准

- [ ] 70 测试全绿，类型/构建通过
- [ ] `npm run dev`：章节列表 → 📋 大纲 → AI 生成总纲 / 为每章生成细纲 → 落 `outlines/*.json`
