/**
 * 金手指/能力边界短句抽取（写前清单与写后自检共用，避免双份规则漂移）。
 */

import type { SettingsEvolutionEntry } from '../../shared/types'
import type { SettingsContext } from './skill-format/settings-md-repo'

const BOUNDARY_RE =
  /只能|不能|无法|不可|禁止|限制|消耗|反弹|副作用|最多|至少|上限|不得|不会直接|无法直接|不会提供|看不到|不可改/

/**
 * 从设定文档 + 近期演进中抽取短边界句（能/不能/消耗/限制）。
 * 最多返回 8 条。
 */
export function extractPowerBoundaryBullets(
  settings: SettingsContext | null | undefined,
  evolution: SettingsEvolutionEntry[] = []
): string[] {
  const bullets: string[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    let t = raw
      .replace(/^[-*•]\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (t.length < 8 || t.length > 160) return
    if (/^#/.test(t)) return
    const key = t.slice(0, 40)
    if (seen.has(key)) return
    seen.add(key)
    bullets.push(t)
  }

  const docs: { name: string; body: string }[] = []
  if (settings) {
    for (const w of settings.worldview) {
      if (/金手指|罗盘|系统|能力|力量/.test(w.name)) docs.push(w)
    }
    for (const r of settings.customRules) {
      if (
        /金手指|罗盘|规则|能力|系统/.test(r.name) ||
        /限制|不能|只能|消耗/.test(r.body.slice(0, 200))
      ) {
        docs.push(r)
      }
    }
    for (const w of settings.worldview) {
      if (
        !docs.includes(w) &&
        /限制|不能|只能|反弹|精神力/.test(w.body.slice(0, 400))
      ) {
        docs.push(w)
      }
    }
  }

  for (const doc of docs) {
    for (const line of doc.body.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      if (!BOUNDARY_RE.test(t)) continue
      push(t)
      if (bullets.length >= 10) break
    }
    if (bullets.length >= 10) break
  }

  for (const e of evolution) {
    if (!/金手指|罗盘|运势|精神力|能力/.test(e.file + e.summary)) continue
    push(`${e.chapter} · ${e.summary}`)
    if (bullets.length >= 12) break
  }

  return bullets.slice(0, 8)
}

/** @deprecated 使用 extractPowerBoundaryBullets；保留别名兼容旧 import */
export const extractPowerBoundaryBulletsFromSettings = extractPowerBoundaryBullets
