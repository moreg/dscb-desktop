import { promises as fs } from 'fs'
import path from 'path'
import { writeTextAtomic, readJson, writeJsonAtomic } from '../atomic'
import type {
  TeardownChapterBoundary,
  TeardownFileNode,
  TeardownLengthKind,
  TeardownLongProgress,
  TeardownShortMeta
} from '../../../shared/types'

/**
 * 拆文库目录树（对齐 oh-story-claudecode skill 包）：
 *
 * teardown-library/{书名}/
 * ├── 原文/原文.{txt|md}            # 管道前置备份
 * ├── 概要.md                       # 长篇 Stage 0 thin → Stage 5 全书覆盖
 * ├── 章节/
 * │   ├── 第1-3章_深度拆解.md       # 长篇 Stage 1 黄金三章
 * │   └── 第N章_摘要.md             # 长篇 Stage 2 逐章
 * ├── 快速预览.md                   # 长篇 Stage 1 停靠交付物
 * ├── 角色/
 * │   ├── {角色名}.md
 * │   └── 角色关系.md
 * ├── 剧情/
 * │   ├── README.md                 # 索引：各文件权威范围
 * │   ├── {剧情标题}.md
 * │   ├── 故事线.md                 # 摘要投影
 * │   ├── 节奏.md                   # 关键信息推进/爽点循环/情绪触动点/爆发节奏【权威】
 * │   ├── 情绪模块.md               # 读者需求/情绪引擎/可复现模块卡【权威】
 * │   └── 散落情节.md               # 6 步兜底
 * ├── 设定/
 * │   ├── 世界观/{背景设定.md, 力量体系.md, 地理.md, 金手指.md}
 * │   └── 势力/{势力名}.md
 * ├── 拆文报告.md                   # 长篇 Stage 5 汇总 / 短篇 Stage 2-6 综合
 * ├── 文风.md                       # Stage 6
 * ├── 情节节点.md                   # 短篇 Stage 2
 * ├── 写作手法.md                   # 短篇 Stage 4
 * ├── _progress.md                  # 长篇状态机（schema v2）
 * └── _meta.json                    # 短篇状态机
 *
 * 短篇极简 4 文件结构：拆文报告.md / 情节节点.md / 写作手法.md / _meta.json
 */
export class TeardownRepository {
  constructor(private readonly teardownRoot: string) {}

  /** 拆文库根目录 */
  root(): string {
    return this.teardownRoot
  }

  /** 单本书目录。对 bookName 做安全化后拼接，并校验结果仍位于 teardownRoot 内，防 `.`/`..` 穿越 */
  bookDir(bookName: string): string {
    const dir = path.resolve(this.teardownRoot, sanitizeBookName(bookName))
    if (dir !== this.teardownRoot && !dir.startsWith(this.teardownRoot + path.sep)) {
      throw new Error(`书名越界：${bookName}`)
    }
    return dir
  }

  /** 该书是否已存在（有目录） */
  async exists(bookName: string): Promise<boolean> {
    try {
      const stat = await fs.stat(this.bookDir(bookName))
      return stat.isDirectory()
    } catch {
      return false
    }
  }

  /** 列出全部拆文库书名 */
  async listBookNames(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.teardownRoot, { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch (err) {
      // ENOENT（首次使用，根目录未创建）是正常路径，静默；其他错误（权限等）记录
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[teardown-repository] listBookNames readdir 失败:', err)
      }
      return []
    }
  }

  /** 初始化书的骨架目录。rawText 落盘到 原文/原文.txt */
  async initBook(
    bookName: string,
    rawText: string,
    _lengthKind: TeardownLengthKind
  ): Promise<void> {
    const dir = this.bookDir(bookName)
    await fs.mkdir(path.join(dir, '原文'), { recursive: true })
    await writeTextAtomic(path.join(dir, '原文', '原文.txt'), rawText)
  }

