import { promises as fs } from 'fs'
import { join, resolve, sep } from 'path'
import type { TeardownRepository } from './teardown-repository'
import { sanitizeBookName } from './teardown-repository'

/**
 * 对标书解析层（对齐 oh-story-claudecode 的对标/拆文库分离设计）。
 *
 * 路径查找回退链（canonical path）：
 *   项目级 对标/{书名}/ → 全局 teardown-library/{书名}/
 *
 * 权威优先级（召回时读哪些文件）：
 *   ① 情绪模块.md（情绪/套路权威）—— 召回 selected_emotion_module
 *   ② 节奏.md（节奏权威）—— 召回 rhythm_reference
 *   ③ 文风.md（句法层）—— 召回文风约束
 *   ④ 拆文报告.md（投影摘要，冲突时让位权威文件）
 *
 * 项目 对标/ 是引用视图（从拆文库复制的子集），全局 拆文库/ 是数据源。
 * 找不到对标书时返回 null（写作降级为无对标，不报错）。
 */
export interface BenchmarkArtifacts {
  bookName: string
  /** 实际命中的目录（项目级或全局） */
  resolvedDir: string
  /** 情绪模块.md 全文（可复现模块卡 EM-*） */
  emotionModuleMd?: string
  /** 节奏.md 全文（关键信息推进/爽点循环/情绪触动点） */
  rhythmMd?: string
  /** 文风.md 全文（句长/标点/对话潜台词/情绪节奏） */
  styleMd?: string
  /** 拆文报告.md 全文（投影摘要，可借鉴套路/写法技巧） */
  reportMd?: string
}

export class BenchmarkResolver {
  constructor(
    private readonly teardownRepo: TeardownRepository
  ) {}

  /**
   * 解析一本对标书的产物（按回退链）。
   * @param projectDir 项目目录（查 对标/{书名}/）
   * @param bookName 对标书名
   */
  async resolve(projectDir: string, bookName: string): Promise<BenchmarkArtifacts | null> {
    // 清洗书名，防止 `..` 等穿越段进入 path.join
    const safeName = sanitizeBookName(bookName)
    const projectBenchmarkDir = resolve(projectDir, '对标', safeName)
    const teardownDir = this.teardownRepo.bookDir(safeName)

    // 纵深防御：解析后必须分别位于 projectDir/对标 和 teardownRoot 之下
    const benchmarkRoot = resolve(projectDir, '对标')
    if (
      projectBenchmarkDir !== benchmarkRoot &&
      !projectBenchmarkDir.startsWith(benchmarkRoot + sep)
    ) {
      return null
    }

    // 回退链：优先项目级 对标/，其次全局 拆文库/
    let resolvedDir: string | null = null
    if (await this.isDirectory(projectBenchmarkDir)) {
      resolvedDir = projectBenchmarkDir
    } else if (await this.isDirectory(teardownDir)) {
      resolvedDir = teardownDir
    }
    if (!resolvedDir) return null

    const [emotionModuleMd, rhythmMd, styleMd, reportMd] = await Promise.all([
      this.tryRead(join(resolvedDir, '剧情', '情绪模块.md')),
      this.tryRead(join(resolvedDir, '剧情', '节奏.md')),
      this.tryRead(join(resolvedDir, '文风.md')),
      this.tryRead(join(resolvedDir, '拆文报告.md'))
    ])

    // 至少有一个权威产物才算有效对标（避免空目录误命中）
    if (!emotionModuleMd && !rhythmMd && !styleMd && !reportMd) {
      return null
    }

    return {
      bookName,
      resolvedDir,
      emotionModuleMd,
      rhythmMd,
      styleMd,
      reportMd
    }
  }

  /** 解析项目的全部对标书（按 benchmarkBooks 列表） */
  async resolveAll(
    projectDir: string,
    benchmarkBooks: string[] | undefined
  ): Promise<BenchmarkArtifacts[]> {
    if (!benchmarkBooks || benchmarkBooks.length === 0) return []
    const results = await Promise.all(
      benchmarkBooks.map((name) => this.resolve(projectDir, name.trim()).catch(() => null))
    )
    return results.filter((r): r is BenchmarkArtifacts => r !== null)
  }

  private async isDirectory(dir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dir)
      return stat.isDirectory()
    } catch {
      return false
    }
  }

  private async tryRead(file: string): Promise<string | undefined> {
    try {
      const content = await fs.readFile(file, 'utf-8')
      return content.trim() || undefined
    } catch {
      return undefined
    }
  }
}
