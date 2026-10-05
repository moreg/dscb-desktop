import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { findSavedPlantEvidence } from '../src/main/data/foreshadowing-plant-backfill'
import { ForeshadowingMdRepo } from '../src/main/data/skill-format/foreshadowing-ledger'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { MemoryWriter } from '../src/main/data/memory-writer'
import type { MemoryExtraction } from '../src/shared/types'

describe('saved prose foreshadowing plant backfill', () => {
  let dir: string
  let ledger: ForeshadowingMdRepo
  let prose: ProseRepo
  const clue = '司机试图触碰踏板下通向后厢的机械杆与阵件，其功能及启动后果尚未揭明。'
  const setup = '马宁伏低身体，看见踏板下有一段外露的机械杆，旁边固定着几块带黑纹的阵件。\n杆头通过短轴连进底梁，阵件上另有一条线通往后厢，跟普通踏板拉线分开。'
  const payoff = '司机的右手在座椅下猛拽了一下，底梁上的黑纹亮起来，亮线顺着车底窜向后厢。'

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-foreshadow-backfill-'))
    await mkdir(join(dir, '追踪'))
    await mkdir(join(dir, '正文'))
    await writeFile(join(dir, '追踪', '伏笔.md'), `# 伏笔实际台账\n\n| 伏笔编号 | 类型 | 内容 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 | 备注 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| FB-026 | 设定 | ${clue} | 未埋设 | 未定 | 未回收 | 未回收 | 仍需核对 |\n`)
    prose = new ProseRepo(dir)
    await prose.write(4, setup)
    await prose.write(5, payoff)
    ledger = new ForeshadowingMdRepo(dir)
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('finds the earlier saved setup and permits the later collection', async () => {
    const records = await ledger.list()
    const found = await findSavedPlantEvidence({
      repo: prose, chapterNumber: 5, collections: records,
      generate: async (prompt) => {
        expect(prompt).toContain('第 4 章已保存正文')
        expect(prompt).toContain(setup)
        return JSON.stringify({ plantings: [{ foreshadowingId: 'FB-026', chapter: 4, evidence: setup.split('\n')[0] }] })
      }
    })
    expect(found).toMatchObject([{ foreshadowingId: 'FB-026', chapter: 4 }])
    expect(await ledger.plantFromSavedEvidence(found[0].foreshadowingId, found[0].chapter, found[0].evidence)).toBe(true)
    expect(await ledger.plantFromSavedEvidence(found[0].foreshadowingId, found[0].chapter, found[0].evidence)).toBe(false)
    const extraction: MemoryExtraction = {
      chapterNumber: 5, newCharacters: [], newLocations: [], newItems: [], newForeshadowings: [],
      newPlotPoints: [], characterStateChanges: [], collectedForeshadowings: [
        { foreshadowingId: 'FB-026', content: clue, chapter: 5, evidence: payoff }
      ]
    }
    const applied = await new MemoryWriter(dir).applyAutomatic(extraction, { sourceContent: payoff })
    expect(applied.errors).toEqual([])
    expect(applied.applied.collected).toBe(1)
    expect((await ledger.list())[0]).toMatchObject({ plantChapter: 4, actualCollect: 5, status: 'collected' })
    expect(await readFile(join(dir, '追踪', '伏笔.md'), 'utf8')).toContain('仍需核对')
    await new MemoryWriter(dir).applyAutomatic({ ...extraction, collectedForeshadowings: [] }, { sourceContent: payoff })
    expect((await ledger.list())[0]).toMatchObject({ plantChapter: 4, actualCollect: undefined, status: 'planted' })
  })

  it('rejects a fabricated quote or a changed saved chapter before mutating the ledger', async () => {
    const records = await ledger.list()
    await expect(findSavedPlantEvidence({
      repo: prose, chapterNumber: 5, collections: records,
      generate: async () => JSON.stringify({ plantings: [{ foreshadowingId: 'FB-026', chapter: 4, evidence: '书上说机械杆已在第四章埋设完毕。' }] })
    })).rejects.toThrow('原文证据')
    await expect(ledger.plantFromSavedEvidence('FB-026', 4, setup.split('\n')[0])).resolves.toBe(true)
    await prose.write(4, '司机站在桥口，没有碰过踏板。')
    await expect(ledger.plantFromSavedEvidence('FB-026', 4, setup.split('\n')[0])).rejects.toThrow('已不在保存正文')
  })

  it('leaves unresolved clues pending when saved prose has no reliable setup', async () => {
    const found = await findSavedPlantEvidence({
      repo: prose, chapterNumber: 5, collections: await ledger.list(),
      generate: async () => '{"plantings":[]}'
    })
    expect(found).toEqual([])
    expect((await ledger.list())[0]).toMatchObject({ plantChapter: undefined, status: 'pending' })
  })
})
