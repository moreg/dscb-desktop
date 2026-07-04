/**
 * 封面视觉风格库（源自 oh-story-claudecode cover-styles.md + SKILL.md）。
 *
 * 把人类作者读的散文风格定义转成结构化数据表 + prompt 构建器。
 * 供 cover-service 构建 GPT-Image-2 英文提示词。
 */

import type {
  CoverComposition,
  CoverGenre,
  CoverPlatform
} from '../../../../shared/types'

/* =========================================================
   题材推断（书名关键词 → genre）
   ========================================================= */

interface GenreRule {
  genre: CoverGenre
  keywords: string[]
}

/** 题材推断规则（按优先级顺序，先命中先用） */
export const GENRE_RULES: GenreRule[] = [
  { genre: 'xianxia', keywords: ['仙', '道', '剑', '灵', '修', '宗', '天', '帝', '尊', '神', '魔', '妖', '佛'] },
  { genre: 'western_fantasy', keywords: ['龙', '骑', '魔法', '异世界', '精灵', '领主', '巫师', '圣'] },
  { genre: 'ancient_romance', keywords: ['妃', '皇', '侯', '宫', '嫡', '庶', '后', '朝', '凤', '鸾', '王爷', '将军'] },
  { genre: 'modern_romance', keywords: ['总裁', '契约', '替嫁', '甜宠', '娇妻', '萌宝', '闪婚', '婚'] },
  { genre: 'urban', keywords: ['都市', '校园', '重生', '系统', '学霸', '医生', '兵王', '神豪', '逆袭'] },
  { genre: 'mystery', keywords: ['诡', '案', '侦探', '悬疑', '推理', '密室', '连环', '杀'] },
  { genre: 'scifi', keywords: ['星际', '末世', '机甲', '赛博', '废土', '进化', '宇宙', '星舰'] },
  { genre: 'historical', keywords: ['三国', '大明', '大唐', '战场', '将军', '谋士', '宋', '汉'] },
  { genre: 'supernatural', keywords: ['鬼', '僵尸', '阴阳', '风水', '盗墓', '咒', '邪'] },
  { genre: 'light_novel', keywords: ['萌', '喵', '团宠', '娇', '转生', '异世界', '猫'] }
]

/** 按书名推断题材（先命中先用，零命中默认 urban） */
export function inferGenre(bookName: string): CoverGenre {
  for (const rule of GENRE_RULES) {
    if (rule.keywords.some((k) => bookName.includes(k))) return rule.genre
  }
  return 'urban'
}

/* =========================================================
   平台风格
   ========================================================= */

export const PLATFORM_STYLES: Record<CoverPlatform, { label: string; ratio: string; prompt: string; uploadSize?: string }> = {
  fanqie: {
    label: '番茄小说',
    ratio: '3:4',
    uploadSize: '600x800',
    prompt:
      'vibrant saturated colors, eye-catching bold design, character portrait dominating frame, mass-market novel cover style, high contrast'
  },
  qidian: {
    label: '起点',
    ratio: '2:3',
    prompt:
      'polished refined illustration, detailed cinematic composition, epic atmospheric, mature sophisticated style, premium quality'
  },
  jjwxc: {
    label: '晋江',
    ratio: '2:3',
    prompt: 'dreamy ethereal aesthetic, soft pastel tones, elegant romantic, delicate beauty, flower petals and bokeh'
  },
  zhihu: {
    label: '知乎盐言',
    ratio: '2:3',
    prompt:
      'minimalist literary style, clean composition with negative space, subtle moody atmosphere, independent film poster aesthetic'
  },
  qimao: {
    label: '七猫',
    ratio: '2:3',
    prompt:
      'striking high-impact design, vivid dramatic colors, spectacular visual effects, attention-grabbing poster style'
  },
  ciweimao: {
    label: '刺猬猫',
    ratio: '2:3',
    prompt: 'anime illustration style, vibrant colorful, detailed character art, Japanese light novel aesthetic'
  },
  other: {
    label: '其他（默认竖版）',
    ratio: '2:3',
    prompt: 'professional digital illustration, balanced composition, atmospheric'
  }
}

/* =========================================================
   题材 → 视觉风格
   ========================================================= */

interface GenreStyle {
  /** 风格标签 */
  tag: string
  /** 色彩 */
  colorPalette: string
  /** 人物描述模板 */
  characterDesc: string
  /** 背景描述 */
  backgroundDesc: string
  /** 光效 */
  lighting: string
  /** 书名字体风格 */
  titleFont: string
  /** 作者名字体风格 */
  authorFont: string
}

