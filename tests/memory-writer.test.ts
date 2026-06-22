import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MemoryWriter } from '../src/main/data/memory-writer'
import { CharacterCardMdRepo } from '../src/main/data/skill-format/character-card-md-repo'
import { LocationMdRepo } from '../src/main/data/skill-format/location-md-repo'
import { ForeshadowingMdRepo } from '../src/main/data/skill-format/foreshadowing-md-repo'
import type { MemoryExtraction } from '../src/shared/types'

function seedCharacterFile(dir: string, content: string): void {
  const file = join(dir, '记忆系统', '角色卡.md')
  mkdirSync(join(dir, '记忆系统'), { recursive: true })
  writeFileSync(file, content, 'utf-8')
}

function seedForeshadowingFile(dir: string, content: string): void {
  const file = join(dir, '记忆系统', '伏笔追踪.md')
  mkdirSync(join(dir, '记忆系统'), { recursive: true })
  writeFileSync(file, content, 'utf-8')
}

function seedPlotFile(dir: string, content: string): void {
  const file = join(dir, '记忆系统', '核心情节.md')
  mkdirSync(join(dir, '记忆系统'), { recursive: true })
  writeFileSync(file, content, 'utf-8')
}

const CHARACTER_FILE = `# 角色卡

## 主角

### 林远（男主）

- **姓名**：林远
- **身份**：剑修
- **显性性格**：坚毅冷静
- **当前状态**：无伤

## 核心配角

### 老吴

- **姓名**：老吴
- **身份**：客栈老板
- **当前状态**：健康
`

const FORESHADOWING_FILE = `# 伏笔追踪

| 编号 | 内容 | 类型 | 埋设 | 预计回收 | 实际回收 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| FB-001 | 玉佩来历 | 设定 | 第 1 章 | 第 10 章 | 未回收 | 已埋设 |
| FB-002 | 门外脚步声 | 悬念 | 第 4 章 | 第 5 章 | 未回收 | 已埋设 |
`

const PLOT_FILE = `# 核心情节

## 第一卷

### 第1章：开端
- **核心事件**：林远入山
- **爽点/打脸**：
- **角色变动**：
- **伏笔**：
`