  /** 读取原文全文（管道 Stage 0/0.5 切片来源） */
  async readRawText(bookName: string): Promise<string> {
    // 兼容 .txt / .md
    for (const ext of ['txt', 'md']) {
      const file = path.join(this.bookDir(bookName), '原文', `原文.${ext}`)
      try {
        return await fs.readFile(file, 'utf-8')
      } catch {
        // try next
      }
    }
    throw new Error(`原文缺失：${bookName}`)
  }

  /** 原子写一个产物 markdown 文件（自动建父目录）。防路径穿越（必须在书目录内） */
  async writeMarkdown(bookName: string, relPath: string, content: string): Promise<void> {
    const full = this.safeJoin(bookName, relPath)
    await writeTextAtomic(full, content)
  }

  /** 读取一个产物文件。防路径穿越 */
  async readMarkdown(bookName: string, relPath: string): Promise<string | null> {
    try {
      return await fs.readFile(this.safeJoin(bookName, relPath), 'utf-8')
    } catch {
      return null
    }
  }

  /** 追加内容到已有 md（如拆文报告 Stage 2-6 逐段 append）。防路径穿越 */
  async appendMarkdown(bookName: string, relPath: string, chunk: string): Promise<void> {
    const full = this.safeJoin(bookName, relPath)
    const existing = await this.readMarkdown(bookName, relPath)
    const next = (existing ?? '') + chunk
    await writeTextAtomic(full, next)
  }

  /**
   * 安全拼接书目录内路径，防路径穿越。
   * 解析后必须以书目录为前缀（含分隔符），否则抛错。
   * 写/读/追加统一走此校验，避免 LLM 输出或外部输入逃逸到书目录外。
   */
  private safeJoin(bookName: string, relPath: string): string {
    const dir = this.bookDir(bookName)
    const full = path.resolve(dir, relPath)
    if (full !== dir && !full.startsWith(dir + path.sep)) {
      throw new Error(`路径越界：${relPath} 不在书目录内`)
    }
    return full
  }

  /* ----- 长篇 _progress.md 状态机 ----- */

  progressFile(bookName: string): string {
    return path.join(this.bookDir(bookName), '_progress.md')
  }

  async readLongProgress(bookName: string): Promise<TeardownLongProgress | null> {
    const file = this.progressFile(bookName)
    // _progress.md 是 JSON-in-fence 结构，便于人类阅读 + 机器解析
    try {
      const raw = await fs.readFile(file, 'utf-8')
      const json = extractJsonFromFence(raw)
      if (json) return parseLongProgress(json)
    } catch {
      // fall through
    }
    return null
  }

  async writeLongProgress(progress: TeardownLongProgress): Promise<void> {
    const md =
      `# _progress.md\n\n` +
      `**schemaVersion**: ${progress.schemaVersion}\n` +
      `**bookName**: ${progress.bookName}\n` +
      `**pausedAfterStage1**: ${progress.pausedAfterStage1}\n` +
      `**stagesCompleted**: ${JSON.stringify(progress.stagesCompleted)}\n` +
      `**updatedAt**: ${progress.updatedAt}\n\n` +
      '```json\n' + JSON.stringify(progress, null, 2) + '\n```\n'
    await writeTextAtomic(this.progressFile(progress.bookName), md)
  }

  /* ----- 短篇 _meta.json 状态机 ----- */

  metaFile(bookName: string): string {
    return path.join(this.bookDir(bookName), '_meta.json')
  }

  async readShortMeta(bookName: string): Promise<TeardownShortMeta | null> {
    return readJson<TeardownShortMeta | null>(this.metaFile(bookName), null)
  }

  async writeShortMeta(meta: TeardownShortMeta): Promise<void> {
    await writeJsonAtomic(this.metaFile(meta.bookName), meta)
  }

  /* ----- 章节边界表（长篇 Stage 0.5 产物，全管道唯一切片来源） ----- */

