import type { Scraper } from './types'
import type { ScanBookRecord } from '../../../../shared/types'

const BASE_URL = 'https://www.jjwxc.net'

const RANK_TYPES = [
  { id: '12', label: '收入金榜', toptenOrder: '12' },
  { id: '11', label: '收藏金榜', toptenOrder: '11' },
  { id: '10', label: '营养液金榜', toptenOrder: '10' },
  { id: '6', label: '积分金榜', toptenOrder: '6' }
]

/** 详情页核心指标（itemprop 微数据提取） */
interface JjwxcDetail {
  novelid: string
  collect?: string // 收藏数
  nutrition?: string // 营养液
  score?: string // 积分
  wordCount?: string // 字数
  status?: string // 状态
  tags?: string[]
}

/**
 * 晋江采集器：列表页 fetch + 详情页 fetch（gb18030 解码，无需登录）。
 *
 * 列表页 topten.php 只有书名+作者，详情页 onebook.php 补核心指标
 * （收藏/营养液/积分/字数/状态，用 itemprop 微数据提取）。
 *
 * 移植自 jjwxc-rank-scraper.js，但脱离 CDP（Node fetch + TextDecoder）。
 */
export class JjwxcScraper implements Scraper {
  platform = 'jjwxc' as const
  rankTypes = RANK_TYPES.map((r) => ({ id: r.id, label: r.label }))

  /** 每频道补详情的本数上限（控制时长） */
  private readonly detailTop = 10

  async scrape(rankType: string) {
    const rt = RANK_TYPES.find((r) => r.id === rankType) ?? RANK_TYPES[0]
    const listUrl = `${BASE_URL}/topten.php?orderstr=${rt.toptenOrder}&t=0`
    const html = await this.fetchGb18030(listUrl)
    const channels = this.parseListPage(html)

    // 合并各频道的书，补详情（每频道 top N）
    const allBooks: Array<{ title: string; author: string; novelid: string; channel: string }> = []
    for (const [channel, books] of Object.entries(channels)) {
      for (const b of books.slice(0, this.detailTop)) {
        allBooks.push({ ...b, channel })
      }
    }

    // 逐本补详情（串行，避免被风控）
    const details = new Map<string, JjwxcDetail>()
    let detailHits = 0
    for (const b of allBooks) {
      if (!b.novelid) continue
      try {
        const detail = await this.fetchDetail(b.novelid)
        details.set(b.novelid, detail)
        if (detail.collect) detailHits += 1
      } catch {
        // 单本失败不中断
      }
    }

    const books: ScanBookRecord[] = allBooks.map((b, idx) => {
      const d = b.novelid ? details.get(b.novelid) : undefined
      const stats: string[] = [b.channel]
      if (d?.collect) stats.push(`收藏 ${d.collect}`)
      if (d?.nutrition) stats.push(`营养液 ${d.nutrition}`)
      if (d?.wordCount) stats.push(`${d.wordCount}字`)
      if (d?.status) stats.push(d.status)
      return {
        rank: idx + 1,
        title: b.title,
        author: b.author,
        genre: '言情/女性向',
        status: stats.join(' · '),
        descText: '',
        url: b.novelid ? `${BASE_URL}/onebook.php?novelid=${b.novelid}` : '',
        tags: d?.tags
      }
    })

    const dataQualityNote =
      detailHits === 0
        ? `[详情解析异常] 0/${allBooks.length} 本取得收藏数（页面结构变更或被拦截），仅列表数据可用`
        : `详情命中率 ${detailHits}/${allBooks.length}`

    return { books, sourceMode: 'fetch' as const, dataQualityNote }
  }

  /** fetch gb18030 页面（Node 默认 UTF-8，需手动解码） */
  private async fetchGb18030(url: string): Promise<string> {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' }
    })
    if (!res.ok) throw new Error(`晋江请求失败：HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    return new TextDecoder('gb18030').decode(buf)
  }

  /** 解析列表页：频道分组 + 书名/作者/novelid */
  private parseListPage(html: string): Record<string, Array<{ title: string; author: string; novelid: string }>> {
    // 晋江列表：频道标题 + 书名/作者交替。
    // 简化提取：用正则扫所有 <a href="...novelid=N">书名</a> 和紧邻的作者
    const result: Record<string, Array<{ title: string; author: string; novelid: string }>> = {}
    const currentChannel = '默认'

    // 提取所有书名 anchor（带 novelid）
    const bookRe = /<a[^>]+href=["'][^"']*novelid=(\d+)[^"']*["'][^>]*>([^<]+)</g
    const books: Array<{ title: string; author: string; novelid: string }> = []
    let m: RegExpExecArray | null
    while ((m = bookRe.exec(html)) !== null) {
      const title = m[2].trim()
      if (!title || title.includes('向《')) continue // 排除霸王票记录
      books.push({ title, author: '', novelid: m[1] })
    }

    // 作者提取（晋江列表作者在书名后，简化：留空，详情页不依赖）
    result[currentChannel] = books
    return result
  }

  /** 详情页提取 itemprop 核心指标 */
  private async fetchDetail(novelid: string): Promise<JjwxcDetail> {
    // 防御：novelid 必须为纯数字（列表页正则已约束，此处兜底防注入）
    if (!/^\d+$/.test(novelid)) {
      throw new Error(`晋江 novelid 非法：${novelid.slice(0, 20)}`)
    }
    const url = `${BASE_URL}/onebook.php?novelid=${novelid}`
    const html = await this.fetchGb18030(url)
    // name 是受控常量（collectionNumber 等），但仍转义以防 ReDoS/正则注入
    const prop = (name: string): string => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pm = html.match(new RegExp(`itemprop=["']${escaped}["'][^>]*>([^<]*)<`))
      return pm ? pm[1].trim() : ''
    }
    // 标签
    const tagMatches = html.matchAll(/itemprop=["']keywords["'][^>]*>([^<]+)/g)
    const tags = Array.from(tagMatches)
      .map((tm) => tm[1].trim())
      .filter(Boolean)

    return {
      novelid,
      collect: prop('collectionNumber') || prop('collect'),
      nutrition: prop('nutrition'),
      score: prop('score') || prop('points'),
      wordCount: prop('wordCount') || prop('wordcount'),
      status: prop('updataStatus') || prop('updateStatus'),
      tags: tags.length > 0 ? tags : undefined
    }
  }
}
