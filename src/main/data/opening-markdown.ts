/**
 * 开书落盘相关的纯函数：Markdown 解析、中文数字转换、路径校验。
 * 从 opening-service.ts 提取，便于单元测试与复用。
 */

export interface ParsedChapter {
  chapterNumber: number
  content: string
}

/** 按 `=== 第N章 ===` 或 `### 第N章` 分隔章节 */
export function splitByChapterMarker(md: string): ParsedChapter[] {
  const result: ParsedChapter[] = []
  const re = /^(?:={2,}\s*第\s*(\d+)\s*章\s*={2,}|(?:#{1,6}\s*)?第\s*(\d+)\s*章(?:\s|：|:|$))/gm
  const matches: { index: number; lastIndex: number; chapterNumber: number; raw: string }[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(md)) !== null) {
    matches.push({
      index: match.index,
      lastIndex: re.lastIndex,
      chapterNumber: parseInt(match[1] || match[2], 10),
      raw: match[0]
    })
  }

  if (matches.length === 0) return result

  const firstMatch = matches[0]
  if (firstMatch.index > 0) {
    const prefixContent = md.slice(0, firstMatch.index)
    if (prefixContent.trim()) {
      const searchRe = /第\s*(\d+)\s*章/
      const m = searchRe.exec(prefixContent)
      const num = m ? parseInt(m[1], 10) : Math.max(1, firstMatch.chapterNumber - 1)
      result.push({ chapterNumber: num, content: prefixContent })
    }
  }

  for (let i = 0; i < matches.length; i++) {
    const curr = matches[i]
    const next = matches[i + 1]
    const contentEnd = next ? next.index : md.length
    let content = md.slice(curr.lastIndex, contentEnd)
    if (!curr.raw.startsWith('=')) content = curr.raw + content
    result.push({ chapterNumber: curr.chapterNumber, content })
  }

  return result
}

/** 规范化大纲相对路径：反斜杠转正斜杠，中文卷号转数字 */
export function normalizeOutlinePath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/').trim()
  const volumeMatch = normalized.match(/^大纲\/卷纲_第([一二三四五六七八九十百零〇两\d]+)卷\.md$/)
  if (!volumeMatch) return normalized
  const volume = parseVolumeToken(volumeMatch[1])
  if (!volume) return normalized
  return `大纲/卷纲_第${volume}卷.md`
}

/** 数字卷号 → 中文卷号别名（如 第1卷 → 第一卷） */
export function toChineseVolumeAlias(relPath: string): string | null {
  const match = relPath.match(/^大纲\/卷纲_第(\d+)卷\.md$/)
  if (!match) return null
  const num = parseInt(match[1], 10)
  if (!Number.isFinite(num) || num <= 0) return null
  return `大纲/卷纲_第${toChineseNumber(num)}卷.md`
}

/** 解析卷号 token（支持中文数字与阿拉伯数字） */
export function parseVolumeToken(token: string): number | null {
  if (/^\d+$/.test(token)) return parseInt(token, 10)
  const value = fromChineseNumber(token)
  return value > 0 ? value : null
}

/** 数字 → 中文数字（支持 0-99） */
export function toChineseNumber(num: number): string {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  if (num < 10) return digits[num]
  if (num === 10) return '十'
  if (num < 20) return `十${digits[num % 10]}`
  if (num < 100) {
    const tens = Math.floor(num / 10)
    const ones = num % 10
    return `${digits[tens]}十${ones === 0 ? '' : digits[ones]}`
  }
  return String(num)
}

/** 中文数字 → 数字（支持 0-99） */
export function fromChineseNumber(raw: string): number {
  const token = raw.replace(/〇/g, '零').replace(/两/g, '二')
  const digitMap: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  }
  if (token === '十') return 10
  if (token.startsWith('十')) return 10 + (digitMap[token.slice(1)] ?? 0)
  if (token.includes('十')) {
    const [left, right] = token.split('十')
    const tens = digitMap[left] ?? 0
    const ones = right ? (digitMap[right] ?? 0) : 0
    return tens * 10 + ones
  }
  return digitMap[token] ?? 0
}

