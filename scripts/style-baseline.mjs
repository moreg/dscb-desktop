#!/usr/bin/env node
/**
 * 文体形态对标：把一批正文的形态指标和番茄在榜作品的基线放在一起看。
 *
 * 这是「写得像不像真人」的尺子，和去 AI 味那套检测是两回事——
 * 那套失败在检测规则和生成规则同源形成闭环（见
 * tests/fixtures/deslop-corpus/FINDINGS.md）；这里的目标是**外部语料的分布**，
 * 不是我们自己定的规则，所以改 prompt → 重新量 → 看有没有靠近，这个循环是有效的。
 *
 * 用法：
 *   node scripts/style-baseline.mjs <目录或文件> [更多...]
 *   npm run style:baseline -- "J:/book/某本书/正文"
 *
 * 基线来自 tests/fixtures/deslop-corpus/human（19 篇番茄榜单作品）；
 * 该目录是 gitignore 的，不存在时回退到内置常量（下方 FALLBACK_BASELINE）。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HUMAN_DIR = join(ROOT, 'tests', 'fixtures', 'deslop-corpus', 'human')

/** 2026-09-05 在 19 篇番茄榜单作品上实测的 p25/中位/p75，语料不在时用它 */
const FALLBACK_BASELINE = {
  每章字数: [2036, 2130, 2700],
  句子平均字数: [15.4, 17.8, 21.8],
  每段平均字数: [19.9, 25.5, 30.1],
  '极短段(≤8字)占比%': [9.3, 11.0, 13.5],
  '对白字数占比%': [6.9, 16.2, 19.3],
  每千字段落数: [30.0, 39.1, 48.0]
}

const METRIC_ORDER = Object.keys(FALLBACK_BASELINE)

function collectFiles(target) {
  if (!existsSync(target)) return []
  if (statSync(target).isFile()) return [target]
  const out = []
  for (const name of readdirSync(target)) {
    const p = join(target, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...collectFiles(p))
    else if (/\.(txt|md)$/i.test(name)) out.push(p)
  }
  return out
}

/** 一篇正文的形态指标 */
function measure(text) {
  const paras = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // 章标题行与 --- 分隔线不是正文，计进去会拉低每段字数
    .filter((l, i) => !(i === 0 && /^(#|第[0-9一二三四五六七八九十百零]+章)/.test(l)))
    .filter((l) => !/^(-{3,}|\*{3,}|={3,})$/.test(l))
  if (paras.length === 0) return null

  const visible = (s) => s.replace(/\s/g, '').length
  const chars = paras.reduce((n, p) => n + visible(p), 0)
  if (chars === 0) return null

  const sents = paras.flatMap((p) =>
    p.split(/[。！？!?]+/).map(visible).filter((n) => n > 0)
  )
  const dlg = [...text.matchAll(/“([^“”]{1,300})”|「([^「」]{1,300})」/g)].map(
    (m) => (m[1] ?? m[2] ?? '').length
  )

  return {
    每章字数: chars,
    句子平均字数: sents.length ? sents.reduce((a, b) => a + b, 0) / sents.length : 0,
    每段平均字数: chars / paras.length,
    '极短段(≤8字)占比%': (paras.filter((p) => visible(p) <= 8).length / paras.length) * 100,
    '对白字数占比%': (dlg.reduce((a, b) => a + b, 0) / chars) * 100,
    每千字段落数: (paras.length / chars) * 1000
  }
}

function quantile(sorted, p) {
  const i = (sorted.length - 1) * p
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

function baseline() {
  const files = collectFiles(HUMAN_DIR)
  if (files.length < 5) return { source: '内置常量（语料目录不足 5 篇）', data: FALLBACK_BASELINE }
  const cols = {}
  for (const f of files) {
    const m = measure(readFileSync(f, 'utf-8'))
    if (!m) continue
    for (const k of METRIC_ORDER) (cols[k] ??= []).push(m[k])
  }
  const data = {}
  for (const k of METRIC_ORDER) {
    const s = cols[k].sort((a, b) => a - b)
    data[k] = [quantile(s, 0.25), quantile(s, 0.5), quantile(s, 0.75)]
  }
  return { source: `${files.length} 篇番茄榜单作品（tests/fixtures/deslop-corpus/human）`, data }
}

/** 中文占两格 */
function pad(s, n) {
  const w = [...String(s)].reduce(
    (a, c) => a + (/[\u4e00-\u9fa5\uff00-\uffef]/.test(c) ? 2 : 1),
    0
  )
  return String(s) + ' '.repeat(Math.max(0, n - w))
}

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error('用法: node scripts/style-baseline.mjs <目录或文件> [更多...]')
  process.exit(1)
}

const files = targets.flatMap(collectFiles)
if (files.length === 0) {
  console.error(`没找到 .txt / .md 文件：${targets.join(' ')}`)
  process.exit(1)
}

const measured = files.map((f) => ({ f, m: measure(readFileSync(f, 'utf-8')) })).filter((x) => x.m)
const base = baseline()

const cols = {}
for (const { m } of measured) for (const k of METRIC_ORDER) (cols[k] ??= []).push(m[k])

console.log(`\n══════ 文体形态对标 ══════`)
console.log(`被测：${measured.length} 篇`)
console.log(`基线：${base.source}\n`)
console.log(pad('指标', 22) + pad('你的中位', 12) + pad('番茄区间', 18) + '判定')
console.log('─'.repeat(66))

for (const k of METRIC_ORDER) {
  const mine = quantile(cols[k].sort((a, b) => a - b), 0.5)
  const [p25, , p75] = base.data[k]
  const verdict =
    mine < p25 ? `偏低 ${(((mine - p25) / p25) * 100).toFixed(0)}%` :
    mine > p75 ? `偏高 +${(((mine - p75) / p75) * 100).toFixed(0)}%` :
    '✓ 在区间内'
  console.log(pad(k, 22) + pad(mine.toFixed(1), 12) + pad(`${p25.toFixed(1)} – ${p75.toFixed(1)}`, 18) + verdict)
}

const off = METRIC_ORDER.filter((k) => {
  const mine = quantile(cols[k].sort((a, b) => a - b), 0.5)
  return mine < base.data[k][0] || mine > base.data[k][2]
})
console.log('')
console.log(
  off.length === 0
    ? '全部指标落在番茄区间内。'
    : `${off.length}/${METRIC_ORDER.length} 项偏离：${off.join('、')}\n改 prompt 后重跑本命令，看有没有靠近。`
)
console.log('')
