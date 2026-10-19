import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import cases from './fixtures/fanqie-chart-tag-filter-cases.json'
import { chartBookTags, cleanSourceTags, introTags, isSelectableTag } from '../src/shared/fanqie-chart-tags'
import { prepareBooks, tagStatistics, validateInsights } from '../src/main/data/fanqie-chart/analysis'
import { FanqieChartService, normalizeChartTagData } from '../src/main/data/fanqie-chart/service'
import { FanqieChapterScraper } from '../src/main/data/fanqie-chart/chapters'
import { parseRankBooks } from '../src/main/data/fanqie-chart/parse'
import { readJson, writeJsonAtomic } from '../src/main/data/atomic'
import type { FanqieBookDetail, FanqieChartBook, FanqieChartRecord } from '../src/shared/fanqie-chart'
import type { LlmService } from '../src/main/data/llm-service'

const book = (patch: Partial<FanqieChartBook> = {}): FanqieChartBook => ({
  bookId: 'one', rank: 1, title: '测试书', author: '作者', genre: '都市脑洞', cover: '',
  wordCount: '', readCount: '', intro: '【系统+空岛垂钓】【评分刚出】故事原文。',
  tags: ['系统', '强力推荐', '系统'], url: '', status: '连载', garbled: false, ...patch
})

describe('榜单共用标签规则', () => {
  it.each(['改编漫剧即将上线', '爱是自卑弃暗投明的时刻', '地拿着她的攻略手册', '他拿着她的攻略手册', '反向把她攻略了', '刀尖上跳舞', '越危险越美丽', 'VS'])('过滤真实宫斗新榜中的宣传和剧情：%s', value => {
    expect(chartBookTags({ tags: [value], intro: `【穿书+${value}+双洁】` })).toEqual(['穿书', '双洁'])
  })
  it('人物介绍和宣传整段排除，不把句子碎片变成标签', () => {
    expect(introTags('【太初圣地大师兄陈安，天资纵横，同阶无敌】【无系统】故事。')).toEqual(['无系统'])
    expect(introTags('【极致暧昧，刀尖上跳舞，越危险越美丽】【穿书】故事。')).toEqual(['穿书'])
    expect(introTags('【穿书，训狗，顶级拉扯】【单女主+同阶无敌】故事。')).toEqual(['穿书', '训狗', '顶级拉扯', '单女主', '同阶无敌'])
  })
  it.each(['世界一', '也界一', '世界12', '也界工', '任务需要', '有的世界1V1', '有的也界无CP', '每个也界工V工', '女主全文最美'])('过滤真实快穿新榜中的分卷标题和作者说明：%s', value => {
    expect(chartBookTags({ tags: [value], intro: `【快穿+${value}+系统】` })).toEqual(['快穿', '系统'])
  })
  it('整组排除任务说明，保留独立题材与视角标签', () => {
    expect(introTags('【男主视角】【任务需要，有的也界工V工，有的也界无CP】故事。')).toEqual(['男主视角'])
    expect(chartBookTags({ intro: '【快穿+世界融合+沉浸式+无固定CP】故事。' })).toEqual(['快穿', '世界融合', '沉浸式', '无固定CP'])
  })
  it.each(['原汁原味', '懂得都懂', '不服就爆', '女主驾驶天赋拉满', '取材泡菜漫', '多多多', '炸炸炸炸炸', '全新题材', '开局拒绝死亡', '逐渐疯狂动物园', '萌宠大黄'])('过滤桌面页面发现的说明与宣传：%s', value => {
    expect(chartBookTags({ intro: `【系统+${value}+种田】`, tags: [value] })).toEqual(['系统', '种田'])
  })
  it.each(cases.reject)('排除非标签：%s', value => {
    expect(isSelectableTag(value)).toBe(false)
    expect(chartBookTags({ tags: [value, '系统'] })).toEqual(['系统'])
  })
  it.each(cases.keep)('保留有效标签：%s', value => {
    expect(isSelectableTag(value)).toBe(true)
  })
  it('处理分隔符、混合宣传语、别名和整段作者说明', () => {
    expect(introTags('【评分刚出+留洋归乡+报国+高智商】正文。')).toEqual(['留洋归乡', '报国', '高智商'])
    expect(introTags('【系统】【养成＋团宠/万绒迷】正文。')).toEqual(['系统', '养成', '团宠', '万绒迷'])
    expect(introTags('【本文纯手搓，不AI，传统工艺，值得信赖】【年代重生】正文。')).toEqual(['年代重生'])
    expect(introTags('【穿越民国+爱国情怀+虐渣+八零那本书前卷】正文。')).toEqual(['穿越民国', '爱国情怀', '虐渣'])
    expect(introTags('【模拟器】【放心品鉴】正文。')).toEqual(['模拟器'])
    expect(introTags('【系统】正文中坐上【极乐号】，看见【选项一：从18楼跳下去】。')).toEqual(['系统'])
    expect(cleanSourceTags([' 系统 ', '系统', null, '作者听劝'])).toEqual(['系统'])
  })
  it('同一本书去重，标签统计与证据核验采用同一份简介标签', () => {
    const books = [book(), book({ bookId: 'two', rank: 2, title: '另一本' })]
    const original = structuredClone(books)
    expect(prepareBooks(books)[0].tags).toEqual(['都市脑洞', '系统', '空岛垂钓'])
    const stat = tagStatistics(books).find(item => item.tag === '空岛垂钓')
    expect(stat).toMatchObject({ count: 2, topCount: 2, bookIds: ['one', 'two'] })
    expect(tagStatistics(books).some(item => item.tag === '强力推荐')).toBe(false)
    const checked = validateInsights({ insights: [{ dimension: 'hot_elements', claim: '样本采用垂钓求生设定',
      confidence: 'sample_supported', evidence: books.map(item => ({ bookId: item.bookId, field: 'tags', quote: '空岛垂钓' })) }] }, books)
    expect(checked.insights).toHaveLength(1)
    expect(books).toEqual(original)
  })
  it('榜单来源解析时自动清理标签', () => {
    const [parsed] = parseRankBooks({ data: { book_list: [{ bookId: '1', bookName: '新书',
      category: '都市脑洞', tags: ['系统', '不吃一点压力', '强力推荐'], abstract: '完整简介' }] } })
    expect(parsed.tags).toEqual(['都市脑洞', '系统'])
    expect(parsed.intro).toBe('完整简介')
  })
  it('保留简介末尾的标签，不在第 500 字截断', () => {
    const intro = '剧情正文。'.repeat(120) + '【系统+种田】'
    const [parsed] = parseRankBooks({ data: { book_list: [{ bookId: '1', bookName: '新书', abstract: intro }] } })
    expect(parsed.intro).toBe(intro)
    expect(chartBookTags(parsed)).toEqual(['系统', '种田'])
  })
})

