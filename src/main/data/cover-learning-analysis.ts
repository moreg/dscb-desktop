import { createHash } from 'crypto'

export interface CoverVisualMetrics {
  width: number
  height: number
  aspectRatio: number
  averageRgb: [number, number, number]
  luminance: number
  saturation: number
  contrast: number
  warmth: number
  detailByBand: [number, number, number]
  dominantColor: string
  colorFamilies?: Array<{ color: string; share: number }>
  perceptualHash: string
  visualFingerprint: string
}

/** Low resolution is deliberately a conservative filter, not a quality score. */
export function coverRejectionReason(metrics: CoverVisualMetrics): string | null {
  if (metrics.aspectRatio >= 1) return '横版或正方形图片，请选择竖版小说封面'
  if (metrics.width < 120 || metrics.height < 160) return '分辨率过低，封面至少需要 120 × 160 像素'
  if (metrics.contrast < 0.005) return '图片几乎为纯色，没有可用于封面学习的视觉结构'
  return null
}

export async function analyzeCover(filePath: string): Promise<CoverVisualMetrics> {
  const { Canvas, loadImage } = await import('skia-canvas')
  const image = await loadImage(filePath)
  if (!image.width || !image.height) throw new Error('图片尺寸无效')
  const width = 72
  const height = 128
  const canvas = new Canvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0, width, height)
  const pixels = ctx.getImageData(0, 0, width, height).data
  const luminances = new Float64Array(width * height)
  const colors = new Map<string, number>()
  let red = 0
  let green = 0
  let blue = 0
  let luminance = 0
  let saturation = 0
  for (let index = 0, pixel = 0; index < pixels.length; index += 4, pixel++) {
    const r = pixels[index] / 255
    const g = pixels[index + 1] / 255
    const b = pixels[index + 2] / 255
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    red += r
    green += g
    blue += b
    luminance += lum
    saturation += max === 0 ? 0 : (max - min) / max
    luminances[pixel] = lum
    const color = classifyColor(pixels[index], pixels[index + 1], pixels[index + 2])
    colors.set(color, (colors.get(color) ?? 0) + 1)
  }
  const count = width * height
  const mean = luminance / count
  let variance = 0
  const detailSum = [0, 0, 0]
  const detailCount = [0, 0, 0]
  for (let y = 0; y < height; y++) {
    const band = Math.min(2, Math.floor((y / height) * 3))
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      variance += (luminances[index] - mean) ** 2
      if (x > 0) {
        detailSum[band] += Math.abs(luminances[index] - luminances[index - 1])
        detailCount[band]++
      }
      if (y > 0) {
        detailSum[band] += Math.abs(luminances[index] - luminances[index - width])
        detailCount[band]++
      }
    }
  }
  const averageRgb: [number, number, number] = [
    Math.round(red / count * 255), Math.round(green / count * 255), Math.round(blue / count * 255)
  ]
  const colorFamilies = [...colors.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([color, frequency]) => ({ color, share: roundMetric(frequency / count) }))
  return {
    width: image.width,
    height: image.height,
    aspectRatio: image.width / image.height,
    averageRgb,
    luminance: roundMetric(mean),
    saturation: roundMetric(saturation / count),
    contrast: roundMetric(Math.sqrt(variance / count)),
    warmth: roundMetric((averageRgb[0] - averageRgb[2]) / 255),
    detailByBand: detailSum.map((value, index) => roundMetric(value / Math.max(1, detailCount[index]))) as [number, number, number],
    dominantColor: colorFamilies[0]?.color ?? 'neutral',
    colorFamilies,
    perceptualHash: buildPerceptualHash(luminances, width, height),
    visualFingerprint: buildNormalizedVisualFingerprint(pixels, width, height)
  }
}

function buildNormalizedVisualFingerprint(pixels: Uint8ClampedArray, width: number, height: number): string {
  const blocksX = 18
  const blocksY = 32
  const signature = Buffer.alloc(blocksX * blocksY * 3)
  let output = 0
  for (let blockY = 0; blockY < blocksY; blockY++) {
    const startY = Math.floor(blockY / blocksY * height)
    const endY = Math.max(startY + 1, Math.floor((blockY + 1) / blocksY * height))
    for (let blockX = 0; blockX < blocksX; blockX++) {
      const startX = Math.floor(blockX / blocksX * width)
      const endX = Math.max(startX + 1, Math.floor((blockX + 1) / blocksX * width))
      const sum = [0, 0, 0]
      let count = 0
      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const index = (y * width + x) * 4
          sum[0] += pixels[index]
          sum[1] += pixels[index + 1]
          sum[2] += pixels[index + 2]
          count++
        }
      }
      for (const value of sum) signature[output++] = Math.round(value / count)
    }
  }
  return createHash('sha256').update(signature).digest('hex')
}

function buildPerceptualHash(luminances: Float64Array, width: number, height: number): string {
  let bits = ''
  for (let y = 0; y < 8; y++) {
    const sourceY = Math.min(height - 1, Math.round((y + 0.5) / 8 * height))
    for (let x = 0; x < 8; x++) {
      const leftX = Math.min(width - 1, Math.round(x / 9 * width))
      const rightX = Math.min(width - 1, Math.round((x + 1) / 9 * width))
      bits += luminances[sourceY * width + leftX] > luminances[sourceY * width + rightX] ? '1' : '0'
    }
  }
  let hex = ''
  for (let index = 0; index < bits.length; index += 4) hex += Number.parseInt(bits.slice(index, index + 4), 2).toString(16)
  return hex.padStart(16, '0')
}

function roundMetric(value: number): number { return Math.round(value * 10_000) / 10_000 }

function classifyColor(r255: number, g255: number, b255: number): string {
  const r = r255 / 255
  const g = g255 / 255
  const b = b255 / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (max < 0.15) return 'black'
  if (delta < 0.1) return max > 0.78 ? 'white' : 'neutral'
  let hue: number
  if (max === r) hue = 60 * (((g - b) / delta) % 6)
  else if (max === g) hue = 60 * ((b - r) / delta + 2)
  else hue = 60 * ((r - g) / delta + 4)
  if (hue < 0) hue += 360
  if (hue < 20 || hue >= 345) return 'red'
  if (hue < 50) return 'orange'
  if (hue < 75) return 'yellow'
  if (hue < 165) return 'green'
  if (hue < 200) return 'cyan'
  if (hue < 260) return 'blue'
  if (hue < 300) return 'purple'
  return 'magenta'
}
