import { promises as fs } from 'fs'
import { join } from 'path'
import { readText, parseDoc } from './md-parser'
import { extractBookName } from './project-skill-repo'

export interface DiscoveredProject {
  /** 项目目录绝对路径 */
  path: string
  /** 书名（来自 大纲.md H1，缺失则用目录名） */
  name: string
}

/**
 * 扫描 projectsRoot 下所有子目录，凡含 `大纲/大纲.md` 的视为 v3.2 项目。
 * 解决「设置了 O:\book 但看不到书」的问题——旧格式（无 大纲.md）不会被识别，符合「不兼容」决策。
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
    const outlineFile = join(dir, '大纲', '大纲.md')
    const text = await readText(outlineFile)
    if (!text) continue
    const doc = parseDoc(text)
    const name = extractBookName(doc.h1Title) || entry
    found.push({ path: dir, name })
  }
  return found
}
