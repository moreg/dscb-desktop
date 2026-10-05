import { promises as fs } from 'fs'
import { join } from 'path'
import { readText, parseDoc } from './md-parser'
import { extractBookName } from './project-skill-repo'

export interface DiscoveredProject {
  /** 项目目录绝对路径 */
  path: string
  /** app 项目保留 project.json 的稳定 ID；只有大纲的外部项目尚未分配 ID。 */
  id?: string
  /** 书名（优先 project.json，旧项目来自大纲 H1，缺失则用目录名） */
  name: string
}

export interface AppProjectIdentity {
  id: string
  name: string
}

/** 新作品可以只有 project.json；普通 JSON 和损坏文件不能成为书架项目。 */
export async function readAppProjectIdentity(dir: string): Promise<AppProjectIdentity | null> {
  let value: unknown
  try {
    value = JSON.parse(await fs.readFile(join(dir, 'project.json'), 'utf-8'))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  if (data.schemaVersion !== 1 || typeof data.id !== 'string' || !data.id.trim() ||
    typeof data.name !== 'string' || !data.name.trim()) return null
  return { id: data.id, name: data.name }
}

/**
 * 扫描直接子目录中的有效 app 项目，以及含 `大纲/大纲.md` 的旧技能项目。
 * 仅保存脑洞的新作品无需提前创建大纲；空目录和其他 JSON 目录仍不识别。
 */
export async function scanProjectsRoot(root: string): Promise<DiscoveredProject[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return []
    throw err
  }
  const found: DiscoveredProject[] = []
  for (const entry of entries) {
    const dir = join(root, entry)
    let stat
    try {
      stat = await fs.stat(dir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    const identity = await readAppProjectIdentity(dir)
    if (identity) {
      found.push({ path: dir, ...identity })
      continue
    }
    const outlineFile = join(dir, '大纲', '大纲.md')
    const text = await readText(outlineFile)
    if (!text) continue
    const doc = parseDoc(text)
    const name = extractBookName(doc.h1Title) || entry
    found.push({ path: dir, name })
  }
  return found
}
