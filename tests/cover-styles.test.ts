import { describe, it, expect } from 'vitest'
import {
  inferGenre,
  buildCoverPrompt,
  COVER_STYLE_PRESETS,
  PLATFORM_STYLES,
  GENRE_STYLES,
  COMPOSITION_DESC,
  compileCoverLearningRules,
  patchCoverPromptTypography,
  filterCoverPromptLearningRules,
  GENRE_RULES,
  migrateBuiltinCoverStyle,
  localizeKnownCoverText
} from '../src/main/data/skill-prompts/cover/cover-styles'
import { LEGACY_COVER_TEXT_TABLES } from '../src/main/data/skill-prompts/cover/cover-localization'
import { COVER_FRAME_SAFETY_PROMPT } from '../src/main/data/cover-frame'
import { CoverService, DEFAULT_COVER_OUTPUT_SIZE, withVisualDirection } from '../src/main/data/cover-service'
import type { CoverGenre, CoverPlatform, CoverStylePreset } from '../src/shared/types'

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
      expect(PLATFORM_STYLES[p].prompt.length).toBeGreaterThan(10)
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

describe('封面成品尺寸', () => {
  it('默认输出严格为 3:4', () => {
    const [width, height] = DEFAULT_COVER_OUTPUT_SIZE.split('x').map(Number)
    expect(width * 4).toBe(height * 3)
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

  it('仙侠书名字体含 金色毛笔书法', () => {
    expect(GENRE_STYLES.xianxia.titleFont).toContain('金色毛笔书法')
  })

  it('每个题材的作者名字体为小号（不抢书名焦点）', () => {
    for (const g of genres) {
      expect(GENRE_STYLES[g].authorFont).toContain('小号')
    }
  })
})

describe('COVER_STYLE_PRESETS 番茄封面风格库', () => {
  const presets: Exclude<CoverStylePreset, 'auto'>[] = [
    'fanqie_impact',
    'ancient_romance',
    'ink_minimal',
    'dark_suspense',
    'urban_cinematic',
    'photorealistic',
    'anime_illustration',
    'anime_light',
    'retro_period',
    'epic_fantasy',
    'concept_symbol',
    'glamour_romance',
    'cute_doodle',
    'warm_period_life',
    'rural_healing',
    'male_power_type',
    'folk_horror',
    'war_spy_epic',
    'game_neon',
    'western_adventure',
    'minimal_typographic'
  ]

  it('全部风格字段完整', () => {
    expect(presets).toHaveLength(Object.keys(COVER_STYLE_PRESETS).length)
    for (const key of presets) {
      const style = COVER_STYLE_PRESETS[key]
      expect(style.label).toBeTruthy()
      expect(style.description).toBeTruthy()
      expect(style.prompt.length).toBeGreaterThan(40)
      expect(style.colorPalette).toBeTruthy()
      expect(style.lighting).toBeTruthy()
      expect(style.titleFont).toBeTruthy()
      expect(style.authorFont).toBeTruthy()
      expect(style.titlePosition).toBeTruthy()
      expect(style.titleEffect).toBeTruthy()
      expect(style.authorPosition).toBeTruthy()
    }
  })

  it('文字设计会覆盖书名与作者名的字体、位置和特效', () => {
    const prompt = buildCoverPrompt({
      bookName: '长夜无声',
      authorName: '余烬',
      platform: 'fanqie',
      genre: 'mystery',
      composition: 'scene',
      stylePreset: 'dark_suspense',
      typography: {
        titleFont: 'brush',
        titlePosition: 'vertical_right',
        titleEffect: 'ink',
        authorFont: 'seal',
        authorPosition: 'vertical_side'
      }
    })
    expect(prompt).toContain('手写中文书法')
    expect(prompt).toContain('在右侧安全区自上而下竖排')
    expect(prompt).toContain('真实干笔墨纹')
    expect(prompt).toContain('传统篆意中文字体')
    expect(prompt).toContain('在标题外侧附近竖排')
    expect(prompt).toContain('准确呈现简体书名和署名各一次')
  })

  it('选择风格后写入风格锁、配色和字体', () => {
    const prompt = buildCoverPrompt({
      bookName: '夜航人',
      authorName: '无灯',
      platform: 'fanqie',
      genre: 'mystery',
      composition: 'closeup',
      stylePreset: 'dark_suspense'
    })
    expect(prompt).toContain('画风约束（暗黑悬疑电影）')
    expect(prompt).toContain(COVER_STYLE_PRESETS.dark_suspense.prompt)
    expect(prompt).toContain(COVER_STYLE_PRESETS.dark_suspense.colorPalette)
    expect(prompt).toContain(COVER_STYLE_PRESETS.dark_suspense.titleFont)
    expect(prompt).toContain(COVER_STYLE_PRESETS.dark_suspense.titlePosition ?? '')
    expect(prompt).toContain(COVER_STYLE_PRESETS.dark_suspense.titleEffect ?? '')
    expect(prompt).not.toContain('character portrait dominating frame')
  })

  it('深度样本风格会写入各自的题材视觉规则', () => {
    const cases: Array<[CoverStylePreset, string]> = [
      ['glamour_romance', '时尚杂志造型'],
      ['cute_doodle', '手绘简笔人物'],
      ['rural_healing', '季节作物'],
      ['male_power_type', '标题适应小缩略图'],
      ['folk_horror', '红棺'],
      ['war_spy_epic', '符合时代的服饰装备'],
      ['game_neon', '受控霓虹界面点缀']
    ]
    for (const [stylePreset, expected] of cases) {
      const prompt = buildCoverPrompt({
        bookName: '测试书名',
        authorName: '测试作者',
        platform: 'fanqie',
        genre: 'urban',
        composition: 'closeup',
        stylePreset
      })
      expect(prompt).toContain(expected)
    }
  })

  it('无人物概念符号会强制使用纯场景并省略人物', () => {
    const prompt = buildCoverPrompt({
      bookName: '倒计时',
      authorName: '零点',
      platform: 'fanqie',
      genre: 'mystery',
      composition: 'closeup',
      stylePreset: 'concept_symbol',
      scene: { characterDesc: 'a detective in a black coat' }
    })
    expect(prompt).toContain('无主体人物')
    expect(prompt).not.toContain('a detective in a black coat')
  })

  it.each(['photorealistic', 'anime_illustration'] as const)('%s 不混入轻小说的萌系标签与 Q 版默认人物', (stylePreset) => {
    const prompt = buildCoverPrompt({
      bookName: '转生之旅', authorName: '作者', platform: 'ciweimao', genre: 'light_novel',
      composition: 'closeup', stylePreset
    })
    expect(prompt).toContain(COVER_STYLE_PRESETS[stylePreset].prompt)
    expect(prompt).not.toContain(PLATFORM_STYLES.ciweimao.prompt)
    expect(prompt).not.toContain(GENRE_STYLES.light_novel.tag)
    expect(prompt).not.toContain(GENRE_STYLES.light_novel.characterDesc)
    expect(prompt).toContain('年龄、外貌和服饰符合故事')
    expect(prompt).not.toContain('高细节数字绘画质感')
  })

  it.each(['qidian', 'ciweimao', 'other'] as const)('真人封面不被 %s 平台的插画默认覆盖', (platform) => {
    const prompt = buildCoverPrompt({
      bookName: '宫墙旧事', authorName: '作者', platform, genre: 'ancient_romance',
      composition: 'closeup', stylePreset: 'photorealistic'
    })
    expect(prompt).toContain('写实媒介约束')
    expect(prompt).toContain('禁止插画、数字绘画、动漫、卡通')
    expect(prompt).not.toContain(PLATFORM_STYLES[platform].prompt)
    expect(prompt).toContain(GENRE_STYLES.ancient_romance.characterDesc)
    expect(prompt).toContain(COVER_FRAME_SAFETY_PROMPT)
  })

  it.each(['photorealistic', 'anime_illustration'] as const)('%s 保留提炼的人物年龄服饰、场景与自选文字排版', (stylePreset) => {
    const prompt = buildCoverPrompt({
      bookName: '转生之旅', authorName: '作者', platform: 'fanqie', genre: 'light_novel',
      composition: 'fullbody', stylePreset,
      scene: {
        characterDesc: 'a sixty-year-old woman in weathered bronze armor',
        backgroundDesc: 'a ruined mountain fortress'
      },
      typography: { titleFont: 'brush', authorPosition: 'bottom_right' }
    })
    expect(prompt).toContain('a sixty-year-old woman in weathered bronze armor')
    expect(prompt).toContain('a ruined mountain fortress')
    expect(prompt).toContain('手写中文书法')
    expect(prompt).toContain('位于右下方安全区')
  })

  it.each(['photorealistic', 'anime_illustration'] as const)('%s 的纯场景构图仍省略主体人物', (stylePreset) => {
    const prompt = buildCoverPrompt({
      bookName: '无人的城', authorName: '作者', platform: 'fanqie', genre: 'urban',
      composition: 'scene', stylePreset, scene: { characterDesc: 'a detective in a black coat' }
    })
    expect(prompt).toContain('无主体人物')
    expect(prompt).not.toContain('a detective in a black coat')
    expect(prompt).not.toContain(GENRE_STYLES.urban.characterDesc)
  })

  it('学习库定义仍受显式真人媒介约束', () => {
    const prompt = buildCoverPrompt({
      bookName: '转生之旅', authorName: '作者', platform: 'ciweimao', genre: 'light_novel',
      composition: 'closeup', stylePreset: 'photorealistic',
      learningPreset: { ...COVER_STYLE_PRESETS.photorealistic, prompt: 'a premium narrative poster with a quiet background' }
    })
    expect(prompt).toContain('a premium narrative poster with a quiet background')
    expect(prompt).toContain('写实媒介约束')
    expect(prompt).not.toContain(GENRE_STYLES.light_novel.tag)
    expect(prompt).not.toContain(GENRE_STYLES.light_novel.characterDesc)
  })

  it('原有二次元预设保留自选画风，题材层不再注入默认萌系人物', () => {
    const prompt = buildCoverPrompt({
      bookName: '萌猫日记', authorName: '作者', platform: 'ciweimao', genre: 'light_novel',
      composition: 'closeup', stylePreset: 'anime_light'
    })
    expect(prompt).toContain(COVER_STYLE_PRESETS.anime_light.prompt)
    expect(prompt).not.toContain(GENRE_STYLES.light_novel.tag)
    expect(prompt).not.toContain(GENRE_STYLES.light_novel.characterDesc)
    expect(prompt).toContain('轻小说叙事')
  })
})

describe('画风、文字布局和统一画幅约束', () => {
  const base = { bookName: '长夜', authorName: '作者', platform: 'fanqie' as const, genre: 'light_novel' as const, composition: 'closeup' as const }

  it.each(Object.keys(COVER_STYLE_PRESETS) as Exclude<CoverStylePreset, 'auto'>[])('%s 明确预设只补题材内容，不混入题材默认画风或Q版人物', (stylePreset) => {
    const prompt = buildCoverPrompt({ ...base, stylePreset })
    expect(prompt).toContain('画风约束')
    expect(prompt).toContain('轻小说叙事')
    expect(prompt).not.toContain(GENRE_STYLES.light_novel.tag)
    expect(prompt).not.toContain(GENRE_STYLES.light_novel.characterDesc)
  })

  it('自动画风仍保留原有平台与题材默认，并可明确选择故事人物', () => {
    const prompt = buildCoverPrompt(base)
    expect(prompt).toContain(GENRE_STYLES.light_novel.tag)
    expect(prompt).toContain(GENRE_STYLES.light_novel.characterDesc)
    const selected = buildCoverPrompt({ ...base, stylePreset: 'ink_minimal', scene: {
      characterDesc: 'a sixty-year-old one-armed warrior in old copper armor', backgroundDesc: 'a ruined mountain fortress'
    } })
    expect(selected).toContain(COVER_STYLE_PRESETS.ink_minimal.prompt)
    expect(selected).toContain('a sixty-year-old one-armed warrior in old copper armor')
    expect(selected).toContain('a ruined mountain fortress')
  })

  it.each([
    ['短书名', 'top', '清晰单行横排'],
    ['这是一本需要正确断句的长书名', 'top', '两至四行横排'],
    ['短书名', 'vertical_left', '单列竖排'],
    ['这是一本需要正确断句的长书名', 'vertical_right', '两至四列竖排'],
    ['这是一本特别特别长需要多列但是不能强制所有书名都分成四列的书名', 'vertical_left', '均衡竖排列数']
  ] as const)('书名“%s”按 %s 生成合适的行/列布局', (bookName, titlePosition, grouping) => {
    const prompt = buildCoverPrompt({ ...base, bookName, typography: { titlePosition } })
    const hierarchy = prompt.split('\n').find((line) => line.startsWith('文字层级：'))!
    expect(prompt).toContain(`书名文字：'${bookName}'`)
    expect(hierarchy).toContain(grouping)
    expect(hierarchy).not.toContain(titlePosition.startsWith('vertical') ? '行横排' : '列竖排')
    if (titlePosition.startsWith('vertical')) expect(hierarchy).toContain('自上而下')
  })

  it('侧部署名只保留侧边区域；底部署名才保留底部独立区域', () => {
    const side = buildCoverPrompt({ ...base, typography: { titlePosition: 'vertical_right', authorPosition: 'vertical_side' } })
    expect(side).toContain('在书名旁预留窄侧区')
    expect(side).not.toContain('独立底部署名区')
    expect(side).not.toContain('bottom eighth')
    const bottom = buildCoverPrompt({ ...base, typography: { authorPosition: 'bottom_center' } })
    expect(bottom).toContain('独立底部署名区')
    expect(bottom).not.toContain('窄侧区')
    const learnedSide = buildCoverPrompt({ ...base, stylePreset: 'ink_minimal' })
    expect(learnedSide).toContain('单列竖排')
    expect(learnedSide).toContain('窄侧区')
  })

  it('统一安全区行只出现一次，保留精确书名署名和著字，不再重复旧画幅要求', () => {
    const prompt = buildCoverPrompt({ ...base, bookName: '女将军与男人城', authorName: '少年她' })
    expect(prompt.split('\n').filter((line) => line.startsWith('画幅安全区：'))).toEqual([COVER_FRAME_SAFETY_PROMPT])
    expect(prompt).toContain("书名文字：'女将军与男人城'")
    expect(prompt).toContain("作者名'少年她'，紧接一个简体'著'字")
    expect(prompt).toContain('不重复字形')
    expect(prompt).not.toContain('portrait 3:4 ratio')
    expect(prompt).not.toContain('inner ~85%')
  })
})

describe('旧英文提示词和内置学习预设兼容', () => {
  const base = { bookName: '女将军与男人城', authorName: '少年她', platform: 'fanqie' as const, genre: 'urban' as const, composition: 'closeup' as const }

  it.each(Object.keys(COVER_STYLE_PRESETS) as Exclude<CoverStylePreset, 'auto'>[])('%s 的旧内置预设按同字段精确迁移为中文，不修改输入', (key) => {
    const previous = { ...LEGACY_COVER_TEXT_TABLES.COVER_STYLE_PRESETS[key] }
    const original = { ...previous }
    expect(migrateBuiltinCoverStyle(key, previous)).toEqual(COVER_STYLE_PRESETS[key])
    expect(previous).toEqual(original)
    const prompt = buildCoverPrompt({ ...base, stylePreset: key, learningPreset: previous })
    expect(prompt).toContain(COVER_STYLE_PRESETS[key].prompt)
    expect(prompt).not.toContain(previous.prompt)
  })

  it('仅精确翻译已知整段文案，不吞自定义英文、局部改写或元数据', () => {
    const previous = LEGACY_COVER_TEXT_TABLES.COVER_STYLE_PRESETS.photorealistic
    const custom = { ...previous, prompt: 'CUSTOM ART: rainy silver streets.',
      lighting: previous.lighting + ' Preserve my special lighting.', source: 'author edit', updatedAt: 'original-version' }
    const localized = migrateBuiltinCoverStyle('photorealistic', custom)
    expect(localized).toMatchObject({ prompt: custom.prompt, lighting: custom.lighting, source: 'author edit', updatedAt: 'original-version' })
    expect(localized.titleFont).toBe(COVER_STYLE_PRESETS.photorealistic.titleFont)
    expect(custom.titleFont).toBe(previous.titleFont)
    expect(migrateBuiltinCoverStyle('auto', custom)).toEqual(custom)
    expect(localizeKnownCoverText(LEGACY_COVER_TEXT_TABLES.TITLE_FONT_STYLES.modern)).toContain('干净几何感现代中文无衬线字')
    expect(localizeKnownCoverText('CUSTOM: ' + previous.prompt)).toBe('CUSTOM: ' + previous.prompt)
  })

  it('旧英文标准文字层重编为中文，仅过滤原快照冲突规则，手改画面和空行原样保留', () => {
    const rules = ['Observed upper third is the first typography candidate.', 'Keep the title readable.']
    const original = ["Title text 'old title' across the upper third.", "Author byline: the author name 'old author'.",
      'Typography hierarchy: original lettering.', 'Frame safety: old six percent margin.',
      'Learned cover rules, advisory: ' + rules.join(' '), 'Main subject: a sixty-year-old one-armed female general in copper armor.',
      'Background: a ruined fortress.', '', 'MY EDIT: keep the red umbrella.', ''].join('\n')
    const replacement = buildCoverPrompt({ ...base, typography: { titlePosition: 'vertical_left', authorPosition: 'vertical_side', titleFont: 'modern' },
      learningRules: ['NEW LIBRARY RULE: use a blue umbrella.'] })
    const patched = patchCoverPromptTypography(original, replacement, { titlePosition: 'vertical_left' }, rules)
    expect(patched).toContain("书名文字：'女将军与男人城'")
    expect(patched).toContain("作者署名：作者名'少年她'，紧接一个简体'著'字")
    expect(patched).toContain('文字层级：')
    expect(patched).toContain(COVER_FRAME_SAFETY_PROMPT)
    expect(patched).not.toContain('Title text ')
    expect(patched).not.toContain('Author byline:')
    expect(patched).not.toContain(rules[0])
    expect(patched).toContain(rules[1])
    expect(patched).not.toContain('NEW LIBRARY RULE')
    expect(patched).toContain('Main subject: a sixty-year-old one-armed female general in copper armor.')
    expect(patched).toContain('Background: a ruined fortress.')
    expect(patched.endsWith('\n\nMY EDIT: keep the red umbrella.\n')).toBe(true)
  })

  it('中文文字层重编也只改排版，保留英文自定义内容和非标准手写提示词', () => {
    const original = buildCoverPrompt({ ...base, scene: { characterDesc: 'MY CHARACTER: an elderly fictional detective',
      backgroundDesc: 'MY BACKGROUND: the same old station' } }) + '\n\nMY EDIT: do not erase this.\n'
    const changed = patchCoverPromptTypography(original, buildCoverPrompt({ ...base, typography: { titleFont: 'modern', titlePosition: 'center' } }))
    expect(changed).toContain('干净几何感现代中文无衬线字')
    expect(changed).toContain('MY CHARACTER: an elderly fictional detective')
    expect(changed).toContain('MY BACKGROUND: the same old station')
    expect(changed.endsWith('\n\nMY EDIT: do not erase this.\n')).toBe(true)
    const manual = 'Only draw the moon.\n\nKeep this exact custom English.\n'
    expect(patchCoverPromptTypography(manual, buildCoverPrompt(base))).toBe(manual)
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

  it('作者名后带「著」落款后缀', () => {
    const prompt = buildCoverPrompt({
      bookName: '剑道独尊',
      authorName: '青椒炒肉',
      platform: 'fanqie',
      genre: 'xianxia',
      composition: 'closeup'
    })
    expect(prompt).toContain("作者名'青椒炒肉'，紧接一个简体'著'字")
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
    expect(prompt).toContain('配色：')
    expect(prompt).toContain('光线：')
  })

  it('包含 不加水印 通用修饰', () => {
    const prompt = buildCoverPrompt({
      bookName: '测试',
      authorName: '作者',
      platform: 'qidian',
      genre: 'urban',
      composition: 'closeup'
    })
    expect(prompt).toContain('不加水印')
    expect(prompt).toContain('数字绘画')
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

  it('所有平台的主封面默认使用 3:4', () => {
    const fanqiePrompt = buildCoverPrompt({
      bookName: 't', authorName: 'a', platform: 'fanqie', genre: 'urban', composition: 'closeup'
    })
    const qidianPrompt = buildCoverPrompt({
      bookName: 't', authorName: 'a', platform: 'qidian', genre: 'urban', composition: 'closeup'
    })
    expect(fanqiePrompt).toContain('3:4')
    expect(qidianPrompt).toContain('3:4')
  })
})

describe('CoverService.resolvePrompt 手改优先', () => {
  // 只测提示词解析，不触碰出图/落盘，故依赖传 null
  const service = new CoverService(
    null as unknown as ConstructorParameters<typeof CoverService>[0],
    null as unknown as ConstructorParameters<typeof CoverService>[1]
  )
  const base = {
    projectId: 'p1',
    bookName: '断刀行',
    authorName: '老猫',
    platform: 'fanqie' as const
  }

  it('没给 promptOverride 时按模板拼装', () => {
    const prompt = service.resolvePrompt(base)
    expect(prompt).toContain("书名文字：'断刀行'")
    expect(prompt).toContain('不加水印')
  })

  it('给了 promptOverride 就原样返回，一个字不加', () => {
    const mine = 'my own prompt, nothing else'
    expect(service.resolvePrompt({ ...base, promptOverride: mine })).toBe(mine)
  })

  it('visualDirection 不写进编辑框用的提示词', () => {
    const mine = 'my own prompt, nothing else'
    expect(service.resolvePrompt({
      ...base,
      promptOverride: mine,
      visualDirection: '主角画韩国财阀女性，嚣张跋扈的坐姿，二次元风格'
    })).toBe(mine)
  })

  it.each(['photorealistic', 'anime_illustration'] as const)('%s 也保留手改提示词的最高优先级', (stylePreset) => {
    const mine = 'my own visual direction'
    expect(service.resolvePrompt({ ...base, stylePreset, promptOverride: mine })).toBe(mine)
  })

  it('手改内容删掉了模板约束也照发（用户说了算）', () => {
    const mine = 'just a cat'
    const prompt = service.resolvePrompt({ ...base, promptOverride: mine })
    expect(prompt).not.toContain('不加水印')
    expect(prompt).not.toContain('断刀行')
  })

  it('纯空白的 promptOverride 视为未提供，回退模板', () => {
    const prompt = service.resolvePrompt({ ...base, promptOverride: '   \n  ' })
    expect(prompt).toContain("书名文字：'断刀行'")
  })

  it('首尾空白被裁掉', () => {
    expect(service.resolvePrompt({ ...base, promptOverride: '  hello  ' })).toBe('hello')
  })

  it('忽略旧学习库里的 9:16 规则，避免与 3:4 成品冲突', async () => {
    const learningLibrary = {
      load: async () => ({
        library: {
          updatedAt: 'old-version',
          source: { sampleCount: 138 },
          globalRules: [
            'Use a portrait 9:16 master canvas.',
            'Keep the title readable at thumbnail size.'
          ]
        }
      }),
      resolveStyle: () => ({ key: 'fanqie_impact', definition: COVER_STYLE_PRESETS.fanqie_impact }),
      getRulesForGenre: (library: { globalRules: string[] }) => library.globalRules
    }
    const serviceWithOldLibrary = new CoverService(
      null as unknown as ConstructorParameters<typeof CoverService>[0],
      null as unknown as ConstructorParameters<typeof CoverService>[1],
      learningLibrary as unknown as ConstructorParameters<typeof CoverService>[2]
    )

    const prompt = await serviceWithOldLibrary.resolvePromptWithLibrary(base)
    expect(prompt).toContain('3:4')
    expect(prompt).not.toContain('9:16')
    expect(prompt).toContain('Keep the title readable at thumbnail size.')
  })
})

describe('withVisualDirection', () => {
  it('方向为空时提示词不变', () => {
    expect(withVisualDirection('keep me')).toBe('keep me')
    expect(withVisualDirection('keep me', '')).toBe('keep me')
    expect(withVisualDirection('keep me', '   \n')).toBe('keep me')
  })

  it('方向只输出一次并放在正文之前，删掉冲突的系统媒介锁', () => {
    const out = withVisualDirection(
      [
        'Selected visual style lock (真人写实封面): photorealistic live-action novel cover, cinematic photographic composition.',
        'Photographic medium lock: render the chosen composition as a live-action film poster. Use no illustration, digital painting, anime, cartoon or 3D-rendered plastic skin. Preserve the story characters ages, identities and period-appropriate clothing.',
        'no human figure as main subject, landscape composition.',
        'a confident young man in a sharp tailored suit.',
        'professional print-ready cover art, faithfully preserve the selected medium and visual language, portrait 3:4 ratio, no watermark'
      ].join('\n'),
      '主角画韩国财阀女性，嚣张跋扈的坐姿，二次元风格'
    )
    expect(out.startsWith('作者画面方向 [managed]:')).toBe(true)
    expect(out.match(/主角画韩国财阀女性，嚣张跋扈的坐姿，二次元风格/g)).toHaveLength(1)
    expect(out.indexOf('主角画韩国财阀女性')).toBeLessThan(out.indexOf('a confident young man'))
    expect(out).toContain('a confident young man')
    expect(out).toContain('3:4')
    expect(out).toContain('no watermark')
    expect(out).not.toContain('Photographic medium lock')
    expect(out).not.toContain('Use no illustration, digital painting, anime')
    expect(out).not.toContain('photorealistic live-action')
    expect(out).not.toContain('Preserve the story characters')
    expect(out).not.toContain('no human figure as main subject')
    expect(out).not.toContain('faithfully preserve the selected medium')
  })

  it('方向没改画风时保留媒介锁，但仍放在正文之前', () => {
    const out = withVisualDirection(
      'Photographic medium lock: live-action.\na man standing.',
      '只要把光线调暗'
    )
    expect(out.startsWith('作者画面方向 [managed]:')).toBe(true)
    expect(out).toContain('Photographic medium lock')
    expect(out.indexOf('只要把光线调暗')).toBeLessThan(out.indexOf('Photographic medium lock'))
  })
})

describe('buildCoverPrompt 提炼方向让路', () => {
  it('作者指定人物时，无人物风格不再丢失提炼人物或强制 scene', () => {
    const prompt = buildCoverPrompt({
      bookName: '女将军', authorName: '作者', platform: 'fanqie', genre: 'historical',
      composition: 'fullbody', stylePreset: 'concept_symbol', directionWins: true,
      scene: { characterDesc: 'a sixty-year-old female general in bronze armor' }
    })
    expect(prompt).toContain('a sixty-year-old female general in bronze armor')
    expect(prompt).not.toContain('无主体人物')
    expect(prompt).toContain(COMPOSITION_DESC.fullbody)
  })
  it('有方向时不锁写实媒介，也不回退成默认男主', () => {
    const prompt = buildCoverPrompt({
      bookName: '让你演财阀恶女',
      authorName: '有空一起撸猫',
      platform: 'fanqie',
      genre: 'urban',
      composition: 'fullbody',
      stylePreset: 'photorealistic',
      directionWins: true,
      scene: { characterDesc: 'a Korean chaebol woman seated with an arrogant pose' }
    })
    expect(prompt).toContain('a Korean chaebol woman seated with an arrogant pose')
    expect(prompt).toContain('画风参考（真人写实封面）')
    expect(prompt).not.toContain('画风约束')
    expect(prompt).not.toContain('写实媒介约束')
    expect(prompt).not.toContain('a confident young man')
    expect(prompt).not.toContain('保持所选媒介')
    expect(prompt).toContain('3:4')
  })
})

describe('学习建议与文字层的优先级', () => {
  it('文字位置补丁过滤旧规则冲突，不从新库偷偷引入新规则并保留原画面和人工编辑', () => {
    const base = { bookName: '长夜', authorName: '作者', platform: 'fanqie' as const,
      genre: 'urban' as const, composition: 'fullbody' as const }
    const originalRules = ['Observed upper third is the first typography candidate.', 'Keep the title readable.']
    const original = buildCoverPrompt({ ...base, learningRules: originalRules,
      scene: { characterDesc: 'a one-armed elderly detective', backgroundDesc: 'an old railway station' }
    }) + '\nAUTHOR EDIT: a red umbrella.'
    const replacement = buildCoverPrompt({ ...base, typography: { titlePosition: 'center' }, learningRules: ['NEW LIBRARY RULE.'] })
    const patched = patchCoverPromptTypography(original, replacement, { titlePosition: 'center' }, originalRules)
    expect(patched).not.toContain(originalRules[0])
    expect(patched).toContain(originalRules[1])
    expect(patched).not.toContain('NEW LIBRARY RULE.')
    expect(patched).toContain('a one-armed elderly detective')
    expect(patched).toContain('an old railway station')
    expect(patched).toContain('AUTHOR EDIT: a red umbrella.')
    expect(filterCoverPromptLearningRules(original, originalRules, { titlePosition: 'center' })).toEqual([originalRules[1]])
  })
  it('中文数值标题面积与显式位置建议过滤，保留可读性规则及原输入快照', () => {
    const rules = ['标题占画面80%，放在上方三分之一', '80%的画面用于书名', '书名占百分之八十', '标题面积占八成',
      '标题放在上部', '书名竖排在左侧', 'Use the top band for the title.', '画布比例9：16',
      '标题保持高对比，轮廓清晰', '保留人物的红色披风']
    const original = [...rules]
    expect(compileCoverLearningRules(rules, { titlePosition: 'center' })).toEqual(['标题保持高对比，轮廓清晰', '保留人物的红色披风'])
    expect(rules).toEqual(original)
    expect(compileCoverLearningRules(['书名竖排在左侧', '标题保持高对比'])).toEqual(['书名竖排在左侧', '标题保持高对比'])
  })

  it('中文上下半区和中英文署名位置建议让位于各自的显式布局', () => {
    const rules = ['书名排在封面上半区', '标题放下半部', '署名放在顶部', '作者名竖排在右边',
      'Place the author at the top.', 'Keep the author name in the lower band.', 'Byline at bottom center.',
      '署名笔画保持清晰', '书名保持高对比', 'AUTHOR RULE: keep the character on the right.']
    expect(compileCoverLearningRules(rules, { titlePosition: 'vertical_left', authorPosition: 'bottom_center' })).toEqual([
      '署名笔画保持清晰', '书名保持高对比', 'AUTHOR RULE: keep the character on the right.'
    ])
    expect(compileCoverLearningRules(['署名放在顶部'], { titlePosition: 'center' })).toEqual(['署名放在顶部'])
    expect(compileCoverLearningRules(['书名排在封面上半区'], { authorPosition: 'bottom_center' })).toEqual(['书名排在封面上半区'])
  })

  it('中文旧学习建议与新位置冲突时重编文字层，不切换学习来源且保留手改画面', () => {
    const base = { bookName: '长夜', authorName: '作者', platform: 'fanqie' as const, genre: 'urban' as const, composition: 'closeup' as const }
    const originalRules = ['标题放在上部。', '标题保持高对比。']
    const original = buildCoverPrompt({ ...base, learningRules: originalRules, scene: {
      characterDesc: 'a one-armed elderly detective in a grey coat', backgroundDesc: 'an old train station'
    } }) + '\n\nMY EDIT: keep the red umbrella.\n'
    const replacement = buildCoverPrompt({ ...base, typography: { titlePosition: 'vertical_left', authorPosition: 'vertical_side' },
      learningRules: ['NEW LIBRARY RULE: keep a blue umbrella.'] })
    const patched = patchCoverPromptTypography(original, replacement, { titlePosition: 'vertical_left' }, originalRules)
    expect(patched).not.toContain(originalRules[0])
    expect(patched).toContain(originalRules[1])
    expect(patched).not.toContain('NEW LIBRARY RULE')
    expect(patched).toContain('单列竖排')
    expect(patched).not.toContain('lower band reserved')
    expect(patched).toContain('a one-armed elderly detective in a grey coat')
    expect(patched).toContain('an old train station')
    expect(patched.endsWith('\n\nMY EDIT: keep the red umbrella.\n')).toBe(true)
    expect(originalRules).toEqual(['标题放在上部。', '标题保持高对比。'])
  })

  it('75条用户规则后追加的新AI规则仍完整编译，长规则也不被静默裁掉', () => {
    const rules = Array.from({ length: 75 }, (_, index) => `USER RULE ${index + 1}: keep this author preference.`)
    const longRule = `AUTHOR LONG RULE: ${'a'.repeat(700)}`
    const compiled = compileCoverLearningRules([...rules, 'LATEST AI RULE: preserve the copper motif.', longRule])
    expect(compiled).toHaveLength(77)
    expect(compiled.at(-2)).toBe('LATEST AI RULE: preserve the copper motif.')
    expect(compiled.at(-1)).toBe(longRule)
    const prompt = buildCoverPrompt({ bookName: '长夜', authorName: '作者', platform: 'fanqie',
      genre: 'urban', composition: 'closeup', learningRules: compiled })
    expect(prompt).toContain('LATEST AI RULE: preserve the copper motif.')
    expect(prompt).toContain(longRule)
  })
  it('纯字风格只有一个有效的标题面积，冲突的学习面积与比例不会进入提示词', () => {
    const prompt = buildCoverPrompt({
      bookName: '长夜', authorName: '作者', platform: 'fanqie', genre: 'mystery',
      composition: 'scene', stylePreset: 'minimal_typographic', learningRules: [
        'Make the title occupy 20 to 35 percent of the cover area.',
        'Use a portrait 9:16 master canvas.',
        'Keep the title readable at thumbnail size.'
      ]
    })
    expect(prompt.match(/约占封面面积的[\d至]+%/g)).toEqual(['约占封面面积的30至45%'])
    expect(prompt).not.toContain('20 to 35 percent')
    expect(prompt).not.toContain('9:16')
    expect(prompt).toContain('Keep the title readable at thumbnail size.')
  })

  it('显式文字位置优先于统计建议，保留不冲突的可读性建议并去重', () => {
    expect(compileCoverLearningRules([
      'Use the lower third as the first typography candidate.',
      'Keep text readable.', 'Keep text readable.'
    ], { titlePosition: 'top' })).toEqual(['Keep text readable.'])
  })

  it('更改字体保留已提炼的人物、场景以及作者手改的非文字行', () => {
    const base = { bookName: '断刀行', authorName: '老猫', platform: 'fanqie' as const,
      genre: 'xianxia' as const, composition: 'fullbody' as const }
    const original = buildCoverPrompt({ ...base, scene: {
      characterDesc: 'a one-armed middle-aged blade master', backgroundDesc: 'a ruined snowy fortress'
    } }) + '\nAUTHOR EDIT: keep a red scarf tied to the broken blade.'
    const changed = patchCoverPromptTypography(original, buildCoverPrompt({
      ...base, typography: { titleFont: 'modern', titlePosition: 'lower_third' }
    }))
    expect(changed).toContain('a one-armed middle-aged blade master')
    expect(changed).toContain('a ruined snowy fortress')
    expect(changed).toContain('AUTHOR EDIT: keep a red scarf tied to the broken blade.')
    expect(changed).toContain('干净几何感现代中文无衬线字')
    expect(changed).toContain('横排于下三分之一区域')
  })

  it('没有标准文字层的手写提示词保持原样', () => {
    expect(patchCoverPromptTypography('Only draw the moon.\n\nKeep this handwritten line.\n', '书名文字：changed')).toBe(
      'Only draw the moon.\n\nKeep this handwritten line.\n'
    )
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
