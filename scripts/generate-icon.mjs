import { PNG } from 'pngjs'
import pngToIco from 'png-to-ico'
import { mkdirSync, writeFileSync } from 'fs'

function makePng(size) {
  const png = new PNG({ width: size, height: size })
  const cx = size / 2
  const cy = size / 2
  const rOuter = size * 0.30
  const rInner = size * 0.20
  const rOuter2 = rOuter * rOuter
  const rInner2 = rInner * rInner
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) << 2
      const dx = x - cx
      const dy = y - cy
      const d2 = dx * dx + dy * dy
      if (d2 < rInner2) {
        // 中心亮白
        png.data[idx] = 0xff
        png.data[idx + 1] = 0xff
        png.data[idx + 2] = 0xff
      } else if (d2 < rOuter2) {
        // 环带 violet #7c3aed（笔尖渐层）
        png.data[idx] = 0x7c
        png.data[idx + 1] = 0x3a
        png.data[idx + 2] = 0xed
      } else {
        // 背景 indigo #4f46e5
        png.data[idx] = 0x4f
        png.data[idx + 1] = 0x46
        png.data[idx + 2] = 0xe5
      }
      png.data[idx + 3] = 0xff
    }
  }
  return PNG.sync.write(png)
}

mkdirSync('build', { recursive: true })
const sizes = [256, 128, 64, 48, 32, 16]
const buffers = sizes.map(makePng)
writeFileSync('build/icon.png', buffers[0])
const ico = await pngToIco(buffers)
writeFileSync('build/icon.ico', ico)
console.log('icon generated: build/icon.ico, build/icon.png')
