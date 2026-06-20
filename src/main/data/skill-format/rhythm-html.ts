import type { RhythmEntry } from '../../../shared/types'

/**
 * 解析 / 回写 `图解/节奏图谱.html` 内的 rhythmData 数组。
 * 只处理 `const rhythmData = [...]` 块，html 其余部分（ECharts 配置、表格、样式）原样保留。
 *
 * 每行格式（技能 v3.2 硬性约定）：
 *   { chapter: 1, title: '困兽', emotion: 5, climax: 1, volume: 1, actualized: false }
 */

const BLOCK_RE = /const\s+rhythmData\s*=\s*\[([\s\S]*?)\];/
const ENTRY_RE =
  /\{\s*chapter:\s*(\d+)\s*,\s*title:\s*'([^']*)'\s*,\s*emotion:\s*(\d+(?:\.\d+)?)\s*,\s*climax:\s*(\d+(?:\.\d+)?)\s*,\s*volume:\s*(\d+)\s*,\s*actualized:\s*(true|false)\s*\}/g

/** 解析 html 内 rhythmData。无块则返回 null。 */
export function parseRhythmData(html: string): RhythmEntry[] | null {
  const block = html.match(BLOCK_RE)
  if (!block) return null
  const entries: RhythmEntry[] = []
  let m: RegExpExecArray | null
  ENTRY_RE.lastIndex = 0
  while ((m = ENTRY_RE.exec(block[1])) !== null) {
    entries.push({
      chapter: parseInt(m[1], 10),
      title: m[2],
      emotion: Number(m[3]),
      climax: Number(m[4]),
      volume: parseInt(m[5], 10),
      actualized: m[6] === 'true'
    })
  }
  return entries
}

/**
 * 序列化 rhythmData 回 html，只替换 BLOCK_RE 匹配的块，其余原样。
 * Phase 3 写入路径使用；Phase 1 不调用。
 * 注意：会丢弃原文里的 `// 第 N 卷` 注释行（Phase 3 可按 volume 字段重新生成）。
 */
export function serializeRhythmData(html: string, entries: RhythmEntry[]): string {
  const block = html.match(BLOCK_RE)
  if (!block) return html
  const indent = detectIndent(block[1])
  const closingIndent = indent.slice(0, Math.max(0, indent.length - 4))
  const lines = entries.map((e) => `${indent}${formatEntry(e)},`)
  if (lines.length > 0) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '')
  }
  const inner = '\n' + lines.join('\n') + '\n' + closingIndent
  return html.replace(BLOCK_RE, `const rhythmData = [${inner}];`)
}

function formatEntry(e: RhythmEntry): string {
  return (
    `{ chapter: ${e.chapter}, title: '${e.title.replace(/'/g, "\\'")}', ` +
    `emotion: ${e.emotion}, climax: ${e.climax}, volume: ${e.volume}, actualized: ${e.actualized} }`
  )
}

function detectIndent(blockBody: string): string {
  const m = blockBody.match(/\n(\s+)\{/)
  return m ? m[1] : '            '
}
