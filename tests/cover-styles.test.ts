import { describe, it, expect } from 'vitest'
import {
  inferGenre,
  buildCoverPrompt,
  PLATFORM_STYLES,
  GENRE_STYLES,
  COMPOSITION_DESC,
  GENRE_RULES
} from '../src/main/data/skill-prompts/cover/cover-styles'
import type { CoverGenre, CoverPlatform } from '../src/shared/types'

describe('inferGenre 书名题材推断', () => {
  it('仙侠关键词命中', () => {
    expect(inferGenre('剑道独尊')).toBe('xianxia')
    expect(inferGenre('修仙传')).toBe('xianxia')
  })

  it('无关键词的书名默认 urban', () => {
    expect(inferGenre('一念永恒')).toBe('urban')
  })

  it('都市关键词命中', () => {
    expect(inferGenre('都市学霸逆袭')).toBe('urban')
    expect(inferGenre('重生之兵王回归')).toBe('urban')
  })

  it('古言关键词命中', () => {
    expect(inferGenre('嫡女风华')).toBe('ancient_romance')
    expect(inferGenre('后宫甄嬛传')).toBe('ancient_romance')
  })

  it('现言关键词命中', () => {
    expect(inferGenre('总裁的替嫁新娘')).toBe('modern_romance')
    expect(inferGenre('甜宠小娇妻')).toBe('modern_romance')
  })

  it('悬疑关键词命中', () => {
    expect(inferGenre('连环杀人案')).toBe('mystery')
    expect(inferGenre('密室推理')).toBe('mystery')
  })

  it('科幻关键词命中', () => {
    expect(inferGenre('星际机甲战争')).toBe('scifi')
    expect(inferGenre('末日废土生存')).toBe('scifi')
  })

  it('西幻关键词命中', () => {
    expect(inferGenre('骑士与巫师领地')).toBe('western_fantasy')
  })

  it('宽泛单字（灵/神/魔）会被仙侠优先拦截（推断局限，可用 genreOverride 覆盖）', () => {
    // 「灵」命中仙侠（精灵的灵），「魔」命中仙侠（魔法的魔），「神」命中仙侠
    expect(inferGenre('龙骑士的魔法领主')).toBe('xianxia')
    expect(inferGenre('精灵森林')).toBe('xianxia')
  })

  it('历史关键词命中', () => {
    expect(inferGenre('三国之谋士无双')).toBe('historical')
  })

  it('灵异关键词命中', () => {
    expect(inferGenre('盗墓笔记之鬼吹灯')).toBe('supernatural')
  })

  it('轻小说关键词命中', () => {
    expect(inferGenre('转生成为团宠喵')).toBe('light_novel')
  })

  it('零命中默认 urban', () => {
    expect(inferGenre('无关键词的书名')).toBe('urban')
  })

  it('优先级：多题材命中取先匹配', () => {
    // 「剑」属仙侠，优先级最高
    expect(inferGenre('剑与魔法')).toBe('xianxia')
    // 「龙」同时在仙侠无、西幻有——但「魔」在仙侠，故判仙侠
    expect(inferGenre('龙的魔法')).toBe('xianxia')
  })
})

describe('PLATFORM_STYLES 平台风格完整', () => {
  it('7 个平台齐全', () => {
    const platforms: CoverPlatform[] = ['fanqie', 'qidian', 'jjwxc', 'zhihu', 'qimao', 'ciweimao', 'other']
    for (const p of platforms) {
      expect(PLATFORM_STYLES[p]).toBeTruthy()
      expect(PLATFORM_STYLES[p].prompt.length).toBeGreaterThan(20)
      expect(PLATFORM_STYLES[p].ratio).toBeTruthy()
    }
  })

  it('番茄有上传尺寸 600x800', () => {
    expect(PLATFORM_STYLES.fanqie.uploadSize).toBe('600x800')
    expect(PLATFORM_STYLES.fanqie.ratio).toBe('3:4')
  })

  it('其他平台无固定上传尺寸', () => {
    expect(PLATFORM_STYLES.qidian.uploadSize).toBeUndefined()
    expect(PLATFORM_STYLES.zhihu.uploadSize).toBeUndefined()
  })
})

