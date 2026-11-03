import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { readJson, writeJsonAtomic, writeTextAtomic } from '../src/main/data/atomic'

describe('atomic json io', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-atomic-'))
  })
  afterEach(() => vi.restoreAllMocks())

  it.each(['write', 'rename'])('preserves the saved file and removes temporary files on %s failure', async failure => {
    const file = path.join(dir, 'data.txt')
    await fs.writeFile(file, '已保存正文')
    const error = new Error('模拟磁盘写入失败')
    if (failure === 'rename') vi.spyOn(fs, 'rename').mockRejectedValueOnce(error)
    else {
      const write = fs.writeFile.bind(fs)
      vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => { await write(...args); throw error })
    }
    await expect(writeTextAtomic(file, '新正文')).rejects.toBe(error)
    expect(await fs.readFile(file, 'utf8')).toBe('已保存正文')
    expect(await fs.readdir(dir)).toEqual(['data.txt'])
  })

  it('returns fallback when file missing', async () => {
    const result = await readJson(path.join(dir, 'nope.json'), { ok: false })
    expect(result).toEqual({ ok: false })
  })

  it.each(['EPERM', 'EBUSY'])('retries a transient %s when another operation removes a listed file', async code => {
    const read = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('busy'), { code }))
    await expect(readJson(path.join(dir, 'removed.json'), null)).resolves.toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not hide persistent access errors or retry malformed JSON', async () => {
    const error = Object.assign(new Error('denied'), { code: 'EPERM' })
    const read = vi.spyOn(fs, 'readFile').mockRejectedValue(error)
    await expect(readJson(path.join(dir, 'denied.json'), null)).rejects.toBe(error)
    expect(read).toHaveBeenCalledTimes(3)
    read.mockReset().mockResolvedValue('{broken')
    await expect(readJson(path.join(dir, 'broken.json'), null)).rejects.toBeInstanceOf(SyntaxError)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('writes then reads round-trip', async () => {
    const file = path.join(dir, 'data.json')
    await writeJsonAtomic(file, { a: 1, list: [1, 2] })
    const read = await readJson<{ a: number; list: number[] }>(file, { a: 0, list: [] })
    expect(read).toEqual({ a: 1, list: [1, 2] })
  })

  it('does not leave a .tmp file after write', async () => {
    const file = path.join(dir, 'data.json')
    await writeJsonAtomic(file, { x: 1 })
    const raw = await readFile(file, 'utf-8')
    expect(JSON.parse(raw)).toEqual({ x: 1 })
  })
})
