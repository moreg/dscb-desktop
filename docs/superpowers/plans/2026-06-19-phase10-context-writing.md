# Phase 10：正文写作增强（上下文组装）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: executing-plans.

**Goal:** 章节编辑器的「✨ AI 生成」从简单 prompt 升级为组装完整上下文：项目信息 + 总纲 + 本章细纲 + 出场人物 + 待处理伏笔 + 前文摘要 → 交给 MiniMax 流式生成正文。

**Architecture:** 新增 `WriteService`（main 端）从各 Repository 拉数据组装 prompt，调 `LlmService.generateStream`。新增 IPC `write:generateChapter`（复用 `llm:token` 事件机制推 token）。preload 加 `generateChapterStream`。`ChapterEditor.aiGenerate` 改用它。

**Tech Stack:** 复用 Phase 01-09，无新增依赖。

---

## Task 1：WriteService（TDD）

**Files:** `src/main/data/write-service.ts`, `tests/write-service.test.ts`

- [ ] **Step 1.1：测试 `tests/write-service.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { OutlineRepository } from '../src/main/data/outline-repository'
import { CharacterRepository } from '../src/main/data/character-repository'
import { ChapterRepository } from '../src/main/data/chapter-repository'
import { WriteService } from '../src/main/data/write-service'
import type { LlmService } from '../src/main/data/llm-service'

function mockLlm(reply: string): LlmService {
  return { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
}

describe('WriteService', () => {
  let root: string
  let projectId: string
  let ps: ProjectService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-ws-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library)
    projectId = (await ps.create({ name: '青云志', genre: '玄幻' })).id
  })

  it('buildChapterPrompt assembles project, outline, characters, prev chapter', async () => {
    const dir = await ps.resolveDir(projectId)
    await new OutlineRepository(dir).writeMain({
      schemaVersion: 1,
      updatedAt: 't',
      synopsis: '少年修仙主线'
    })
    await new OutlineRepository(dir).upsertDetailed({
      chapterNumber: 2,
      plotSummary: '本章细纲：林远突破'
    })
    await new CharacterRepository(dir).create({ name: '林远', role: '主角', personality: '坚毅' })
    await new ChapterRepository(dir).create({ title: '第一章' })
    await new ChapterRepository(dir).create({ title: '第二章' })
    await new ChapterRepository(dir).updateContent(1, '前一章的正文内容。')

    const service = new WriteService(ps, mockLlm('正文'))
    const prompt = await service.buildChapterPrompt(projectId, 2)
    expect(prompt).toContain('青云志')
    expect(prompt).toContain('少年修仙主线')
    expect(prompt).toContain('林远突破')
    expect(prompt).toContain('林远')
    expect(prompt).toContain('前一章的正文内容')
  })

  it('generateChapterStream calls llm with assembled prompt', async () => {
    const llm = mockLlm('生成的正文')
    const service = new WriteService(ps, llm)
    const full = await service.generateChapterStream(projectId, 1)
    expect(full).toBe('生成的正文')
    expect(llm.generateStream).toHaveBeenCalled()
  })
})
```

- [ ] **Step 1.2：跑确认失败**

- [ ] **Step 1.3：实现 `src/main/data/write-service.ts`**

```ts
import { join } from 'path'
import type { ProjectService } from './project-service'
import type { LlmService } from './llm-service'
import { OutlineRepository } from './outline-repository'
import { CharacterRepository } from './character-repository'
import { ForeshadowingRepository } from './foreshadowing-repository'
import { ChapterRepository } from './chapter-repository'
import type { GenerateOptions } from './llm-service'

export class WriteService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly llm: LlmService
  ) {}

  async buildChapterPrompt(projectId: string, chapterNumber: number): Promise<string> {
    const dir = await this.projectService.resolveDir(projectId)
    const project = await this.projectService.getProjectData(projectId)

    const outline = new OutlineRepository(dir)
    const main = await outline.readMain()
    const detailed = await outline.listDetailed()
    const detail = detailed.find((d) => d.chapterNumber === chapterNumber)

    const characters = await new CharacterRepository(dir).list()
    const foreshadowings = await new ForeshadowingRepository(dir).list()
    const chapters = await new ChapterRepository(dir).list()
    const prev = chapters.find((c) => c.chapterNumber === chapterNumber - 1)
    let prevSummary = ''
    if (prev) {
      const prevContent = await new ChapterRepository(dir).get(prev.chapterNumber)
      prevSummary = prevContent.content.slice(0, 400)
    }

    const pending = foreshadowings.filter(
      (f) => f.status === 'pending' || (f.status === 'planted' && f.expectedCollect === chapterNumber)
    )

    const lines: string[] = []
    lines.push(`小说《${project.name}》（题材：${project.genre ?? '未指定'}）`)
    if (main?.synopsis) lines.push(`总纲：${main.synopsis}`)
    if (detail?.plotSummary) lines.push(`第 ${chapterNumber} 章细纲：${detail.plotSummary}`)
    if (characters.length > 0) {
      lines.push(
        '主要人物：' +
          characters
            .map((c) => `${c.name}（${c.role ?? '角色'}）${c.personality ? '，' + c.personality : ''}`)
            .join('；')
      )
    }
    if (pending.length > 0) {
      lines.push('本章相关伏笔：' + pending.map((f) => f.content).join('；'))
    }
    if (prevSummary) lines.push(`前一章内容摘要：${prevSummary}`)
    lines.push(`请写第 ${chapterNumber} 章正文，约 2000 字，承接前文、推进剧情。直接输出正文，不要标题或解释。`)
    return lines.join('\n\n')
  }

  async generateChapterStream(
    projectId: string,
    chapterNumber: number,
    opts: GenerateOptions = {}
  ): Promise<string> {
    const prompt = await this.buildChapterPrompt(projectId, chapterNumber)
    return this.llm.generateStream(prompt, opts)
  }
}
```

