import { describe, expect, it } from 'vitest'
import {
  allowLongStoryBrainstormRecoveryWrite, appendLongStoryBrainstormBatch, copyLongStoryBrainstormRecovery,
  emptyLongStoryBrainstormRecovery, LONG_STORY_BRAINSTORM_PREFIX, longStoryBrainstormSourceMatches,
  readLongStoryBrainstormRecovery, releaseActiveLongStoryBrainstormRecovery, toggleLongStoryBrainstormFavorite,
  updateActiveLongStoryBrainstormRecovery, validLongStoryBrainstormBatch, writeLongStoryBrainstormRecovery
} from '../src/renderer/src/long-story-brainstorm-library'
import type { LongBrainstormStorage } from '../src/renderer/src/long-story-brainstorm-library'
import { SHORT_STORY_BRAINSTORM_PREFIX } from '../src/renderer/src/short-story-brainstorm-library'
import type { LongStoryIdea } from '../src/shared/long-story-brainstorm'

function idea(number: number): LongStoryIdea {
  return { title: `方案${number}`, premise: `药师${number}能从废丹中看到炼丹人的记忆`, hook: '宗门废炉里藏着失踪师父的传讯',
    mainLine: '从救回师父到查清丹道垄断的真相', progression: '救治同伴，建立药铺，在各地寻找被抹去的丹方',
    twist: `丹方${number}中藏着可解除血契的配方`, ending: '公开丹方，让更多药师能独立行医' }
}
function memoryStorage(): LongBrainstormStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
}

