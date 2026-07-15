import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MemoryWriter } from '../src/main/data/memory-writer'
import { CharacterRepo } from '../src/main/data/memory/character-repo'
import { LocationRepo } from '../src/main/data/memory/location-repo'
import { ItemRepo } from '../src/main/data/memory/item-repo'
import { PlotPointRepo } from '../src/main/data/memory/plot-point-repo'
import { ForeshadowingMdRepo } from '../src/main/data/skill-format/foreshadowing-md-repo'
import type { MemoryExtraction } from '../src/shared/types'

/** v4：seed 角色文件到 设定/角色/<name>.md（CharacterRepo fallback） */
function seedCharacterFile(dir: string, name = '林远'): void {
  mkdirSync(join(dir, '设定', '角色'), { recursive: true })
  mkdirSync(join(dir, '记忆', '人物'), { recursive: true })
  writeFileSync(
    join(dir, '设定', '角色', `${name}.md`),
    `# ${name}\n\n## 基本信息\n\n- **身份**：剑修\n`,
    'utf-8'
  )
}

function seedForeshadowingFile(dir: string, content: string): void {
  const file = join(dir, '追踪', '伏笔.md')
  mkdirSync(join(dir, '追踪'), { recursive: true })
  writeFileSync(file, content, 'utf-8')
}

const FORESHADOWING_FILE = `# 伏笔追踪

| 编号 | 内容 | 类型 | 埋设 | 预计回收 | 实际回收 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| FB-001 | 玉佩来历 | 设定 | 第 1 章 | 第 10 章 | 未回收 | 已埋设 |
| FB-002 | 门外脚步声 | 悬念 | 第 4 章 | 第 5 章 | 未回收 | 已埋设 |
`

