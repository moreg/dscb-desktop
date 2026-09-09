import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ForeshadowingMdRepo, parseForeshadowingMarkdown } from '../src/main/data/skill-format/foreshadowing-md-repo'
import { MemoryWriter, resolveAutomaticForeshadowing } from '../src/main/data/memory-writer'
import type { MemoryExtraction } from '../src/shared/types'

const table = `# 伏笔追踪\n\n| 编号 | 内容 | 类型 | 埋设 | 预计回收 | 实际回收 | 状态 |\n|---|---|---|---|---|---|---|\n| FB-001 | 玉佩真正的来历 | 道具 | 第 2 章 | 第 20 章 | 未回收 | 未回收 |\n| FB-002 | 家族失踪者的真实身份 | 身世 | 第 3 章 | 第 30 章 | 未回收 | 已埋设 |\n`
function extraction(chapter = 10): MemoryExtraction {
  return { chapterNumber: chapter, newCharacters: [], newLocations: [], newItems: [], newForeshadowings: [], newPlotPoints: [], characterStateChanges: [], collectedForeshadowings: [] }
}

describe('foreshadowing schema and actual progress', () => {
  let dir: string
  let file: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'aw-foreshadow-ledger-')); await mkdir(join(dir, '追踪')); file = join(dir, '追踪', '伏笔.md'); await writeFile(file, table) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('does not mistake negation, planned completion or partial payoff for complete payoff', () => {
    const text = table + `\n## 新线索\n| 状态 | 伏笔编号 | 内容 | 埋设章节 | 实际回收章节 | 预计回收章节 |\n|---|---|---|---|---|---|\n| 未回收（计划写成已回收） | FB-003 | 名册来源 | 第 2 章 | 第 10 章 | 第 10 章 |\n| ✅ 已部分回收（第9章） | FB-004 | 门后真相 | 第 2 章 | 第 9 章 | 第 30 章 |\n| 已回收 | FB-005 | 只有计划日期 | 第 2 章 | 预计第 30 章 | 第 30 章 |\n| 已回收 | FB-006 | 真正闭环 | 第 2 章 | 第 8 章 | 第 30 章 |\n\n## 细纲回收计划\n### 本章方案\n| 编号 | 内容 | 状态 | 埋设 | 实际回收 |\n|---|---|---|---|---|\n| FB-999 | 未来闭环 | 已回收 | 第 2 章 | 第 999 章 |`
    const items = parseForeshadowingMarkdown(text)
    expect(items).toHaveLength(6)
    expect(items.find((f) => f.id === 'FB-003')).toMatchObject({ status: 'planted', actualCollect: undefined })
    expect(items.find((f) => f.id === 'FB-004')).toMatchObject({ status: 'partial', partialCollectChapters: [9], actualCollect: undefined })
    expect(items.find((f) => f.id === 'FB-005')!.status).toBe('planted')
    expect(items.find((f) => f.id === 'FB-006')).toMatchObject({ status: 'collected', actualCollect: 8 })
    expect(items.some((f) => f.id === 'FB-999')).toBe(false)
  })

  it('modifies a reordered second table by its own columns and keeps author columns and notes', async () => {
    await writeFile(file, table + '\n## 支线实际记录\n\n作者备注不能丢。\n\n| 备注 | 实际回收章节 | 内容 | 状态 | 埋设章节 | 编号 | 预计回收章节 | 原始编号 |\n|---|---|---|---|---|---|---|---|\n| 作者解释 | 未回收 | 暗门的机关 | 已埋设 | 第 3 章 | FB-010 | 第 20 章 | ORIGINAL-X |\n')
    await new ForeshadowingMdRepo(dir).collect('FB-010', 8)
    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('作者备注不能丢。')
    expect(raw).toContain('ORIGINAL-X')
    expect(raw).toContain(table.trimEnd())
    expect((await new ForeshadowingMdRepo(dir).list()).find((f) => f.id === 'FB-010')).toMatchObject({ status: 'collected', actualCollect: 8, content: '暗门的机关', note: '作者解释' })
  })

  it('serializes concurrent creation and distinct row updates without losing either mutation', async () => {
    const repo = new ForeshadowingMdRepo(dir)
    const created = await Promise.all(Array.from({ length: 12 }, (_, i) => repo.create({ content: `新增线索-${i}` })))
    expect(new Set(created.map((f) => f.id)).size).toBe(12)
    await Promise.all([repo.update('FB-001', { content: '作者修订玉佩来源' }), repo.collect('FB-002', 10)])
    const items = await repo.list()
    expect(items).toHaveLength(14)
    expect(items[0].content).toBe('作者修订玉佩来源')
    expect(items[1].actualCollect).toBe(10)
  })

  it('rejects impossible or destructive status transitions and invalid dates', async () => {
    const repo = new ForeshadowingMdRepo(dir)
    const pending = await repo.create({ content: '尚未埋设的新伏笔' })
    await expect(repo.collect(pending.id, 3)).rejects.toThrow('尚未登记')
    await expect(repo.collect('FB-001', 1)).rejects.toThrow('不能早于')
    await expect(repo.plant('FB-001', -1)).rejects.toThrow('整数')
    await repo.collect('FB-001', 10)
    await expect(repo.plant('FB-001', 20)).rejects.toThrow('先撤销')
    await expect(repo.markMissed('FB-001')).rejects.toThrow('不能标记')
    await expect(repo.collect('FB-001', 11)).rejects.toThrow('先撤销')
    await repo.uncollect('FB-001')
    expect((await repo.list())[0]).toMatchObject({ status: 'planted', actualCollect: undefined, plantChapter: 2 })
  })

  it('clears optional metadata and accumulates concurrent stage events without full collection', async () => {
    const repo = new ForeshadowingMdRepo(dir)
    await repo.update('FB-001', { note: '需要继续观察', expectedCollect: 30 })
    await repo.update('FB-001', { note: null, expectedCollect: null })
    await Promise.all([repo.update('FB-001', { status: 'reinforced', reinforcementChapters: [4] }), repo.update('FB-001', { status: 'reinforced', reinforcementChapters: [6] })])
    await repo.update('FB-001', { status: 'partial', partialCollectChapters: [8] })
    expect((await repo.list())[0]).toMatchObject({ note: undefined, expectedCollect: undefined, status: 'partial', reinforcementChapters: [4, 6], partialCollectChapters: [8], actualCollect: undefined })
    await expect(repo.collect('FB-001', 7)).rejects.toThrow('部分回收')
    await repo.update('FB-001', { partialCollectChapters: [] })
    expect((await repo.list())[0].status).toBe('reinforced')
  })

  it('rejects duplicate ids instead of editing the first arbitrary row', async () => {
    await writeFile(file, table + '\n## 重复数据\n| 内容 | 编号 | 状态 | 埋设 | 实际回收 |\n|---|---|---|---|---|\n| 另一条伏笔 | FB-001 | 已埋设 | 第 3 章 | 未回收 |\n')
    const before = await readFile(file, 'utf8')
    await expect(new ForeshadowingMdRepo(dir).collect('FB-001', 10)).rejects.toThrow('重复')
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('uses the final stated actual chapter when a payoff spans several chapters', () => {
    const items = parseForeshadowingMarkdown(table.replace('未回收 | 未回收', '第 8 章开始，第 12 章全部完成 | 已回收'))
    expect(items[0].actualCollect).toBe(12)
  })
})

