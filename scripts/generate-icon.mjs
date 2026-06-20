import { PNG } from 'pngjs'
import pngToIco from 'png-to-ico'
import { mkdirSync, writeFileSync } from 'fs'

/**
 * 印章 / 篆刻方块图标。
 * 圆角方印 + 双线回纹 + 四个抽象篆字方块 + 朱砂高光 + 右下磨痕。
 * 调色：朱红主 + 深红边 + 暖白篆字（与 app indigo/violet 主色形成暖色对比）。
 */

const RED_MAIN = [0xc0, 0x39, 0x2b]      // 朱砂红主色
const RED_DARK = [0x8e, 0x2c, 0x20]      // 深红边框
const RED_HI = [0xe5, 0x5d, 0x4f]        // 高光红
const SEAL_WHITE = [0xfe, 0xf5, 0xe7]    // 宣纸暖白（篆字）
const SEAL_SHADOW = [0xc9, 0x69, 0x5a]    // 篆字轻投影

function setPx(png, x, y, size, [r, g, b], a = 0xff) {
  if (x < 0 || x >= size || y < 0 || y >= size) return
  const idx = (size * y + x) << 2
  // 主体未绘制（alpha=0）的位置直接跳过，避免高光/磨痕画到主体外
  if (a < 0xff && png.data[idx + 3] === 0) return
  png.data[idx] = r
  png.data[idx + 1] = g
  png.data[idx + 2] = b
  png.data[idx + 3] = Math.max(png.data[idx + 3], a)
}
function blend(bg, fg, alpha) {
  // alpha 0-1
  return [
    Math.round(bg[0] * (1 - alpha) + fg[0] * alpha),
    Math.round(bg[1] * (1 - alpha) + fg[1] * alpha),
    Math.round(bg[2] * (1 - alpha) + fg[2] * alpha)
  ]
}

