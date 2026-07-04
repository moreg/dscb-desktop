import type { ScanBookRecord, ScanPlatform, ScanRankType, ScanSourceMode } from '../../../../shared/types'

/**
 * 采集器统一接口。各平台实现此接口，scan-service 按 platform 路由。
 *
 * 采集失败时抛错（不返回空数组），由 scan-service 捕获并降级（user/builtin 模式）。
 */
export interface Scraper {
  platform: ScanPlatform
  /** 支持的榜单类型（label 用于前端展示） */
  rankTypes: { id: ScanRankType; label: string }[]
  /**
   * 采集榜单。
   * @returns 结构化条目 + 数据质量提示
   */
  scrape(rankType: ScanRankType): Promise<{
    books: ScanBookRecord[]
    sourceMode: ScanSourceMode
    dataQualityNote?: string
  }>
}
