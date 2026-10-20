import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureReferenceFamilies, isFontFile } from '../src/main/data/fanqie-chart/reference-fonts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('汉字对照字体', () => {
  it('系统里能画出常用字时不再下载', async () => {
    const dir = await makeDir()
    let fetched = false
    const families = await ensureReferenceFamilies(
      dir,
      (family) => family === '"Microsoft YaHei"',
      () => {},
      undefined,
      async () => {
        fetched = true
        throw new Error('不应下载')
      }
    )
    expect(families).toEqual(['"Microsoft YaHei"'])
    expect(fetched).toBe(false)
  })

  it('系统没有汉字字体时下载思源黑体和文泉驿微米黑，并跳过坏的镜像', async () => {
    const dir = await makeDir()
    const used: string[] = []
    const requested: string[] = []
    const families = await ensureReferenceFamilies(
      dir,
      (family) => family.startsWith('dscb-'),
      (family, file) => used.push(`${family}:${path.basename(file)}`),
      undefined,
      async (url) => {
        requested.push(String(url))
        if (String(url).includes('tuna.tsinghua.edu.cn')) {
          return new Response(`<!DOCTYPE html>${'x'.repeat(2000)}`)
        }
        return new Response(Uint8Array.from(fontBytes(String(url).includes('wqy') ? 'ttcf' : 'OTTO')))
      }
    )
    expect(families).toEqual(['dscb-noto-sans-sc', 'dscb-wqy-microhei'])
    expect(used).toContain('dscb-noto-sans-sc:NotoSansCJKsc-Regular.otf')
    expect(used).toContain('dscb-wqy-microhei:wqy-microhei.ttc')
    expect(requested.some((url) => url.includes('tuna.tsinghua.edu.cn'))).toBe(true)
    expect(requested.some((url) => url.includes('github.com/notofonts'))).toBe(true)
    const saved = await readdir(path.join(dir, 'reference-fonts'))
    expect(saved.sort()).toEqual(['NotoSansCJKsc-Regular.otf', 'wqy-microhei.ttc'])
    expect(isFontFile(await readFile(path.join(dir, 'reference-fonts', 'NotoSansCJKsc-Regular.otf')))).toBe(true)
  })

  it('已经下载过的字体直接复用', async () => {
    const dir = await makeDir()
    const folder = path.join(dir, 'reference-fonts')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'NotoSansCJKsc-Regular.otf'), fontBytes('OTTO'))
    await writeFile(path.join(folder, 'wqy-microhei.ttc'), fontBytes('ttcf'))
    let fetched = false
    const families = await ensureReferenceFamilies(
      dir,
      (family) => family.startsWith('dscb-'),
      () => {},
      undefined,
      async () => {
        fetched = true
        throw new Error('不应下载')
      }
    )
    expect(families).toEqual(['dscb-noto-sans-sc', 'dscb-wqy-microhei'])
    expect(fetched).toBe(false)
  })

  it('两个镜像都下不到时说明无法还原', async () => {
    const dir = await makeDir()
    await expect(ensureReferenceFamilies(
      dir,
      () => false,
      () => {},
      undefined,
      async () => new Response('nope', { status: 404 })
    )).rejects.toThrow('无法下载汉字对照字体，书名无法还原')
    expect(await readdir(dir)).toEqual([])
  })
})

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aw-font-'))
  roots.push(dir)
  return dir
}

function fontBytes(tag: string): Buffer {
  const bytes = Buffer.alloc(2048)
  bytes.write(tag, 0, 'ascii')
  return bytes
}