describe('MemoryWriter (v4)', () => {
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
      seedCharacterFile(dir, '林远')
      seedForeshadowingFile(dir, FORESHADOWING_FILE)
      // seed 时间线骨架（开书时创建的初始表）
      mkdirSync(join(dir, '追踪'), { recursive: true })
      writeFileSync(
        join(dir, '追踪', '时间线.md'),
        '# 时间线\n\n| 章节 | 事件名 | 时间跨度 | 涉及角色 | 详细描述 |\n|---|---|---|---|---|\n| 第 1 章 | 开端 | 1 天 | 主角 | 故事开始 |\n',
        'utf-8'
      )

      const extraction: MemoryExtraction = {
        chapterNumber: 5,
        newCharacters: [],
        newLocations: [],
        newItems: [],
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
      expect(result.errors).toEqual([])

      // 验证角色状态追加到 customFields['状态轨迹']（CharacterRepo 读 记忆/人物/*.md）
      const charRepo = new CharacterRepo(dir)
      const lin = (await charRepo.list()).find((c) => c.name === '林远')
      expect(lin?.customFields?.['状态轨迹']).toContain('伤势：轻伤')

      // 验证剧情点写到 记忆/剧情点/第005章 初露锋芒.md
      const plotFile = join(dir, '记忆', '剧情点', '第005章 初露锋芒.md')
      expect(existsSync(plotFile)).toBe(true)
      const plotRaw = readFileSync(plotFile, 'utf-8')
      expect(plotRaw).toContain('林远击败赵乾')

      // 验证伏笔状态更新为已回收
      const fRepo = new ForeshadowingMdRepo(dir)
      const f = (await fRepo.list()).find((x) => x.content.includes('玉佩来历'))
      expect(f?.status).toBe('collected')
      expect(f?.actualCollect).toBe(5)
    })

    it('skips state change when character does not exist', async () => {
      seedCharacterFile(dir, '林远')
      const extraction: MemoryExtraction = {
        chapterNumber: 5,
        newCharacters: [],
        newLocations: [],
        newItems: [],
        newForeshadowings: [],
        newPlotPoints: [],
        characterStateChanges: [
          { name: '不存在的人', field: '伤势', oldValue: '无', newValue: '轻伤' }
        ],
        collectedForeshadowings: []
      }
      const result = await writer.applyAutomatic(extraction)
      expect(result.applied.stateChanges).toBe(0)
      expect(result.errors).toEqual([])
    })

    it('剧情点标题含路径字符时 sanitize 落盘且不逃逸目录', async () => {
      const extraction: MemoryExtraction = {
        chapterNumber: 3,
        newCharacters: [],
        newLocations: [],
        newItems: [],
        newForeshadowings: [],
        newPlotPoints: [
          { title: '../逃逸/危险标题', event: '不应写出 记忆/剧情点 之外', coolPoint: '测路径' }
        ],
        characterStateChanges: [],
        collectedForeshadowings: []
      }
      const result = await writer.applyAutomatic(extraction)
      expect(result.applied.plotPoints).toBe(1)
      expect(result.errors).toEqual([])

      const plotDir = join(dir, '记忆', '剧情点')
      expect(existsSync(plotDir)).toBe(true)
      // 不应出现上级目录逃逸文件
      expect(existsSync(join(dir, '逃逸'))).toBe(false)
      expect(existsSync(join(dir, '记忆', '逃逸'))).toBe(false)

      const files = readdirSync(plotDir)
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/^第003章 /)
      expect(files[0].includes('..')).toBe(false)
      expect(files[0].includes('/')).toBe(false)
      const raw = readFileSync(join(plotDir, files[0]), 'utf-8')
      // H1 保留原始标题语义；文件名已消毒
      expect(raw).toContain('# 第3章 ../逃逸/危险标题')
    })

    it('creates 记忆/剧情点/<file>.md with initial structure when absent', async () => {
      const extraction: MemoryExtraction = {
        chapterNumber: 1,
        newCharacters: [],
        newLocations: [],
        newItems: [],
        newForeshadowings: [],
        newPlotPoints: [{ title: '开端', event: '林远入山', coolPoint: undefined }],
        characterStateChanges: [],
        collectedForeshadowings: []
      }
      const result = await writer.applyAutomatic(extraction)
      expect(result.applied.plotPoints).toBe(1)
      const file = join(dir, '记忆', '剧情点', '第001章 开端.md')
      expect(existsSync(file)).toBe(true)
      const raw = readFileSync(file, 'utf-8')
      expect(raw).toContain('# 第1章 开端')
      expect(raw).toContain('林远入山')
    })

    it('skips foreshadowing collection when no match', async () => {
      seedForeshadowingFile(dir, FORESHADOWING_FILE)
      const extraction: MemoryExtraction = {
        chapterNumber: 5,
        newCharacters: [],
        newLocations: [],
        newItems: [],
        newForeshadowings: [],
        newPlotPoints: [],
        characterStateChanges: [],
        collectedForeshadowings: [{ content: '不存在的伏笔', chapter: 5 }]
      }
      const result = await writer.applyAutomatic(extraction)
      expect(result.applied.collected).toBe(0)
      expect(result.errors).toEqual([])
    })

    it('appends plot point as separate chapter file (not aggregated)', async () => {
      const extraction: MemoryExtraction = {
        chapterNumber: 11,
        newCharacters: [],
        newLocations: [],
        newItems: [],
        newForeshadowings: [],
        newPlotPoints: [{ title: '新章', event: 'c', coolPoint: undefined }],
        characterStateChanges: [],
        collectedForeshadowings: []
      }
      await writer.applyAutomatic(extraction)
      // v4：每个 plot point 是独立文件
      const file = join(dir, '记忆', '剧情点', '第011章 新章.md')
      expect(existsSync(file)).toBe(true)
    })

    it('appends progress summary to 追踪/上下文.md with chapter + summary', async () => {
      // seed 上下文骨架（开书时创建的空进度表）
      mkdirSync(join(dir, '追踪'), { recursive: true })
      writeFileSync(
        join(dir, '追踪', '上下文.md'),
        '# 上下文（日更进度摘要）\n\n| 日期 | 章节 | 进度摘要 | 下一章目标 | 阻塞点 |\n|---|---|---|---|---|\n',
        'utf-8'
      )

      const extraction: MemoryExtraction = {
        chapterNumber: 5,
        newCharacters: [],
        newLocations: [],
        newItems: [],
        newForeshadowings: [],
        newPlotPoints: [
          { title: '初露锋芒', event: '林远击败赵乾', coolPoint: '打脸' }
        ],
        characterStateChanges: [],
        collectedForeshadowings: []
      }
      await writer.applyAutomatic(extraction)

      const raw = readFileSync(join(dir, '追踪', '上下文.md'), 'utf-8')
      // 追加行应含日期、第 5 章、进度摘要
      expect(raw).toContain('第 5 章')
      expect(raw).toContain('初露锋芒：林远击败赵乾')
      // 下一章目标/阻塞点填 -
      expect(raw).toMatch(/\|\s*-\s*\|\s*-\s*\|/)
    })

    it('skips progress append when same chapter already recorded', async () => {
      mkdirSync(join(dir, '追踪'), { recursive: true })
      const file = join(dir, '追踪', '上下文.md')
      writeFileSync(
        file,
        '# 上下文（日更进度摘要）\n\n| 日期 | 章节 | 进度摘要 | 下一章目标 | 阻塞点 |\n|---|---|---|---|---|\n| 2026-01-01 | 第 5 章 | 旧摘要 | - | - |\n',
        'utf-8'
      )

      const extraction: MemoryExtraction = {
        chapterNumber: 5,
        newCharacters: [],
        newLocations: [],
        newItems: [],
        newForeshadowings: [],
        newPlotPoints: [{ title: '新事件', event: 'xxx', coolPoint: undefined }],
        characterStateChanges: [],
        collectedForeshadowings: []
      }
      await writer.applyAutomatic(extraction)

      const raw = readFileSync(file, 'utf-8')
      // 不应重复追加第 5 章行
      const ch5Lines = raw.split(/\r?\n/).filter((l) => l.includes('第 5 章'))
      expect(ch5Lines.length).toBe(1)
      // 仍保留旧摘要
      expect(raw).toContain('旧摘要')
    })

    it('does not crash when 上下文.md is absent', async () => {
      // 不 seed 上下文.md
      const extraction: MemoryExtraction = {
        chapterNumber: 3,
        newCharacters: [],
        newLocations: [],
        newItems: [],
        newForeshadowings: [],
        newPlotPoints: [{ title: '测试', event: '事件', coolPoint: undefined }],
        characterStateChanges: [],
        collectedForeshadowings: []
      }
      const result = await writer.applyAutomatic(extraction)
      // 不应因缺文件报错
      expect(result.errors).toEqual([])
      expect(result.applied.plotPoints).toBe(1)
    })
  })

  describe('applyNewCharacters', () => {
    it('creates new characters in 记忆/人物/<name>.md', async () => {
      const n = await writer.applyNewCharacters([
        { name: '青云子', role: '核心配角', identity: '神秘修士', personality: '高深莫测' }
      ])
      expect(n).toBe(1)
      const repo = new CharacterRepo(dir)
      const list = await repo.list()
      expect(list.find((c) => c.name === '青云子')).toBeDefined()
    })
  })

  describe('applyNewLocations', () => {
    it('creates new locations in 记忆/地点/<name>.md', async () => {
      const n = await writer.applyNewLocations([
        { name: '青云观', category: '门派', notes: '青云子所在' }
      ])
      expect(n).toBe(1)
      const repo = new LocationRepo(dir)
      const list = await repo.list()
      expect(list.find((l) => l.name === '青云观')).toBeDefined()
    })
  })

  describe('applyNewItems', () => {
    it('creates new items in 记忆/道具/<name>.md', async () => {
      const n = await writer.applyNewItems([
        { name: '玄铁剑', category: '兵器', notes: '削铁如泥' }
      ])
      expect(n).toBe(1)
      const repo = new ItemRepo(dir)
      const list = await repo.list()
      const sword = list.find((i) => i.name === '玄铁剑')
      expect(sword).toBeDefined()
      expect(sword?.category).toBe('兵器')
    })
  })

  describe('applyNewForeshadowings', () => {
    it('creates new foreshadowings in 追踪/伏笔.md', async () => {
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
