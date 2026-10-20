import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { buildContinuityContext } from '../src/main/data/memory/continuity-context'
import { hashProse } from '../src/main/data/memory/prose-memory-index'
import type { ContinuityFact } from '../src/shared/types'

describe('300万字符/千章长期记忆', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), 'longform-million-')) })
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }) })

  it('跨千章保留认知反转与承诺结果，热查询不重读全部正文，改稿后旧记录失效', async () => {
    await fs.mkdir(join(dir, '正文'))
    await fs.mkdir(join(dir, '记忆', '章节概要'), { recursive: true })
    const prosePath = (n: number) => join(dir, '正文', `${String(n).padStart(3, '0')}.md`)
    const summaryPath = (n: number) => join(dir, '记忆', '章节概要', `第${String(n).padStart(3, '0')}章.json`)
    const early = '陆安误以为内应就是船夫，陆宁却不知道内应是谁。陆安答应找到母亲，带她回家。'
    const later = '陆安读完密信，终于得知赵伯才是内应；陆宁尚未看到密信，仍不知道真相。'
    const resolved = '陆安带着母亲回到故乡，寻找母亲的承诺已经兑现。'
    let totalChars = 0
    for (let offset = 1; offset <= 1000; offset += 32) {
      await Promise.all(Array.from({ length: Math.min(32, 1001 - offset) }, async (_, index) => {
        const chapter = offset + index
        const intro = chapter === 3 ? early : chapter === 980 ? resolved : chapter === 990 ? later : `陆安赶路到了第${chapter}站。`
        const prose = intro + '山路漫长，行人继续赶路。'.repeat(300).slice(0, 3000 - intro.length)
        totalChars += prose.length
        const facts: ContinuityFact[] = chapter === 3 ? [
          { kind: 'knowledge', subject: '陆安', object: '内应身份', aspect: '知情程度', value: '误信船夫是内应', evidence: early },
          { kind: 'knowledge', subject: '陆宁', object: '内应身份', aspect: '知情程度', value: '不知内应是谁', evidence: early },
          { kind: 'thread', subject: '寻找母亲', object: '', aspect: '进展', value: '陆安已承诺寻找母亲', evidence: early }
        ] : chapter === 990 ? [
          { kind: 'knowledge', subject: '陆安', object: '内应身份', aspect: '知情程度', value: '已知赵伯是内应，来源密信', evidence: later },
          { kind: 'knowledge', subject: '陆宁', object: '内应身份', aspect: '知情程度', value: '不知真相，尚未看到密信', evidence: later }
        ] : chapter === 980 ? [
          { kind: 'thread', subject: '寻找母亲', object: '', aspect: '进展', value: '已完成，陆安带母亲回乡', evidence: resolved }
        ] : []
        await fs.writeFile(prosePath(chapter), prose)
        await fs.writeFile(summaryPath(chapter), JSON.stringify({ schemaVersion: 1, chapterNumber: chapter, sourceHash: hashProse(prose),
          generatedAt: '', events: [], stateChanges: [], openThreads: [], continuity: facts }))
      }))
    }
    expect(totalChars).toBe(3_000_000)
    const query = { text: '陆安和陆宁谈论内应身份和寻找母亲', characters: ['陆安', '陆宁', '赵伯'], aliases: [], props: [] }
    const start = performance.now()
    const cold = (await buildContinuityContext(dir, 1001, query)).join('\n')
    const coldMs = performance.now() - start
    const reads = vi.spyOn(fs, 'readFile')
    const warmStart = performance.now()
    const warm = (await buildContinuityContext(dir, 1001, query)).join('\n')
    const warmMs = performance.now() - warmStart
    expect(warm).toBe(cold)
    expect(reads.mock.calls.filter(([path]) => dirname(String(path)) === join(dir, '正文'))).toHaveLength(0)
    expect(warm).toContain('陆安 → 内应身份：已知赵伯是内应，来源密信')
    expect(warm).toContain('陆宁 → 内应身份：不知真相，尚未看到密信')
    expect(warm).toContain('赵伯：未检索到可靠认知记录')
    expect(warm).toContain('进展：已完成，陆安带母亲回乡')
    expect(warm.indexOf('进展：已完成')).toBeLessThan(warm.indexOf('进展：陆安已承诺'))
    expect(warm.length).toBeLessThan(17_000)

    // Backfill must not see the later discovery or completion, even with a warm future index.
    const past = (await buildContinuityContext(dir, 500, query)).join('\n')
    expect(past).toContain('误信船夫是内应')
    expect(past).not.toContain('赵伯才是内应')
    expect(past).not.toContain('已完成，陆安带母亲回乡')

    // Editing only the derived summary invalidates the validated chapter cache.
    const summary = JSON.parse(await fs.readFile(summaryPath(990), 'utf8'))
    summary.continuity[0].value = '已知赵伯身份，亲自读信确认'
    await fs.writeFile(summaryPath(990), JSON.stringify(summary))
    const edited = (await buildContinuityContext(dir, 1001, query)).join('\n')
    expect(edited).toContain('已知赵伯身份，亲自读信确认')

    // A rewritten source removes both old recognition and its evidence.
    await fs.writeFile(prosePath(990), '陆安没有读到密信，只能继续赶路。')
    const changed = (await buildContinuityContext(dir, 1001, query)).join('\n')
    expect(changed).not.toContain('已知赵伯身份，亲自读信确认')
    expect(changed).not.toContain('终于得知赵伯才是内应')
    expect(changed).toContain('旧章缺少有效结构化连续性记录')
    console.info(`[longform 3,000,000 chars / 1,000 chapters] cold=${coldMs.toFixed(0)}ms warm=${warmMs.toFixed(0)}ms context=${warm.length} chars`)
  }, 60_000)
})
