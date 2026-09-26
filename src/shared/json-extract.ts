/**
 * 从模型输出里取出 JSON（main 与 renderer 共享，无 Node 依赖）。
 *
 * 模型常见的格式偏差：带 <think> 推理块、包 ```json 围栏、JSON 前后夹说明文字
 * （说明里再出现 [P0]、{角色} 之类括号时，/\{[\s\S]*\}/ 这种贪婪匹配就会切错）。
 * 这里先去掉推理块和围栏，按首个开括号到末个闭括号解析（与旧贪婪匹配等价）；
 * 失败再逐个开括号做括号配平，取第一个能解析且满足 accept 的片段。
 */
type Json = ReturnType<typeof JSON.parse>

export function findJson(
  raw: string,
  open: '[' | '{',
  accept: (v: Json) => boolean = () => true
): Json | undefined {
  const close = open === '[' ? ']' : '}'
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
  const tryParse = (s: string): Json | undefined => {
    try { return JSON.parse(s) } catch { return undefined }
  }
  const first = text.indexOf(open)
  const last = text.lastIndexOf(close)
  if (first !== -1 && last > first) {
    const v = tryParse(text.slice(first, last + 1))
    if (v !== undefined && accept(v)) return v
  }
  for (let start = first; start !== -1; start = text.indexOf(open, start + 1)) {
    const end = findBalancedEnd(text, start)
    if (end === -1) continue
    const v = tryParse(text.slice(start, end + 1))
    if (v !== undefined && accept(v)) return v
  }
  return undefined
}

export function findJsonArray(raw: string): Json[] | undefined {
  return findJson(raw, '[', Array.isArray)
}

export function findJsonObject(raw: string): Record<string, Json> | undefined {
  return findJson(raw, '{', (v) => !!v && typeof v === 'object' && !Array.isArray(v))
}

function findBalancedEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}
