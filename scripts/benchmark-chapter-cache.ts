import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join, resolve, sep, basename } from 'path'
import { performance } from 'perf_hooks'
import { chapterDependencyHash } from '../src/main/data/chapter-stage-cache'
import { diffUnits } from '../src/shared/text-diff'

const root = resolve(tmpdir())
const dir = await fs.mkdtemp(join(root, 'codex-perf-'))
try {
  for (let i = 0; i < 500; i++) await fs.writeFile(join(dir, `chapter-${String(i).padStart(4, '0')}.md`), '正文测试。'.repeat(1000))
  await fs.writeFile(join(dir, 'cover.bin'), Buffer.alloc(16 * 1024 * 1024, 3))
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
  async function original() {
    const files: [string, string][] = []
    const names = (await fs.readdir(dir)).sort((a, b) => a.localeCompare(b))
    for (const name of names) files.push([name, digest(await fs.readFile(join(dir, name)))])
    return digest(JSON.stringify(['batch-stages-2-boundary', {}, files]))
  }
  if (await original() !== await chapterDependencyHash(dir, {})) throw new Error('Hash mismatch')
  async function measure(action: () => Promise<unknown>) {
    const timings: number[] = []
    for (let i = 0; i < 5; i++) { const start = performance.now(); await action(); timings.push(performance.now() - start) }
    return Number(timings.sort((a, b) => a - b)[2].toFixed(2))
  }
  const oldMs = await measure(original)
  const warmMs = await measure(() => chapterDependencyHash(dir, {}))
  const before = Array.from({ length: 10000 }, (_, i) => `第${i}段。`)
  const after = [...before]; after[5000] = '修改后的段落。'
  const diffStart = performance.now()
  const hunks = diffUnits(before, after)
  console.log(JSON.stringify({ files: 501, largeFileMB: 16, repetitions: 5, oldMedianMs: oldMs, warmMedianMs: warmMs,
    improvementPercent: Number(((oldMs - warmMs) / oldMs * 100).toFixed(1)),
    diffParagraphs: before.length, diffMs: Number((performance.now() - diffStart).toFixed(2)), hunks: hunks.length }))
} finally {
  const target = resolve(dir)
  if (!target.startsWith(root + sep) || !basename(target).startsWith('codex-perf-')) throw new Error('Unexpected benchmark path')
  await fs.rm(target, { recursive: true, force: true })
}