describe('automatic foreshadow receipts', () => {
  let dir: string
  let file: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'aw-foreshadow-auto-')); await mkdir(join(dir, '追踪')); file = join(dir, '追踪', '伏笔.md'); await writeFile(file, table) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('prioritizes ids and rejects empty, short, ambiguous and overly broad legacy references', async () => {
    const list = await new ForeshadowingMdRepo(dir).list()
    expect(resolveAutomaticForeshadowing(list, { foreshadowingId: 'FB-002', content: list[1].content })?.id).toBe('FB-002')
    expect(resolveAutomaticForeshadowing(list, { foreshadowingId: 'FB-002', content: list[0].content })).toBeUndefined()
    for (const content of ['', '玉佩', '来历', '玉佩和家族的全部故事']) expect(resolveAutomaticForeshadowing(list, { content })).toBeUndefined()
    expect(resolveAutomaticForeshadowing([...list, { ...list[0], id: 'FB-999' }], { content: list[0].content })).toBeUndefined()
    expect(resolveAutomaticForeshadowing(list, { foreshadowingId: 'FB-404', content: list[0].content })).toBeUndefined()
  })

  it('records source evidence and reverts only its chapter when rewriting removes the collection', async () => {
    const writer = new MemoryWriter(dir)
    const first = extraction(10)
    first.collectedForeshadowings = [{ foreshadowingId: 'FB-001', content: '玉佩真正的来历', chapter: 10, evidence: '玉佩是母亲留下的信物。' }]
    await writer.applyAutomatic(first, { sourceContent: '祖母终于告诉他，玉佩是母亲留下的信物。' })
    const second = extraction(12)
    second.collectedForeshadowings = [{ foreshadowingId: 'FB-002', content: '家族失踪者的真实身份', chapter: 12 }]
    await writer.applyAutomatic(second)
    const record = (await readFile(file, 'utf8')).match(/writer-foreshadow-collection:([A-Za-z0-9+/=]+)/)!
    expect(JSON.parse(Buffer.from(record[1], 'base64').toString('utf8'))).toMatchObject({ id: 'FB-001', chapter: 10, evidence: first.collectedForeshadowings[0].evidence, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/), beforeHash: expect.any(String), afterHash: expect.any(String) })
    await writer.applyAutomatic(extraction(10), { sourceContent: '祖母没有回答他。' })
    const list = await new ForeshadowingMdRepo(dir).list()
    expect(list[0]).toMatchObject({ status: 'planted', actualCollect: undefined })
    expect(list[1]).toMatchObject({ status: 'collected', actualCollect: 12 })
  })

  it('protects manually edited collection rows and manually collected unrelated records on undo', async () => {
    const writer = new MemoryWriter(dir)
    const data = extraction()
    data.collectedForeshadowings = [{ foreshadowingId: 'FB-001', content: '玉佩真正的来历', chapter: 10 }]
    const applied = await writer.applyAutomatic(data)
    const repo = new ForeshadowingMdRepo(dir)
    await repo.update('FB-001', { note: '作者已核实此回收成立' })
    await repo.collect('FB-002', 12)
    const undone = await writer.revertAutomatic(data, applied.appliedDiffs)
    expect(undone.reverted.collected).toBe(0)
    expect(undone.errors).toContainEqual(expect.stringContaining('已被编辑'))
    expect((await repo.list()).map((f) => f.status)).toEqual(['collected', 'collected'])
  })

  it('does not erase an earlier valid receipt when a replacement has missing evidence or ambiguous references', async () => {
    const writer = new MemoryWriter(dir)
    const data = extraction()
    data.collectedForeshadowings = [{ foreshadowingId: 'FB-001', content: '玉佩真正的来历', chapter: 10, evidence: '真相已经揭晓。' }]
    await writer.applyAutomatic(data, { sourceContent: '真相已经揭晓。' })
    const invalid = await writer.applyAutomatic(data, { sourceContent: '他还没有找到证据。' })
    expect(invalid.errors).toContainEqual(expect.stringContaining('原文回收证据'))
    data.collectedForeshadowings = [{ content: '玉佩', chapter: 10 }]
    const ambiguous = await writer.applyAutomatic(data)
    expect(ambiguous.errors).toContainEqual(expect.stringContaining('唯一编号'))
    expect((await new ForeshadowingMdRepo(dir).list())[0].status).toBe('collected')
  })

  it('rejects a collection extracted for another chapter without changing actual state', async () => {
    const data = extraction(10)
    data.collectedForeshadowings = [{ foreshadowingId: 'FB-001', content: '玉佩真正的来历', chapter: 20 }]
    const result = await new MemoryWriter(dir).applyAutomatic(data)
    expect(result.applied.collected).toBe(0)
    expect(result.errors).toContainEqual(expect.stringContaining('必须是本章'))
    expect((await new ForeshadowingMdRepo(dir).list())[0].status).toBe('planted')
  })

  it('undoing an invalid or unapplied submission does not undo an older receipt from the same chapter', async () => {
    const writer = new MemoryWriter(dir)
    const data = extraction()
    data.collectedForeshadowings = [{ foreshadowingId: 'FB-001', content: '玉佩真正的来历', chapter: 10, evidence: '真相已经揭晓。' }]
    await writer.applyAutomatic(data, { sourceContent: '真相已经揭晓。' })
    const failed = await writer.applyAutomatic(data, { sourceContent: '依旧毫无头绪。' })
    const undone = await writer.revertAutomatic(data, failed.appliedDiffs)
    expect(undone.reverted.collected).toBe(0)
    expect((await new ForeshadowingMdRepo(dir).list())[0].status).toBe('collected')
  })

  it('binds undo to the actual receipt so an older task cannot remove a later successful submission', async () => {
    const writer = new MemoryWriter(dir)
    const data = extraction()
    data.collectedForeshadowings = [{ foreshadowingId: 'FB-001', content: '玉佩真正的来历', chapter: 10, evidence: '真相已经揭晓。' }]
    const first = await writer.applyAutomatic(data, { sourceContent: '真相已经揭晓。' })
    const second = await writer.applyAutomatic(data, { sourceContent: '祖母开口，真相已经揭晓。' })
    expect(first.appliedDiffs?.find((d) => d.kind === 'collect')?.receiptId).not.toBe(second.appliedDiffs?.find((d) => d.kind === 'collect')?.receiptId)
    const oldUndo = await writer.revertAutomatic(data, first.appliedDiffs)
    expect(oldUndo.reverted.collected).toBe(0)
    expect(oldUndo.errors).toContainEqual(expect.stringContaining('更新提交'))
    expect((await new ForeshadowingMdRepo(dir).list())[0].status).toBe('collected')
  })

  it('reports rewrite-driven uncollection separately and can undo that exact rewrite receipt', async () => {
    const writer = new MemoryWriter(dir)
    const data = extraction()
    data.collectedForeshadowings = [{ foreshadowingId: 'FB-001', content: '玉佩真正的来历', chapter: 10 }]
    await writer.applyAutomatic(data)
    const rewrite = await writer.applyAutomatic(extraction())
    expect(rewrite.applied.collected).toBe(0)
    expect(rewrite.appliedDiffs).toContainEqual(expect.objectContaining({ kind: 'collect', collectionAction: 'uncollect', foreshadowingId: 'FB-001', receiptId: expect.any(String) }))
    expect((await new ForeshadowingMdRepo(dir).list())[0].status).toBe('planted')
    const undo = await writer.revertAutomatic(extraction(), rewrite.appliedDiffs)
    expect(undo.reverted.collected).toBe(1)
    expect((await new ForeshadowingMdRepo(dir).list())[0].status).toBe('collected')
  })

  it('rejects the correct id paired with a different foreshadowing title and unrelated evidence', async () => {
    const data = extraction()
    data.collectedForeshadowings = [{ foreshadowingId: 'FB-001', content: '家族失踪者的真实身份', chapter: 10, evidence: '失踪者终于承认自己的身份。' }]
    const result = await new MemoryWriter(dir).applyAutomatic(data, { sourceContent: '失踪者终于承认自己的身份。' })
    expect(result.applied.collected).toBe(0)
    expect(result.errors).toContainEqual(expect.stringContaining('伏笔回收未应用'))
    expect((await new ForeshadowingMdRepo(dir).list()).every((f) => f.status !== 'collected')).toBe(true)
  })
})
