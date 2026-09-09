import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PlotPointRepo } from '../src/main/data/memory/plot-point-repo'
import { hashProse } from '../src/main/data/memory/prose-memory-index'

describe('plot summaries require current prose evidence', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-plot-evidence-'))
    for (const folder of ['正文', '细纲', '记忆/剧情点']) await mkdir(join(dir, folder), { recursive: true })
  })
  const memory = (event: string, prose?: string) => `# 第1章 救人\n\n## 字段\n\n- **核心事件**：${event}\n${prose != null ? `- **正文哈希**：${hashProse(prose)}\n` : ''}`

  it('uses exact saved prose when the outline contradicts it or memory has no proof', async () => {
    const prose = '林远仍未找到失踪的母亲。'
    await writeFile(join(dir, '正文', '001.md'), prose)
    await writeFile(join(dir, '细纲', '细纲_第001章_救人.md'), '# 第1章\n\n- **核心事件**：母亲已经获救。')
    const repo = new PlotPointRepo(dir)
    const [withoutMemory] = await repo.listSummariesBefore(2)
    expect(withoutMemory.summary).toBe(prose)
    expect(withoutMemory.source).toBe('prose_excerpt')
    expect(withoutMemory.sourcePath).toBe('正文/001.md')
    await writeFile(join(dir, '记忆', '剧情点', '第001章 救人.md'), memory('母亲已经获救。'))
    const [withLegacy] = await repo.listSummariesBefore(2)
    expect(withLegacy.summary).toBe(prose)
    expect(withLegacy.unverifiedMemorySummary).toBe('母亲已经获救。')
  })

  it('accepts a hash-bound summary, immediately notices summary edits, and rejects it after prose changes', async () => {
    const prose = '林远终于救出了母亲。'
    const proseFile = join(dir, '正文', '001.md')
    const memoryFile = join(dir, '记忆', '剧情点', '第001章 救人.md')
    await writeFile(proseFile, prose)
    await writeFile(memoryFile, memory('营救成功。', prose))
    const repo = new PlotPointRepo(dir)
    expect((await repo.listSummariesBefore(2))[0]).toMatchObject({ source: 'memory', verified: true, summary: '营救成功。' })
    await writeFile(memoryFile, memory('母亲脱险。', prose))
    expect((await repo.listSummariesBefore(2))[0].summary).toBe('母亲脱险。')
    await writeFile(proseFile, '林远仍未找到母亲。')
    expect((await repo.listSummariesBefore(2))[0]).toMatchObject({ source: 'prose_excerpt', summary: '林远仍未找到母亲。' })
    await unlink(proseFile)
    expect(await repo.listSummariesBefore(2)).toEqual([])
  })
})
