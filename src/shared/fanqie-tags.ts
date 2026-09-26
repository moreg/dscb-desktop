/**
 * 番茄小说作者区标签推荐（纯函数，主/渲染进程共用）。
 *
 * 数据源：作者区真实接口调研结果（2026-08 抓取）——阅读标签
 * /api/author/book/category_list/v0/（260 个，分「主分类/主题/角色/情节」四层），
 * 内容标签 /app/book/label_list/v0/（359 个，分「世界观/人设/情感/情节」四组）。
 * 完整词表见 fanqie-tags-data.ts。
 *
 * 打标签思路：以「关键词 → 标签」映射为主，书名/简介/题材里出现关键词即加分；
 * 标签名自报家门或题材直接命中给更高分。最后按层截断输出，
 * 每个命中都带 via（命中理由）供人工核对。
 *
 * 注意：番茄建书时「阅读标签」主分类是书架分类的必备项（layer=主分类），
 * 其余阅读标签与内容标签都属于书架标签墙 / 推荐画像，可多选。
 */

import type { FanqieReadingTag, FanqieContentTag } from './fanqie-tags-data'
import { FANQIE_READING_TAGS, FANQIE_CONTENT_TAGS } from './fanqie-tags-data'

export interface FanqieTagHit {
  /** 词表对应 id：阅读标签=categoryId，内容标签=labelId */
  id: number
  name: string
  /** 命中理由（关键词 / 题材 / 原文命中），供人工核对 */
  via: string[]
  score: number
}

export interface FanqieTagRecommendation {
  /** 主分类（layer=主分类）命中里得分最高的一个；建书时作为书架分类 */
  mainCategory?: FanqieTagHit
  /** 其余阅读标签（主题/角色/情节层） */
  readingTags: FanqieTagHit[]
  /** 内容标签（世界观/人设/情感/情节四组） */
  contentTags: FanqieTagHit[]
}

export interface FanqieTagInput {
  /** 书名 / 项目名 */
  name?: string
  /** 作品简介 / 题材描述 */
  description?: string
  /** 项目题材（ProjectData.genre，如「玄幻」「都市言情」），命中权重最高 */
  genre?: string
}

/**
 * 关键词 → 阅读标签名。值只允许出现在 FANQIE_READING_TAGS 里的名称。
 * 键命中文本即给该标签 +1 分。
 */
