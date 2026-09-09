import { PNG } from 'pngjs'
import pngToIco from 'png-to-ico'
import { mkdirSync, writeFileSync } from 'fs'

/**
 * 大神持笔 — 应用图标生成器（全新理念）
 *
 * 旧理念（已废弃）：黑色石板 + 金色西式钢笔，冷硬、与 App 内部宣纸/朱砂风格割裂。
 * 新理念：中式文人 · 朱砂印章
 *   · 一枚实心圆角朱印（朱砂红竖向渐变 + 内框线），像一方钤在宣纸上的名章
 *   · 阴刻「抽象笔尖」——不用汉字，用负空间留白拼出一支笔尖 / 一撇
 *   · 笔尖保留出气孔 + 中缝两个经典符号，16px 也读得出「笔」
 *   · 笔尖正下方一点留白 = 落笔的第一个字
 *   · 配色对齐 design.css：--vermilion #b8331f / --vermilion-2 #d4452e，宣纸白 #f4ebd6
 *
 * 实现：每个目标尺寸独立以 4× 超采样渲染再盒式降采样，保证小尺寸边缘干净。
 * 矢量母版见 build/icon-source.svg。
 */

// ---- 配色（印泥朱漆：深、偏绛、哑光，不橙不艳）------------------------
const SEAL_BASE = [0xa1, 0x28, 0x21] // 印面主色（近「美丽朱砂」印泥）
const SEAL_EDGE = [0x7b, 0x18, 0x16] // 四边积色（偏氧化牛血红）
const SEAL_LIFT = [0xb0, 0x35, 0x2b] // 中心极轻提亮
const PAPER_TOP = [0xf1, 0xe8, 0xd2] // 留白：象牙色，非纯白
const PAPER_BOT = [0xe1, 0xd0, 0xb0] // 留白近尖压暗
const CARVE = [0x78, 0x1c, 0x18] // 阴刻回填（比主色更沉，像刻得更深）
const FRAME = [0x5f, 0x15, 0x15] // 边栏凹槽色

const GRAIN_SEAL = 7 // 印面哑光颗粒振幅
const GRAIN_PAPER = 4 // 留白颗粒振幅

const SS = 4 // 超采样倍数
const SIZES = [256, 128, 64, 48, 32, 16]

// ---- 基础几何 ---------------------------------------------------------
function lerp(a, b, t) {
  return a + (b - a) * t
}
function lerpColor(a, b, t) {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t))
  ]
}
function smoothstep(t) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}
/** 确定性 2D 噪声，0..1；用于哑光颗粒 */
function hash2(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) ^ 0x9e3779b9
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967295
}

/** 三次贝塞尔取点 */
function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t
  const w0 = u * u * u
  const w1 = 3 * u * u * t
  const w2 = 3 * u * t * t
  const w3 = t * t * t
  return [
    w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0],
    w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1]
  ]
}

/** 把一串三次贝塞尔段采样成折线点列 */
function sampleBeziers(segments, per = 48) {
  const pts = []
  for (const [p0, p1, p2, p3] of segments) {
    for (let i = 0; i < per; i++) pts.push(bezier(p0, p1, p2, p3, i / per))
  }
  return pts
}

/** 点是否在多边形内（射线法） */
function pointInPoly(x, y, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0]
    const yi = poly[i][1]
    const xj = poly[j][0]
    const yj = poly[j][1]
    const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (hit) inside = !inside
  }
  return inside
}

