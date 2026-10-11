import type { DeslopFinding } from '../../../shared/types'

/** 定向复核候选，不是禁词命中；模型可保留合理用法，不参与复扫失败判定。 */
export function pressActionReviewFindings(text: string): DeslopFinding[] {
  const lines = text.split('\n')
  const actions = lines.flatMap((line, index) => {
    const narration = line.replace(/[“「"][^”」"\n]*[”」"]/g, '')
    // 只取动词形态，压力、血压、压缩等普通名词/术语不触发。
    const count = [...narration.matchAll(/压(?:在|住|下|过来|着|到|上)/g)].length
    return count ? [{ index, line, count, narration }] : []
  })
  return actions.filter((action) => {
    if (/压在[^。！？\n]{0,24}(?:签名栏|签字栏|签名处|签字处)/.test(action.narration)) return true
    // 同一局部场景的密集使用只触发语义检查，不要求改掉真实受力动作。
    const nearby = actions.filter((other) => Math.abs(other.index - action.index) <= 8)
    const first = Math.min(...nearby.map((other) => other.index))
    const last = Math.max(...nearby.map((other) => other.index))
    return nearby.reduce((sum, other) => sum + other.count, 0) >= 3
      && lines.slice(first, last + 1).join('\n').length <= 500
  }).map((action) => ({
    line: action.index + 1, column: 1, type: 'press-action-review', severity: 'advisory', gate: 'C',
    message: '按上下文检查“压”的动作对象、用途及重复；必要且清楚的受力动作保留，不编造动作或动机，不机械换同义词。',
    excerpt: action.line.trim()
  }))
}