export const GENRE_STYLES: Record<CoverGenre, GenreStyle> = {
  xianxia: {
    tag: 'xianxia Chinese fantasy art style, ethereal atmosphere',
    colorPalette: 'deep blue, gold, white, black',
    characterDesc:
      'a young swordsman in flowing white silk robes with gold embroidery, long black hair tied in a topknot with a jade crown, piercing dark eyes, confident expression, holding a glowing blue spirit sword',
    backgroundDesc: 'ethereal clouds swirling below, dramatic mountain peaks, ancient pavilions, spiritual energy particles',
    lighting: 'divine golden light rays from above, mystical mist, spiritual energy glow',
    titleFont: 'bold golden brush calligraphy with metallic glow and sharp strokes',
    authorFont:
      'small refined white serif text with faint golden glow, flanked by delicate cloud-scroll ornaments on both sides, resting on a thin horizontal gold line'
  },
  urban: {
    tag: 'modern urban contemporary style, clean cinematic composition',
    colorPalette: 'deep blue, grey, gold, with neon accents',
    characterDesc:
      'a confident young man in a sharp tailored suit, clean modern hairstyle, determined eyes, urban professional aura',
    backgroundDesc: 'city skyline at dusk, glass skyscrapers, neon-lit streets, reflective wet pavement',
    lighting: 'sharp city lights, sunset glow reflecting on glass buildings, neon rim light',
    titleFont: 'modern bold sans-serif with metallic silver finish',
    authorFont:
      'small clean white modern text with subtle drop shadow, positioned above a thin silver horizontal divider line'
  },
  ancient_romance: {
    tag: 'ancient Chinese romance palace drama, elegant classical beauty',
    colorPalette: 'crimson red, gold, ink black',
    characterDesc:
      'an elegant woman in luxurious palace hanfu with phoenix crown and golden hairpins, delicate makeup, poised graceful demeanor',
    backgroundDesc: 'magnificent palace halls, red walls, beaded curtains, folding screens, glowing lanterns',
    lighting: 'warm lantern light, golden candle glow, silk fabric shimmering',
    titleFont: 'elegant golden traditional Kai script with ornate decoration',
    authorFont:
      'small elegant dark red traditional text inside a thin golden rectangular border frame with corner decorations'
  },
  modern_romance: {
    tag: 'modern romance cover art, soft dreamy warm atmosphere',
    colorPalette: 'pink, warm white, light gold',
    characterDesc:
      'a sweet couple, woman in a flowing dress and man in casual elegant attire, gentle smiles, looking at each other with affection',
    backgroundDesc: 'cozy cafe, blooming garden, warm interior with soft curtains, sunset beach',
    lighting: 'soft warm backlighting, dreamy bokeh, gentle sunset glow',
    titleFont: 'soft rounded handwritten style in white with pink glow',
    authorFont:
      'small soft pink-white handwritten text with a tiny heart motif on the left side, light sparkle effect'
  },
  mystery: {
    tag: 'dark mystery thriller, noir atmosphere, high contrast shadows',
    colorPalette: 'black, dark grey, deep blue, with blood red accent',
    characterDesc:
      'a silhouetted figure in a trench coat, half-face hidden in shadow, cold sharp gaze, tense posture',
    backgroundDesc: 'rain-soaked alley, old derelict building, dimly lit room, foggy street',
    lighting: 'dramatic chiaroscuro, single spotlight, rain-slicked reflections',
    titleFont: 'distorted bold cracked letters in blood red',
    authorFont: 'small pale grey text with slight blur effect, almost hidden in the shadows, a thin cracked line underneath'
  },
  scifi: {
    tag: 'sci-fi cyberpunk, futuristic technology, post-apocalyptic',
    colorPalette: 'deep blue, black, silver, with neon blue and electric purple',
    characterDesc:
      'a figure in sleek tactical mecha suit with holographic interface, glowing visor, futuristic weapon, cybernetic enhancements',
    backgroundDesc: 'ruined futuristic city, space station interior, neon-lit cyberpunk metropolis, holographic displays',
    lighting: 'holographic blue glow, neon rim lighting, energy arcs',
    titleFont: 'neon glowing futuristic font in electric blue',
    authorFont: 'small crisp white monospace text with subtle cyan scanline overlay, flanked by small geometric brackets'
  },
  western_fantasy: {
    tag: 'western high fantasy, epic medieval atmosphere',
    colorPalette: 'deep blue, dark gold, silver white, with fire red and magic purple',
    characterDesc:
      'a valiant knight in ornate plate armor with a flowing cloak, holding a glowing enchanted sword, accompanied by a majestic dragon in the sky',
    backgroundDesc: 'stone castle, dragon lair, glowing magic circle, vast fantasy plains, stormy sky',
    lighting: 'magic spell glow, dramatic stormy sky, firelight from torches',
    titleFont: 'metallic embossed fantasy lettering with glow effect',
    authorFont:
      'small bronze medieval script text with aged parchment texture, enclosed in a small decorative shield or banner shape'
  },
  historical: {
    tag: 'historical Chinese war epic, grand battlefield panorama',
    colorPalette: 'iron grey, dark red, earth yellow, with golden armor and beacon orange',
    characterDesc:
      'a mighty general in detailed golden armor with a red cape, holding a halberd, commanding presence on horseback',
    backgroundDesc: 'grand battlefield, ancient city walls, military camps, beacon fires, smoke-filled sky',
    lighting: 'dramatic battlefield firelight, smoke-filled sky, sunset over war',
    titleFont: 'heavy stone-carved seal script in deep red',
    authorFont: 'small dignified white Song typeface text above a double horizontal line in dark red'
  },
  supernatural: {
    tag: 'Chinese supernatural horror, eerie ghostly atmosphere',
    colorPalette: 'ink black, sickly green, dark red, with paper white and candlelight yellow',
    characterDesc:
      'a Daoist priest in dark robes holding a paper talisman, surrounded by ghostly silhouettes and paper figures',
    backgroundDesc: 'old graveyard, abandoned temple, dark alley, eerie coffin, paper money scattered',
    lighting: 'eerie green glow, flickering candlelight, cold ghostly luminescence',
    titleFont: 'eerie dripping handwritten font in sickly green',
    authorFont: 'small faded grey-green text slightly tilted, with a thin dripping ink line above'
  },
  light_novel: {
    tag: 'anime light novel cover, vibrant colorful moe style',
    colorPalette: 'bright multicolor, with sparkle stars and petals',
    characterDesc:
      'a cute chibi character with big sparkling eyes, cat ears, pastel colored hair, playful expression, magical accessories',
    backgroundDesc: 'fantasy world, colorful school, isekai landscape, starry sky, floating magical particles',
    lighting: 'sparkly star effects, magical particle effects, soft luminous glow',
    titleFont: 'colorful cartoon outlined bubbly font',
    authorFont: 'small playful rounded white text with pastel color outline, tiny star decorations on both sides'
  }
}

