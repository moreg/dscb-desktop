import { promises as fs } from 'fs'
import path from 'path'

/**
 * 番茄的加密字要和已知黑体、雅黑的字形比对。
 * Windows 上直接用系统字体。Linux 服务器通常没有这两套字体，
 * 就下载 OFL 的思源黑体和 Apache 许可的文泉驿微米黑，存进数据目录后重复使用。
 */

const MAX_FONT_BYTES = 24 * 1024 * 1024
const MIN_FONT_BYTES = 1024

interface SystemFont {
  family: string
  file: string
}

interface RemoteFont {
  family: string
  label: string
  file: string
  urls: string[]
}

const SYSTEM_FONTS: SystemFont[] = [
  { family: 'simhei', file: 'C:/Windows/Fonts/simhei.ttf' },
  { family: 'wqy-microhei', file: '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc' },
  { family: 'noto-sans-cjk', file: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc' },
  { family: 'noto-sans-cjk', file: '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc' },
  { family: 'noto-sans-cjk-sc', file: '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf' }
]

const REMOTE_FONTS: RemoteFont[] = [
  {
    family: 'dscb-noto-sans-sc',
    label: '思源黑体',
    file: 'NotoSansCJKsc-Regular.otf',
    urls: [
      'https://mirrors.tuna.tsinghua.edu.cn/CTAN/fonts/notocjksc/NotoSansCJKsc-Regular.otf',
      'https://github.com/notofonts/noto-cjk/raw/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf'
    ]
  },
  {
    family: 'dscb-wqy-microhei',
    label: '文泉驿微米黑',
    file: 'wqy-microhei.ttc',
    urls: [
      'https://cdn.jsdelivr.net/gh/anthonyfok/fonts-wqy-microhei@master/wqy-microhei.ttc',
      'https://github.com/anthonyfok/fonts-wqy-microhei/raw/master/wqy-microhei.ttc'
    ]
  }
]

export function isFontFile(bytes: Buffer): boolean {
  if (bytes.length < MIN_FONT_BYTES || bytes.length > MAX_FONT_BYTES) return false
  return hasFontHeader(bytes)
}

function hasFontHeader(bytes: Buffer): boolean {
  const tag = bytes.subarray(0, 4).toString('ascii')
  if (tag === 'OTTO' || tag === 'ttcf' || tag === 'wOFF') return true
  return bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0
}

export async function ensureReferenceFamilies(
  cacheDir: string,
  probe: (family: string) => boolean,
  useFont: (family: string, file: string) => void,
  onProgress?: (message: string) => void,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  const installed = await systemFamilies(probe, useFont)
  if (installed.length > 0) return installed
  const downloaded: string[] = []
  const failures: string[] = []
  for (const font of REMOTE_FONTS) {
    onProgress?.(`正在下载汉字对照字体：${font.label}`)
    try {
      const file = await ensureDownloadedFont(cacheDir, font, fetchImpl)
      useFont(font.family, file)
      if (probe(font.family)) downloaded.push(font.family)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : '字体下载失败')
    }
  }
  if (downloaded.length === 0) {
    const detail = failures.find(Boolean)
    throw new Error(detail ? `无法下载汉字对照字体，书名无法还原（${detail}）` : '无法下载汉字对照字体，书名无法还原')
  }
  return downloaded
}

async function systemFamilies(
  probe: (family: string) => boolean,
  useFont: (family: string, file: string) => void
): Promise<string[]> {
  const families: string[] = []
  if (probe('"Microsoft YaHei"')) families.push('"Microsoft YaHei"')
  for (const font of SYSTEM_FONTS) {
    if (families.length >= 2) break
    if (families.includes(font.family)) continue
    try {
      await fs.access(font.file)
      useFont(font.family, font.file)
    } catch {
      continue
    }
    if (probe(font.family)) families.push(font.family)
  }
  return families
}

async function ensureDownloadedFont(cacheDir: string, font: RemoteFont, fetchImpl: typeof fetch): Promise<string> {
  const directory = path.join(cacheDir, 'reference-fonts')
  const destination = path.join(directory, font.file)
  if (!destination.startsWith(directory + path.sep)) throw new Error('字体保存位置无效')
  if (await readableFont(destination)) return destination
  let lastMessage = '字体下载失败'
  for (const url of font.urls) {
    const partial = `${destination}.${process.pid}.partial`
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'dscb-font-fetch', Accept: 'application/octet-stream' },
        signal: AbortSignal.timeout(120_000)
      })
      if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!isFontFile(bytes)) throw new Error('下载内容不是字体文件')
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(partial, bytes)
      await fs.rename(partial, destination)
      return destination
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : lastMessage
      await fs.rm(partial, { force: true }).catch(() => undefined)
    }
  }
  throw new Error(lastMessage)
}

async function readableFont(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file)
    if (stat.size < MIN_FONT_BYTES || stat.size > MAX_FONT_BYTES) return false
    const handle = await fs.open(file, 'r')
    try {
      const header = Buffer.alloc(4)
      const { bytesRead } = await handle.read(header, 0, 4, 0)
      return bytesRead === 4 && hasFontHeader(header)
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}
