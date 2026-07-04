import { promises as fs } from 'fs'
import { join } from 'path'
import { LlmService } from '../llm-service'
import { QidianScraper } from './scrapers/qidian-scraper'
import { JjwxcScraper } from './scrapers/jjwxc-scraper'
import type { Scraper } from './scrapers/types'
import {
  renderScanReport,
  buildReportFileName,
  assessDataQuality,
  PLATFORM_LABELS
} from './scan-renderer'
import { buildBuiltinKnowledgeMarkdown } from './builtin-knowledge'
import {
  SCAN_ANALYZE_SYSTEM_PROMPT,
  buildTopicDecisionPrompt,
  buildBuiltinTopicPrompt
} from '../skill-prompts/scan/topic-decision'
import { writeTextAtomic } from '../atomic'
import type {
  ScanBookRecord,
  ScanPlatform,
  ScanRankType,
  ScanReportSummary,
  ScanResult,
  ScanRankInput,
  ScanSourceMode
} from '../../../shared/types'

/** 扫榜输出目录（全局，跨项目共享的市场洞察） */
const SCAN_OUTPUT_DIR = 'scan-output'

/** 长篇/短篇平台判定 */
const LONG_PLATFORMS: ScanPlatform[] = ['qidian', 'fanqie', 'jjwxc', 'qimao', 'ciweimao']
const SHORT_PLATFORMS: ScanPlatform[] = ['dz', 'heiyan', 'zhihu']

/**
 * 扫榜服务（编排 Phase 1 采集 + 报告落盘；Phase 4 选题决策由 analyzeRankStream 单独触发）。
 *
 * 采集降级链：
 *   fetch 采集器（起点 SSR / 晋江 fetch）→ 失败 → user 模式（用户提供数据）→ 无 → builtin 模式（内置知识）
 *
 * 番茄/七猫/刺猬猫/短篇平台因强反爬，默认走 user/builtin 模式（引导用户提供数据或用内置知识）。
 */
export class ScanService {
  private readonly scrapers: Partial<Record<ScanPlatform, Scraper>> = {}

  constructor(
    private readonly scanRoot: string,
    private readonly llm: LlmService
  ) {
    // 注册已实现的 fetch 采集器
    this.scrapers.qidian = new QidianScraper()
    this.scrapers.jjwxc = new JjwxcScraper()
  }

  /* =========================================================
     Phase 1：采集 + 报告落盘
     ========================================================= */

  async scan(input: ScanRankInput): Promise<ScanResult> {
    const { platform } = input
    const isLong = LONG_PLATFORMS.includes(platform)

    // user 模式：用户直接提供数据
    if (input.userData && input.userData.trim()) {
      return this.buildUserResult(platform, input.rankType ?? 'user', input.userData)
    }

    // fetch 模式：尝试用采集器
    const scraper = this.scrapers[platform]
    if (scraper) {
      try {
        const rankType = input.rankType ?? scraper.rankTypes[0]?.id ?? 'default'
        const scraped = await scraper.scrape(rankType)
        const rankLabel = scraper.rankTypes.find((r) => r.id === rankType)?.label ?? rankType
        return this.buildScrapedResult(platform, rankType, rankLabel, scraped.books, scraped.sourceMode, scraped.dataQualityNote)
      } catch (err) {
        // 采集失败，降级 builtin
        return this.buildBuiltinResult(platform, isLong, (err as Error).message)
      }
    }

    // 无 fetch 采集器的平台（番茄/七猫/刺猬猫/短篇）：直接 builtin 降级
    return this.buildBuiltinResult(
      platform,
      isLong,
      `${PLATFORM_LABELS[platform] ?? platform} 强反爬/需登录态，未内嵌采集器。请在「用户提供数据」框粘贴榜单，或使用内置知识分析。`
    )
  }

  /* =========================================================
     Phase 4：LLM 选题决策（流式）
     ========================================================= */

  async analyzeRank(
    report: string,
    platform: string,
    onToken?: (token: string) => void
  ): Promise<void> {
    const prompt = buildTopicDecisionPrompt(report, platform)
    await this.llm.generateStream(prompt, {
      systemPrompt: SCAN_ANALYZE_SYSTEM_PROMPT,
      maxTokens: 8192,
      meta: { feature: 'scan' },
      onToken
    })
  }

  /* =========================================================
     报告管理
     ========================================================= */

