import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { readText, parseDoc, parseBoldFields, type FieldValue } from '../skill-format/md-parser'

/**
 * 用 SHA1 前 12 个十六进制字符生成确定性 id，避免 31 倍多项式哈希在中文短名下的碰撞。
 * 同一输入永远得到同一输出；不同输入碰撞概率可忽略（160 位空间取 48 位）。
 */
export function hashName(name: string): string {
  return createHash('sha1').update(name, 'utf-8').digest('hex').slice(0, 12)
}

/**
 * 由名字生成确定性角色 id（`char-` 前缀 + hashName）。
 */
export function charId(name: string): string {
  return 'char-' + hashName(name)
}

/**
 * 递归枚举目录下所有 .md 文件，返回相对路径数组（统一用 `/` 分隔）。
 */
export async function listMdFilesDeep(rootDir: string): Promise<string[]> {
  const out: string[] = []
  const stack: string[] = [rootDir]
  while (stack.length) {
    const cur = stack.pop()!
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(cur, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name.endsWith('.md')) {
        out.push(full.slice(rootDir.length + 1).replace(/\\/g, '/'))
      }
    }
  }
  return out
}

/**
 * 把 rawFields 中的值统一为 string | string[] 形式（保留多行子列表）。
 */
export function parseBoldFieldsToMap(body: string): {
  fields: Map<string, FieldValue>
  order: string[]
} {
  return parseBoldFields(body)
}

/** 拼接 multi-line 字段值为字符串（多行用「；」分隔） */
export function fieldToJoinedString(v: FieldValue | undefined): string | undefined {
  if (v == null || v === '') return undefined
  return Array.isArray(v) ? v.join('；') : v
}

/**
 * 从 # 标题中提取 entity name（H1 文本，trim）。
 * 若是骨架文件无 H1，则 fallback 到文件名去后缀。
 */
export function extractEntityNameFromDoc(doc: ReturnType<typeof parseDoc>, fallbackFile: string): string {
  return doc.h1Title.trim() || fallbackFile.replace(/\.md$/, '')
}

/**
 * 安全的文件名规整：去括号内容、替换非法字符（保留 `/` 以支持子目录）。
 * 路径遍历防护：按 `/` 切分后丢弃 `..` 段和空段，防止 `../` 逃逸出目标目录。
 */
export function safeFileName(raw: string): string {
  return raw
    .replace(/[\\:*?"<>|]/g, '_')
    .replace(/[（(].*?[)）]/g, '')
    .split('/')
    .filter((seg) => seg.trim() !== '' && seg.trim() !== '..')
    .join('/')
    .trim()
}

/**
 * 写文件用的名称消毒：剥离路径分隔符与 `..`（防路径遍历），替换 OS 保留字符，
 * 去除首尾空格与点号（Windows 禁止）。与 safeFileName 的区别：不保留 `/`、不删括号内容，
 * 适合用户输入的角色/地点名直接拼成文件名。
 */
export function sanitizeForFileName(raw: string): string {
  // 1. 统一斜杠并按段切分，丢弃 `..` 与空段（防 `../` 逃逸）
  const cleaned = raw.replace(/\\/g, '/').split('/').filter((seg) => seg && seg !== '..').join('')
  // 2. 替换 OS 保留字符为下划线
  const noReserved = cleaned.replace(/[\\/:*?"<>|]/g, '_')
  // 3. 去除控制字符
  const noCtrl = noReserved.replace(/[\x00-\x1f]/g, '')
  // 4. 去除首尾空格与点号（Windows 禁止）
  return noCtrl.replace(/^[\s.]+|[\s.]+$/g, '') || 'untitled'
}