describe('新旧榜单与详情缓存', () => {
  it('历史榜单读取后统计和标签选项使用最新规则，不调用模型', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fanqie-tag-history-'))
    try {
      const chartType = 'new_book_male:262'
      const record: FanqieChartRecord = { id: chartType, chartType, chartDate: '2026-05-30', books: [book()],
        status: 'fetched', analysis: null, ideas: null, targetCount: 30, actualCount: 1, isPartial: true,
        partialReason: '', sourceHash: '', fetchedAt: '', updatedAt: '' }
      const cachedAnalysis: FanqieChartRecord = { ...record, analysis: {
        chartType, category: '都市脑洞', chartDate: record.chartDate, analyzedAt: '', totalBooks: 1,
        analyzedBooks: 1, excludedBooks: 0, introCount: 1, readCountCount: 0, taggedCount: 1,
        isPartial: true, targetCount: 30, topN: 10, limitations: [], sourceHash: 'old',
        tagStatistics: [{ tag: '强力推荐', count: 1, share: 1, topCount: 1, topShare: 1, bookIds: ['one'] }],
        insights: ['强力推荐', '空岛垂钓'].map(quote => ({ dimension: 'hot_elements', claim: quote,
          confidence: 'sample_supported', evidence: [{ bookId: 'one', field: 'tags', quote }] }))
      } }
      const normalized = normalizeChartTagData(cachedAnalysis)
      expect(normalized.analysis?.tagStatistics.map(item => item.tag).sort()).toEqual(['系统', '空岛垂钓', '都市脑洞'].sort())
      expect(normalized.analysis?.insights.map(item => item.claim)).toEqual(['空岛垂钓'])
      expect(cachedAnalysis.analysis?.tagStatistics[0].tag).toBe('强力推荐')
      const file = path.join(dir, 'fanqie-charts', 'new_book_male__262.json')
      await writeJsonAtomic(file, record)
      const generateStream = vi.fn()
      const service = new FanqieChartService(dir, { generateStream } as unknown as LlmService)
      const [loaded] = await service.list()
      expect(loaded.books[0].tags).toEqual(['系统'])
      expect(chartBookTags(loaded.books[0])).toEqual(['都市脑洞', '系统', '空岛垂钓'])
      expect(loaded.books[0].intro).toBe(record.books[0].intro)
      expect(generateStream).not.toHaveBeenCalled()
      expect(await service.list()).toEqual([loaded])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('详情旧缓存自动清理并保存，简介标签随简介替换而更新', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fanqie-tag-detail-'))
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应请求网络'))
    try {
      const detail: FanqieBookDetail = { bookId: 'old', title: '历史书', author: '', cover: '', genre: '',
        intro: '【养成】【评分刚出】原文。', tags: ['团宠', '放心品鉴', '团宠'], wordCount: '', readCount: '', status: '',
        chapters: [{ id: 'chapter', title: '第一章', index: 1, needPay: false, isLocked: false }], cachedChapterIds: [], updatedAt: '' }
      const file = path.join(dir, 'fanqie-books', 'old', 'detail.json')
      await writeJsonAtomic(file, detail)
      const scraper = new FanqieChapterScraper(dir)
      const loaded = await scraper.getBookDetail('old')
      expect(loaded.tags).toEqual(['团宠'])
      expect((await readJson<FanqieBookDetail>(file, detail)).tags).toEqual(['团宠'])
      expect(chartBookTags(loaded)).toEqual(['团宠', '养成'])
      expect(chartBookTags({ ...loaded, intro: '【种田】新简介。' })).toEqual(['团宠', '种田'])
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally { fetchSpy.mockRestore(); await rm(dir, { recursive: true, force: true }) }
  })
})
