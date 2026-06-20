import { PNG } from 'pngjs'
import pngToIco from 'png-to-ico'
import { mkdirSync, writeFileSync } from 'fs'

/**
 * 打开的书 + 斜放钢笔
 * 圆角方形背景(深紫→紫红渐变)+ 翻开的书本(米色页面 + 文字线)+ 金尖钢笔 + 星点装饰
 * 设计原则:文学感、温暖、精致
 */

// 配色:温暖文学风
const BG_TOP = [0x2a, 0x18, 0x4d]     // 深紫
const BG_BOT = [0x6b, 0x21, 0x54]     // 紫红
const BOOK_PAGE = [0xf5, 0xeb, 0xd0]  // 米色书页
const BOOK_PAGE_DK = [0xd9, 0xc9, 0xa3] // 书页暗部
const BOOK_SPINE = [0x7a, 0x52, 0x2d] // 书脊棕
const TEXT_LINE = [0x9b, 0x8a, 0x6a]  // 文字线
const PEN_BODY = [0x1f, 0x29, 0x37]   // 深色笔杆
const PEN_HI = [0x3a, 0x4a, 0x62]     // 笔杆高光
const PEN_CAP = [0x12, 0x1a, 0x24]    // 笔尾深色
const PEN_NIB = [0xe6, 0xc2, 0x4a]    // 金色笔尖
const PEN_NIB_DK = [0xb8, 0x90, 0x20] // 金色暗部
const SLIT = [0x0a, 0x0a, 0x14]       // 笔尖缝
const STAR = [0xff, 0xe6, 0x80]       // 星点金色

function setPx(png, x, y, size, [r, g, b], a = 0xff) {
  if (x < 0 || x >= size || y < 0 || y >= size) return
  const idx = (size * y + x) << 2
  if (a < 0xff && png.data[idx + 3] === 0) return
  png.data[idx] = r
  png.data[idx + 1] = g
  png.data[idx + 2] = b
  png.data[idx + 3] = Math.max(png.data[idx + 3], a)
}

function fillCircle(png, size, cx, cy, r, color) {
  const r2 = r * r
  const x0 = Math.max(0, Math.floor(cx - r))
  const x1 = Math.min(size - 1, Math.ceil(cx + r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const y1 = Math.min(size - 1, Math.ceil(cy + r))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= r2) setPx(png, x, y, size, color)
    }
  }
}

