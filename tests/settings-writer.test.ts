import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SettingsWriter, patchesFromWorldLocations } from '../src/main/data/settings-writer'
import { SettingsMdRepo } from '../src/main/data/skill-format/settings-md-repo'
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
    expect(raw).toMatch(/<!-- aw-settings-patch chapter=12 id=[a-f0-9]{16} checksum=[a-f0-9]{16} -->/)
    expect(raw.indexOf('## 境界')).toBeLessThan(raw.indexOf('<!-- aw-settings-patch'))

    const log = readFileSync(join(dir, '追踪', '设定演进.md'), 'utf-8')
    expect(log).toContain('第 12 章')
    expect(log).toContain('力量体系')
  })

  it('refuses 题材定位 (with or without .md) and skips onlyAuto medium', async () => {
    const patches: SettingsPatch[] = [
      {
        target: 'worldview',
        fileName: '题材定位.md',
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
    expect(preview.diffs[0].fileName).toBe('题材定位')
    expect(preview.diffs[0].note).toMatch(/禁止/)
    expect(preview.autoCount).toBe(0)

    const onlyAuto = await writer.applyPatches(1, patches, { onlyAuto: true })
    expect(onlyAuto.applied).toBe(0)

    const all = await writer.applyPatches(1, patches, { onlyAuto: false })
    expect(all.applied).toBe(1)
    expect(existsSync(join(dir, '设定', '世界观', '背景设定.md'))).toBe(true)
    // 禁止文件不应被创建为 题材定位.md.md
    expect(existsSync(join(dir, '设定', '世界观', '题材定位.md'))).toBe(false)
    expect(existsSync(join(dir, '设定', '世界观', '题材定位.md.md'))).toBe(false)
  })

  it('writes real chapter number into geography table', async () => {
    const patches: SettingsPatch[] = [
      {
        target: 'geography',
        fileName: '地理',
        op: 'append_bullet',
        title: '法租界',
        content: '天津常驻',
        confidence: 'high'
      }
    ]
    await writer.applyPatches(9, patches, { onlyAuto: false })
    const raw = readFileSync(join(dir, '设定', '世界观', '地理.md'), 'utf-8')
    expect(raw).toContain('法租界')
    expect(raw).toContain('第 9 章')
    expect(raw).not.toContain('第?章')
    // 幂等：再写一次不重复行
    await writer.applyPatches(9, patches, { onlyAuto: false })
    const raw2 = readFileSync(join(dir, '设定', '世界观', '地理.md'), 'utf-8')
    expect((raw2.match(/法租界/g) || []).length).toBe(1)
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

  it('撤销只删除该章标记内的补丁，保留既有作者标题和内容', async () => {
    const file = join(dir, '设定', '世界观', '力量体系.md')
    mkdirSync(join(dir, '设定', '世界观'), { recursive: true })
    const baseline = '# 力量体系\n\n## 境界\n\n- **明劲**：作者事先规划的基础能力。\n'
    writeFileSync(file, baseline)
    const result = await writer.applyPatches(12, [{ target: 'worldview', fileName: '力量体系', op: 'append_bullet', sectionTitle: '境界', title: '暗劲', content: '本章首次掌握隔物发力。' }])
    const wrongChapter = await writer.revertPatches(11, result.appliedDiffs)
    expect(wrongChapter.reverted).toBe(0)
    const reverted = await writer.revertPatches(12, result.appliedDiffs)
    expect(reverted.reverted).toBe(1)
    expect(readFileSync(file, 'utf-8').trim()).toBe(baseline.trim())
    expect(await writer.revertPatches(12, result.appliedDiffs)).toEqual({ reverted: 0, errors: [] })
  })

  it('补丁被作者修改后拒绝自动撤销，缺少来源标记的旧内容也不猜删', async () => {
    const content = '本章确认青帮负责码头收费。'
    const result = await writer.applyPatches(3, [{ target: 'faction', fileName: '青帮', op: 'append_h2', title: '码头', content }])
    const file = join(dir, '设定', '势力', '青帮.md')
    writeFileSync(file, readFileSync(file, 'utf-8').replace(content, content + '作者补充了收费例外。'))
    const edited = await writer.revertPatches(3, result.appliedDiffs)
    expect(edited.reverted).toBe(0)
    expect(edited.errors[0]).toContain('已被编辑')
    expect(readFileSync(file, 'utf-8')).toContain('作者补充了收费例外')
    const oldBaseline = `# 青帮\n\n## 码头\n${content}\n`
    writeFileSync(file, oldBaseline)
    expect((await writer.revertPatches(3, result.appliedDiffs)).reverted).toBe(0)
    expect(readFileSync(file, 'utf-8')).toBe(oldBaseline)
  })

  it('在已有节补写时不会插入到下一个未来补丁标记内部', async () => {
    mkdirSync(join(dir, '设定', '世界观'), { recursive: true })
    const file = join(dir, '设定', '世界观', '金手指.md')
    writeFileSync(file, '# 金手指\n\n## 起始功能\n作者规定只能辨认方向。\n')
    const future = await writer.applyPatches(12, [{ target: 'worldview', fileName: '金手指', op: 'append_h2', title: '隔空取物', content: '第十二章取得遥控物体的能力。' }])
    const earlier = await writer.applyPatches(3, [{ target: 'worldview', fileName: '金手指', op: 'append_bullet', sectionTitle: '起始功能', title: '辨距', content: '第三章开始可以判断物体距离。' }])
    const beforeFourth = await new SettingsMdRepo(dir).read(4)
    expect(beforeFourth!.worldview[0].body).toContain('判断物体距离')
    expect(beforeFourth!.worldview[0].body).not.toContain('隔空取物')
    // 后续插入没有改变未来块校验值；分别撤销都能精确定位。
    expect((await writer.revertPatches(12, future.appliedDiffs)).reverted).toBe(1)
    expect((await writer.revertPatches(3, earlier.appliedDiffs)).reverted).toBe(1)
    expect(readFileSync(file, 'utf-8').trim()).toBe('# 金手指\n\n## 起始功能\n作者规定只能辨认方向。')
  })
})