describe('GENRE_STYLES 题材风格完整', () => {
  const genres: CoverGenre[] = [
    'xianxia', 'urban', 'ancient_romance', 'modern_romance', 'mystery',
    'scifi', 'western_fantasy', 'historical', 'supernatural', 'light_novel'
  ]

  it('10 个题材齐全，每个有 7 个字段', () => {
    for (const g of genres) {
      const style = GENRE_STYLES[g]
      expect(style).toBeTruthy()
      expect(style.tag).toBeTruthy()
      expect(style.colorPalette).toBeTruthy()
      expect(style.characterDesc).toBeTruthy()
      expect(style.backgroundDesc).toBeTruthy()
      expect(style.lighting).toBeTruthy()
      expect(style.titleFont).toBeTruthy()
      expect(style.authorFont).toBeTruthy()
    }
  })

  it('仙侠书名字体含 golden brush calligraphy', () => {
    expect(GENRE_STYLES.xianxia.titleFont).toContain('golden brush calligraphy')
  })

  it('每个题材的作者名字体含 small（不抢书名焦点）', () => {
    for (const g of genres) {
      expect(GENRE_STYLES[g].authorFont).toContain('small')
    }
  })
})

describe('buildCoverPrompt 完整提示词构建', () => {
  it('包含书名和作者名', () => {
    const prompt = buildCoverPrompt({
      bookName: '剑道独尊',
      authorName: '青椒炒肉',
      platform: 'fanqie',
      genre: 'xianxia',
      composition: 'closeup'
    })
    expect(prompt).toContain("'剑道独尊'")
    expect(prompt).toContain("'青椒炒肉'")
  })

  it('包含平台风格', () => {
    const prompt = buildCoverPrompt({
      bookName: '测试',
      authorName: '作者',
      platform: 'fanqie',
      genre: 'urban',
      composition: 'closeup'
    })
    expect(prompt).toContain(PLATFORM_STYLES.fanqie.prompt)
  })

  it('包含题材标签', () => {
    const prompt = buildCoverPrompt({
      bookName: '测试',
      authorName: '作者',
      platform: 'qidian',
      genre: 'mystery',
      composition: 'scene'
    })
    expect(prompt).toContain(GENRE_STYLES.mystery.tag)
  })

  it('包含构图描述', () => {
    const prompt = buildCoverPrompt({
      bookName: '测试',
      authorName: '作者',
      platform: 'qidian',
      genre: 'urban',
      composition: 'fullbody'
    })
    expect(prompt).toContain(COMPOSITION_DESC.fullbody)
  })

  it('包含字体风格', () => {
    const prompt = buildCoverPrompt({
      bookName: '测试',
      authorName: '作者',
      platform: 'qidian',
      genre: 'xianxia',
      composition: 'closeup'
    })
    expect(prompt).toContain(GENRE_STYLES.xianxia.titleFont)
    expect(prompt).toContain(GENRE_STYLES.xianxia.authorFont)
  })

  it('包含色彩和光效', () => {
    const prompt = buildCoverPrompt({
      bookName: '测试',
      authorName: '作者',
      platform: 'qidian',
      genre: 'scifi',
      composition: 'closeup'
    })
    expect(prompt).toContain('Color palette:')
    expect(prompt).toContain('Lighting:')
  })

  it('包含 no watermark 通用修饰', () => {
    const prompt = buildCoverPrompt({
      bookName: '测试',
      authorName: '作者',
      platform: 'qidian',
      genre: 'urban',
      composition: 'closeup'
    })
    expect(prompt).toContain('no watermark')
    expect(prompt).toContain('digital painting')
  })

  it('styleHint 追加到 prompt', () => {
    const prompt = buildCoverPrompt({
      bookName: '测试',
      authorName: '作者',
      platform: 'qidian',
      genre: 'urban',
      composition: 'closeup',
      styleHint: 'add snow background'
    })
    expect(prompt).toContain('add snow background')
  })

  it('比例随平台变化（番茄 3:4 / 起点 2:3）', () => {
    const fanqiePrompt = buildCoverPrompt({
      bookName: 't', authorName: 'a', platform: 'fanqie', genre: 'urban', composition: 'closeup'
    })
    const qidianPrompt = buildCoverPrompt({
      bookName: 't', authorName: 'a', platform: 'qidian', genre: 'urban', composition: 'closeup'
    })
    expect(fanqiePrompt).toContain('3:4')
    expect(qidianPrompt).toContain('2:3')
  })
})

describe('GENRE_RULES 推断规则', () => {
  it('按优先级排序（仙侠在前）', () => {
    // 仙侠规则应在数组靠前位置
    const xianxiaIndex = GENRE_RULES.findIndex((r) => r.genre === 'xianxia')
    const urbanIndex = GENRE_RULES.findIndex((r) => r.genre === 'urban')
    expect(xianxiaIndex).toBeLessThan(urbanIndex)
  })

  it('每个规则有 genre 和 keywords', () => {
    for (const rule of GENRE_RULES) {
      expect(rule.genre).toBeTruthy()
      expect(Array.isArray(rule.keywords)).toBe(true)
      expect(rule.keywords.length).toBeGreaterThan(0)
    }
  })
})
