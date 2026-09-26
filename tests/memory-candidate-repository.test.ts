import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { listMemoryCandidates } from '../src/main/data/memory/candidate-repository'

describe('记忆候选清单', () => {
  let dir: string
  let cache: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-candidate-repo-'))
    cache = join(dir, '.cache', 'memory-candidates')
    await mkdir(cache, { recursive: true })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const write = async (n: number, body: Record<string, unknown>): Promise<void> => {
    await writeFile(join(cache, `chapter-${n}.json`), JSON.stringify(body), 'utf-8')
  }

  it('没跑过写后同步时返回空清单而不是抛错', async () => {
    await expect(listMemoryCandidates(join(dir, '不存在'))).resolves.toEqual([])
  })

  it('只列出还有待办的章，按章号排序', async () => {
    await write(3, { status: 'partial', chapterIssues: [], itemIssues: ['情节「甲」：缺少可定位的正文原文依据'] })
    await write(1, { status: 'pending', chapterIssues: ['正文自检待核对：前后衔接'], itemIssues: [] })
    await write(2, { status: 'applied', chapterIssues: [], itemIssues: [] })
    await write(4, { status: 'validated', chapterIssues: [], itemIssues: [] })

    const list = await listMemoryCandidates(dir)

    expect(list.map((c) => c.chapterNumber)).toEqual([1, 3])
    expect(list[0].status).toBe('pending')
    expect(list[0].chapterIssues).toHaveLength(1)
    expect(list[1].status).toBe('partial')
    expect(list[1].itemIssues).toHaveLength(1)
  })

  it('旧文件只有拍平的 issues 时按整章待核对处理', async () => {
    // chapterIssues/itemIssues 是分级之后才有的字段，旧文件分不出级别，
    // 保守归到整章——与它写下时的实际行为一致
    await write(7, { status: 'pending', issues: ['情节「甲」：缺少可定位的正文原文依据'] })

    const [item] = await listMemoryCandidates(dir)

    expect(item.chapterIssues).toEqual(['情节「甲」：缺少可定位的正文原文依据'])
    expect(item.itemIssues).toEqual([])
  })

  it('单个文件坏掉或文件名不合规不影响其余', async () => {
    await write(5, { status: 'partial', chapterIssues: [], itemIssues: ['甲'] })
    await writeFile(join(cache, 'chapter-6.json'), '{ 这不是 JSON', 'utf-8')
    await writeFile(join(cache, 'notes.txt'), 'hello', 'utf-8')

    const list = await listMemoryCandidates(dir)

    expect(list.map((c) => c.chapterNumber)).toEqual([5])
  })
})
