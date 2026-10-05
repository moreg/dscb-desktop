import { describe, expect, it } from 'vitest'
import {
  allowShortStoryBrainstormRecoveryWrite, appendShortStoryBrainstormBatch, emptyShortStoryBrainstormRecovery,
  isValidShortStoryRewrite, readShortStoryBrainstormRecovery, releaseActiveShortStoryBrainstormRecovery,
  SHORT_STORY_BRAINSTORM_PREFIX, shortStoryBrainstormSourceMatches, toggleShortStoryBrainstormFavorite,
  transferShortStoryBrainstormRecovery, updateActiveShortStoryBrainstormRecovery, validShortStoryBrainstormBatch,
  writeShortStoryBrainstormRecovery
} from '../src/renderer/src/short-story-brainstorm-library'
import type { BrainstormStorage } from '../src/renderer/src/short-story-brainstorm-library'
import type { ShortStoryIdea } from '../src/shared/short-story'

function idea(number: number): ShortStoryIdea {
  return { title: `方案${number}`, premise: `主角${number}要找回遗失的一天`, hook: '门外有人报出了他的死亡时间', twist: `线索${number}由未来的自己留下`, ending: '主角选择公开证据，救回失踪的人' }
}
function memoryStorage(): BrainstormStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
}

describe('short story brainstorm library', () => {
  it('保留最近5批完整方案、时间和来源，同时独立保留最近30个完整去重指纹', () => {
    let recovery = emptyShortStoryBrainstormRecovery()
    for (let index = 0; index < 12; index++) recovery = appendShortStoryBrainstormBatch(recovery, [idea(index * 3), idea(index * 3 + 1), idea(index * 3 + 2)], `条件${index}`, `2026-10-${String(index + 1).padStart(2, '0')}`, `batch-${index}`)
    expect(recovery.batches.map(batch => batch.id)).toEqual(['batch-11', 'batch-10', 'batch-9', 'batch-8', 'batch-7'])
    expect(recovery.batches[4].ideas[0].ending).toBe(idea(21).ending)
    expect(recovery.batches[4].source).toBe('条件7')
    expect(recovery.batches[4].createdAt).toBe('2026-10-08')
    expect(recovery.previousIdeas).toHaveLength(30)
    expect(recovery.previousIdeas[0].title).toBe('方案6')
    expect(recovery.history).toHaveLength(30)
    expect(recovery.history.every(item => item.length <= 1500)).toBe(true)
  })

  it('允许1—3个完整方案，拒绝无方案或坏字段', () => {
    expect(validShortStoryBrainstormBatch([idea(1)])).toBe(true)
    expect(validShortStoryBrainstormBatch([idea(1), idea(2)])).toBe(true)
    expect(validShortStoryBrainstormBatch([])).toBe(false)
    expect(validShortStoryBrainstormBatch([{ ...idea(1), ending: '' }])).toBe(false)
  })

  it('收藏至多30个，已收藏项可取消，改写版本以完整内容单独收藏', () => {
    let recovery = emptyShortStoryBrainstormRecovery()
    for (let index = 0; index < 30; index++) recovery = toggleShortStoryBrainstormFavorite(recovery, idea(index), '条件', '时间').recovery
    expect(recovery.favorites).toHaveLength(30)
    const overflow = toggleShortStoryBrainstormFavorite(recovery, idea(31), '', '')
    expect(overflow.error).toContain('最多收藏 30')
    expect(overflow.recovery).toBe(recovery)
    recovery = toggleShortStoryBrainstormFavorite(recovery, idea(0), '', '').recovery
    expect(recovery.favorites).toHaveLength(29)
    recovery = toggleShortStoryBrainstormFavorite(recovery, { ...idea(1), ending: '主角选择隐瞒证据，付出自由的代价' }, '', '').recovery
    expect(recovery.favorites).toHaveLength(30)
    expect(recovery.favorites.filter(item => item.idea.title === '方案1')).toHaveLength(2)
  })

  it('按改写重点验证锁定字段，坏改写不得冒充原方案新候选', () => {
    const original = idea(1)
    expect(isValidShortStoryRewrite(original, { ...original, twist: '公平线索指向主角的妹妹' }, 'twist')).toBe(true)
    expect(isValidShortStoryRewrite(original, { ...original, twist: '新反转', ending: '新结局' }, 'twist')).toBe(false)
    expect(isValidShortStoryRewrite(original, { ...original, ending: '新结局' }, 'ending')).toBe(true)
    expect(isValidShortStoryRewrite(original, { ...original, hook: '新开场' }, 'emotion')).toBe(false)
    expect(isValidShortStoryRewrite(original, { ...original, hook: '新开场', ending: '新结局' }, 'custom')).toBe(true)
    expect(isValidShortStoryRewrite(original, idea(2), 'custom')).toBe(false)
  })

  it('成功采用只消除预期梗概变化，其他条件或随后手改梗概仍显示过期', () => {
    const old = { genre: '悬疑', requirements: '', targetWords: 8000, brief: '', direction: '' }
    const adopted = JSON.stringify({ ...old, brief: '已采用的梗概' })
    expect(shortStoryBrainstormSourceMatches(JSON.stringify(old), adopted, '已采用的梗概')).toBe(true)
    expect(shortStoryBrainstormSourceMatches(JSON.stringify(old), JSON.stringify({ ...old, brief: '已采用的梗概', targetWords: 5000 }), '已采用的梗概')).toBe(false)
    expect(shortStoryBrainstormSourceMatches(JSON.stringify(old), JSON.stringify({ ...old, brief: '再次手改' }), '已采用的梗概')).toBe(false)
  })

  it('恢复旧版3方案记录，保留摘要并迁移出可回看完整历史', () => {
    const storage = memoryStorage(); const key = 'legacy-library'
    storage.setItem(SHORT_STORY_BRAINSTORM_PREFIX + key, JSON.stringify({ direction: '调查员', ideas: [idea(1), idea(2), idea(3)], history: ['旧摘要'], raw: '旧原文', source: '旧条件', status: 'generating' }))
    const loaded = readShortStoryBrainstormRecovery(key, storage)
    expect(loaded.corrupt).toBe(false)
    expect(loaded.recovery.status).toBe('stopped')
    expect(loaded.recovery.batches[0].ideas[1].hook).toBe(idea(2).hook)
    expect(loaded.recovery.previousIdeas).toHaveLength(3)
    expect(loaded.recovery.history).toEqual(['旧摘要'])
  })

  it('损坏或读取失败的记录禁止自动回写和迁移，明确用户修改后才允许写', () => {
    const storage = memoryStorage(); const key = 'damaged-library'; const raw = '{坏记录'
    storage.setItem(SHORT_STORY_BRAINSTORM_PREFIX + key, raw)
    const loaded = readShortStoryBrainstormRecovery(key, storage)
    updateActiveShortStoryBrainstormRecovery(key, loaded.recovery)
    expect(loaded.corrupt).toBe(true)
    expect(writeShortStoryBrainstormRecovery(key, loaded.recovery, storage)).toBe(false)
    expect(transferShortStoryBrainstormRecovery(key, 'damaged-target', storage)).toBe(false)
    expect(storage.getItem(SHORT_STORY_BRAINSTORM_PREFIX + key)).toBe(raw)
    allowShortStoryBrainstormRecoveryWrite(key)
    expect(writeShortStoryBrainstormRecovery(key, { ...loaded.recovery, direction: '明确输入新方向' }, storage)).toBe(true)
    releaseActiveShortStoryBrainstormRecovery(key)
    const failureKey = 'read-failure-library'
    const failing: BrainstormStorage = { ...storage, getItem: () => { throw new Error('读被拒绝') } }
    expect(readShortStoryBrainstormRecovery(failureKey, failing).corrupt).toBe(true)
    expect(writeShortStoryBrainstormRecovery(failureKey, emptyShortStoryBrainstormRecovery(), storage)).toBe(false)
  })

  it('迁移使用最新活动快照，成功清源后旧组件cleanup不能重建源记录', () => {
    const storage = memoryStorage(); const from = 'active-source'; const to = 'active-book'
    const saved = appendShortStoryBrainstormBatch(emptyShortStoryBrainstormRecovery(), [idea(1)], '条件', '时间', '批次')
    writeShortStoryBrainstormRecovery(from, saved, storage)
    const active = { ...saved, direction: '尚未等到节流的方向修改' }
    updateActiveShortStoryBrainstormRecovery(from, active)
    expect(transferShortStoryBrainstormRecovery(from, to, storage)).toBe(true)
    expect(storage.getItem(SHORT_STORY_BRAINSTORM_PREFIX + from)).toBeNull()
    expect(readShortStoryBrainstormRecovery(to, storage).recovery.direction).toBe(active.direction)
    expect(writeShortStoryBrainstormRecovery(from, active, storage)).toBe(true)
    expect(storage.getItem(SHORT_STORY_BRAINSTORM_PREFIX + from)).toBeNull()
    readShortStoryBrainstormRecovery(from, storage)
    expect(writeShortStoryBrainstormRecovery(from, { ...emptyShortStoryBrainstormRecovery(), direction: '下一本新作品' }, storage)).toBe(true)
  })

  it('没有使用脑洞的新建表单无需写入目标缓存，即使存储空间已满也能创建', () => {
    const storage = memoryStorage(); const from = 'unused-source'
    updateActiveShortStoryBrainstormRecovery(from, emptyShortStoryBrainstormRecovery())
    const quota: BrainstormStorage = { ...storage, setItem: () => { throw new Error('QuotaExceededError') } }
    expect(transferShortStoryBrainstormRecovery(from, 'unused-book', quota)).toBe(true)
    expect(storage.values.size).toBe(0)
    releaseActiveShortStoryBrainstormRecovery(from)
  })

  it('复制quota失败、目标损坏或源静默删不掉时报告失败并保留源', () => {
    const storage = memoryStorage(); const from = 'quota-source'; const to = 'quota-book'
    const value = appendShortStoryBrainstormBatch(emptyShortStoryBrainstormRecovery(), [idea(1)], '', '', 'b')
    writeShortStoryBrainstormRecovery(from, value, storage)
    const quota: BrainstormStorage = { ...storage, setItem: () => { throw new Error('QuotaExceededError') } }
    expect(transferShortStoryBrainstormRecovery(from, to, quota)).toBe(false)
    expect(storage.getItem(SHORT_STORY_BRAINSTORM_PREFIX + from)).not.toBeNull()
    storage.setItem(SHORT_STORY_BRAINSTORM_PREFIX + to, '{坏目标')
    expect(transferShortStoryBrainstormRecovery(from, to, storage)).toBe(false)
    expect(storage.getItem(SHORT_STORY_BRAINSTORM_PREFIX + to)).toBe('{坏目标')
    storage.removeItem(SHORT_STORY_BRAINSTORM_PREFIX + to)
    const silentDelete: BrainstormStorage = { ...storage, removeItem: () => undefined }
    expect(transferShortStoryBrainstormRecovery(from, to, silentDelete)).toBe(false)
    expect(storage.getItem(SHORT_STORY_BRAINSTORM_PREFIX + from)).not.toBeNull()
  })
})