/** 圆角矩形内部判定；也可用于环形（内外半径）框线 */
function inRoundedRect(x, y, x0, y0, w, h, r) {
  const x1 = x0 + w
  const y1 = y0 + h
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

// ---- 归一化坐标下的形状（0..1，原点左上，y 向下）-----------------------
// 整支笔尖绕中心旋转，成一道自右上向左下的「撇」——既是钢笔尖，也是一笔起手。
const PIVOT = [0.5, 0.5]
const NIB_ANGLE = (17 * Math.PI) / 180 // 顺时针：笔尖甩向左下
const NIB_SCALE = 1.03

function xform([x, y]) {
  const dx = (x - PIVOT[0]) * NIB_SCALE
  const dy = (y - PIVOT[1]) * NIB_SCALE
  const c = Math.cos(NIB_ANGLE)
  const s = Math.sin(NIB_ANGLE)
  return [PIVOT[0] + dx * c - dy * s, PIVOT[1] + dx * s + dy * c]
}

// 抽象笔尖轮廓（直立时）：平直顶边 → 宽肩 → 近直的内凹收窄 → 一点尖
// 左右严格对称（x 关于 0.5 镜像），旋转后自然成「撇」势
const NIB_OUTLINE = (() => {
  const topL = [0.414, 0.19]
  const topR = [0.586, 0.19]
  const tip = [0.5, 0.85]
  const shoulderR = [0.63, 0.33]
  const shoulderL = [0.37, 0.33]
  const top = sampleBeziers([[topL, [0.446, 0.172], [0.554, 0.172], topR]], 20)
  const right = sampleBeziers([
    [topR, [0.616, 0.212], [0.628, 0.268], shoulderR],
    [shoulderR, [0.63, 0.46], [0.582, 0.66], tip]
  ])
  const left = sampleBeziers([
    [tip, [0.418, 0.66], [0.37, 0.46], shoulderL],
    [shoulderL, [0.372, 0.268], [0.384, 0.212], topL]
  ])
  return top.concat(right, left).map(xform)
})()

// 中缝：自出气孔一路贯穿到笔尖，把笔尖劈成两瓣（上端封在气孔里，顶边保持完整）
const SLIT_POLY = [
  [0.487, 0.3],
  [0.513, 0.3],
  [0.504, 0.83],
  [0.496, 0.83]
].map(xform)

const BREATHER_C = xform([0.5, 0.3]) // 出气孔（中缝上端终点）
const BREATHER_R = 0.032 * NIB_SCALE

// ---- 渲染单个尺寸 ---------------------------------------------------------
function renderSize(size) {
  const S = size * SS
  const png = new PNG({ width: size, height: size })
  const acc = new Float64Array(size * size * 4)

  const radius = S * 0.172 // 更接近「一方章」的方正
  const drawFrame = size >= 40 // 极小尺寸省掉边栏，避免糊成一团
  const frameOuterInset = S * 0.062
  const frameW = S * 0.016

  const nib = NIB_OUTLINE.map(([nx, ny]) => [nx * S, ny * S])
  const slit = SLIT_POLY.map(([nx, ny]) => [nx * S, ny * S])
  const bcx = BREATHER_C[0] * S
  const bcy = BREATHER_C[1] * S
  const br = BREATHER_R * S

  let nibMinY = Infinity
  let nibMaxY = -Infinity
  for (const [, y] of nib) {
    if (y < nibMinY) nibMinY = y
    if (y > nibMaxY) nibMaxY = y
  }

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // 1) 印章圆角方形
      if (!inRoundedRect(x, y, 0, 0, S - 1, S - 1, radius)) continue

      // 1) 印面：径向渐晕——中心稍亮，四边积色（仿印泥钤压时边缘沉淀）
      const nx = x / S - 0.5
      const ny = y / S - 0.5
      const d = Math.min(1, Math.hypot(nx, ny) / 0.7)
      let col = lerpColor(SEAL_BASE, SEAL_EDGE, smoothstep(d) * 0.62)
      const lift = Math.max(0, 0.16 * (1 - d * 1.5))
      if (lift > 0) col = lerpColor(col, SEAL_LIFT, lift)
      let grain = GRAIN_SEAL

      // 2) 边栏凹槽（碑刻式：外沿压深一线，内沿提亮一线）
      if (drawFrame) {
        const inO = inRoundedRect(x, y, frameOuterInset, frameOuterInset, S - 1 - 2 * frameOuterInset, S - 1 - 2 * frameOuterInset, radius * 0.8)
        const inM = inRoundedRect(x, y, frameOuterInset + frameW, frameOuterInset + frameW, S - 1 - 2 * (frameOuterInset + frameW), S - 1 - 2 * (frameOuterInset + frameW), radius * 0.72)
        const inI = inRoundedRect(x, y, frameOuterInset + frameW * 2, frameOuterInset + frameW * 2, S - 1 - 2 * (frameOuterInset + frameW * 2), S - 1 - 2 * (frameOuterInset + frameW * 2), radius * 0.64)
        if (inO && !inM) col = lerpColor(col, FRAME, 0.5)
        else if (inM && !inI) col = lerpColor(col, SEAL_LIFT, 0.28)
      }

      // 3) 抽象笔尖留白
      if (y >= nibMinY && y <= nibMaxY && pointInPoly(x, y, nib)) {
        const nt = (y - nibMinY) / (nibMaxY - nibMinY)
        col = lerpColor(PAPER_TOP, PAPER_BOT, nt)
        grain = GRAIN_PAPER

        const ddx = x - bcx
        const ddy = y - bcy
        if (ddx * ddx + ddy * ddy <= br * br) col = CARVE.slice() // 出气孔
        if (pointInPoly(x, y, slit)) col = CARVE.slice() // 中缝：贯穿到尖
      }

      // 4) 哑光颗粒（按最终像素定位，保证降采样后仍留存）
      const fx = Math.floor(x / SS)
      const fy = Math.floor(y / SS)
      const g = (hash2(fx, fy) - 0.5) * grain

      const oi = (fy * size + fx) << 2
      acc[oi] += col[0] + g
      acc[oi + 1] += col[1] + g * 0.88
      acc[oi + 2] += col[2] + g * 0.78
      acc[oi + 3] += 255
    }
  }

  const per = SS * SS
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))
  for (let i = 0; i < size * size; i++) {
    const o = i << 2
    png.data[o] = clamp(acc[o] / per)
    png.data[o + 1] = clamp(acc[o + 1] / per)
    png.data[o + 2] = clamp(acc[o + 2] / per)
    png.data[o + 3] = clamp(acc[o + 3] / per)
  }
  return png
}

// ---- 输出 --------------------------------------------------------------
mkdirSync('build', { recursive: true })

const pngs = SIZES.map((s) => ({ s, png: renderSize(s) }))
const buffers = pngs.map(({ png }) => PNG.sync.write(png))

writeFileSync('build/icon.png', buffers[0]) // 256
writeFileSync('build/icon-32-preview.png', buffers[SIZES.indexOf(32)])
writeFileSync('build/icon.ico', await pngToIco(buffers))

// 高分母版（1024）用于商店 / 安装器展示
writeFileSync('build/icon-master.png', PNG.sync.write(renderSize(1024)))

console.log('icon generated (朱砂印章 · 抽象笔尖):')
console.log('  build/icon.ico   ', SIZES.join('/'))
console.log('  build/icon.png    256')
console.log('  build/icon-master.png 1024')
console.log('  build/icon-source.svg  (矢量母版)')
