import { withFileLock } from '../file-lock'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import frequency from './char-frequency.json'
import { ensureReferenceFamilies } from './reference-fonts'

/**
 * 番茄榜单把书名、作者、简介编进私用区，页面只给一套打乱过的字体。
 * 把私用区字形和已知黑体渲染成同样大小的点阵再比对，才能把字还原回来。
 * 标准字的点阵按机器缓存一次，之后同一套字体直接复用映射。
 * 雅黑和黑体各存一份，取相似度更高的那份。只留雅黑时，大会认成犬、走会认成定。
 * 机器上没有这两套字体时，下载思源黑体和文泉驿微米黑再建立点阵。
 */

const CACHE_MAGIC = 'FQGL'
const CACHE_VERSION = 4
const CANVAS = 128
const FONT_PX = 96
const GRID = 32
const MIN_SIM = 0.55
const FREQUENCY_BONUS = 0.12
const SHORTLIST = 512

export interface GlyphCandidate {
  codepoint: number
  char: string
  vec: Float32Array
  sig: Uint8Array
  coarse?: Float32Array
}

type DrawCanvas = import('skia-canvas').Canvas

let canvas: DrawCanvas | null = null
let fontLibrary: { use(family: string, files: string[]): void } | null = null
const loadedFamilies = new Set<string>()

async function canvasOf(): Promise<DrawCanvas> {
  if (canvas) return canvas
  const skia = await import('skia-canvas')
  fontLibrary = skia.FontLibrary
  canvas = new skia.Canvas(CANVAS, CANVAS)
  return canvas
}

export function renderGlyph(draw: DrawCanvas, ch: string, family: string): { vec: Float32Array; sig: Uint8Array } | null {
  const ctx = draw.getContext('2d')
  ctx.clearRect(0, 0, CANVAS, CANVAS)
  ctx.fontHinting = true
  ctx.fillStyle = '#000'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.font = `${FONT_PX}px ${family}`
  ctx.fillText(ch, CANVAS / 2, CANVAS / 2)
  const data = ctx.getImageData(0, 0, CANVAS, CANVAS).data
  let minX = CANVAS
  let maxX = 0
  let minY = CANVAS
  let maxY = 0
  let count = 0
  for (let y = 0; y < CANVAS; y++) {
    for (let x = 0; x < CANVAS; x++) {
      if (data[(y * CANVAS + x) * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        count += 1
      }
    }
  }
  if (count < 8 || maxX <= minX || maxY <= minY) return null
  const width = maxX - minX + 1
  const height = maxY - minY + 1
  const raw = new Float32Array(GRID * GRID)
  for (let gy = 0; gy < GRID; gy++) {
    const sy = minY + ((gy + 0.5) * height) / GRID - 0.5
    for (let gx = 0; gx < GRID; gx++) {
      const sx = minX + ((gx + 0.5) * width) / GRID - 0.5
      raw[gy * GRID + gx] = bilinearAlpha(data, sx, sy)
    }
  }
  const sig = signatureOf(raw)
  let mean = 0
  for (const value of raw) mean += value
  mean /= raw.length
  let norm = 0
  for (let i = 0; i < raw.length; i++) {
    raw[i] -= mean
    norm += raw[i] * raw[i]
  }
  norm = Math.sqrt(norm)
  if (norm < 1e-6) return null
  for (let i = 0; i < raw.length; i++) raw[i] /= norm
  return { vec: raw, sig }
}

function bilinearAlpha(data: Uint8ClampedArray, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = x - x0
  const ty = y - y0
  const sample = (px: number, py: number): number => {
    if (px < 0 || py < 0 || px >= CANVAS || py >= CANVAS) return 0
    return data[(py * CANVAS + px) * 4 + 3]
  }
  const top = sample(x0, y0) * (1 - tx) + sample(x0 + 1, y0) * tx
  const bottom = sample(x0, y0 + 1) * (1 - tx) + sample(x0 + 1, y0 + 1) * tx
  return top * (1 - ty) + bottom * ty
}

function signatureOf(raw: Float32Array): Uint8Array {
  const sig = new Uint8Array(8)
  let peak = 0
  for (const value of raw) if (value > peak) peak = value
  const threshold = peak * 0.12
  let bit = 0
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      let sum = 0
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) sum += raw[(by * 4 + y) * GRID + (bx * 4 + x)]
      }
      if (sum / 16 > threshold) sig[bit >> 3] |= 1 << (bit & 7)
      bit += 1
    }
  }
  return sig
}

