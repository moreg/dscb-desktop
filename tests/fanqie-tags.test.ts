import { describe, expect, it } from 'vitest'
import {
  FANQIE_READING_TAGS,
  FANQIE_CONTENT_TAGS,
  FANQIE_READING_LIMITS,
  FANQIE_CONTENT_LIMITS,
  recommendFanqieTags
} from '../src/shared/fanqie-tags'

describe('番茄标签词表', () => {
  it('阅读标签词表取自作者区接口，层分类齐全', () => {
    expect(FANQIE_READING_TAGS.length).toBe(260)
    const layers = new Set(FANQIE_READING_TAGS.map((t) => t.layer))
    expect(layers).toEqual(new Set(['主分类', '主题', '角色', '情节']))
    // 主分类恰好 36 个（书架分类单选）
    const mains = FANQIE_READING_TAGS.filter((t) => t.layer === '主分类')
    expect(mains).toHaveLength(36)
    // categoryId 唯一
    expect(new Set(FANQIE_READING_TAGS.map((t) => t.categoryId)).size).toBe(260)
  })

  it('内容标签词表取自作者区接口，四组齐全', () => {
    expect(FANQIE_CONTENT_TAGS.length).toBe(359)
    const groups = new Set(FANQIE_CONTENT_TAGS.map((t) => t.group))
    expect(groups).toEqual(new Set(['世界观', '人设', '情感', '情节']))
    expect(new Set(FANQIE_CONTENT_TAGS.map((t) => t.labelId)).size).toBe(359)
  })
})

