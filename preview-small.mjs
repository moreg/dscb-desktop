import { Canvas } from 'skia-canvas'

const PAPER = '#f5f0e6'
const INK = '#252525'
const GOLD = '#c9a227'

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
  ctx.lineTo(x + radius, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}

const size = 32
const canvas = new Canvas(size, size)
const ctx = canvas.getContext('2d')
ctx.fillStyle = INK
roundRect(ctx, 0, 0, size, size, size * 0.18)
ctx.fill()
ctx.save()
ctx.translate(size / 2, size / 2)
ctx.rotate(45 * Math.PI / 180)
const bodyLen = size * 0.42
const bodyW = size * 0.10
const nibLen = size * 0.14
ctx.fillStyle = GOLD
roundRect(ctx, -bodyLen / 2, -bodyW / 2, bodyLen, bodyW, bodyW * 0.3)
ctx.fill()
ctx.beginPath()
ctx.moveTo(bodyLen / 2, -bodyW * 0.55)
ctx.lineTo(bodyLen / 2 + nibLen, 0)
ctx.lineTo(bodyLen / 2, bodyW * 0.55)
ctx.closePath()
ctx.fill()
ctx.restore()
await canvas.toFile('build/icon-32-preview.png')
console.log('saved')