function coarseOf(vec: Float32Array): Float32Array {
  const out = new Float32Array(64)
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      let sum = 0
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) sum += vec[(by * 4 + y) * GRID + (bx * 4 + x)]
      }
      out[by * 8 + bx] = sum
    }
  }
  let norm = 0
  for (const value of out) norm += value * value
  norm = Math.sqrt(norm)
  if (norm < 1e-6) return out
  for (let i = 0; i < out.length; i++) out[i] /= norm
  return out
}

function ensureCoarse(item: GlyphCandidate): Float32Array {
  if (!item.coarse) item.coarse = coarseOf(item.vec)
  return item.coarse
}

let priorReady = false
const charPrior = new Map<string, number>()

function priorOf(ch: string): number {
  if (!priorReady) {
    const counts = frequency as Record<string, number>
    let max = 0
    for (const value of Object.values(counts)) if (value > max) max = value
    const scale = Math.log1p(max) || 1
    for (const [char, count] of Object.entries(counts)) charPrior.set(char, Math.log1p(count) / scale)
    priorReady = true
  }
  return charPrior.get(ch) ?? 0
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

export function matchGlyph(
  query: { vec: Float32Array; sig: Uint8Array },
  candidates: GlyphCandidate[]
): string | null {
  if (candidates.length === 0) return null
  const queryCoarse = coarseOf(query.vec)
  const shortlist: Array<{ index: number; score: number }> = []
  let worst = 0
  for (let i = 0; i < candidates.length; i++) {
    const score = dot(queryCoarse, ensureCoarse(candidates[i]))
    if (shortlist.length < SHORTLIST) {
      shortlist.push({ index: i, score })
      if (shortlist.length === SHORTLIST) {
        worst = 0
        for (let j = 1; j < shortlist.length; j++) {
          if (shortlist[j].score < shortlist[worst].score) worst = j
        }
      }
      continue
    }
    if (score <= shortlist[worst].score) continue
    shortlist[worst] = { index: i, score }
    for (let j = 0; j < shortlist.length; j++) {
      if (shortlist[j].score < shortlist[worst].score) worst = j
    }
  }
  let bestChar = ''
  let best = -1
  let bestPrior = 0
  const bestByCode = new Map<number, { score: number; prior: number; char: string }>()
  for (const item of shortlist) {
    const candidate = candidates[item.index]
    const prior = priorOf(candidate.char)
    const score = dot(query.vec, candidate.vec) + FREQUENCY_BONUS * prior
    const previous = bestByCode.get(candidate.codepoint)
    if (previous && previous.score >= score) continue
    bestByCode.set(candidate.codepoint, { score, prior, char: candidate.char })
    if (score > best) {
      best = score
      bestChar = candidate.char
      bestPrior = prior
    }
  }
  // 横线和生僻形近字在拉成方格后会压过常用字。领先的字很生僻时，在近分里改选更常用的字。
  if (bestPrior < 0.25) {
    for (const item of bestByCode.values()) {
      if (best - item.score <= 0.1 && item.prior > bestPrior && item.score >= MIN_SIM) {
        bestChar = item.char
        bestPrior = item.prior
      }
    }
  }
  if (!bestChar || best < MIN_SIM) return null
  return bestChar
}

function familyRenders(draw: DrawCanvas, family: string): boolean {
  const glyphs = new Map<string, Float32Array>()
  for (const ch of '永大犬走定') {
    const rendered = renderGlyph(draw, ch, family)
    if (!rendered) return false
    glyphs.set(ch, rendered.vec)
  }
  // 系统没有汉字时，缺字会画成同一个方框，点积接近 1。常用黑体里这两组形近字的点积低于 0.95。
  const da = glyphs.get('大')
  const quan = glyphs.get('犬')
  const zou = glyphs.get('走')
  const ding = glyphs.get('定')
  if (!da || !quan || !zou || !ding) return false
  return glyphSeparable(da, quan) && glyphSeparable(zou, ding)
}

function glyphSeparable(left: Float32Array, right: Float32Array): boolean {
  let dot = 0
  for (let i = 0; i < left.length; i++) dot += left[i] * right[i]
  return dot < 0.98
}

function isCandidate(codepoint: number): boolean {
  if (codepoint >= 0xff10 && codepoint <= 0xff19) return false
  if (codepoint >= 0xff21 && codepoint <= 0xff3a) return false
  if (codepoint >= 0xff41 && codepoint <= 0xff5a) return false
  if (codepoint >= 0x21 && codepoint <= 0x7e) return true
  if (codepoint >= 0x3000 && codepoint <= 0x303f) return true
  if (codepoint >= 0x4e00 && codepoint <= 0x9fff) return true
  if (codepoint >= 0xff01 && codepoint <= 0xff60) return true
  return false
}

function candidateCodepoints(): number[] {
  const codes: number[] = []
  for (let code = 0x21; code <= 0x9fff; code++) {
    if (isCandidate(code)) codes.push(code)
  }
  for (let code = 0xff01; code <= 0xff60; code++) {
    if (isCandidate(code)) codes.push(code)
  }
  return codes
}

function cacheFile(dir: string): string {
  return path.join(dir, `standard-glyphs-v${CACHE_VERSION}.bin`)
}

export function encodeGlyphCache(items: GlyphCandidate[]): Buffer {
  const count = items.length
  const header = 16
  const codesBytes = count * 4
  const sigBytes = count * 8
  const vecBytes = count * GRID * GRID * 4
  const buf = Buffer.alloc(header + codesBytes + sigBytes + vecBytes)
  buf.write(CACHE_MAGIC, 0, 'ascii')
  buf.writeUInt32LE(CACHE_VERSION, 4)
  buf.writeUInt32LE(count, 8)
  buf.writeUInt32LE(GRID, 12)
  items.forEach((item, index) => {
    buf.writeUInt32LE(item.codepoint, header + index * 4)
    Buffer.from(item.sig).copy(buf, header + codesBytes + index * 8)
    Buffer.from(item.vec.buffer, item.vec.byteOffset, item.vec.byteLength).copy(
      buf,
      header + codesBytes + sigBytes + index * GRID * GRID * 4
    )
  })
  return buf
}

export function decodeGlyphCache(buf: Buffer): GlyphCandidate[] {
  if (buf.length < 16 || buf.toString('ascii', 0, 4) !== CACHE_MAGIC) throw new Error('字形缓存损坏')
  if (buf.readUInt32LE(4) !== CACHE_VERSION || buf.readUInt32LE(12) !== GRID) throw new Error('字形缓存版本不符')
  const count = buf.readUInt32LE(8)
  const header = 16
  const expected = header + count * 4 + count * 8 + count * GRID * GRID * 4
  if (buf.length !== expected) throw new Error('字形缓存长度不符')
  const items: GlyphCandidate[] = []
  for (let index = 0; index < count; index++) {
    const codepoint = buf.readUInt32LE(header + index * 4)
    const sig = Uint8Array.from(buf.subarray(header + count * 4 + index * 8, header + count * 4 + index * 8 + 8))
    const start = header + count * 4 + count * 8 + index * GRID * GRID * 4
    const vec = new Float32Array(GRID * GRID)
    for (let i = 0; i < vec.length; i++) vec[i] = buf.readFloatLE(start + i * 4)
    items.push({ codepoint, char: String.fromCodePoint(codepoint), vec, sig })
  }
  return items
}

let standardPromise: Promise<GlyphCandidate[]> | null = null

export function loadStandardGlyphs(
  cacheDir: string,
  onProgress?: (message: string) => void
): Promise<GlyphCandidate[]> {
  if (!standardPromise) {
    standardPromise = readOrBuildStandard(cacheDir, onProgress).catch((err) => {
      standardPromise = null
      throw err
    })
  }
  return standardPromise
}

async function readOrBuildStandard(
  cacheDir: string,
  onProgress?: (message: string) => void
): Promise<GlyphCandidate[]> {
  const file = cacheFile(cacheDir)
  try {
    const buf = await fs.readFile(file)
    const items = decodeGlyphCache(buf)
    if (items.length > 1000) return items
  } catch {
    // 没有缓存或缓存坏了，下面重建。
  }
  const draw = await canvasOf()
  const families = await ensureReferenceFamilies(
    cacheDir,
    (family) => familyRenders(draw, family),
    (family, file) => fontLibrary?.use(family, [file]),
    onProgress
  )
  onProgress?.('第一次要建立汉字点阵，大约需要一分钟')
  const codes = candidateCodepoints()
  const items: GlyphCandidate[] = []
  for (const family of families) {
    for (let index = 0; index < codes.length; index++) {
      const rendered = renderGlyph(draw, String.fromCodePoint(codes[index]), family)
      if (rendered) {
        items.push({ codepoint: codes[index], char: String.fromCodePoint(codes[index]), ...rendered })
      }
      if (index > 0 && index % 800 === 0) {
        onProgress?.(`正在建立汉字点阵 ${index}/${codes.length}`)
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
  }
  if (items.length < 1000) throw new Error('没有可用的汉字对照字体，无法还原番茄字体')
  await fs.mkdir(cacheDir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, encodeGlyphCache(items))
  await fs.rename(tmp, file)
  return items
}

const mapCache = new Map<string, Map<number, string>>()

export async function decryptPrivateChars(
  fontBytes: Buffer,
  chars: string[],
  cacheDir: string,
  onProgress?: (message: string) => void
): Promise<Map<number, string>> {
  const hash = createHash('sha256').update(fontBytes).digest('hex')
  return withFileLock(path.join(cacheDir, 'fonts', hash), async () => {
    const memory = mapCache.get(hash)
    if (memory && chars.every((ch) => memory.has(ch.charCodeAt(0)))) return memory
    const mapFile = path.join(cacheDir, 'fonts', `${hash}.json`)
    const saved: Record<string, string> = {}
    try {
      Object.assign(saved, JSON.parse(await fs.readFile(mapFile, 'utf8')) as Record<string, string>)
    } catch {
      // 这套字体还没对照过。
    }
    const missing = chars.filter((ch) => !(String(ch.charCodeAt(0)) in saved))
    if (missing.length > 0) {
      const standards = await loadStandardGlyphs(cacheDir, onProgress)
      const draw = await canvasOf()
      const family = `fanqie${hash.slice(0, 12)}`
      if (!loadedFamilies.has(family)) {
        const fontPath = path.join(cacheDir, 'fonts', `${hash}.woff`)
        await fs.mkdir(path.dirname(fontPath), { recursive: true })
        await fs.writeFile(fontPath, fontBytes)
        fontLibrary?.use(family, [fontPath])
        loadedFamilies.add(family)
      }
      onProgress?.(`正在还原 ${missing.length} 个加密字`)
      for (const [index, ch] of missing.entries()) {
        const code = String(ch.charCodeAt(0))
        const rendered = renderGlyph(draw, ch, family)
        saved[code] = rendered ? matchGlyph(rendered, standards) ?? '' : ''
        if (index > 0 && index % 30 === 0) await new Promise((resolve) => setImmediate(resolve))
      }
      await fs.mkdir(path.dirname(mapFile), { recursive: true })
      await fs.writeFile(mapFile, JSON.stringify(saved))
    }
    const map = new Map<number, string>()
    for (const [code, value] of Object.entries(saved)) {
      if (value) map.set(Number(code), value)
      else map.set(Number(code), '')
    }
    mapCache.set(hash, map)
    return map
  })
}