describe('recommendFanqieTags（题材驱动）', () => {
  it('都市系统文：主分类=都市脑洞，内容标签按组上限截断', () => {
    const r = recommendFanqieTags({
      name: '重生之都市医仙',
      description: '主角重生后绑定签到系统，在都市当神医，打脸富二代，一路逆袭赚钱。',
      genre: '都市/系统'
    })
    expect(r.mainCategory?.name).toBe('都市脑洞')
    // 阅读标签：主分类之外 主题/角色/情节 各 ≤ 2
    expect(r.readingTags.length).toBeLessThanOrEqual(5)
    // 内容标签按组截断
    const count = (g: string) => r.contentTags.filter((t) => FANQIE_CONTENT_TAGS.find((c) => c.labelId === t.id)?.group === g).length
    expect(count('世界观')).toBeLessThanOrEqual(FANQIE_CONTENT_LIMITS.世界观)
    expect(count('人设')).toBeLessThanOrEqual(FANQIE_CONTENT_LIMITS.人设)
    expect(count('情感')).toBeLessThanOrEqual(FANQIE_CONTENT_LIMITS.情感)
    expect(count('情节')).toBeLessThanOrEqual(FANQIE_CONTENT_LIMITS.情节)
    expect(r.contentTags.length).toBeLessThanOrEqual(11)
  })

  it('仙侠古言：主分类偏向玄幻/古风', () => {
    const r = recommendFanqieTags({
      name: '凤逆九州',
      description: '修仙女强，师尊与徒弟的救赎，宗门争斗。',
      genre: '玄幻/仙侠/女强'
    })
    expect(r.mainCategory?.name).toBeDefined()
    expect(['传统玄幻', '东方仙侠', '玄幻脑洞', '玄幻言情']).toContain(r.mainCategory!.name)
  })

  it('都市日常无内容信息时兜底：主分类仍有一个（都市）', () => {
    const r = recommendFanqieTags({ name: '平凡的一天', description: '', genre: '都市' })
    // 主分类兜底：无论内容多贫乏，至少给一个主分类推荐
    expect(r.mainCategory).toBeDefined()
    expect(['都市日常', '都市脑洞', '都市修真', '都市种田', '都市高武']).toContain(r.mainCategory!.name)
  })

  it('性别专属标签：女主/男性向都能命中对应词表', () => {
    const r = recommendFanqieTags({
      name: '女帝的权谋',
      description: '女尊世界，女帝后宫，权谋夺嫡。',
      genre: '古言/女尊'
    })
    const names = r.contentTags.map((t) => t.name)
    expect(names).toContain('女尊')
    // 阅读标签含女主相关
    const readingNames = r.readingTags.map((t) => t.name)
    expect(readingNames).toContain('女强')
  })

  it('纯函数：同一输入两次输出一致', () => {
    const input = { name: '时间循环的追凶', description: '悬疑推理，破案抓凶手。', genre: '悬疑' }
    expect(recommendFanqieTags(input)).toEqual(recommendFanqieTags(input))
  })

  it('阅读标签按建书规则截断：主分类 1 + 主题 2 + 角色 2 + 情节 2', () => {
    const r = recommendFanqieTags({
      name: '什么都有的混搭文',
      description:
        '穿越重生系统修仙都市赘婿战神历史三国大唐明朝清朝大秦民国古言宫斗宅斗权谋甜宠校园青梅竹马总裁豪门马甲快穿无限流种田美食年代娱乐圈电竞体育网游卡牌同人二次元女尊现言职场婚恋双男主双女主纯爱玄学风水捉鬼山海经洪荒封神西游红楼甄嬛漫威火影龙珠海贼宝可梦奥特曼特工医生律师厨娘学霸奶爸萌宝女帝皇帝公主王妃皇叔嫡女精灵反派大佬神豪兽世军旅末日求生废土赛博朋克克苏鲁武侠剑修剑道无CP单女主多女主无女主后宫无后宫搞笑轻小说开局龙傲天权谋间谍。',
      genre: '都市/玄幻/历史/仙侠'
    })
    // 主分类恰好 1 个
    expect(r.mainCategory).toBeDefined()
    // 阅读标签每层 ≤ 上限
    const byLayer = new Map<string, number>()
    for (const hit of r.readingTags) {
      const layer = FANQIE_READING_TAGS.find((t) => t.categoryId === hit.id)?.layer
      if (layer) byLayer.set(layer, (byLayer.get(layer) ?? 0) + 1)
    }
    for (const [layer, n] of byLayer) {
      expect(n).toBeLessThanOrEqual(FANQIE_READING_LIMITS[layer as keyof typeof FANQIE_READING_LIMITS])
    }
  })

  it('内容标签按建书规则截断：世界观 1 + 人设 4 + 情感 2 + 情节 4 = ≤11', () => {
    const r = recommendFanqieTags({
      name: '内容丰富的大杂烩',
      description:
        '系统穿书快穿无限流规则怪谈惊悚末世丧尸废土星际机甲赛博克苏鲁女尊兽世基建种田美食经商囤货逃荒直播黑科技大逃杀电竞游戏历史三国唐宋朝明清朝大秦抗战谍战港综韩娱综漫综影视漫威火影海贼龙珠宝可梦奥特曼洪荒封神西游山海经红楼甄嬛如懿科举仕途权谋夺嫡后宫家族女帝暴君王爷皇叔王妃贵妃妃子嫡福晋婆婆丫鬟主母继室农女商女医妃神医奶爸萌宝奶妈学霸高智商天才千金名媛灰姑娘总裁赘婿战神兵王军嫂网红反派恶毒女配炮灰满级大佬娇妻狐妖吸血鬼美人鱼双洁1v1无CP无女主单女主多女主多CP HE BE 虐恋甜宠追妻追夫火葬场破镜重圆久别重逢青梅竹马初恋暗恋白月光替身先婚后爱契约婚姻闪婚隐婚婚约联姻姐弟恋年上老夫少妻师徒人外相爱相杀救赎双向奔赴治愈温馨打脸逆袭装逼扮猪吃虎吃瓜群像全息查案推理悬疑捉鬼驱邪风水盗墓鉴宝古玩钓鱼末日求生荒岛公路海洋全球灾变神豪暴富财阀争宠宫斗皇位登基复仇虐渣黑化升级流技能装备建设经营升职官场分家高考考研考场直播穿越越狱逃亡爽文入魔双修渡劫历劫灵魂附身赶尸。',
      genre: '都市/玄幻'
    })
    const byGroup = new Map<string, number>()
    for (const hit of r.contentTags) {
      const group = FANQIE_CONTENT_TAGS.find((t) => t.labelId === hit.id)?.group
      if (group) byGroup.set(group, (byGroup.get(group) ?? 0) + 1)
    }
    console.log('内容标签分组:', Object.fromEntries(byGroup))
    for (const [group, n] of byGroup) {
      expect(n).toBeLessThanOrEqual(FANQIE_CONTENT_LIMITS[group as keyof typeof FANQIE_CONTENT_LIMITS])
    }
    expect(r.contentTags.length).toBeLessThanOrEqual(11)
  })
})