const READING_KEYWORDS: Record<string, string[]> = {
  // —— 主分类推断（书架分类必备）——
  玄幻: ['传统玄幻', '玄幻脑洞', '玄幻言情'],
  修仙: ['东方仙侠'],
  仙侠: ['东方仙侠', '古风世情'],
  修真: ['都市修真'],
  都市: ['都市日常', '都市脑洞', '都市修真', '都市种田', '都市高武'],
  高武: ['都市高武'],
  赘婿: ['战神赘婿'],
  战神: ['战神赘婿'],
  兵王: ['战神赘婿'],
  历史: ['历史古代', '历史脑洞'],
  三国: ['历史古代', '三国'],
  大唐: ['历史古代', '大唐'],
  宋朝: ['历史古代', '宋朝'],
  明朝: ['历史古代', '明朝'],
  清朝: ['历史古代', '清朝'],
  大秦: ['历史古代', '大秦'],
  民国: ['民国言情', '民国'],
  穿越: ['穿越', '古穿今', '今穿古', '群穿', '异世穿越', '清穿'],
  重生: ['重生', '双重生'],
  末世: ['科幻末世', '末世'],
  丧尸: ['科幻末世'],
  星际: ['科幻末世', '星际'],
  机甲: ['科幻末世'],
  科幻: ['科幻末世'],
  规则怪谈: ['悬疑脑洞', '规则怪谈'],
  惊悚: ['悬疑脑洞', '惊悚游戏'],
  灵异: ['悬疑灵异', '灵异'],
  悬疑: ['悬疑脑洞', '悬疑灵异', '悬疑'],
  推理: ['悬疑脑洞', '推理'],
  探案: ['悬疑脑洞', '破案'],
  破案: ['悬疑脑洞', '破案'],
  盗墓: ['悬疑灵异', '盗墓'],
  谍战: ['抗战谍战', '谍战'],
  抗战: ['抗战谍战'],
  宫斗: ['宫斗宅斗'],
  宅斗: ['宫斗宅斗'],
  古言: ['古言脑洞', '古言权谋'],
  权谋: ['古言权谋'],
  朝堂: ['古言权谋'],
  女尊: ['古言脑洞', '女强'],
  甜宠: ['青春甜宠', '甜宠'],
  校园: ['青春甜宠', '校园'],
  青梅竹马: ['青春甜宠', '青梅竹马'],
  总裁: ['豪门总裁', '总裁'],
  豪门: ['豪门总裁', '豪门世家'],
  马甲: ['玄幻脑洞', '马甲'],
  系统: ['玄幻脑洞', '都市脑洞', '系统'],
  金手指: ['玄幻脑洞', '都市脑洞', '系统'],
  快穿: ['快穿'],
  无限流: ['悬疑脑洞', '无限流'],
  种田: ['种田', '都市种田'],
  美食: ['都市种田', '美食'],
  经商: ['都市种田', '发家致富'],
  年代: ['年代'],
  直播: ['都市脑洞', '直播'],
  娱乐圈: ['星光璀璨', '娱乐圈'],
  明星: ['星光璀璨', '明星'],
  电竞: ['游戏体育', '电竞'],
  体育: ['游戏体育', '体育'],
  游戏: ['游戏体育', '网游'],
  网游: ['游戏体育', '网游'],
  卡牌: ['游戏体育', '卡牌'],
  同人: ['男频衍生', '女频衍生', '同人'],
  衍生: ['男频衍生', '女频衍生', '动漫衍生', '衍生'],
  二次元: ['动漫衍生', '二次元'],
  现言: ['现言脑洞', '现代言情'],
  职场: ['职场婚恋', '职场商战', '职场'],
  婚恋: ['职场婚恋', '婚恋'],
  双男主: ['双男主'],
  双女主: ['双女主'],
  纯爱: ['双男主', '纯爱'],
  玄学: ['风水秘术'],
  风水: ['风水秘术'],
  捉鬼: ['悬疑灵异', '捉鬼'],
  鬼怪: ['悬疑灵异', '捉鬼'],
  山海经: ['山海经'],
  洪荒: ['洪荒'],
  封神: ['洪荒', '封神'],
  西游: ['西游衍生'],
  红楼: ['红楼衍生'],
  甄嬛: ['甄嬛衍生'],
  漫威: ['漫威'],
  火影: ['火影'],
  龙珠: ['龙珠'],
  海贼: ['海贼'],
  宝可梦: ['神奇宝贝'],
  奥特曼: ['动漫衍生'],
  特工: ['特工'],
  杀手: ['特工'],
  医生: ['医生'],
  律师: ['律师'],
  厨娘: ['厨娘'],
  学霸: ['学霸'],
  奶爸: ['奶爸'],
  萌宝: ['萌宝'],
  女帝: ['女帝'],
  皇帝: ['皇帝'],
  公主: ['公主'],
  王妃: ['王妃'],
  皇叔: ['皇叔'],
  嫡女: ['嫡女'],
  精灵: ['精灵'],
  反派: ['反派'],
  大佬: ['大佬'],
  神豪: ['神豪'],
  兽世: ['兽世'],
  军旅: ['异世大陆'],
  末日求生: ['科幻末世', '末日求生'],
  求生: ['悬疑脑洞', '求生'],
  废土: ['科幻末世', '废土'],
  赛博朋克: ['科幻末世', '赛博朋克'],
  克苏鲁: ['悬疑灵异', '克苏鲁'],
  武侠: ['武侠', '传统玄幻'],
  剑修: ['东方仙侠', '剑修'],
  剑道: ['东方仙侠', '剑道'],
  无CP: ['双男主', '无CP'],
  单女主: ['单女主'],
  多女主: ['多女主'],
  无女主: ['无女主'],
  后宫: ['战神赘婿'],
  无后宫: ['无后宫'],
  搞笑: ['都市脑洞', '搞笑轻松'],
  轻小说: ['动漫衍生', '搞笑轻松'],
  开局: ['开局'],
  龙傲天: ['都市高武', '无脑爽']
}

