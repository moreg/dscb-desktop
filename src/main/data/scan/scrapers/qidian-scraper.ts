import type { Scraper } from './types'
import type { ScanBookRecord } from '../../../../shared/types'

const MOBILE_BASE_URL = 'https://m.qidian.com'

const MOBILE_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
}

const RANK_TYPES = [
  { id: 'hotsales', label: '畅销榜', mobilePath: '/rank/hotsales/' },
  { id: 'yuepiao', label: '月票榜', mobilePath: '/rank/yuepiao/' },
  { id: 'readindex', label: '阅读指数榜', mobilePath: '/rank/readindex/' },
  { id: 'collect', label: '收藏榜', mobilePath: '/rank/collect/' },
  { id: 'recom', label: '原创推荐榜', mobilePath: '/rank/recom/' },
  { id: 'signnewbook', label: '签约作者新书榜', mobilePath: '/rank/sign/' },
  { id: 'pubnewbook', label: '公众作者新书榜', mobilePath: '/rank/pubnewbook/' },
  { id: 'newauthor', label: '新人作者新书榜', mobilePath: '/rank/newauthor/' },
  { id: 'newsign', label: '新人签约新书榜', mobilePath: '/rank/newsign/' }
]

/**
 * 起点采集器：移动端 SSR（不依赖 CDP/浏览器，规避 PC 风控）。
 *
 * 采集 m.qidian.com 的 pageContext JSON（vite-plugin-ssr 注入），解析 books 数组。
 * 移植自 qidian-rank-scraper.js 的 mobile 模式。
 */
export class QidianScraper implements Scraper {
  platform = 'qidian' as const
  rankTypes = RANK_TYPES.map((r) => ({ id: r.id, label: r.label }))

  async scrape(rankType: string) {
    const rt = RANK_TYPES.find((r) => r.id === rankType) ?? RANK_TYPES[0]
    const url = `${MOBILE_BASE_URL}${rt.mobilePath}`
    const html = await this.fetchText(url)
    const pageContext = this.extractMobilePageContext(html)
    // pageContext 是 vite-plugin-ssr 注入的嵌套 JSON，深层路径用 any 访问
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pc = pageContext as any
    const pageData = pc?.pageContext?.pageProps?.pageData
    const booksRaw =
      pageData?.books ?? pageData?.rank?.books ?? pageData?.list ?? []
    if (!Array.isArray(booksRaw) || booksRaw.length === 0) {
      throw new Error(
        '起点移动端 SSR 未解析到榜单数据（页面结构可能变更，或被风控拦截）'
      )
    }
    const books: ScanBookRecord[] = booksRaw.map(
      (record: Record<string, unknown>, idx: number) => this.normalizeMobileBook(record, idx)
    )
    return {
      books,
      sourceMode: 'fetch' as const,
      dataQualityNote: `抓取方式：mobile-ssr（${url}）`
    }
  }

  private async fetchText(url: string): Promise<string> {
    const res = await fetch(url, {
      headers: MOBILE_HEADERS,
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) throw new Error(`起点请求失败：HTTP ${res.status}`)
    return res.text()
  }

  /** 从 HTML 提取 vite-plugin-ssr 注入的 pageContext JSON */
  private extractMobilePageContext(html: string): unknown {
    const m = html.match(
      /<script[^>]+id=["']vite-plugin-ssr_pageContext["'][^>]*>([\s\S]*?)<\/script>/i
    )
    if (!m) return null
    try {
      return JSON.parse(m[1])
    } catch {
      return null
    }
  }

  /** pageContext 的 book 记录 → 统一 ScanBookRecord */
  private normalizeMobileBook(record: Record<string, unknown>, idx: number): ScanBookRecord {
    const title = String(record.bName ?? record.bookName ?? '')
    const bid = String(record.bid ?? record.bookId ?? '')
    const genre = [record.cat, record.subCat].filter(Boolean).join('·')
    const stats: string[] = []
    if (record.cnt) stats.push(String(record.cnt))
    if (record.rankCnt) stats.push(`榜单值 ${record.rankCnt}`)
    return {
      rank: Number(record.rankNum ?? idx + 1),
      title,
      url: bid ? `${MOBILE_BASE_URL}/book/${bid}/` : '',
      author: String(record.bAuth ?? record.author ?? ''),
      genre,
      status: stats.join(' · '),
      descText: String(record.desc ?? '')
    }
  }
}