/** 解析 LLM 多文件 Markdown（`=== path ===` 分隔），返回 路径→内容 映射 */
export function parseMergedMarkdown(merged: string): Record<string, string> {
  const map: Record<string, string> = {}
  const matches = [...merged.matchAll(/===+\s*([^\s]+)\s*===+/g)]
  if (matches.length === 0) return map
  for (let i = 0; i < matches.length; i++) {
    const currentMatch = matches[i]
    const nextMatch = matches[i + 1]
    const startIdx = currentMatch.index! + currentMatch[0].length
    const endIdx = nextMatch ? nextMatch.index! : merged.length
    const rawPath = currentMatch[1].trim()
    const filePath = rawPath.replace(/[`']/g, '')
    const fileContent = merged.substring(startIdx, endIdx).trim()
    map[filePath] = fileContent
  }
  return map
}

/**
 * 校验 LLM 输出的相对路径是否安全（防止 prompt injection 越界写文件）。
 * - 禁止绝对路径 / 盘符 / 分隔符开头
 * - 禁止 `..` 分量（任何层级的目录穿越）
 * - 第一段必须在白名单前缀内
 * 返回 true 表示安全可用。
 */
export function isSafeRelPath(relPath: string, allowedPrefixes: string[]): boolean {
  const p = relPath.trim()
  if (!p) return false
  if (/^[/\\]/.test(p) || /^[A-Za-z]:[\\/]/.test(p)) return false
  const segments = p.split(/[/\\]/)
  if (segments.some((s) => s === '..')) return false
  const firstSeg = segments[0]
  return allowedPrefixes.some(
    (prefix) => firstSeg === prefix || firstSeg.startsWith(prefix + '/')
  )
}

/** 去除 H1 标题行及其上方内容，返回正文 */
export function cleanContent(md: string): string {
  const lines = md.split(/\r?\n/)
  const h1Index = lines.findIndex((l) => /^#\s+/.test(l))
  if (h1Index < 0) return md.trim()
  return lines.slice(h1Index + 1).join('\n').trim()
}

/** 从卷纲内容中提取从第一个 `### 第N章` 开始的部分 */
export function cleanVolumeContent(md: string): string {
  const lines = md.split(/\r?\n/)
  const firstChIndex = lines.findIndex((l) => /^###\s+第\s*\d+\s*章/.test(l))
  if (firstChIndex < 0) return ''
  return lines.slice(firstChIndex).join('\n').trim()
}

/**
 * 从细纲内容中解析章节标题（用于生成符合番茄风格的文件名 `细纲_第NNN章_标题.md`）。
 * 匹配 `## 第 N 章：标题` 或 `### 第 N 章：标题`，返回标题文本（去掉首尾空白）。
 * 未找到返回空串。
 */
export function parseChapterTitle(content: string): string {
  const m = content.match(/^#{2,3}\s+第\s*\d+\s*章\s*[：:]\s*(.+?)\s*$/m)
  return m ? m[1].trim() : ''
}

/**
 * 把章节标题清洗为文件名安全片段（用于 `细纲_第NNN章_标题.md` 的 `_标题` 部分）。
 * - 去除 Windows/Unix 文件系统非法字符：/ \ : * ? " < > |
 * - 去除控制字符
 * - 截断到 30 字（番茄章名 12-20 字，留余量）
 * - 去除首尾空白和点号（避免 Windows 末尾点问题）
 */
export function sanitizeTitleForFilename(title: string): string {
  if (!title) return ''
  const cleaned = title
    .replace(/[/\\:*?"<>|]/g, '') // 文件系统非法字符（半角）
    .replace(/[：]/g, '') // 全角冒号（避免与章号分隔符混淆）
    .replace(/[\x00-\x1f\x7f]/g, '') // 控制字符
    .replace(/\s+/g, ' ') // 折叠多空白为单空格
    .replace(/[.]+$/g, '') // 末尾点号
    .trim()
    .slice(0, 30)
  return cleaned
}