/**
 * 关键词 → 内容标签名。值只允许出现在 FANQIE_CONTENT_TAGS 里的名称。
 */
const CONTENT_KEYWORDS: Record<string, string[]> = {
  玄幻: ['位面'],
  修仙: ['修仙者', '仙尊'],
  修真: ['修仙者'],
  宗门: ['宗门大比', '收徒'],
  武侠: ['综武'],
  江湖: ['综武'],
  都市: ['都市江湖'],
  末世: ['丧尸', '末世种田'],
  丧尸: ['丧尸'],
  天灾: ['末世冰封'],
  废土: ['废土'],
  星际: ['星际'],
  机甲: ['机甲'],
  赛博: ['赛博朋克'],
  诡异: ['规则怪谈'],
  规则怪谈: ['规则怪谈'],
  惊悚: ['惊悚游戏'],
  无限流: ['无限流'],
  副本: ['无限流'],
  穿书: ['穿书'],
  穿剧: ['穿剧'],
  两界穿梭: ['两界穿梭'],
  抽卡: ['抽卡'],
  转职: ['转职'],
  觉醒: ['觉醒天赋', '全民觉醒'],
  灵气复苏: ['灵气复苏'],
  女尊: ['女尊'],
  兽世: ['兽世'],
  兽人: ['兽世'],
  基建: ['基建'],
  种田: ['美食'],
  美食: ['美食'],
  经商: ['商战', '致富'],
  囤货: ['囤物资'],
  逃荒: ['逃荒'],
  直播: ['直播'],
  带货: ['带货直播'],
  黑科技: ['黑科技'],
  大逃杀: ['大逃杀'],
  逃生: ['密室逃脱'],
  密室: ['密室逃脱'],
  电竞: ['电竞'],
  游戏: ['游戏入侵', '游戏制作'],
  网游: ['游戏入侵'],
  历史: ['历史演义'],
  三国: ['三国'],
  大唐: ['大唐'],
  宋朝: ['宋朝'],
  明朝: ['明朝'],
  清朝: ['清朝'],
  大秦: ['大秦'],
  抗战: ['抗战'],
  港综: ['港综'],
  韩娱: ['韩娱'],
  综漫: ['综漫'],
  综影视: ['综影视'],
  漫威: ['漫威'],
  火影: ['火影'],
  海贼: ['海贼王'],
  龙珠: ['龙珠'],
  宝可梦: ['宝可梦'],
  奥特曼: ['奥特曼'],
  洪荒: ['洪荒'],
  封神: ['封神'],
  西游: ['西游衍生'],
  山海经: ['山海经'],
  红楼: ['红楼衍生'],
  甄嬛: ['甄嬛衍生'],
  如懿: ['如懿衍生'],
  科举: ['科举'],
  仕途: ['仕途'],
  权谋: ['权谋'],
  夺嫡: ['夺嫡'],
  后宫: ['后宫'],
  家族: ['豪门世家'],
  豪门: ['豪门世家'],
  女帝: ['女帝'],
  暴君: ['暴君'],
  王爷: ['王爷'],
  皇叔: ['皇叔'],
  王妃: ['王妃'],
  贵妃: ['贵妃'],
  妃子: ['宠妃'],
  嫡福晋: ['嫡福晋'],
  婆婆: ['老太太'],
  老奶奶: ['太奶奶'],
  丫鬟: ['丫鬟'],
  主母: ['主母'],
  继室: ['继室'],
  农女: ['农女'],
  商女: ['商女'],
  医妃: ['医妃'],
  神医: ['神医'],
  名医: ['神医'],
  医女: ['医妃'],
  奶爸: ['奶爸'],
  萌宝: ['萌宝'],
  宝宝: ['萌宝'],
  萌娃: ['萌宝'],
  奶妈: ['奶妈'],
  学霸: ['学霸'],
  高智商: ['高智商'],
  天才: ['天才'],
  神童: ['天才'],
  千金: ['豪门千金', '名媛'],
  名媛: ['名媛'],
  灰姑娘: ['灰姑娘'],
  总裁: ['总裁'],
  霸总: ['总裁'],
  赘婿: ['赘婿'],
  战神: ['战神'],
  兵王: ['战神'],
  军嫂: ['军嫂'],
  军人: ['军嫂'],
  网红: ['网红'],
  反派: ['反派'],
  恶人: ['反派'],
  女配: ['恶毒女配'],
  炮灰: ['炮灰'],
  穿成女配: ['穿成女配'],
  满级大佬: ['满级大佬'],
  大佬: ['满级大佬'],
  娇妻: ['娇妻'],
  小甜妻: ['娇妻'],
  灵气: ['修仙者'],
  修行者: ['修仙者'],
  狐妖: ['狐妖'],
  吸血鬼: ['吸血鬼'],
  美人鱼: ['美人鱼'],
  石灵: ['非人类'],
  非人类: ['非人类'],
  双洁: ['双洁'],
  双C: ['双洁'],
  '1v1': ['1v1'],
  无CP: ['无CP'],
  无女主: ['无女主'],
  单女主: ['单女主'],
  多女主: ['多CP'],
  无男主: ['单女主'],
  多CP: ['多CP'],
  虐恋: ['虐恋情深'],
  虐心: ['虐恋情深'],
  追妻: ['追妻'],
  追夫: ['追夫'],
  火葬场: ['追妻火葬场', '追夫火葬场'],
  破镜重圆: ['破镜重圆'],
  破镜不重圆: ['破镜不重圆'],
  久别重逢: ['久别重逢'],
  青梅竹马: ['青梅竹马'],
  初恋: ['初恋'],
  暗恋: ['暗恋'],
  白月光: ['白月光'],
  替身: ['替身'],
  先婚后爱: ['先婚后爱'],
  闪婚: ['闪婚'],
  隐婚: ['隐婚'],
  婚约: ['祈福联姻', '家族联姻'],
  联姻: ['家族联姻'],
  姐弟恋: ['姐弟恋'],
  年上: ['年上'],
  老夫少妻: ['老夫少妻'],
  师徒: ['师徒'],
  人外: ['人外恋'],
  相爱相杀: ['相爱相杀'],
  救赎: ['救赎'],
  双向奔赴: ['双向奔赴', '双向暗恋'],
  治愈: ['救赎'],
  温馨: ['救赎'],
  婚恋: ['日久生情'],
  日久生情: ['日久生情'],
  打脸: ['逆袭'],
  逆袭: ['逆袭'],
  装逼: ['逆袭'],
  吃瓜: ['吃瓜'],
  // 注意：不要加「爽文」→「逆袭」映射——爽文只是泛指爽感向，和「逆袭翻盘」这个具体情节标签无关，
  // 加上会导致几乎所有写「爽文」的题材都被误打上逆袭标签
  群像: ['群像'],
  全息: ['游戏入侵'],
  查案: ['破案'],
  探案: ['破案'],
  推理: ['推理'],
  捉鬼: ['捉鬼'],
  捉妖: ['捉鬼'],
  驱邪: ['驱魔降妖'],
  法事: ['风水秘术'],
  风水: ['风水秘术'],
  盗墓: ['古墓探秘'],
  鉴宝: ['鉴宝'],
  古玩: ['鉴宝'],
  末日求生: ['末世种田'],
  荒岛: ['荒岛求生'],
  公路: ['公路求生'],
  海洋: ['海洋求生'],
  全球灾变: ['全球灾变'],
  神豪: ['神豪'],
  暴富: ['神豪'],
  财阀: ['神豪'],
  争宠: ['宠妃'],
  宫斗: ['夺嫡'],
  皇位: ['夺嫡'],
  登基: ['夺嫡'],
  复仇: ['复仇'],
  虐渣: ['虐渣'],
  黑化: ['黑化'],
  打怪升级: ['打怪升级'],
  升级流: ['打怪升级'],
  技能: ['爆装备'],
  装备: ['爆装备'],
  建设: ['经营建设'],
  经营: ['经营建设'],
  升职: ['仕途'],
  升官: ['仕途'],
  官场: ['仕途'],
  分家: ['分家'],
  高考: ['高考'],
  上学: ['升学'],
  考研: ['升学'],
  考场: ['升学'],
  直播穿越: ['直播穿越'],
  越狱: ['越狱'],
  逃亡: ['密室逃脱'],
  入魔: ['入魔'],
  双修: ['双修'],
  渡劫: ['历劫'],
  历劫: ['历劫'],
  灵魂: ['灵魂互换', '附身'],
  附身: ['附身'],
  赶尸: ['赶尸'],
}

