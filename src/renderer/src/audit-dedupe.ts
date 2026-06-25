import type { AuditViolation } from '../../shared/types'

/**
 * 禁用词命中按 offset 去重。
 *
 * 同一 offset 上若叠了多条前缀重叠命中（短词命中被长词命中完全覆盖，
 * 如「轰」⊂「轰然」、「嘴角勾起」⊂「嘴角勾起一抹弧度」），
 * 只保留 word 最长（最具体）的那条；非 forbidden_word 违例与无 offset 的
 * 命中原样保留。
 *
 * tie-breaker 取舍：用 word.length。对字面词前缀重叠精确（保留「轰然」）。
 * 模式命中（word 是规则 id，如「嘴角_弧度_底层模式」）字符串偏长，
 * 同 offset 时可能盖过字面词，但其 message 已含改写指引，
 * 展示一条即可消除视觉重复，可接受。
 */
export function dedupeForbiddenViolations(violations: AuditViolation[]): AuditViolation[] {
  const byOffset = new Map<number, AuditViolation>()
  const rest: AuditViolation[] = []
  for (const v of violations) {
    if (v.category !== 'forbidden_word' || v.offset == null) {
      rest.push(v)
      continue
    }
    const prev = byOffset.get(v.offset)
    if (!prev || (v.word ?? '').length > (prev.word ?? '').length) {
      byOffset.set(v.offset, v)
    }
  }
  return [...rest, ...byOffset.values()]
}