describe('MemoryWriter', () => {
  let dir: string
  let writer: MemoryWriter

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aw-mw-'))
    writer = new MemoryWriter(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('applyAutomatic', () => {
    it('auto-applies state changes + plot points + foreshadowing collection', async () => {
      seedCharacterFile(dir, CHARACTER_FILE)
      seedForeshadowingFile(dir, FORESHADOWING_FILE)
      seedPlotFile(dir, PLOT_FILE)

      const extraction: MemoryExtraction = {
        chapterNumber: 5,
        newCharacters: [],
        newLocations: [],
        newForeshadowings: [],
        newPlotPoints: [
          { title: '初露锋芒', event: '林远击败赵乾', coolPoint: '打脸' }
        ],
        characterStateChanges: [
          { name: '林远', field: '伤势', oldValue: '无', newValue: '轻伤' }
        ],
        collectedForeshadowings: [{ content: '玉佩来历', chapter: 5 }]
      }

      const result = await writer.applyAutomatic(extraction)
      expect(result.applied.stateChanges).toBe(1)
      expect(result.applied.plotPoints).toBe(1)
      expect(result.applied.collected).toBe(1)
      expect(result.applied.characters).toBe(0)
      expect(result.applied.locations).toBe(0)
      expect(result.applied.foreshadowings).toBe(0)
      expect(result.errors).toEqual([])

      // 验证角色卡状态追加
      const charRepo = new CharacterCardMdRepo(dir)
      const lin = (await charRepo.list()).find((c) => c.name === '林远')
      expect(lin?.synopsis).toContain('伤势：轻伤')

      // 验证核心情节追加了 H3
      const plotRaw = readFileSync(join(dir, '记忆系统', '核心情节.md'), 'utf-8')
      expect(plotRaw).toContain('### 第5章：初露锋芒')
      expect(plotRaw).toContain('林远击败赵乾')

      // 验证伏笔状态更新为已回收
      const fRepo = new ForeshadowingMdRepo(dir)
      const f = (await fRepo.list()).find((x) => x.content.includes('玉佩来历'))
      expect(f?.status).toBe('collected')
      expect(f?.actualCollect).toBe(5)
    })

    it('skips state change when character does not exist', async () => {
      seedCharacterFile(dir, CHARACTER_FILE)
      const extraction: MemoryExtraction = {
        chapterNumber: 5,
        newCharacters: [],
        newLocations: [],
        newForeshadowings: [],
        newPlotPoints: [],
        characterStateChanges: [
          { name: '不存在的人', field: '伤势', oldValue: '无', newValue: '轻伤' }
        ],
        collectedForeshadowings: []
      }
      const result = await writer.applyAutomatic(extraction)
      expect(result.applied.stateChanges).toBe(0)
      // 不存在角色不报错（静默跳过）
      expect(result.errors).toEqual([])
    })

    it('creates 核心情节.md with initial structure when absent', async () => {
      const extraction: MemoryExtraction = {
        chapterNumber: 1,
        newCharacters: [],
        newLocations: [],
        newForeshadowings: [],
        newPlotPoints: [{ title: '开端', event: '林远入山', coolPoint: undefined }],
        characterStateChanges: [],
        collectedForeshadowings: []
      }
      const result = await writer.applyAutomatic(extraction)
      expect(result.applied.plotPoints).toBe(1)
      expect(existsSync(join(dir, '记忆系统', '核心情节.md'))).toBe(true)
      const raw = readFileSync(join(dir, '记忆系统', '核心情节.md'), 'utf-8')
      expect(raw).toContain('# 核心情节')
      expect(raw).toContain('### 第1章：开端')
    })

    it('skips foreshadowing collection when no match', async () => {
      seedForeshadowingFile(dir, FORESHADOWING_FILE)
      const extraction: MemoryExtraction = {
        chapterNumber: 5,
        newCharacters: [],
        newLocations: [],
        newForeshadowings: [],
        newPlotPoints: [],
        characterStateChanges: [],
        collectedForeshadowings: [{ content: '不存在的伏笔', chapter: 5 }]
      }
      const result = await writer.applyAutomatic(extraction)
      expect(result.applied.collected).toBe(0)
      expect(result.errors).toEqual([])
    })

    it('appends plot point to last H2 when multiple volumes exist', async () => {
      seedPlotFile(
        dir,
        `# 核心情节

## 第一卷

### 第1章：开端
- **核心事件**：a

## 第二卷

### 第10章：远行
- **核心事件**：b
`
      )
      const extraction: MemoryExtraction = {
        chapterNumber: 11,
        newCharacters: [],
        newLocations: [],
        newForeshadowings: [],
        newPlotPoints: [{ title: '新章', event: 'c', coolPoint: undefined }],
        characterStateChanges: [],
        collectedForeshadowings: []
      }
      await writer.applyAutomatic(extraction)
      const raw = readFileSync(join(dir, '记忆系统', '核心情节.md'), 'utf-8')
      // 新 H3 应在第二卷下（在第一卷之后）
      const idxVol1 = raw.indexOf('## 第一卷')
      const idxVol2 = raw.indexOf('## 第二卷')
      const idxNew = raw.indexOf('### 第11章：新章')
      expect(idxVol1).toBeGreaterThan(-1)
      expect(idxVol2).toBeGreaterThan(idxVol1)
      expect(idxNew).toBeGreaterThan(idxVol2)
    })
  })

  describe('applyNewCharacters', () => {
    it('creates new characters after user confirmation', async () => {
      seedCharacterFile(dir, CHARACTER_FILE)
      const n = await writer.applyNewCharacters([
        { name: '青云子', role: '核心配角', identity: '神秘修士', personality: '高深莫测' }
      ])
      expect(n).toBe(1)
      const repo = new CharacterCardMdRepo(dir)
      const list = await repo.list()
      expect(list.find((c) => c.name === '青云子')).toBeDefined()
    })
  })

  describe('applyNewLocations', () => {
    it('creates new locations after user confirmation', async () => {
      const n = await writer.applyNewLocations([
        { name: '青云观', category: '门派', notes: '青云子所在' }
      ])
      expect(n).toBe(1)
      const repo = new LocationMdRepo(dir)
      const list = await repo.list()
      expect(list.find((l) => l.name === '青云观')).toBeDefined()
    })
  })

  describe('applyNewForeshadowings', () => {
    it('creates new foreshadowings after user confirmation', async () => {
      seedForeshadowingFile(dir, FORESHADOWING_FILE)
      const n = await writer.applyNewForeshadowings([
        { content: '神秘信件', expectedCollect: 15, note: '悬念' }
      ])
      expect(n).toBe(1)
      const repo = new ForeshadowingMdRepo(dir)
      const list = await repo.list()
      expect(list.find((f) => f.content.includes('神秘信件'))).toBeDefined()
    })
  })
})