  async listReports(): Promise<ScanReportSummary[]> {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(this.scanDir(), { withFileTypes: true })
    } catch {
      return []
    }
    const out: ScanReportSummary[] = []
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      try {
        const content = await fs.readFile(join(this.scanDir(), e.name), 'utf-8')
        const parsed = this.parseReportHeader(content)
        out.push({
          fileName: e.name,
          platform: parsed.platform,
          rankType: parsed.rankType,
          bookCount: parsed.bookCount,
          scannedAt: parsed.scannedAt
        })
      } catch (err) {
        console.warn(`[scan-service] listReports 跳过异常报告 ${e.name}:`, err)
      }
    }
    return out.sort((a, b) => b.scannedAt.localeCompare(a.scannedAt))
  }

  async readReport(fileName: string): Promise<string | null> {
    if (!isSafeReportName(fileName)) return null
    try {
      return await fs.readFile(join(this.scanDir(), fileName), 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[scan-service] readReport 失败 (${fileName}):`, err)
      }
      return null
    }
  }

  async deleteReport(fileName: string): Promise<void> {
    if (!isSafeReportName(fileName)) return
    try {
      await fs.unlink(join(this.scanDir(), fileName))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[scan-service] deleteReport 失败 (${fileName}):`, err)
      }
    }
  }

  /* =========================================================
     私有：结果构建 + 落盘
     ========================================================= */

  private scanDir(): string {
    return join(this.scanRoot, SCAN_OUTPUT_DIR)
  }

  private async persistReport(
    platform: ScanPlatform,
    rankType: ScanRankType,
    rankLabel: string,
    markdown: string
  ): Promise<string> {
    const fileName = buildReportFileName(platform, rankType, rankLabel)
    await fs.mkdir(this.scanDir(), { recursive: true })
    await writeTextAtomic(join(this.scanDir(), fileName), markdown)
    return fileName
  }

  private async buildScrapedResult(
    platform: ScanPlatform,
    rankType: ScanRankType,
    rankLabel: string,
    books: ScanBookRecord[],
    sourceMode: ScanSourceMode,
    dataQualityNote?: string
  ): Promise<ScanResult> {
    const markdown = renderScanReport(
      platform,
      rankType,
      rankLabel,
      books,
      sourceMode,
      dataQualityNote
    )
    const fileName = await this.persistReport(platform, rankType, rankLabel, markdown)
    return {
      platform,
      rankType,
      sourceMode,
      fileName,
      books,
      markdown,
      dataQualityNote,
      scannedAt: new Date().toISOString()
    }
  }

  private async buildUserResult(
    platform: ScanPlatform,
    rankType: ScanRankType,
    userData: string
  ): Promise<ScanResult> {
    // 用户数据直接作为报告内容（包裹数据质量头）
    const now = new Date().toISOString()
    const header =
      `# ${PLATFORM_LABELS[platform] ?? platform} · 用户提供数据\n\n` +
      `- 来源：用户粘贴\n- 抓取方式：user\n- 抓取时间：${now}\n` +
      `- 数据质量：用户提供的原始数据，需人工核验\n\n---\n\n`
    const markdown = header + userData
    const fileName = await this.persistReport(platform, rankType, '用户提供', markdown)
    return {
      platform,
      rankType,
      sourceMode: 'user',
      fileName,
      books: [],
      markdown,
      dataQualityNote: '用户提供的原始数据',
      scannedAt: now
    }
  }

  private async buildBuiltinResult(
    platform: ScanPlatform,
    isLong: boolean,
    reason: string
  ): Promise<ScanResult> {
    const builtinMd = buildBuiltinKnowledgeMarkdown(isLong)
    const now = new Date().toISOString()
    const header =
      `# ${PLATFORM_LABELS[platform] ?? platform} · 内置题材趋势（降级）\n\n` +
      `- 来源：内置知识库（非实时采集）\n- 抓取方式：builtin\n- 抓取时间：${now}\n` +
      `- 数据质量：候选假设，非实时数据\n- 降级原因：${reason}\n\n---\n\n`
    const markdown = header + builtinMd
    const fileName = await this.persistReport(platform, 'builtin', '内置趋势', markdown)
    return {
      platform,
      rankType: 'builtin',
      sourceMode: 'builtin',
      fileName,
      books: [],
      markdown,
      dataQualityNote: reason,
      scannedAt: now
    }
  }

  /** 从报告头部解析 platform/rankType/bookCount/scannedAt */
  private parseReportHeader(content: string): {
    platform: ScanPlatform
    rankType: ScanRankType
    bookCount: number
    scannedAt: string
  } {
    const titleMatch = content.match(/^#\s+(.+?)$/m)
    const title = titleMatch ? titleMatch[1] : ''
    // 反查 platform
    let platform: ScanPlatform = 'qidian'
    for (const [key, label] of Object.entries(PLATFORM_LABELS)) {
      if (title.includes(label)) {
        platform = key as ScanPlatform
        break
      }
    }
    const countMatch = content.match(/条目数：(\d+)/)
    const timeMatch = content.match(/抓取时间：([^\n]+)/)
    return {
      platform,
      rankType: title.split('·')[1]?.trim() ?? '榜单',
      bookCount: countMatch ? parseInt(countMatch[1], 10) : 0,
      scannedAt: timeMatch ? timeMatch[1].trim() : ''
    }
  }
}

/** 平台支持的榜单类型（前端选择用）。独立纯函数，不实例化 service */
export function getRankTypesForPlatform(platform: ScanPlatform): { id: string; label: string }[] {
  const longDefault = [
    { id: 'hotsales', label: '畅销榜' },
    { id: 'yuepiao', label: '月票榜' },
    { id: 'readindex', label: '阅读指数榜' }
  ]
  const shortDefault = [{ id: 'hot', label: '热门榜' }]
  // 有 fetch 采集器的平台返回真实榜单
  if (platform === 'qidian') return new QidianScraper().rankTypes
  if (platform === 'jjwxc') return new JjwxcScraper().rankTypes
  // 番茄/七猫/刺猬猫/短篇平台用默认（采集走 user/builtin）
  return LONG_PLATFORMS.includes(platform) ? longDefault : shortDefault
}

/**
 * 校验报告文件名安全（防路径穿越）。
 * 拒绝 ..、路径分隔符、绝对路径——报告名只能是纯文件名。
 */
export function isSafeReportName(fileName: string): boolean {
  if (!fileName || fileName.length > 200) return false
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return false
  if (/^[A-Za-z]:/.test(fileName)) return false
  return true
}
