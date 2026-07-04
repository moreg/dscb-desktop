import type {
  ScanBookRecord,
  ScanPlatform,
  ScanRankType,
  ScanSourceMode
} from '../../../shared/types'

const PLATFORM_LABELS: Record<ScanPlatform, string> = {
  qidian: '起点',
  fanqie: '番茄',
  jjwxc: '晋江',
  qimao: '七猫',
  ciweimao: '刺猬猫',
  dz: '点众',
  heiyan: '黑岩',
  zhihu: '知乎盐言'
}

const RANK_TYPE_FALLBACK_LABEL = '榜单'

/** 数据质量判定：有效条目数 / 问题摘要 */
export function assessDataQuality(books: ScanBookRecord[]): {
  ok: boolean
  validCount: number
  issues: string[]
} {
  const issues: string[] = []
  let valid = 0
  let emptyTitle = 0
  for (const b of books) {
    if (b.title && b.title.trim() && !b.title.includes('待解析')) {
      valid += 1
    } else {
      emptyTitle += 1
    }
  }
  if (emptyTitle > books.length * 0.3) {
    issues.push(`${emptyTitle} 本标题异常（待解析/空），疑似采集失败`)
  }
  if (books.length === 0) issues.push('榜单为空')
  return { ok: issues.length === 0, validCount: valid, issues }
}

/**
 * 渲染扫榜报告 markdown（匹配 scan-output-format.md 规范）。
 * 文件头必含：数据质量 / 有效条目 / 问题摘要。
 */
export function renderScanReport(
  platform: ScanPlatform,
  rankType: ScanRankType,
  rankLabel: string,
  books: ScanBookRecord[],
  sourceMode: ScanSourceMode,
  dataQualityNote?: string
): string {
  const now = new Date().toISOString()
  const platformLabel = PLATFORM_LABELS[platform] ?? platform
  const quality = assessDataQuality(books)

  const lines: string[] = []
  lines.push(`# ${platformLabel} · ${rankLabel || RANK_TYPE_FALLBACK_LABEL}`)
  lines.push('')
  lines.push(`- 来源：（${sourceMode} 模式采集）`)
  lines.push(`- 抓取方式：${sourceMode}`)
  lines.push(`- 抓取时间：${now}`)
  lines.push(`- 条目数：${books.length}`)
  lines.push(`- 数据质量：${quality.ok ? 'OK' : '存在问题'}`)
  lines.push(`- 有效条目：${quality.validCount} / ${books.length}`)
  lines.push(
    `- 问题摘要：${quality.issues.length === 0 ? '无' : quality.issues.join('；')}`
  )
  if (dataQualityNote) lines.push(`- 备注：${dataQualityNote}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  for (let i = 0; i < books.length; i++) {
    const b = books[i]
    lines.push(`## #${b.rank || i + 1} ${b.title || '（标题缺失）'}`)
    const meta = [b.author, b.genre, b.status].filter(Boolean).join(' · ')
    if (meta) lines.push(`*${meta}*`)
    if (b.tags && b.tags.length > 0) lines.push(`**标签：** ${b.tags.join('、')}`)
    if (b.url) lines.push(`[作品页](${b.url})`)
    if (b.descText) {
      lines.push('')
      lines.push('**简介**')
      lines.push('')
      lines.push(b.descText)
    }
    lines.push('', '---', '')
  }

  return lines.join('\n')
}

/** 生成报告文件名：{平台}{榜单}_{YYYYMMDD}.md */
export function buildReportFileName(
  platform: ScanPlatform,
  rankType: ScanRankType,
  rankLabel?: string
): string {
  const platformLabel = PLATFORM_LABELS[platform] ?? platform
  const label = rankLabel || rankType || RANK_TYPE_FALLBACK_LABEL
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  // 文件名去除非法字符
  const safeLabel = label.replace(/[\\/:*?"<>|]/g, '')
  return `${platformLabel}${safeLabel}_${date}.md`
}

export { PLATFORM_LABELS }