function makePng(size) {
  const png = new PNG({ width: size, height: size })

  // 1) 透明背景
  for (let i = 0; i < png.data.length; i += 4) png.data[i + 3] = 0

  // 2) 圆角方印主体（圆角半径 ≈ size*0.06，小圆角=真印章感）
  const cx = size / 2
  const cy = size / 2
  const half = size * 0.40
  const r = size * 0.06
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.abs(x - cx) - (half - r)
      const dy = Math.abs(y - cy) - (half - r)
      let inside = false
      if (dx <= 0 && dy <= 0) inside = true
      else if (dx > 0 && dy <= 0 && dx <= r) {
        const cy2 = Math.max(0, r - dx)
        inside = (x - (cx + half - r)) ** 2 + (y - cy) ** 2 <= cy2 * cy2 ||
                 (x - (cx - half + r)) ** 2 + (y - cy) ** 2 <= cy2 * cy2
      } else if (dy > 0 && dx <= 0 && dy <= r) {
        const cx2 = Math.max(0, r - dy)
        inside = (y - (cy + half - r)) ** 2 + (x - cx) ** 2 <= cx2 * cx2 ||
                 (y - (cy - half + r)) ** 2 + (x - cx) ** 2 <= cx2 * cx2
      } else if (dx > 0 && dy > 0 && dx <= r && dy <= r) {
        const cx2 = cx + half - r
        const cy2 = cy + half - r
        if ((x - cx2) ** 2 + (y - cy2) ** 2 <= r * r) inside = true
        else if ((x - (cx - half + r)) ** 2 + (y - cy2) ** 2 <= r * r) inside = true
        else if ((x - cx2) ** 2 + (y - (cy - half + r)) ** 2 <= r * r) inside = true
        else if ((x - (cx - half + r)) ** 2 + (y - (cy - half + r)) ** 2 <= r * r) inside = true
      }
      if (inside) setPx(png, x, y, size, RED_MAIN)
    }
  }

  // 3) 左上 → 右下斜向高光（让印章有微微立体/朱砂湿润感）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) << 2
      if (png.data[idx + 3] === 0) continue
      // 沿对角线渐变：左上更亮（0.15 alpha 高光），右下不变
      const t = (x + y) / (size * 2) // 0(左上) → 1(右下)
      const a = Math.max(0, 0.18 * (1 - t * 1.4))
      png.data[idx] = Math.round(png.data[idx] * (1 - a) + RED_HI[0] * a)
      png.data[idx + 1] = Math.round(png.data[idx + 1] * (1 - a) + RED_HI[1] * a)
      png.data[idx + 2] = Math.round(png.data[idx + 2] * (1 - a) + RED_HI[2] * a)
    }
  }

  // 4) 一道内框装饰（距主体边缘 5%）
  const drawInnerRect = (offset) => {
    const half2 = half - offset
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = Math.abs(x - cx) - (half2 - r)
        const dy = Math.abs(y - cy) - (half2 - r)
        let onEdge = false
        if (Math.abs(x - cx) <= half2 && Math.abs(y - cy) <= half2) {
          if (
            (Math.abs(x - (cx + half2)) < 1.0 && Math.abs(y - cy) <= half2) ||
            (Math.abs(x - (cx - half2)) < 1.0 && Math.abs(y - cy) <= half2) ||
            (Math.abs(y - (cy + half2)) < 1.0 && Math.abs(x - cx) <= half2) ||
            (Math.abs(y - (cy - half2)) < 1.0 && Math.abs(x - cx) <= half2)
          ) onEdge = true
        }
        if (!onEdge && dx > 0 && dy > 0 && dx <= r + 1.0 && dy <= r + 1.0) {
          for (const [sx, sy] of [
            [cx + half2 - r, cy + half2 - r],
            [cx - half2 + r, cy + half2 - r],
            [cx + half2 - r, cy - half2 + r],
            [cx - half2 + r, cy - half2 + r]
          ]) {
            const d = Math.sqrt((x - sx) ** 2 + (y - sy) ** 2)
            if (Math.abs(d - r) < 1.0) onEdge = true
          }
        }
        if (onEdge) {
          const idx = (size * y + x) << 2
          if (png.data[idx + 3] !== 0) {
            png.data[idx] = RED_DARK[0]
            png.data[idx + 1] = RED_DARK[1]
            png.data[idx + 2] = RED_DARK[2]
          }
        }
      }
    }
  }
  drawInnerRect(size * 0.05)

  // 5) 中心 2 个篆字方块（左右各一个，更大更清楚）
  //    左「持」感：横 + 田字框；右「笔」感：点 + 横 + 竖 + 横
  //    各占半印（左右各 36% 宽，中间留 4% 间隔）
  const writePx = (x, y) => {
    const idx = (size * y + x) << 2
    if (png.data[idx + 3] === 0) return
    setPx(png, x, y, size, SEAL_WHITE)
  }
  const drawGlyph = (gx, gy, gw, gh, glyph) => {
    const draw = (rx, ry, rw, rh) => {
      const x0 = Math.round(gx + rx * gw)
      const y0 = Math.round(gy + ry * gh)
      const x1 = Math.round(gx + (rx + rw) * gw)
      const y1 = Math.round(gy + (ry + rh) * gh)
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) writePx(x, y)
      }
    }
    // 笔画（实心矩形）
    for (const [rx, ry, rw, rh] of glyph.rects) draw(rx, ry, rw, rh)
    // 边框（口字 / 田字），画四边
    if (glyph.borders) {
      for (const [bx, by, bw, bh] of glyph.borders) {
        const t = Math.max(1, Math.round(size * 0.028))
        const x0 = Math.round(gx + bx * gw)
        const y0 = Math.round(gy + by * gh)
        const x1 = Math.round(gx + (bx + bw) * gw)
        const y1 = Math.round(gy + (by + bh) * gh)
        for (let i = 0; i < t; i++) {
          for (let x = x0; x < x1; x++) {
            writePx(x, y0 + i)
            writePx(x, y1 - 1 - i)
          }
          for (let y = y0; y < y1; y++) {
            writePx(x0 + i, y)
            writePx(x1 - 1 - i, y)
          }
        }
      }
    }
  }

  // 左半印：「持」字形 — 上横 + 下田字框
  const leftGlyph = {
    rects: [[0.18, 0.10, 0.64, 0.10]],  // 顶横
    borders: [[0.20, 0.28, 0.60, 0.60]]  // 下田字框
  }
  // 右半印：「笔」字形 — 顶部点 + 中横 + 竖 + 底横
  const rightGlyph = {
    rects: [
      [0.50, 0.08, 0.12, 0.12],  // 顶部点
      [0.14, 0.28, 0.72, 0.09],  // 中横
      [0.38, 0.38, 0.10, 0.52],  // 中竖
      [0.14, 0.88, 0.72, 0.10]   // 底横
    ]
  }

  // 整体左半 + 右半
  const halfW = size * 0.36
  const startY = cy - size * 0.30
  const startXLeft = cx - size * 0.38
  const startXRight = cx + size * 0.02
  drawGlyph(startXLeft, startY, halfW, size * 0.60, leftGlyph)
  drawGlyph(startXRight, startY, halfW, size * 0.60, rightGlyph)

  // 6) 右下角轻微「残红」磨痕（少量）
  for (let i = 0; i < Math.floor(size * 1.2); i++) {
    const x = Math.floor(cx + size * 0.18 + Math.random() * size * 0.12)
    const y = Math.floor(cy + size * 0.18 + Math.random() * size * 0.14)
    if (x >= size || y >= size) continue
    const idx = (size * y + x) << 2
    if (png.data[idx + 3] === 0) continue
    if (Math.random() < 0.6) {
      png.data[idx] = Math.max(0, png.data[idx] - 35)
      png.data[idx + 1] = Math.max(0, png.data[idx + 1] - 35)
      png.data[idx + 2] = Math.max(0, png.data[idx + 2] - 35)
    }
  }

  // 7) 左上角实心小高光（朱砂湿润感）
  const hiX = Math.round(cx - size * 0.32)
  const hiY = Math.round(cy - size * 0.32)
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      if (dx * dx + dy * dy > 9) continue
      setPx(png, hiX + dx, hiY + dy, size, RED_HI, 0xc0)
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