/** 填一个凸多边形(shoelace 扫描线) */
function fillPolygon(png, size, pts, color) {
  let minY = Infinity, maxY = -Infinity
  for (const [, y] of pts) {
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  minY = Math.max(0, Math.floor(minY))
  maxY = Math.min(size - 1, Math.ceil(maxY))
  for (let y = minY; y <= maxY; y++) {
    let left = Infinity
    let right = -Infinity
    const n = pts.length
    for (let i = 0; i < n; i++) {
      const [ax, ay] = pts[i]
      const [bx, by] = pts[(i + 1) % n]
      if ((ay <= y && by > y) || (by <= y && ay > y)) {
        const t = (y - ay) / (by - ay)
        const x = ax + t * (bx - ax)
        if (x < left) left = x
        if (x > right) right = x
      }
    }
    if (left <= right) {
      for (let x = Math.ceil(left); x <= Math.floor(right); x++) setPx(png, x, y, size, color)
    }
  }
}

/** 圆角矩形检测 */
function inRoundedRect(x, y, size, r) {
  if (x < 0 || x >= size || y < 0 || y >= size) return false
  const inCornerX = (x < r) || (x > size - 1 - r)
  const inCornerY = (y < r) || (y > size - 1 - r)
  if (!inCornerX || !inCornerY) return true
  const ccx = x < r ? r : size - 1 - r
  const ccy = y < r ? r : size - 1 - r
  const dx = x - ccx
  const dy = y - ccy
  return dx * dx + dy * dy <= r * r
}

/** 旋转多边形并填充(本地坐标→世界坐标) */
function fillPolygonRotated(png, size, pts, color, cx, cy, angle) {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const rotated = pts.map(([x, y]) => [
    cx + x * cos - y * sin,
    cy + x * sin + y * cos
  ])
  fillPolygon(png, size, rotated, color)
}

/** 旋转圆并填充 */
function fillCircleRotated(png, size, lx, ly, r, color, cx, cy, angle) {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const wx = cx + lx * cos - ly * sin
  const wy = cy + lx * sin + ly * cos
  fillCircle(png, size, wx, wy, r, color)
}

function makePng(size) {
  const png = new PNG({ width: size, height: size })
  const cx = size / 2
  const cy = size / 2

  // 1) 圆角方形背景:深紫→紫红渐变
  const radius = size * 0.16
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRoundedRect(x, y, size, radius)) continue
      const t = y / size
      const idx = (size * y + x) << 2
      png.data[idx] = Math.round(BG_TOP[0] * (1 - t) + BG_BOT[0] * t)
      png.data[idx + 1] = Math.round(BG_TOP[1] * (1 - t) + BG_BOT[1] * t)
      png.data[idx + 2] = Math.round(BG_TOP[2] * (1 - t) + BG_BOT[2] * t)
      png.data[idx + 3] = 0xff
    }
  }

  // 2) 背景星点装饰
  fillCircle(png, size, cx - size * 0.30, cy - size * 0.32, size * 0.012, STAR)
  fillCircle(png, size, cx + size * 0.32, cy - size * 0.28, size * 0.010, STAR)
  fillCircle(png, size, cx - size * 0.34, cy + size * 0.05, size * 0.008, STAR)
  fillCircle(png, size, cx + size * 0.34, cy + size * 0.10, size * 0.009, STAR)

  // 3) 打开的书本(中下部)
  const bookCx = cx
  const bookCy = cy + size * 0.14
  const bookW = size * 0.58
  const bookH = size * 0.26

  // 书本投影(柔和阴影)
  const shadow = [
    [bookCx - bookW / 2 - size * 0.015, bookCy + bookH * 0.85],
    [bookCx + bookW / 2 + size * 0.015, bookCy + bookH * 0.85],
    [bookCx + bookW / 2 + size * 0.03, bookCy + bookH * 1.02],
    [bookCx - bookW / 2 - size * 0.03, bookCy + bookH * 1.02]
  ]
  fillPolygon(png, size, shadow, [0x1a, 0x0d, 0x2a])

  // 左页(梯形:书脊在中间最高)
  const leftPage = [
    [bookCx - bookW / 2, bookCy + bookH * 0.20],
    [bookCx, bookCy],
    [bookCx, bookCy + bookH],
    [bookCx - bookW / 2, bookCy + bookH * 0.80]
  ]
  fillPolygon(png, size, leftPage, BOOK_PAGE)

  // 右页
  const rightPage = [
    [bookCx, bookCy],
    [bookCx + bookW / 2, bookCy + bookH * 0.20],
    [bookCx + bookW / 2, bookCy + bookH * 0.80],
    [bookCx, bookCy + bookH]
  ]
  fillPolygon(png, size, rightPage, BOOK_PAGE)

  // 右页暗部(右侧轻微阴影,增加立体感)
  const rightPageDk = [
    [bookCx + bookW * 0.30, bookCy + bookH * 0.24],
    [bookCx + bookW / 2, bookCy + bookH * 0.20],
    [bookCx + bookW / 2, bookCy + bookH * 0.80],
    [bookCx + bookW * 0.30, bookCy + bookH * 0.76]
  ]
  fillPolygon(png, size, rightPageDk, BOOK_PAGE_DK)

  // 书脊(中间 V 形凹陷)
  const spine = [
    [bookCx - size * 0.006, bookCy],
    [bookCx + size * 0.006, bookCy],
    [bookCx + size * 0.004, bookCy + bookH],
    [bookCx - size * 0.004, bookCy + bookH]
  ]
  fillPolygon(png, size, spine, BOOK_SPINE)

  // 页面文字线(左页)
  for (let i = 0; i < 4; i++) {
    const ly = bookCy + bookH * 0.28 + i * bookH * 0.15
    const lx1 = bookCx - bookW * 0.44
    const lx2 = bookCx - bookW * 0.10
    const line = [
      [lx1, ly],
      [lx2, ly],
      [lx2, ly + Math.max(1, size * 0.008)],
      [lx1, ly + Math.max(1, size * 0.008)]
    ]
    fillPolygon(png, size, line, TEXT_LINE)
  }
  // 右页文字线
  for (let i = 0; i < 4; i++) {
    const ly = bookCy + bookH * 0.28 + i * bookH * 0.15
    const lx1 = bookCx + bookW * 0.10
    const lx2 = bookCx + bookW * 0.44
    const line = [
      [lx1, ly],
      [lx2, ly],
      [lx2, ly + Math.max(1, size * 0.008)],
      [lx1, ly + Math.max(1, size * 0.008)]
    ]
    fillPolygon(png, size, line, TEXT_LINE)
  }

  // 4) 钢笔(斜放在书上方,笔尖朝右下指向书页)
  //    本地坐标系:笔尾在左,笔尖在右;旋转 +28° 后笔尖指向右下
  const penCx = cx - size * 0.04
  const penCy = cy - size * 0.10
  const penAngle = 28 * Math.PI / 180

  const bodyLen = size * 0.40
  const bodyW = size * 0.052   // 笔杆半宽
  const nibLen = size * 0.085
  const nibW = size * 0.048

  // 笔尾圆头(深色帽)
  fillCircleRotated(png, size, -bodyLen / 2, 0, bodyW * 0.95, PEN_CAP, penCx, penCy, penAngle)

  // 笔杆(收腰梯形:笔尾略细,中段粗,接笔尖处收窄)
  const penBody = [
    [-bodyLen / 2 + size * 0.005, -bodyW * 0.75],
    [-bodyLen * 0.05, -bodyW],
    [bodyLen / 2 - nibLen * 0.4, -bodyW * 0.85],
    [bodyLen / 2 - nibLen * 0.4, bodyW * 0.85],
    [-bodyLen * 0.05, bodyW],
    [-bodyLen / 2 + size * 0.005, bodyW * 0.75]
  ]
  fillPolygonRotated(png, size, penBody, PEN_BODY, penCx, penCy, penAngle)

  // 笔杆高光(上沿细亮线)
  const penHi = [
    [-bodyLen * 0.35, -bodyW * 0.55],
    [bodyLen * 0.30, -bodyW * 0.62],
    [bodyLen * 0.30, -bodyW * 0.40],
    [-bodyLen * 0.35, -bodyW * 0.35]
  ]
  fillPolygonRotated(png, size, penHi, PEN_HI, penCx, penCy, penAngle)

  // 笔尖(金色三角)
  const penNib = [
    [bodyLen / 2 - nibLen * 0.4, -nibW],
    [bodyLen / 2 + nibLen, 0],
    [bodyLen / 2 - nibLen * 0.4, nibW]
  ]
  fillPolygonRotated(png, size, penNib, PEN_NIB, penCx, penCy, penAngle)

  // 笔尖下半暗部(金属质感)
  const penNibDk = [
    [bodyLen / 2 - nibLen * 0.4, nibW * 0.15],
    [bodyLen / 2 + nibLen * 0.55, 0],
    [bodyLen / 2 - nibLen * 0.4, nibW]
  ]
  fillPolygonRotated(png, size, penNibDk, PEN_NIB_DK, penCx, penCy, penAngle)

  // 笔尖中缝(劈尖)
  const slitPts = [
    [bodyLen / 2 - nibLen * 0.3, -size * 0.004],
    [bodyLen / 2 + nibLen * 0.88, 0],
    [bodyLen / 2 - nibLen * 0.3, size * 0.004]
  ]
  fillPolygonRotated(png, size, slitPts, SLIT, penCx, penCy, penAngle)

  // 笔尖呼吸孔(小圆点)
  fillCircleRotated(png, size, bodyLen / 2 - nibLen * 0.15, 0, size * 0.008, SLIT, penCx, penCy, penAngle)

  return PNG.sync.write(png)
}

mkdirSync('build', { recursive: true })
const sizes = [256, 128, 64, 48, 32, 16]
const buffers = sizes.map(makePng)
writeFileSync('build/icon.png', buffers[0])
const ico = await pngToIco(buffers)
writeFileSync('build/icon.ico', ico)
console.log('icon generated: build/icon.ico, build/icon.png')