/* =========================================================
   构图变体
   ========================================================= */

export const COMPOSITION_DESC: Record<CoverComposition, string> = {
  closeup: 'close-up portrait, face filling upper half of the frame',
  fullbody: 'full body shot, dynamic pose',
  scene: 'no human figure as main subject, landscape composition',
  duo: 'two figures facing each other, emotional connection'
}

/* =========================================================
   完整 prompt 构建
   ========================================================= */

export interface BuildPromptArgs {
  bookName: string
  authorName: string
  platform: CoverPlatform
  genre: CoverGenre
  composition: CoverComposition
  styleHint?: string
}

/**
 * 构建完整英文提示词（文字层 + 风格层 + 画面层 + 通用修饰）。
 * 对齐 SKILL.md 的完整提示词模板。
 */
export function buildCoverPrompt(args: BuildPromptArgs): string {
  const platform = PLATFORM_STYLES[args.platform]
  const style = GENRE_STYLES[args.genre]
  const composition = COMPOSITION_DESC[args.composition]

  const lines: string[] = []
  // 风格层
  lines.push(`Chinese web novel cover design, ${platform.prompt}.`)
  // 文字层
  lines.push(`Title text '${args.bookName}' at top center in ${style.titleFont}.`)
  lines.push(
    `Author name '${args.authorName}' at bottom center in ${style.authorFont}.`
  )
  // 题材 + 构图 + 画面层
  lines.push(`${style.tag}.`)
  lines.push(`${composition}.`)
  lines.push(style.characterDesc + '.')
  lines.push('Background: ' + style.backgroundDesc + '.')
  lines.push(`Color palette: ${style.colorPalette}.`)
  lines.push(`Lighting: ${style.lighting}.`)
  // 用户风格偏好
  if (args.styleHint && args.styleHint.trim()) {
    lines.push(args.styleHint.trim() + '.')
  }
  // 通用修饰
  lines.push(
    `Professional book cover, high detail digital painting style, portrait ${platform.ratio} ratio, keep title and author name inside the central safe area away from edges (inner ~85%), no watermark, no text other than the title and author name`
  )

  return lines.join('\n')
}
