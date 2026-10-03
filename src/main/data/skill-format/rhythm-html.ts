import type { RhythmEntry } from '../../../shared/types'

/**
 * 解析 / 回写 `图解/节奏图谱.html` 内的 rhythmData 数组。
 * 只处理 `const rhythmData = [...]` 块，html 其余部分（ECharts 配置、表格、样式）原样保留。
 *
 * 每行格式（技能 v3.2 硬性约定）：
 *   { chapter: 1, title: '困兽', emotion: 5, climax: 1, volume: 1, actualized: false }
 */

type SourceEntry = Omit<RhythmEntry, 'volume'> & { volume: number | string }

/** 数据字面量的词法规则；不接受调用、模板字符串或其他可执行表达式。 */
const TOKEN_RE = /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\\r\n])*'|"(?:\\[\s\S]|[^"\\\r\n])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_$][\w$]*|[{}[\],:]/y

/** 解析 html 内 rhythmData。无块则返回 null。 */
export function parseRhythmData(html: string): RhythmEntry[] | null {
  const block = findBlock(html)
  if (!block) return null
  const source = parseSourceEntries(block.body)
  const volumes = mapVolumes(source)
  return source.map((entry) => ({ ...entry, volume: volumes.get(entry.volume)! }))
}

/**
 * 序列化 rhythmData 回 html，只替换数组内容，其余原样。
 * Phase 3 写入路径使用；Phase 1 不调用。
 * 注意：会丢弃原文里的 `// 第 N 卷` 注释行（Phase 3 可按 volume 字段重新生成）。
 */
export function serializeRhythmData(html: string, entries: RhythmEntry[]): string {
  const block = findBlock(html)
  if (!block) return html
  const source = parseSourceEntries(block.body)
  const volumes = mapVolumes(source)
  const sourceVolumes = new Map<number, number | string>()
  for (const entry of source) sourceVolumes.set(volumes.get(entry.volume)!, entry.volume)
  const indent = detectIndent(block.body)
  const closingIndent = indent.slice(0, Math.max(0, indent.length - 4))
  const lines = entries.map((e) => `${indent}${formatEntry(e, sourceVolumes.get(e.volume) ?? e.volume)},`)
  if (lines.length > 0) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '')
  }
  const inner = '\n' + lines.join('\n') + '\n' + closingIndent
  return html.slice(0, block.start) + inner + html.slice(block.end)
}

function formatEntry(e: RhythmEntry, volume: number | string): string {
  return (
    `{ chapter: ${e.chapter}, title: ${quoteString(e.title)}, ` +
    `emotion: ${e.emotion}, climax: ${e.climax}, volume: ${typeof volume === 'string' ? quoteString(volume) : volume}, actualized: ${e.actualized} }`
  )
}

function quoteString(value: string): string {
  // 保留历史单引号格式，同时转义反斜杠、换行及 HTML script 结束标记。
  return "'" + JSON.stringify(value).slice(1, -1)
    .replace(/'/g, "\\'").replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + "'"
}

/** 找数组边界时跳过字符串和注释，标题里的 `];` 不会截断数据。 */
function findBlock(html: string): { start: number; end: number; body: string } | null {
  const opening = /const\s+rhythmData\s*=\s*\[/.exec(html)
  if (!opening) return null
  const start = opening.index + opening[0].length
  let depth = 1
  for (let i = start; i < html.length; i++) {
    const char = html[i]
    if (char === "'" || char === '"') {
      const quote = char
      for (i++; i < html.length; i++) {
        if (html[i] === '\\') i++
        else if (html[i] === quote) break
      }
    } else if (char === '/' && html[i + 1] === '/') {
      while (i < html.length && html[i] !== '\n' && html[i] !== '\r') i++
    } else if (char === '/' && html[i + 1] === '*') {
      const end = html.indexOf('*/', i + 2)
      if (end < 0) return null
      i = end + 1
    } else if (char === '[') depth++
    else if (char === ']' && --depth === 0) return { start, end: i, body: html.slice(start, i) }
  }
  return null
}

function parseSourceEntries(body: string): SourceEntry[] {
  try {
    const tokens: string[] = []
    let position = 0
    while (position < body.length) {
      TOKEN_RE.lastIndex = position
      const match = TOKEN_RE.exec(body)
      if (!match) return []
      const token = match[0]
      position = TOKEN_RE.lastIndex
      if (!/^\s|^\/\//.test(token) && !token.startsWith('/*')) tokens.push(token)
    }
    const json = tokens.map((token, index) => {
      if (token === ',' && (index === tokens.length - 1 || /^[}\]]$/.test(tokens[index + 1]))) return ''
      if (token.startsWith("'")) return JSON.stringify(readSingleQuotedString(token))
      if (/^[A-Za-z_$]/.test(token) && tokens[index + 1] === ':') return JSON.stringify(token)
      return token
    }).join('')
    const data: unknown = JSON.parse(`[${json}]`)
    return Array.isArray(data) ? data.filter(isSourceEntry) : []
  } catch {
    return []
  }
}

function readSingleQuotedString(token: string): string {
  // JSON.parse 处理 JSON 转义；JS 单引号和十六进制转义先转成 JSON 形式。
  let json = '"'
  for (let i = 1; i < token.length - 1; i++) {
    const char = token[i]
    if (char === '"') json += '\\"'
    else if (char !== '\\') json += char
    else {
      const escaped = token[++i]
      if (escaped === "'") json += "'"
      else if (escaped === 'x') {
        const hex = token.slice(i + 1, i + 3)
        if (!/^[\da-f]{2}$/i.test(hex)) throw new Error('Invalid string escape')
        json += `\\u00${hex}`
        i += 2
      } else if (escaped === 'v') json += '\\u000b'
      else if (escaped === '0') {
        if (/\d/.test(token[i + 1])) throw new Error('Unsupported octal escape')
        json += '\\u0000'
      } else if (escaped === '\n' || escaped === '\r') {
        if (escaped === '\r' && token[i + 1] === '\n') i++
      } else json += '\\' + escaped
    }
  }
  return JSON.parse(json + '"') as string
}

function isSourceEntry(value: unknown): value is SourceEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.chapter === 'number' && Number.isInteger(entry.chapter) && entry.chapter >= 0
    && typeof entry.title === 'string'
    && typeof entry.emotion === 'number' && Number.isFinite(entry.emotion) && entry.emotion >= 0
    && typeof entry.climax === 'number' && Number.isFinite(entry.climax) && entry.climax >= 0
    && (typeof entry.volume === 'number' && Number.isInteger(entry.volume) && entry.volume >= 0
      || typeof entry.volume === 'string' && entry.volume.trim().length > 0)
    && typeof entry.actualized === 'boolean'
}

function mapVolumes(source: SourceEntry[]): Map<number | string, number> {
  const volumes = new Map<number | string, number>()
  const used = new Set<number>()
  // 先预留显式卷号，避免文字卷名和数字卷号碰撞。
  for (const { volume } of source) {
    if (typeof volume === 'number' || /^\d+$/.test(volume.trim())) {
      const number = Number(volume)
      if (Number.isSafeInteger(number)) {
        volumes.set(volume, number)
        used.add(number)
      }
    }
  }
  let next = 1
  for (const { volume } of source) {
    if (volumes.has(volume)) continue
    while (used.has(next)) next++
    volumes.set(volume, next)
    used.add(next++)
  }
  return volumes
}

function detectIndent(blockBody: string): string {
  const m = blockBody.match(/\n(\s+)\{/)
  return m ? m[1] : '            '
}
