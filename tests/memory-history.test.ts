import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { MemoryWriter } from '../src/main/data/memory-writer'
import { TrackingMdRepo } from '../src/main/data/skill-format/tracking-md-repo'
import { PlotPointRepo } from '../src/main/data/memory/plot-point-repo'
import { CharacterRepo } from '../src/main/data/memory/character-repo'
import type { MemoryExtraction } from '../src/shared/types'

function extraction(chapter: number, field: string, value: string): MemoryExtraction {
  return { chapterNumber: chapter, newCharacters: [], newLocations: [], newItems: [], newForeshadowings: [], newPlotPoints: [], collectedForeshadowings: [],
    characterStateChanges: value ? [{ name: '林远', field, oldValue: '', newValue: value }] : [] }
}

describe('automatic history remains recoverable', () => {
  let dir: string
  const original = `# 角色状态

> 作者备注：不许删除这段伏笔安排。

## 当前状态（第1章）
| 角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 更新章节 |
|---|---|---|---|---|---|---|
| 林远 | 炼气 | 中立 | 找药 | 玉佩 | 朋友 | 第1章 |
`
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-memory-history-'))
    await mkdir(join(dir, '追踪'), { recursive: true })
    await writeFile(join(dir, '追踪', '角色状态.md'), original)
  })

  it('retains prior chapters and untouched author content when later states are synchronized', async () => {
    const writer = new MemoryWriter(dir)
    await writer.applyAutomatic(extraction(5, '实力', '筑基'))
    await writer.applyAutomatic(extraction(10, '目标', '离开山门'))
    const repo = new TrackingMdRepo(dir)
    expect((await repo.read(2))!.characterStates[0]).toMatchObject({ power: '炼气', goal: '找药' })
    expect((await repo.read(6))!.characterStates[0]).toMatchObject({ power: '筑基', goal: '找药' })
    expect((await repo.read(11))!.characterStates[0]).toMatchObject({ power: '筑基', goal: '离开山门' })
    expect(await readFile(join(dir, '追踪', '角色状态.md'), 'utf8')).toContain(original.trimEnd())
  })

  it('replaces a rewritten chapter instead of accumulating old values, and can clear its automatic changes', async () => {
    const writer = new MemoryWriter(dir)
    await writer.applyAutomatic(extraction(5, '实力', '天帝境'))
    await writer.applyAutomatic(extraction(5, '实力', '筑基'))
    const repo = new TrackingMdRepo(dir)
    let current = await repo.read(6)
    expect(current!.characterStates[0].power).toBe('筑基')
    expect(current!.stateChanges.some((c) => c.change.includes('天帝境'))).toBe(false)
    expect((await readFile(join(dir, '追踪', '角色状态.md'), 'utf8')).match(/writer-state-history:5:start/g)).toHaveLength(1)
    await writer.applyAutomatic(extraction(5, '实力', ''))
    current = await repo.read(6)
    expect(current!.characterStates[0].power).toBe('炼气')
    expect(current!.stateChanges).toEqual([])
  })

  it('binds a new plot summary only to explicitly supplied extraction source content', async () => {
    const prose = '林远在密室找到了母亲。'
    await mkdir(join(dir, '正文'), { recursive: true })
    await writeFile(join(dir, '正文', '005.md'), prose)
    const data = extraction(5, '', '')
    data.newPlotPoints = [{ title: '重逢', event: '成功找到母亲。' }]
    await new MemoryWriter(dir).applyAutomatic(data, { sourceContent: prose })
    expect((await new PlotPointRepo(dir).listSummariesBefore(6))[0]).toMatchObject({ source: 'memory', verified: true, summary: '成功找到母亲。' })
    await writeFile(join(dir, '正文', '005.md'), '林远打开了空无一人的密室。')
    expect((await new PlotPointRepo(dir).listSummariesBefore(6))[0].source).toBe('prose_excerpt')
  })

  it('replays later deltas after an early item acquisition is removed without losing later explicit changes', async () => {
    const writer = new MemoryWriter(dir)
    await writer.applyAutomatic(extraction(5, '持有物', '铜钥匙'))
    await writer.applyAutomatic(extraction(10, '目标', '离开山门'))
    await writer.applyAutomatic(extraction(20, '实力', '元婴'))
    await writer.applyAutomatic(extraction(5, '', ''))
    const current = (await new TrackingMdRepo(dir).read(21))!.characterStates[0]
    expect(current).toMatchObject({ items: '玉佩', goal: '离开山门', power: '元婴' })
    expect(await readFile(join(dir, '追踪', '角色状态.md'), 'utf8')).not.toContain('铜钥匙')
    expect(await readFile(join(dir, '追踪', '角色状态.md'), 'utf8')).toContain(original.trimEnd())
  })

  it('rebuilds current character cards and their trajectory while preserving an author edit', async () => {
    const repo = new CharacterRepo(dir)
    const character = await repo.create({ name: '林远', identity: '外门弟子', personality: '温和' })
    const writer = new MemoryWriter(dir)
    await writer.applyAutomatic(extraction(5, '身份', '真传弟子'))
    await writer.applyAutomatic(extraction(10, '性格', '果断'))
    await writer.applyAutomatic(extraction(5, '', ''))
    let current = (await repo.get(character.id))!
    expect(current).toMatchObject({ identity: '外门弟子', personality: '果断' })
    expect(current.customFields?.['状态轨迹']).not.toContain('真传弟子')
    expect(current.customFields?.['状态轨迹']).toContain('第10章 性格：果断')
    await repo.update(character.id, { personality: '作者修订的谨慎性格' })
    await writer.applyAutomatic(extraction(10, '', ''))
    current = (await repo.get(character.id))!
    expect(current.personality).toBe('作者修订的谨慎性格')
  })

  it('keeps personality, identity and role on their historical chapters instead of the power column', async () => {
    const writer = new MemoryWriter(dir)
    const data = extraction(5, '性格', '谨慎')
    data.characterStateChanges.push({ name: '林远', field: '身份', oldValue: '', newValue: '真传弟子' }, { name: '林远', field: '角色定位', oldValue: '', newValue: '宗门继承人' })
    await writer.applyAutomatic(data)
    await writer.applyAutomatic(extraction(10, '性格', '冷酷'))
    const repo = new TrackingMdRepo(dir)
    expect((await repo.read(6))!.characterStates[0]).toMatchObject({ power: '炼气', personality: '谨慎', identity: '真传弟子', role: '宗门继承人' })
    expect((await repo.read(11))!.characterStates[0].personality).toBe('冷酷')
    await writer.applyAutomatic(extraction(10, '', ''))
    expect((await repo.read(11))!.characterStates[0].personality).toBe('谨慎')
  })

  it('protects an author-edited automatic history block with its checksum', async () => {
    const writer = new MemoryWriter(dir)
    await writer.applyAutomatic(extraction(5, '实力', '筑基'))
    const file = join(dir, '追踪', '角色状态.md')
    const edited = (await readFile(file, 'utf8')).replace('林远 | 筑基', '林远 | 作者核定金丹')
    await writeFile(file, edited)
    const result = await writer.applyAutomatic(extraction(5, '实力', '炼气'))
    expect(await readFile(file, 'utf8')).toBe(edited)
    expect(result.errors).toContainEqual(expect.stringContaining('已被人工编辑'))
  })

  it('clears only owned timeline events on an empty extraction, preserving same-chapter author records', async () => {
    const file = join(dir, '追踪', '时间线.md')
    const authorRow = '| 第 5 章 | 作者确认事件 | - | - | 手写事实保留 |'
    await writeFile(file, '# 时间线\n\n| 章节 | 事件名 | 时间跨度 | 涉及角色 | 详细描述 |\n|---|---|---|---|---|\n' + authorRow + '\n')
    const writer = new MemoryWriter(dir)
    const data = extraction(5, '', '')
    data.newPlotPoints = [{ title: '获赠', event: '获得铜钥匙' }]
    await writer.applyAutomatic(data)
    await writer.applyAutomatic(extraction(8, '目标', '开门'))
    await writer.applyAutomatic(extraction(5, '', ''))
    const raw = await readFile(file, 'utf8')
    expect(raw).toContain(authorRow)
    expect(raw).not.toContain('获得铜钥匙')
    expect((await new TrackingMdRepo(dir).read(9))!.recentProgress.filter((p) => p.chapter.includes('5'))).toHaveLength(1)
  })

  it('refreshes unchanged automatic plot summaries and removes renamed or empty obsolete summaries', async () => {
    const writer = new MemoryWriter(dir)
    const data = extraction(5, '', '')
    data.newPlotPoints = [{ title: '重逢', event: '找到母亲。' }]
    await writer.applyAutomatic(data, { sourceContent: '林远找到了母亲。' })
    data.newPlotPoints = [{ title: '重逢', event: '密室里没有母亲。' }]
    await writer.applyAutomatic(data, { sourceContent: '林远只找到空密室。' })
    const plots = join(dir, '记忆', '剧情点')
    const same = await readFile(join(plots, '第005章 重逢.md'), 'utf8')
    expect(same).toContain('密室里没有母亲。')
    expect(same).not.toContain('找到母亲。')
    data.newPlotPoints = [{ title: '空室', event: '屋内空无一人。' }]
    await writer.applyAutomatic(data, { sourceContent: '林远只找到空密室。' })
    expect(await readdir(plots)).toEqual(['第005章 空室.md'])
    await writer.applyAutomatic(extraction(5, '', ''))
    expect(await readdir(plots)).toEqual([])
  })

  it('preserves manually edited and unowned plot summaries during re-sync and undo', async () => {
    const writer = new MemoryWriter(dir)
    const data = extraction(5, '', '')
    data.newPlotPoints = [{ title: '重逢', event: '找到母亲。' }]
    const applied = await writer.applyAutomatic(data)
    const file = join(dir, '记忆', '剧情点', '第005章 重逢.md')
    const edited = (await readFile(file, 'utf8')) + '\n作者补记：此处是假扮的母亲。\n'
    await writeFile(file, edited)
    await writer.applyAutomatic(extraction(5, '', ''))
    await writer.revertAutomatic(data, applied.appliedDiffs)
    expect(await readFile(file, 'utf8')).toBe(edited)
    const unowned = '# 第5章 重逢\n\n作者旧笔记\n'
    await writeFile(file, unowned)
    await writer.applyAutomatic(data)
    await writer.revertAutomatic(data, [])
    expect(await readFile(file, 'utf8')).toBe(unowned)
  })

  it('migrates exact legacy managed snapshots and replays their deltas after an earlier rewrite', async () => {
    const file = join(dir, '追踪', '角色状态.md')
    const legacy = (chapter: number, power: string, goal: string, field: string, value: string) => `<!-- writer-state-history:${chapter}:start -->
## 自动历史快照（第 ${chapter} 章）

| 角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 更新章节 |
|---|---|---|---|---|---|---|
| 林远 | ${power} | 中立 | ${goal} | 玉佩 | 朋友 | 第 ${chapter} 章 |

## 自动状态变更（第 ${chapter} 章）

| 章节 | 角色 | 变更内容 |
|---|---|---|
| 第 ${chapter} 章 | 林远 | ${field}：${value} |

<!-- writer-state-history:${chapter}:end -->`
    await writeFile(file, original + '\n' + legacy(5, '筑基', '找药', '实力', '筑基') + '\n\n' + legacy(10, '筑基', '离开山门', '目标', '离开山门'))
    const result = await new MemoryWriter(dir).applyAutomatic(extraction(5, '', ''))
    expect(result.errors).toEqual([])
    expect((await new TrackingMdRepo(dir).read(11))!.characterStates[0]).toMatchObject({ power: '炼气', goal: '离开山门' })
    expect(await readFile(file, 'utf8')).toContain('writer-state-checksum:')
  })

  it('updates the owned progress row in place and protects edits to timeline rows', async () => {
    const writer = new MemoryWriter(dir)
    const data = extraction(5, '', '')
    data.newPlotPoints = [{ title: '旧事件', event: '获得铜钥匙' }]
    await writer.applyAutomatic(data)
    data.newPlotPoints = [{ title: '新事件', event: '发现空箱子' }]
    await writer.applyAutomatic(data)
    const context = (await new TrackingMdRepo(dir).read(6))!
    expect(context.recentProgress).toHaveLength(1)
    expect(context.recentProgress[0].summary).toBe('新事件：发现空箱子')
    expect(context.timeline).not.toContain('writer-tracking:')
    const file = join(dir, '追踪', '时间线.md')
    const edited = (await readFile(file, 'utf8')).replace('发现空箱子', '作者修订事件')
    await writeFile(file, edited)
    await writer.applyAutomatic(extraction(5, '', ''))
    expect(await readFile(file, 'utf8')).toBe(edited)
  })

  it('migrates legacy card ownership using its old trail, restoring proven history or unknown values', async () => {
    const repo = new CharacterRepo(dir)
    const character = await repo.create({ name: '林远', identity: '外门弟子' })
    const writer = new MemoryWriter(dir)
    const data = extraction(5, '持有物', '铜钥匙')
    data.characterStateChanges.push({ name: '林远', field: '身份', oldValue: '外门弟子', newValue: '真传弟子' })
    await writer.applyAutomatic(data)
    // Simulate a pre-ledger installation: only automatic snapshots and the old unversioned trail exist.
    await unlink(join(dir, '追踪', '.automatic-state-ledger.json'))
    await repo.update(character.id, { customFields: { 状态轨迹: '持有物：铜钥匙；身份：真传弟子' } })
    await writer.applyAutomatic(extraction(5, '', ''))
    const current = (await repo.get(character.id))!
    expect(current.customFields?.['持有物']).toBe('玉佩')
    expect(current.identity || '').toBe('')
    expect(current.customFields?.['状态轨迹'] || '').not.toContain('铜钥匙')
    expect(current.customFields?.['状态轨迹'] || '').not.toContain('真传弟子')
  })

  it('invalidates dependent author-edited derived snapshots without deleting their text', async () => {
    const writer = new MemoryWriter(dir)
    await writer.applyAutomatic(extraction(5, '持有物', '铜钥匙'))
    await writer.applyAutomatic(extraction(10, '目标', '离开山门'))
    const file = join(dir, '追踪', '角色状态.md')
    await writeFile(file, (await readFile(file, 'utf8')).replace('林远 | 炼气 | 中立 | 离开山门', '林远 | 炼气 | 中立 | 作者修订目标'))
    const result = await writer.applyAutomatic(extraction(5, '', ''))
    expect(result.errors).toContainEqual(expect.stringContaining('已标记待核对'))
    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('作者修订目标')
    expect(raw).toContain('铜钥匙')
    const context = (await new TrackingMdRepo(dir).read(11))!
    expect(context.characterStates[0].items).toBe('玉佩')
    expect(context.stateChanges).toEqual([])
    expect((await new TrackingMdRepo(dir).readForDisplay())!.characterStates[0].goal).toBe('作者修订目标')
  })

  it('rejects malformed extraction before changing previously saved memory', async () => {
    const writer = new MemoryWriter(dir)
    const data = extraction(5, '持有物', '铜钥匙')
    data.newPlotPoints = [{ title: '获赠', event: '获得铜钥匙' }]
    await writer.applyAutomatic(data)
    const before = await readFile(join(dir, '追踪', '角色状态.md'), 'utf8')
    await expect(writer.applyAutomatic({ ...extraction(5, '', ''), parseError: '缺少必填数组' })).rejects.toThrow('未写入或清理历史')
    expect(await readFile(join(dir, '追踪', '角色状态.md'), 'utf8')).toBe(before)
    expect(await readFile(join(dir, '记忆', '剧情点', '第005章 获赠.md'), 'utf8')).toContain('获得铜钥匙')
  })
})
