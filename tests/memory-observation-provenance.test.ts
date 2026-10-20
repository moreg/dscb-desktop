import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MemoryWriter } from '../src/main/data/memory-writer'
import { CharacterRepo } from '../src/main/data/memory/character-repo'
import { ItemRepo } from '../src/main/data/memory/item-repo'
import { hashProse } from '../src/main/data/memory/prose-memory-index'
import { FIELD_CHAPTERS } from '../src/main/data/memory/observation-provenance'
import { markBatchReviewPending } from '../src/main/data/longform-review-state'
import type { MemoryExtraction } from '../src/shared/types'

const extraction = (chapter: number, changes: MemoryExtraction['characterStateChanges'] = []): MemoryExtraction => ({
  chapterNumber: chapter, newCharacters: [], newLocations: [], newItems: [], newForeshadowings: [],
  newPlotPoints: [], characterStateChanges: changes, collectedForeshadowings: []
})
describe('真实审计回归：实体观察的时效与重复字段', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), 'memory-observation-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it('旧自定义副本不覆盖新标准字段，带章号标签读回后仍可重放及撤回', async () => {
    const repo = new CharacterRepo(dir)
    const c = await repo.create({ name: '陆安', synopsis: '未拆信' })
    await repo.update(c.id, { customFields: { 当前状态: '未拆信' } })
    const writer = new MemoryWriter(dir)
    await writer.applyAutomatic(extraction(4, [{ name: '陆安', field: '当前状态', oldValue: '未拆信', newValue: '已拆信' }]))
    expect((await repo.get(c.id))?.synopsis).toBe('已拆信')
    const file = join(dir, '记忆', '人物', '陆安.md')
    expect(await fs.readFile(file, 'utf8')).toContain('当前状态（第4章观察）')
    await writer.applyAutomatic(extraction(4))
    expect((await repo.get(c.id))?.synopsis).toBe('未拆信')
    expect((await repo.get(c.id))?.customFields?.[FIELD_CHAPTERS]).toBe('{}')
  })

  it('各字段分别记章号，不能把较旧位置当成最新章观察', async () => {
    const repo = new CharacterRepo(dir)
    const c = await repo.create({ name: '沈禾' })
    const writer = new MemoryWriter(dir)
    await writer.applyAutomatic(extraction(3, [{ name: '沈禾', field: '位置', oldValue: '', newValue: '与兄弟分开' }]))
    await writer.applyAutomatic(extraction(10, [{ name: '沈禾', field: '持有物', oldValue: '', newValue: '行李' }]))
    const dates = JSON.parse(String((await repo.get(c.id))?.customFields?.[FIELD_CHAPTERS]))
    expect(dates).toEqual({ 位置: 3, 持有物: 10 })
  })

  it('作者修改未在台账中的值，不伪造其记录章或覆盖值', async () => {
    const repo = new CharacterRepo(dir)
    const c = await repo.create({ name: '陆安' })
    const writer = new MemoryWriter(dir)
    const e = extraction(4, [{ name: '陆安', field: '当前状态', oldValue: '', newValue: '已拆信' }])
    await writer.applyAutomatic(e)
    await repo.update(c.id, { synopsis: '作者重新设定的状态' })
    await writer.applyAutomatic(e)
    const updated = await repo.get(c.id)
    expect(updated?.synopsis).toBe('作者重新设定的状态')
    expect(JSON.parse(String(updated?.customFields?.[FIELD_CHAPTERS]))).toEqual({})
  })

  it('新增道具的用途未知、托管状态以来源章节保存，重复调用不覆盖作者卡片', async () => {
    const writer = new MemoryWriter(dir)
    const item = { name: '铜钥匙', category: '线索', notes: '沈禾保管，用途未知。' }
    await writer.applyNewItems([item], 1)
    const repo = new ItemRepo(dir)
    const c = (await repo.list())[0]
    expect(c.notes).toContain('第1章观察快照（历史记录')
    await repo.update(c.id, { notes: '作者的备注' })
    await writer.applyNewItems([item], 8)
    expect((await repo.get(c.id))?.notes).toBe('作者的备注')
  })

  it('同章恢复移除未修改的旧自动实体，保留作者编辑的旧实体', async () => {
    const writer = new MemoryWriter(dir)
    await writer.applyNewItems([{ name: '旧账册', category: '账册', notes: '旧名称' },
      { name: '作者修改的信', category: '信件', notes: '原备注' }], 7)
    const repo = new ItemRepo(dir)
    const edited = (await repo.list()).find(i => i.name === '作者修改的信')!
    await repo.update(edited.id, { notes: '作者备注' })
    await writer.reconcileAutomaticEntities(extraction(7))
    const remaining = await repo.list()
    expect(remaining.map(i => i.name)).toEqual(['作者修改的信'])
    expect(remaining[0].notes).toBe('作者备注')
  })

  it('解析失败不清理实体，回查旧章也不删除后续章节可能使用的卡片', async () => {
    const writer = new MemoryWriter(dir)
    await writer.applyNewItems([{ name: '铜钥匙', category: '道具', notes: '保管线索' }], 1)
    await expect(writer.reconcileAutomaticEntities({ ...extraction(1), parseError: '坏响应' })).rejects.toThrow('不能清理')
    await fs.mkdir(join(dir, '正文'), { recursive: true })
    await fs.writeFile(join(dir, '正文', '002.md'), '后续章节仍使用钥匙。')
    await writer.reconcileAutomaticEntities(extraction(1))
    expect((await new ItemRepo(dir).list()).map(i => i.name)).toEqual(['铜钥匙'])
  })

  it('恢复重提取已知人物不再返回新增，仍被本章正文使用的卡片不得清理', async () => {
    const writer = new MemoryWriter(dir)
    await writer.applyNewCharacters([{ name: '赵伯', role: '配角', identity: '信中签押者', personality: '未揭示' }], 4)
    await fs.mkdir(join(dir, '正文'), { recursive: true })
    await fs.writeFile(join(dir, '正文', '004.md'), '陆安核对信中赵伯的签押，确认了这位签押者。')
    // The real extraction prompt explicitly excludes known characters.
    await writer.reconcileAutomaticEntities(extraction(4))
    expect((await new CharacterRepo(dir).list()).map(c=>c.name)).toContain('赵伯')
  })

  it.each(['current', 'changed', 'pending'] as const)('迁移只标记正文版本仍有效且完成检查的原自动观察：%s', async state => {
    const body = '陆安把信交给沈禾代管。'
    const repo = new ItemRepo(dir)
    const item = await repo.create({ name: '无名封信', notes: '尚未拆封' })
    await fs.mkdir(join(dir, '正文'), { recursive: true })
    await fs.writeFile(join(dir, '正文', '001.md'), body)
    await fs.mkdir(join(dir, '.cache', 'memory-candidates'), { recursive: true })
    await fs.writeFile(join(dir, '.cache', 'memory-candidates', 'chapter-1.json'), JSON.stringify({ status: 'applied',
      sourceHash: hashProse(state === 'changed' ? '旧正文' : body),
      extraction: { ...extraction(1), newItems: [{ name: item.name, notes: item.notes }] } }))
    if (state === 'pending') await markBatchReviewPending(dir, 1, hashProse(body))
    const writer = new MemoryWriter(dir)
    await writer.dateLegacyObservations()
    await writer.dateLegacyObservations()
    const notes = (await repo.get(item.id))?.notes
    if (state === 'current') expect(notes?.match(/第1章观察快照/g)).toHaveLength(1)
    else expect(notes).toBe('尚未拆封')
  })
})
