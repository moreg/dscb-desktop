import { join } from 'path'
import { promises as fs } from 'fs'
import { writeTextAtomic } from '../atomic'

const PAD = 3

/**
 * 正文仓储。支持双格式读取：
 * - 技能格式：`正文/第NNN章 标题.md`（3位零填充 + 空格 + 标题）
 * - 兼容旧技能格式：`正文/第NNN章_标题.md`（下划线分隔）
 * - app 旧格式：`正文/NNN.md`（纯数字，3位零填充）
 *
 * 写入始终用技能格式（`第NNN章 标题.md`），与正文编辑器保存一致。
 * 读取时先找技能格式（空格→下划线兼容），找不到再回退旧格式。
 */
export class ProseRepo {
  constructor(private readonly projectDir: string) {}

  /** app 旧格式文件路径：NNN.md */
  private legacyFile(n: number): string {
    return join(this.projectDir, '正文', `${String(n).padStart(PAD, '0')}.md`)
  }

  /** 技能格式文件路径：第NNN章 标题.md */
  private skillFile(n: number, title: string): string {
    const safeTitle = sanitizeTitle(title)
    return join(this.projectDir, '正文', `${this.chapterPrefix(n)} ${safeTitle}.md`)
  }

  /** 章节前缀：第NNN章（不含分隔符） */
  private chapterPrefix(n: number): string {
    return `第${String(n).padStart(PAD, '0')}章`
  }

  async read(n: number): Promise<string> {
    // 1. 先找技能格式：第NNN章 *.md（空格分隔，优先）或 第NNN章_*.md（下划线兼容）
    const skillFile = await this.findSkillFile(n)
    if (skillFile) {
      try {
        return await fs.readFile(skillFile, 'utf-8')
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code !== 'ENOENT') throw err
      }
    }
    // 2. 回退旧格式：NNN.md
    try {
      return await fs.readFile(this.legacyFile(n), 'utf-8')
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return ''
      throw err
    }
  }

  /**
   * 写入正文。标题提供时使用技能格式（`第NNN章 标题.md`）；
   * 标题缺失时回退旧格式（`NNN.md`）。
   * 写入前会自动迁移同章节的旧文件（重命名/清理）。
   */
  async write(n: number, content: string, title?: string): Promise<void> {
    if (!title) {
      // 无标题：直接用旧格式写入
      await writeTextAtomic(this.legacyFile(n), content)
      return
    }

    const target = this.skillFile(n, title)
    // 迁移：删除其他格式的旧文件，避免同章节多份文件
    await this.migrateOldFiles(n, target)
    await writeTextAtomic(target, content)
  }

  async exists(n: number): Promise<boolean> {
    // 检查技能格式
    const skillFile = await this.findSkillFile(n)
    if (skillFile) return true
    // 检查旧格式
    try {
      await fs.access(this.legacyFile(n))
      return true
    } catch {
      return false
    }
  }

  /**
   * 在 正文/ 目录中查找技能格式的章节文件（第NNN章 标题.md 或 第NNN章_标题.md）。
   * 优先匹配空格分隔的新格式；找不到再匹配下划线分隔的旧格式。
   * @returns 匹配的文件完整路径，或 null
   */
  private async findSkillFile(n: number): Promise<string | null> {
    const dir = join(this.projectDir, '正文')
    const prefix = this.chapterPrefix(n)
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      return null
    }
    const candidates = files.filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
    if (candidates.length === 0) return null
    // 优先空格分隔（新格式），其次下划线分隔（兼容旧技能格式）
    const spaceMatch = candidates.find((f) => f.charAt(prefix.length) === ' ')
    if (spaceMatch) return join(dir, spaceMatch)
    const underscoreMatch = candidates.find((f) => f.charAt(prefix.length) === '_')
    if (underscoreMatch) return join(dir, underscoreMatch)
    // 兜底：前缀匹配即可（容错）
    return join(dir, candidates[0])
  }

  /**
   * 迁移旧文件：写入新格式前清理同章节的其他格式文件，避免多份残留。
   * - 旧格式 NNN.md → 删除
   * - 旧技能格式 第NNN章_标题.md → 删除
   * - 同章节但不同标题的 第NNN章 xxx.md → 删除（标题变更后旧文件应被替换）
   */
  private async migrateOldFiles(n: number, target: string): Promise<void> {
    const dir = join(this.projectDir, '正文')
    const prefix = this.chapterPrefix(n)
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      return
    }
    for (const f of files) {
      if (!f.startsWith(prefix) || !f.endsWith('.md')) continue
      const full = join(dir, f)
      if (full === target) continue
      try {
        await fs.unlink(full)
      } catch {
        // 清理失败不阻断主流程
      }
    }
    // 清理旧格式 NNN.md
    const legacy = this.legacyFile(n)
    if (legacy !== target) {
      try {
        await fs.unlink(legacy)
      } catch {
        // ignore
      }
    }
  }
}

/** 清理标题中的非法文件名字符，保留可读性 */
function sanitizeTitle(title: string): string {
  if (!title) return '未命名'
  // 替换路径分隔符和其他危险字符为空格，再合并连续空白
  return title.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || '未命名'
}