function buildHaystack(input: FanqieTagInput): string {
  return [input.name, input.description, input.genre].filter(Boolean).join('\n')
}

interface ScoreEntry {
  via: string[]
  score: number
}

type ScoreMap = Map<string, ScoreEntry>

function bump(map: ScoreMap, name: string, reason: string, weight: number): void {
  const entry = map.get(name) ?? { via: [], score: 0 }
  if (!entry.via.includes(reason)) entry.via.push(reason)
  entry.score += weight
  map.set(name, entry)
}

/** 关键词映射：文本包含关键词 → 加分 */
function scoreByKeywords(map: ScoreMap, haystack: string, mapping: Record<string, string[]>): void {
  for (const [keyword, tagNames] of Object.entries(mapping)) {
    if (!haystack.includes(keyword)) continue
    for (const name of tagNames) bump(map, name, keyword, 1)
  }
}

/** 题材直接给高分（项目题材是人工填写的，置信度最高） */
function scoreByGenre(map: ScoreMap, genre: string | undefined, allNames: string[]): void {
  if (!genre) return
  for (const name of allNames) {
    if (genre.includes(name)) bump(map, name, '题材', 2)
  }
}

/** 标签名在书名/简介里自报家门（例如简介里写「系统文」「重生」） */
function scoreBySelfHit(map: ScoreMap, haystack: string, allNames: string[]): void {
  for (const name of allNames) {
    if (haystack.includes(name)) bump(map, name, '原文命中', 1)
  }
}