- [ ] **Step 1.4：跑确认通过（2 passed）+ 提交**

```bash
git add src/main/data/write-service.ts tests/write-service.test.ts
git commit -m "feat: add WriteService with context assembly"
```

---

## Task 2：IPC + 主进程接线

**Files:** `src/main/ipc/write.ts`（新）, `src/main/index.ts`

- [ ] **Step 2.1：`src/main/ipc/write.ts`**（复用 llm:token 事件推 token）

```ts
import { ipcMain, BrowserWindow } from 'electron'
import { WriteService } from '../data/write-service'

export function registerWriteIpc(service: WriteService): void {
  ipcMain.handle(
    'write:generateChapter',
    async (e, payload: { projectId: string; chapterNumber: number; requestId: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        await service.generateChapterStream(payload.projectId, payload.chapterNumber, {
          onToken: (token) =>
            win?.webContents.send('llm:token', {
              requestId: payload.requestId,
              token,
              done: false
            })
        })
        win?.webContents.send('llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )
}
```

- [ ] **Step 2.2：`src/main/index.ts` 接线**

import 加：
```ts
import { WriteService } from './data/write-service'
import { registerWriteIpc } from './ipc/write'
```
`whenReady` 中（`registerOutlineIpc(...)` 之后）加：
```ts
  const writeService = new WriteService(projectService, llmService)
  registerWriteIpc(writeService)
```

- [ ] **Step 2.3：类型检查 + 提交**

```bash
npx tsc --noEmit -p tsconfig.node.json
git add src/main/ipc/write.ts src/main/index.ts
git commit -m "feat: wire write ipc"
```

---

## Task 3：扩展 preload + RendererApi

**Files:** `src/preload/index.ts`, `src/shared/types.ts`

- [ ] **Step 3.1：preload `api` 末尾追加**

```ts
  generateChapterStream: (
    projectId: string,
    chapterNumber: number,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = Math.random().toString(36).slice(2)
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('llm:token', handler as never)
    return ipcRenderer
      .invoke('write:generateChapter', { projectId, chapterNumber, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never))
  }
```

- [ ] **Step 3.2：`shared/types.ts` 的 `RendererApi` 末尾追加**

```ts
  generateChapterStream: (
    projectId: string,
    chapterNumber: number,
    onToken: (token: string, done: boolean) => void
  ) => Promise<{ ok: boolean; error?: string }>
```

- [ ] **Step 3.3：类型检查 + 提交**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
git add src/preload/index.ts src/shared/types.ts
git commit -m "feat: expose generateChapterStream on window.api"
```

---

## Task 4：ChapterEditor 改用上下文生成

**Files:** `src/renderer/src/ChapterEditor.tsx`

- [ ] **Step 4.1：把 `aiGenerate` 函数体替换为用 `generateChapterStream`**

把现有 `aiGenerate` 替换为：

```ts
  const aiGenerate = async () => {
    if (!(await window.api.hasLlmKey())) {
      window.alert('请先在「⚙️ 设置」中配置 MiniMax API Key')
      return
    }
    setGenerating(true)
    setDraft('')
    try {
      await window.api.generateChapterStream(projectId, chapterNumber, (token, done) => {
        if (token) setDraft((d) => d + token)
        if (done) setGenerating(false)
      })
      setDirty(true)
    } catch {
      setGenerating(false)
    }
  }
```

> 按钮文案可改为「✨ AI 写作（组装上下文）」——可选。

- [ ] **Step 4.2：类型检查 + 提交**

```bash
npx tsc --noEmit -p tsconfig.web.json
git add src/renderer/src/ChapterEditor.tsx
git commit -m "feat: editor AI write assembles full context"
```

---

## Task 5：端到端验证 + 收尾

- [ ] **Step 5.1：全量测试 + 类型 + 构建**

```bash
npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npm run build
```
Expected: 72 测试通过（70 + write-service 2）。

- [ ] **Step 5.2：真实 key 冒烟（可选，验证组装 prompt 真实生成）**

LlmService 已在 Phase 08 真实验证流式；WriteService 在 main 端组装 prompt 后调同一个 LlmService。冒烟可跳过真实调用（单测已覆盖 prompt 组装）。如需真实：临时在 main 加建项目+大纲+人物+`writeService.generateChapterStream(pid, 1, {onToken: t=>process.stdout.write(t)})`，跑完清理 key。

- [ ] **Step 5.3：README**：架构图加 `WriteService (上下文组装)`；下一阶段改为

```
Phase 11：打包（electron-builder 出 Windows/macOS 安装包）。
```

- [ ] **Step 5.4：提交** `git commit -m "docs: update readme for phase 10"`

---

## 完成标准

- [ ] 72 测试全绿，类型/构建通过
- [ ] 编辑器「✨ AI 生成」改为组装完整上下文（项目+总纲+细纲+人物+伏笔+前文）后流式生成正文
- [ ] 无 key 时友好提示
