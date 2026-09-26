import { promises as fs, type Dirent } from 'fs'
import { join } from 'path'

/**
 * 项目自己定义的世界观术语 = 设定/ 下的 .md 文件名（含 世界观/角色/势力 等子目录）。
 *
 * 用途见 AuditOptions.worldTerms：元叙事词表是全局的，而「作者」「主角」「反派」
 * 这类词在不少书里就是页内身份。判据取文件名而不是正文出现次数——
 * 「作者魂印.md」「原作者阵营.md」是作者亲手立的设定，和角色偶然提到「读者」
 * 不是一回事；后者没有对应设定文件，仍然按打破第四面墙报 error。
 */
const SETTINGS_DIR = '设定'
/** 目录深度上限：设定/世界观/地理.md 只有两层，再深多半是用户自己堆的杂物 */
const MAX_DEPTH = 3

/**
 * 读取项目的世界观术语。
 * 读不到（没有设定目录、权限不足）时返回空数组——审稿照常跑，只是没有豁免。
 */
export async function readWorldTerms(projectDir: string): Promise<string[]> {
  const terms = new Set<string>()
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), depth + 1)
        // 目录名本身也是设定分类（如 势力/、角色/），不当术语用
        continue
      }
      if (!entry.name.endsWith('.md')) continue
      const name = entry.name.slice(0, -3).trim()
      if (name) terms.add(name)
    }
  }
  await walk(join(projectDir, SETTINGS_DIR), 1)
  return [...terms]
}