function toHits(map: ScoreMap, byName: (name: string) => number | undefined, limit: number): FanqieTagHit[] {
  return [...map.entries()]
    .map(([name, { via, score }]) => ({ name, id: byName(name) ?? -1, via, score }))
    .filter((hit) => hit.id >= 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh'))
    .slice(0, limit)
}

/**
 * 番茄作者区建书标签的数量限制（建书页面上限，用户已确认）：
 * - 阅读标签：主分类 1 + 主题 2 + 角色 2 + 情节 2 = 7 个
 * - 内容标签：世界观 1 + 人设 4 + 情感 2 + 情节 4 = 11 个
 */
export const FANQIE_READING_LIMITS: Record<'主分类' | '主题' | '角色' | '情节', number> = {
  主分类: 1,
  主题: 2,
  角色: 2,
  情节: 2
}

export const FANQIE_CONTENT_LIMITS: Record<'世界观' | '人设' | '情感' | '情节', number> = {
  世界观: 1,
  人设: 4,
  情感: 2,
  情节: 4
}

/** 每个标签在词表里的层/组（供分组截断用） */
function readingLayerOf(id: number): FanqieReadingTag['layer'] | undefined {
  return FANQIE_READING_TAGS.find((t) => t.categoryId === id)?.layer
}

function contentGroupOf(id: number): FanqieContentTag['group'] | undefined {
  return FANQIE_CONTENT_TAGS.find((t) => t.labelId === id)?.group
}

/** 按层截断：每层最多保留 limit 个（按 score 从高到低，同分按名字序） */
function truncateBy(layerOf: (id: number) => string | undefined, limits: Record<string, number>, hits: FanqieTagHit[]): FanqieTagHit[] {
  const byLayer = new Map<string, FanqieTagHit[]>()
  for (const hit of hits) {
    const layer = layerOf(hit.id)
    if (!layer) continue
    const arr = byLayer.get(layer) ?? []
    arr.push(hit)
    byLayer.set(layer, arr)
  }
  let out: FanqieTagHit[] = []
  for (const [layer, arr] of byLayer) {
    const limit = limits[layer] ?? 0
    out = out.concat(arr.slice(0, limit))
  }
  // 输出按层顺序稳定排序（主分类·主题·角色·情节；世界观·人设·情感·情节）
  const order = Object.keys(limits)
  return out.sort((a, b) => {
    const la = order.indexOf(layerOf(a.id) ?? '')
    const lb = order.indexOf(layerOf(b.id) ?? '')
    if (la !== lb) return la - lb || a.name.localeCompare(b.name, 'zh')
    return b.score - a.score || a.name.localeCompare(b.name, 'zh')
  })
}

/**
 * 推荐番茄作者区建书时的阅读标签（书架分类 + 标签墙）与内容标签（推荐画像）。
 *
 * - mainCategory：layer=主分类 得分最高的一个（最多 1 个），建书时用作书架分类；
 * - readingTags：主题/角色/情节层推荐，按上限截断（主题 2/角色 2/情节 2）；
 * - contentTags：内容标签推荐，按上限截断（世界观 1/人设 4/情感 2/情节 4）。
 *
 * 每次调用都受 FANQIE_READING_LIMITS / FANQIE_CONTENT_LIMITS 约束，保证输出可直接用于建书。
 * 纯函数：同一输入恒同一输出，便于测试与「重新推荐」。
 */
export function recommendFanqieTags(input: FanqieTagInput): FanqieTagRecommendation {
  const haystack = buildHaystack(input)
  const readingNames = FANQIE_READING_TAGS.map((t) => t.name)
  const contentNames = FANQIE_CONTENT_TAGS.map((t) => t.name)

  const reading = new Map<string, ScoreEntry>()
  scoreByKeywords(reading, haystack, READING_KEYWORDS)
  scoreByGenre(reading, input.genre, readingNames)
  scoreBySelfHit(reading, haystack, readingNames)

  const content = new Map<string, ScoreEntry>()
  scoreByKeywords(content, haystack, CONTENT_KEYWORDS)
  scoreByGenre(content, input.genre, contentNames)
  scoreBySelfHit(content, haystack, contentNames)

  const readingId = (name: string) => FANQIE_READING_TAGS.find((t) => t.name === name)?.categoryId
  const contentId = (name: string) => FANQIE_CONTENT_TAGS.find((t) => t.name === name)?.labelId

  const allReadingHits = toHits(reading, readingId, 100)
  const allContentHits = toHits(content, contentId, 100)

  // 主分类：layer=主分类 的推荐里得分最高者（最多 1 个）
  const mainCategory: FanqieTagHit | undefined = allReadingHits.find(
    (hit) => readingLayerOf(hit.id) === '主分类'
  )

  // 阅读标签（其余层，按层限度截断，主分类不在此列）
  const readingTags = truncateBy(readingLayerOf as (id: number) => string | undefined, FANQIE_READING_LIMITS, allReadingHits.filter((hit) => readingLayerOf(hit.id) !== '主分类'))

  // 内容标签（按组限度截断）
  const contentTags = truncateBy(contentGroupOf as (id: number) => string | undefined, FANQIE_CONTENT_LIMITS, allContentHits)

  return { mainCategory, readingTags, contentTags }
}

export { FANQIE_READING_TAGS, FANQIE_CONTENT_TAGS }
export type { FanqieReadingTag, FanqieContentTag }