describe('长篇脑洞库', () => {
  it('相同恢复key与短篇隔离，各作品也分别恢复自己的候选和方向', () => {
    const storage = memoryStorage(); const first = 'long-library-isolation'; const second = 'long-library-other'
    const recovery = appendLongStoryBrainstormBatch({ ...emptyLongStoryBrainstormRecovery(), direction: '废丹记忆', requirements: '慢热成长' }, [idea(1)], '条件', '时间', '批次')
    storage.setItem(SHORT_STORY_BRAINSTORM_PREFIX + first, '短篇原记录')
    expect(writeLongStoryBrainstormRecovery(first, recovery, storage)).toBe(true)
    expect(readLongStoryBrainstormRecovery(first, storage).recovery).toEqual(recovery)
    expect(readLongStoryBrainstormRecovery(second, storage).found).toBe(false)
    expect(storage.getItem(SHORT_STORY_BRAINSTORM_PREFIX + first)).toBe('短篇原记录')
    expect(LONG_STORY_BRAINSTORM_PREFIX).not.toBe(SHORT_STORY_BRAINSTORM_PREFIX)
  })

  it('保留最近5批完整方案和最近30个去重指纹，失败结果不能覆盖旧候选', () => {
    let recovery = emptyLongStoryBrainstormRecovery()
    for (let index = 0; index < 12; index++) recovery = appendLongStoryBrainstormBatch(recovery, [idea(index * 3), idea(index * 3 + 1), idea(index * 3 + 2)], `条件${index}`, `2026-10-${String(index + 1).padStart(2, '0')}`, `batch-${index}`)
    expect(recovery.batches.map(batch => batch.id)).toEqual(['batch-11', 'batch-10', 'batch-9', 'batch-8', 'batch-7'])
    expect(recovery.batches[4].ideas[0].mainLine).toBe(idea(21).mainLine)
    expect(recovery.batches[4].source).toBe('条件7')
    expect(recovery.batches[4].createdAt).toBe('2026-10-08')
    expect(recovery.previousIdeas).toHaveLength(30)
    expect(recovery.previousIdeas[0].title).toBe('方案6')
    expect(appendLongStoryBrainstormBatch(recovery, [{ ...idea(36), progression: '' }], '', '', 'invalid')).toBe(recovery)
    expect(validLongStoryBrainstormBatch([])).toBe(false)
    expect(validLongStoryBrainstormBatch([idea(1), idea(2), idea(3), idea(4)])).toBe(false)
  })

  it('最多收藏30个方案且可取消，主线或成长路线不同的同标题方案独立收藏', () => {
    let recovery = emptyLongStoryBrainstormRecovery()
    for (let index = 0; index < 30; index++) recovery = toggleLongStoryBrainstormFavorite(recovery, idea(index), '条件', '时间').recovery
    const overflow = toggleLongStoryBrainstormFavorite(recovery, idea(31), '', '')
    expect(overflow.error).toContain('最多收藏 30')
    expect(overflow.recovery).toBe(recovery)
    recovery = toggleLongStoryBrainstormFavorite(recovery, idea(0), '', '').recovery
    expect(recovery.favorites).toHaveLength(29)
    recovery = toggleLongStoryBrainstormFavorite(recovery, { ...idea(1), progression: '先经营药铺，再组织同行打破药材垄断' }, '', '').recovery
    expect(recovery.favorites.filter(item => item.idea.title === '方案1')).toHaveLength(2)
  })

  it('恢复中断流及已经收到的文本，损坏内容恢复有效部分但不自动覆盖原记录', () => {
    const storage = memoryStorage(); const key = 'long-library-interrupted'
    const saved = { ...appendLongStoryBrainstormBatch(emptyLongStoryBrainstormRecovery(), [idea(1)], '条件', '时间', '批次'), status: 'generating', raw: '模型已收到的一半文本' }
    storage.setItem(LONG_STORY_BRAINSTORM_PREFIX + key, JSON.stringify(saved))
    const loaded = readLongStoryBrainstormRecovery(key, storage)
    expect(loaded.corrupt).toBe(false)
    expect(loaded.recovery.status).toBe('stopped')
    expect(loaded.recovery.raw).toBe(saved.raw)
    expect(loaded.recovery.ideas).toEqual([idea(1)])

    const badKey = 'long-library-partial-corrupt'
    const raw = JSON.stringify({ ...saved, ideas: [idea(1), { ...idea(2), mainLine: '' }] })
    storage.setItem(LONG_STORY_BRAINSTORM_PREFIX + badKey, raw)
    const partial = readLongStoryBrainstormRecovery(badKey, storage)
    expect(partial.corrupt).toBe(true)
    expect(partial.recovery.ideas).toEqual([idea(1)])
    expect(partial.recovery.raw).toBe(saved.raw)
    expect(writeLongStoryBrainstormRecovery(badKey, partial.recovery, storage)).toBe(false)
    expect(storage.getItem(LONG_STORY_BRAINSTORM_PREFIX + badKey)).toBe(raw)
    allowLongStoryBrainstormRecoveryWrite(badKey)
    expect(writeLongStoryBrainstormRecovery(badKey, { ...partial.recovery, direction: '用户重新编辑' }, storage)).toBe(true)
  })

  it('无法读取或完全损坏时不自动清除恢复记录，写入失败也保留已有记录', () => {
    const storage = memoryStorage(); const key = 'long-library-bad-json'
    storage.setItem(LONG_STORY_BRAINSTORM_PREFIX + key, '{坏记录')
    const result = readLongStoryBrainstormRecovery(key, storage)
    expect(result.warning).toContain('原记录保留')
    expect(writeLongStoryBrainstormRecovery(key, result.recovery, storage)).toBe(false)
    expect(storage.getItem(LONG_STORY_BRAINSTORM_PREFIX + key)).toBe('{坏记录')
    const readFailure: LongBrainstormStorage = { ...storage, getItem: () => { throw new Error('读取失败') } }
    expect(readLongStoryBrainstormRecovery('long-library-read-failure', readFailure).corrupt).toBe(true)
    expect(writeLongStoryBrainstormRecovery('long-library-read-failure', emptyLongStoryBrainstormRecovery(), storage)).toBe(false)
    allowLongStoryBrainstormRecoveryWrite(key)
    const quota: LongBrainstormStorage = { ...storage, setItem: () => { throw new Error('QuotaExceededError') } }
    expect(writeLongStoryBrainstormRecovery(key, { ...emptyLongStoryBrainstormRecovery(), direction: '新方向' }, quota)).toBe(false)
    expect(storage.getItem(LONG_STORY_BRAINSTORM_PREFIX + key)).toBe('{坏记录')
  })

  it('空字符串也是损坏记录，恢复与复制都不能将它当作不存在并覆盖', () => {
    const storage = memoryStorage(); const key = 'long-library-empty-corrupt'
    storage.setItem(LONG_STORY_BRAINSTORM_PREFIX + key, '')
    const loaded = readLongStoryBrainstormRecovery(key, storage)
    expect(loaded).toMatchObject({ found: true, corrupt: true })
    expect(writeLongStoryBrainstormRecovery(key, loaded.recovery, storage)).toBe(false)
    expect(copyLongStoryBrainstormRecovery(key, 'long-library-empty-corrupt-target', storage)).toBe(false)
    expect(storage.getItem(LONG_STORY_BRAINSTORM_PREFIX + key)).toBe('')
    const source = 'long-library-empty-target-source'
    writeLongStoryBrainstormRecovery(source, { ...emptyLongStoryBrainstormRecovery(), direction: '新方向' }, storage)
    const destination = 'long-library-empty-target'
    storage.setItem(LONG_STORY_BRAINSTORM_PREFIX + destination, '')
    expect(copyLongStoryBrainstormRecovery(source, destination, storage)).toBe(false)
    expect(storage.getItem(LONG_STORY_BRAINSTORM_PREFIX + destination)).toBe('')
  })

  it('超过收藏容量的原记录属于损坏记录，恢复时不自动丢掉第31个收藏', () => {
    const storage = memoryStorage(); const key = 'long-library-too-many-favorites'
    const raw = JSON.stringify({ ...emptyLongStoryBrainstormRecovery(), favorites: Array.from({ length: 31 }, (_, index) => ({ idea: idea(index), source: '', createdAt: '' })) })
    storage.setItem(LONG_STORY_BRAINSTORM_PREFIX + key, raw)
    const loaded = readLongStoryBrainstormRecovery(key, storage)
    expect(loaded.corrupt).toBe(true)
    expect(loaded.recovery.favorites).toHaveLength(30)
    expect(writeLongStoryBrainstormRecovery(key, loaded.recovery, storage)).toBe(false)
    expect(copyLongStoryBrainstormRecovery(key, 'long-library-too-many-copy', storage)).toBe(false)
    expect(storage.getItem(LONG_STORY_BRAINSTORM_PREFIX + key)).toBe(raw)
  })

  it('采用产生的梗概变化无需提示条件过期，用户手改或修改章数仍提示过期', () => {
    const before = { genre: '玄幻', direction: '药师', requirements: '慢热', targetChapters: 200, brief: '' }
    const after = { ...before, brief: '已采用的故事设定' }
    expect(longStoryBrainstormSourceMatches(JSON.stringify(before), JSON.stringify(after), after.brief)).toBe(true)
    expect(longStoryBrainstormSourceMatches(JSON.stringify(before), JSON.stringify({ ...after, targetChapters: 300 }), after.brief)).toBe(false)
    expect(longStoryBrainstormSourceMatches(JSON.stringify(before), JSON.stringify({ ...after, brief: '作者再编辑' }), after.brief)).toBe(false)
  })

  it('新建后复制最新活动快照到作品，保留新建库；损坏目标或复制失败不丢源', () => {
    const storage = memoryStorage(); const from = 'long-library-new'; const to = 'long-library-project'
    const recovery = appendLongStoryBrainstormBatch(emptyLongStoryBrainstormRecovery(), [idea(1)], '条件', '时间', '批次')
    writeLongStoryBrainstormRecovery(from, recovery, storage)
    updateActiveLongStoryBrainstormRecovery(from, { ...recovery, direction: '尚未写入的方向' })
    expect(copyLongStoryBrainstormRecovery(from, to, storage)).toBe(true)
    expect(readLongStoryBrainstormRecovery(to, storage).recovery.direction).toBe('尚未写入的方向')
    expect(storage.getItem(LONG_STORY_BRAINSTORM_PREFIX + from)).not.toBeNull()
    storage.setItem(LONG_STORY_BRAINSTORM_PREFIX + 'long-library-damaged-target', '{坏目标')
    expect(copyLongStoryBrainstormRecovery(from, 'long-library-damaged-target', storage)).toBe(false)
    expect(storage.getItem(LONG_STORY_BRAINSTORM_PREFIX + 'long-library-damaged-target')).toBe('{坏目标')
    const quota: LongBrainstormStorage = { ...storage, setItem: () => { throw new Error('空间已满') } }
    expect(copyLongStoryBrainstormRecovery(from, 'long-library-quota-target', quota)).toBe(false)
    expect(storage.getItem(LONG_STORY_BRAINSTORM_PREFIX + from)).not.toBeNull()
    releaseActiveLongStoryBrainstormRecovery(from)
  })

  it('未用脑洞的新建入口不要求存储空间，复制合并收藏溢出时保持两边', () => {
    const storage = memoryStorage()
    updateActiveLongStoryBrainstormRecovery('long-library-unused', emptyLongStoryBrainstormRecovery())
    const quota: LongBrainstormStorage = { ...storage, setItem: () => { throw new Error('空间已满') } }
    expect(copyLongStoryBrainstormRecovery('long-library-unused', 'long-library-unused-project', quota)).toBe(true)
    releaseActiveLongStoryBrainstormRecovery('long-library-unused')
    let first = emptyLongStoryBrainstormRecovery(); let second = emptyLongStoryBrainstormRecovery()
    for (let index = 0; index < 20; index++) first = toggleLongStoryBrainstormFavorite(first, idea(index), '', '').recovery
    for (let index = 20; index < 40; index++) second = toggleLongStoryBrainstormFavorite(second, idea(index), '', '').recovery
    writeLongStoryBrainstormRecovery('long-library-merge-from', first, storage)
    writeLongStoryBrainstormRecovery('long-library-merge-to', second, storage)
    expect(copyLongStoryBrainstormRecovery('long-library-merge-from', 'long-library-merge-to', storage)).toBe(false)
    expect(readLongStoryBrainstormRecovery('long-library-merge-from', storage).recovery.favorites).toHaveLength(20)
    expect(readLongStoryBrainstormRecovery('long-library-merge-to', storage).recovery.favorites).toHaveLength(20)
  })
})
