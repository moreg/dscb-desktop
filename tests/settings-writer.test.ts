import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SettingsWriter, patchesFromWorldLocations } from '../src/main/data/settings-writer'
import type { SettingsPatch } from '../src/shared/types'

describe('SettingsWriter', () => {
  let dir: string
  let writer: SettingsWriter

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aw-sw-'))
    writer = new SettingsWriter(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('appends power-system bullet and logs evolution', async () => {
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
    const raw = readFileSync(join(dir, '设定', '世界观', '力量体系.md'), 'utf-8')
    expect(raw).toContain('暗劲圆满')
    expect(raw).toContain('可短时外放')

    const log = readFileSync(join(dir, '追踪', '设定演进.md'), 'utf-8')
    expect(log).toContain('第 12 章')
    expect(log).toContain('力量体系')
  })

  it('refuses 题材定位 and skips in onlyAuto medium confidence', async () => {
    const patches: SettingsPatch[] = [
      {
        target: 'worldview',
        fileName: '题材定位',
        op: 'append_h2',
        title: '不应写入',
        content: '坏补丁',
        confidence: 'high'
      },
      {
        target: 'worldview',
        fileName: '背景设定',
        op: 'append_h2',
        title: '新史实',
        content: '北洋时期细节',
        confidence: 'medium'
      }
    ]
    const preview = writer.preview(patches)
    expect(preview.diffs[0].note).toMatch(/禁止/)
    expect(preview.autoCount).toBe(0)

    const onlyAuto = await writer.applyPatches(1, patches, { onlyAuto: true })
    expect(onlyAuto.applied).toBe(0)

    const all = await writer.applyPatches(1, patches, { onlyAuto: false })
    expect(all.applied).toBe(1)
    expect(existsSync(join(dir, '设定', '世界观', '背景设定.md'))).toBe(true)
  })

  it('patchesFromWorldLocations only takes scope=world', () => {
    const p = patchesFromWorldLocations([
      { name: '茶馆', notes: '一次性', scope: 'scene' },
      { name: '法租界', notes: '常驻', scope: 'world' }
    ])
    expect(p).toHaveLength(1)
    expect(p[0].title).toBe('法租界')
    expect(p[0].target).toBe('geography')
  })

  it('is idempotent on second apply', async () => {
    const patches: SettingsPatch[] = [
      {
        target: 'faction',
        fileName: '青帮',
        op: 'append_h2',
        title: '码头分舵',
        content: '负责装卸保护费',
        confidence: 'high'
      }
    ]
    await writer.applyPatches(3, patches, { onlyAuto: false })
    const r2 = await writer.applyPatches(3, patches, { onlyAuto: false })
    expect(r2.applied).toBe(0)
    const raw = readFileSync(join(dir, '设定', '势力', '青帮.md'), 'utf-8')
    const count = (raw.match(/码头分舵/g) || []).length
    expect(count).toBeGreaterThanOrEqual(1)
  })

  it('readRecentEvolution returns last entries', async () => {
    mkdirSync(join(dir, '追踪'), { recursive: true })
    writeFileSync(
      join(dir, '追踪', '设定演进.md'),
      `# 设定演进\n\n| 日期 | 章节 | 类型 | 目标文件 | 摘要 | 状态 |\n|---|---|---|---|---|---|\n| 2026-01-01 | 第 1 章 | 增量 | worldview/a | 甲 | 已应用 |\n| 2026-01-02 | 第 2 章 | 增量 | worldview/b | 乙 | 已应用 |\n`,
      'utf-8'
    )
    const entries = await writer.readRecentEvolution(1)
    expect(entries).toHaveLength(1)
    expect(entries[0].summary).toBe('乙')
  })
})
