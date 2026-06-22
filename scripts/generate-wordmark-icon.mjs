import { Canvas, loadImage } from 'skia-canvas'
import pngToIco from 'png-to-ico'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const GENERATED_MASTER = 'C:/Users/Administrator/.codex/generated_images/019ee8d4-a609-7ea3-af83-1effa9b5f804/ig_0dac57f52d5dcf3a016a3783c10e90819bb9ea39e5a52c26b6.png'
const BUILD_DIR = resolve('build')
const MASTER_PATH = resolve(BUILD_DIR, 'icon-master.png')
const OUTPUT_PNG = resolve(BUILD_DIR, 'icon.png')
const OUTPUT_ICO = resolve(BUILD_DIR, 'icon.ico')
const OUTPUT_32 = resolve(BUILD_DIR, 'icon-32-preview.png')

async function renderSquare(sourcePath, size) {
  const image = await loadImage(sourcePath)
  const canvas = new Canvas(size, size)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.clearRect(0, 0, size, size)
  ctx.drawImage(image, 0, 0, size, size)
  return canvas.toBuffer('png')
}

mkdirSync(BUILD_DIR, { recursive: true })

if (!existsSync(MASTER_PATH)) {
  copyFileSync(GENERATED_MASTER, MASTER_PATH)
}

const sizes = [256, 128, 64, 48, 32, 16]
const buffers = await Promise.all(sizes.map((size) => renderSquare(MASTER_PATH, size)))
writeFileSync(OUTPUT_PNG, buffers[0])
writeFileSync(OUTPUT_32, buffers[4])
writeFileSync(OUTPUT_ICO, await pngToIco(buffers))

console.log('icon generated from master artwork:', MASTER_PATH)
