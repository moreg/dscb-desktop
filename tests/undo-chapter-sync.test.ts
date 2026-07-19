import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MemoryWriter } from '../src/main/data/memory-writer'
import { SettingsWriter } from '../src/main/data/settings-writer'
import type { MemoryExtraction, SettingsPatch } from '../src/shared/types'

function seedCharacter(dir: string, name = '林远'): void {
  mkdirSync(join(dir, '设定', '角色'), { recursive: true })
  mkdirSync(join(dir, '记忆', '人物'), { recursive: true })
  writeFileSync(
    join(dir, '设定', '角色', `${name}.md`),
    `# ${name}\n\n## 基本信息\n\n- **身份**：剑修\n`,
    'utf-8'
  )
}

function seedForeshadowing(dir: string): void {
  mkdirSync(join(dir, '追踪'), { recursive: true })
  writeFileSync(
    join(dir, '追踪', '伏笔.md'),
    `# 伏笔追踪

| 编号 | 内容 | 类型 | 埋设 | 预计回收 | 实际回收 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| FB-001 | 玉佩来历 | 设定 | 第 1 章 | 第 10 章 | 未回收 | 已埋设 |
`,
    'utf-8'
  )
}

describe('MemoryWriter.revertAutomatic', () => {
  let dir: string
  let writer: MemoryWriter

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aw-undo-mw-'))
    writer = new MemoryWriter(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reverts state, plot, context, foreshadow after apply', async () => {
    seedCharacter(dir, '林远')
    seedForeshadowing(dir)

    const extraction: MemoryExtraction = {
      chapterNumber: 5,
      newCharacters: [],
      newLocations: [],
      newItems: [],
      newForeshadowings: [],
      newPlotPoints: [{ title: '初露锋芒', event: '林远击败赵乾', coolPoint: '打脸' }],
      characterStateChanges: [
        { name: '林远', field: '伤势', oldValue: '无', newValue: '轻伤' }
      ],
      collectedForeshadowings: [{ content: '玉佩来历', chapter: 5 }]
    }

    const applied = await writer.applyAutomatic(extraction)
    expect(applied.applied.stateChanges).toBe(1)
    expect(applied.applied.plotPoints).toBe(1)
    expect(applied.applied.collected).toBe(1)

    const plotFile = join(dir, '记忆', '剧情点', '第005章 初露锋芒.md')
    expect(existsSync(plotFile)).toBe(true)
    const ctxAfter = readFileSync(join(dir, '追踪', '上下文.md'), 'utf-8')
    expect(ctxAfter).toContain('第 5 章')
    const fsAfter = readFileSync(join(dir, '追踪', '伏笔.md'), 'utf-8')
    expect(fsAfter).toMatch(/已回收/)

    const undone = await writer.revertAutomatic(extraction, applied.appliedDiffs ?? [])
    expect(undone.reverted.plotPoints).toBe(1)
    expect(undone.reverted.collected).toBe(1)
    expect(undone.reverted.tracking).toBeGreaterThanOrEqual(1)
    expect(existsSync(plotFile)).toBe(false)

    const ctxUndo = readFileSync(join(dir, '追踪', '上下文.md'), 'utf-8')
    expect(ctxUndo).not.toMatch(/\|\s*第\s*5\s*章\s*\|/)

    const fsUndo = readFileSync(join(dir, '追踪', '伏笔.md'), 'utf-8')
    expect(fsUndo).toMatch(/已埋设/)
    expect(fsUndo).not.toMatch(/第 5 章回收|已回收/)
  })
})

describe('SettingsWriter.revertPatches', () => {
  let dir: string
  let writer: SettingsWriter

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aw-undo-sw-'))
    writer = new SettingsWriter(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('removes applied bullet and marks evolution 已撤销', async () => {
    mkdirSync(join(dir, '设定', '世界观'), { recursive: true })
    writeFileSync(
      join(dir, '设定', '世界观', '力量体系.md'),
      '# 力量体系\n\n## 境界\n\n- **明劲**：入门\n',
      'utf-8'
    )

    const patches: SettingsPatch[] = [
      {
        target: 'worldview',
        fileName: '力量体系',
        op: 'append_bullet',
        sectionTitle: '境界',
        title: '暗劲圆满',
        content: '可短时外放',
        reason: '第12章揭晓',
        confidence: 'high'
      }
    ]

    const result = await writer.applyPatches(12, patches, { onlyAuto: true })
    expect(result.applied).toBe(1)
    expect(readFileSync(join(dir, '设定', '世界观', '力量体系.md'), 'utf-8')).toContain(
      '暗劲圆满'
    )

    const undone = await writer.revertPatches(12, result.appliedDiffs)
    expect(undone.reverted).toBe(1)
    const raw = readFileSync(join(dir, '设定', '世界观', '力量体系.md'), 'utf-8')
    expect(raw).not.toContain('暗劲圆满')
    expect(raw).toContain('明劲')

    const log = readFileSync(join(dir, '追踪', '设定演进.md'), 'utf-8')
    expect(log).toContain('已撤销')
  })
})
