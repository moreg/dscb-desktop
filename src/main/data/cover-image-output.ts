import { Canvas, loadImage } from 'skia-canvas'
import type { CoverCropOptions } from '../../shared/types'

const MAX_IMAGE_BYTES = 50 * 1024 * 1024
const MAX_IMAGE_PIXELS = 40_000_000
export const DEFAULT_COVER_CROP: CoverCropOptions = { offsetX: 0.5, offsetY: 0.5, fit: 'cover' }

export interface DecodedCoverImage {
  png: Buffer
  width: number
  height: number
}

/** 在创建正式版本前解码，保存完整像素为 PNG，不把任意字符串当成成品。 */
export async function decodeCoverImage(base64: string): Promise<DecodedCoverImage> {
  if (typeof base64 !== 'string' || !base64.length || base64.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 === 1) {
    throw new Error('COVER_INVALID_IMAGE: 图像服务没有返回有效的图片数据')
  }
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('COVER_INVALID_IMAGE: 图片数据大小无效')
  try {
    const image = await loadImage(bytes)
    if (image.width < 3 || image.height < 4 || image.width * image.height > MAX_IMAGE_PIXELS) {
      throw new Error('图片尺寸过小或超过处理上限')
    }
    const canvas = new Canvas(image.width, image.height)
    canvas.getContext('2d').drawImage(image, 0, 0)
    return { png: await canvas.toBuffer('png'), width: image.width, height: image.height }
  } catch (error) {
    throw new Error('COVER_INVALID_IMAGE: 返回数据无法解码为可用图片', { cause: error })
  }
}

/** 主成品保持 3:4，并限制在原图像素以内；低清原图不悄悄放大成高清。 */
export function coverOutputSize(width: number, height: number): string {
  const unit = Math.floor(Math.min(width / 3, height / 4, 341))
  if (unit < 1) throw new Error('COVER_INVALID_IMAGE: 原图尺寸不足以生成封面')
  return `${unit * 3}x${unit * 4}`
}

export function validateCoverCrop(input: Partial<CoverCropOptions>): CoverCropOptions {
  const options = { ...DEFAULT_COVER_CROP, ...input }
  if (!Number.isFinite(options.offsetX) || !Number.isFinite(options.offsetY) ||
    options.offsetX < 0 || options.offsetX > 1 || options.offsetY < 0 || options.offsetY > 1 ||
    !['cover', 'contain'].includes(options.fit)) throw new Error('COVER_INVALID_CROP: 裁剪参数无效')
  return options
}

export async function renderCoverImage(
  png: Buffer, targetSize: string, crop: CoverCropOptions = DEFAULT_COVER_CROP
): Promise<Buffer> {
  const options = validateCoverCrop(crop)
  const [width, height] = targetSize.split('x').map(Number)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('COVER_INVALID_CROP: 成品尺寸无效')
  }
  const image = await loadImage(png)
  const scale = options.fit === 'contain'
    ? Math.min(width / image.width, height / image.height)
    : Math.max(width / image.width, height / image.height)
  const scaledWidth = image.width * scale
  const scaledHeight = image.height * scale
  const canvas = new Canvas(width, height)
  const context = canvas.getContext('2d')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  if (options.fit === 'contain') {
    context.fillStyle = '#f8f4ee'
    context.fillRect(0, 0, width, height)
  }
  context.drawImage(image, (width - scaledWidth) * options.offsetX, (height - scaledHeight) * options.offsetY, scaledWidth, scaledHeight)
  return canvas.toBuffer('png')
}
