import type { OutlineProseSection } from '../../../shared/types'

const POINT_ITEM = /^(\d+)\s*[.、)]\s+(\S.*)$/
const POINT_LABEL = /^(?:\*\*)?情节点\s*(\d+)\s*(?:\*\*)?\s*[：:]\s*/
const POINT_BUDGET = /\s*【[^【】\n]+[，,]\s*约\s*\d+\s*字\s*】$/
const BARE_REFERENCE = /^(?:(?:参见|见|对应)\s*)?情节点\s*(\d+)\s*[。.]?$/
const BARE_RANGE = /^(?:(?:参见|见|对应)\s*)?情节点\s*(\d+)\s*[—–-]\s*(\d+)\s*[。.]?$/
const TRAILING_REFERENCE = /[（(]\s*(?:(?:参见|见|对应)\s*)?情节点\s*(\d+)\s*[）)]\s*[。.]?$/

/** 只投影到本章生成提示词。情节点正文、原始字段和保存的细纲继续使用原文。 */
export function buildPlotPointReferences(sections: OutlineProseSection[] = []) {
  const points = new Map<number, string | undefined>()
  for (const section of sections) {
    if (!section.title.startsWith('情节点序列')) continue
    let fenced = false
    for (const line of section.text.split('\n')) {
      if (line.trimStart().startsWith('```')) fenced = !fenced
      if (fenced) continue
      const item = line.match(POINT_ITEM)
      if (!item) continue
      const number = Number(item[1])
      const label = item[2].match(POINT_LABEL)
      if (label && Number(label[1]) !== number) {
        points.set(Number(label[1]), undefined)
        points.set(number, undefined)
        continue
      }
      const text = item[2].replace(POINT_LABEL, '').replace(POINT_BUDGET, '').trim()
      points.set(number, points.has(number) || !text ? undefined : text)
    }
  }

  const unresolved = new Map<number, string>()
  return {
    unresolved,
    renderSummary(value: string): string {
      const text = value.trim()
      // 仅处理纯编号范围；带文字的摘要可能含独有因果，不能自动删。
      const range = text.match(BARE_RANGE)
      if (range) {
        const start = Number(range[1]), end = Number(range[2])
        if (end < start || end - start > 100) return value
        let valid = true
        for (let n = start; n <= end; n++) {
          if (!points.get(n)) {
            unresolved.set(n, points.has(n) ? '编号不唯一或正文不明确' : '未找到可确认的编号')
            valid = false
          }
        }
        return valid ? `参见下方情节点 ${start}—${end}。` : value
      }
      const bare = text.match(BARE_REFERENCE)
      const reference = bare ?? text.match(TRAILING_REFERENCE)
      if (reference) {
        const number = Number(reference[1])
        const point = points.get(number)
        if (!point) {
          unresolved.set(number, points.has(number) ? '编号不唯一或正文不明确' : '未找到可确认的编号')
          return value
        }
        const summary = bare ? '' : text.slice(0, reference.index).trimEnd()
        return !summary || summary === point ? `参见下方情节点 ${number}。` : value
      }
      // 只合并完全一致且指向唯一的正文，保留任何附带因果或约束的摘要。
      const matches = [...points].filter(([, point]) => point === text)
      return matches.length === 1 ? `参见下方情节点 ${matches[0][0]}。` : value
    }
  }
}