  /** 读取章节边界表；未生成则返回 null */
  async readChapterBoundaries(bookName: string): Promise<TeardownChapterBoundary[] | null> {
    const p = await this.readLongProgress(bookName)
    return p?.chapterBoundaries ?? null
  }

  /* ----- 产物文件树（前端预览用） ----- */

  /** 递归列出某书拆文库的全部文件/目录，返回相对路径树 */
  async listFiles(bookName: string): Promise<TeardownFileNode[]> {
    const dir = this.bookDir(bookName)
    const out: TeardownFileNode[] = []
    const walk = async (rel: string): Promise<void> => {
      const full = path.join(dir, rel)
      let entries: import('fs').Dirent[]
      try {
        entries = await fs.readdir(full, { withFileTypes: true })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`[teardown-repository] listFiles readdir 失败 (${full}):`, err)
        }
        return
      }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          out.push({ path: childRel, isDir: true, size: 0 })
          await walk(childRel)
        } else {
          try {
            const stat = await fs.stat(path.join(full, e.name))
            out.push({ path: childRel, isDir: false, size: stat.size })
          } catch {
            out.push({ path: childRel, isDir: false, size: 0 })
          }
        }
      }
    }
    await walk('')
    return out
  }

  /** 读取任意产物文件内容（前端预览）。禁止路径穿越（必须在书目录内） */
  async readFile(bookName: string, relPath: string): Promise<string | null> {
    try {
      return await fs.readFile(this.safeJoin(bookName, relPath), 'utf-8')
    } catch {
      return null
    }
  }

  /** 删除整本书的拆文库 */
  async deleteBook(bookName: string): Promise<void> {
    await fs.rm(this.bookDir(bookName), { recursive: true, force: true })
  }
}

/* =========================================================
   辅助：书名清洗 + _progress.md JSON 解析
   ========================================================= */

/** 书名 → 安全目录名（去除路径分隔符等非法字符，保留中文） */
export function sanitizeBookName(name: string): string {
  // 仅去除文件系统敏感字符，保留中日韩文字、字母数字
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0) return '未命名'
  // 拒绝纯点号段（如 "." / ".." / "..."），避免 path.resolve 后越界到父目录
  if (/^\.+$/.test(cleaned)) return '未命名'
  return cleaned.slice(0, 120)
}

/** 从 _progress.md 的 json fence 提取 JSON 文本 */
function extractJsonFromFence(raw: string): string | null {
  const match = raw.match(/```json\s*([\s\S]*?)```/)
  return match ? match[1].trim() : null
}

/** 解析并校验长篇 _progress 的 JSON（容错：字段缺失时降级） */
function parseLongProgress(jsonStr: string): TeardownLongProgress | null {
  try {
    const obj = JSON.parse(jsonStr) as Partial<TeardownLongProgress>
    if (!obj || typeof obj !== 'object') return null
    return {
      schemaVersion: 2,
      bookName: typeof obj.bookName === 'string' ? obj.bookName : '',
      chapterBoundaries: Array.isArray(obj.chapterBoundaries)
        ? obj.chapterBoundaries.filter(isValidBoundary)
        : [],
      stagesCompleted: Array.isArray(obj.stagesCompleted) ? obj.stagesCompleted : [],
      lastStageInProgress: obj.lastStageInProgress,
      pausedAfterStage1: obj.pausedAfterStage1 === true,
      failures: Array.isArray(obj.failures) ? obj.failures : [],
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString()
    }
  } catch {
    return null
  }
}

function isValidBoundary(b: unknown): b is TeardownChapterBoundary {
  if (!b || typeof b !== 'object') return false
  const o = b as Partial<TeardownChapterBoundary>
  return (
    typeof o.chapter === 'number' &&
    typeof o.title === 'string' &&
    typeof o.start === 'number' &&
    typeof o.end === 'number'
  )
}
