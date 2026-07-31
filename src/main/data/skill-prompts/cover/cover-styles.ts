/**
 * 封面视觉风格库（源自 oh-story-claudecode cover-styles.md + SKILL.md）。
 *
 * 把人类作者读的散文风格定义转成结构化数据表 + prompt 构建器。
 * 供 cover-service 构建 GPT-Image-2 英文提示词。
 */

import type {
  CoverComposition,
  CoverGenre,
  CoverPlatform,
  CoverScene,
  CoverStylePreset,
  CoverTypographyOptions,
  CoverTitleFontStyle,
  CoverTitlePosition,
  CoverTitleEffect,
  CoverAuthorFontStyle,
  CoverAuthorPosition
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

/** 应用内封面的默认成品比例。平台只改变视觉风格，不再改变主封面的画幅。 */
export const DEFAULT_COVER_RATIO = '9:16'

export const PLATFORM_STYLES: Record<CoverPlatform, { label: string; ratio: string; prompt: string; uploadSize?: string }> = {
  fanqie: {
    label: '番茄小说',
    ratio: DEFAULT_COVER_RATIO,
    uploadSize: '600x800',
    prompt:
      'vibrant saturated colors, eye-catching bold design, character portrait dominating frame, mass-market novel cover style, high contrast'
  },
  qidian: {
    label: '起点',
    ratio: DEFAULT_COVER_RATIO,
    prompt:
      'polished refined illustration, detailed cinematic composition, epic atmospheric, mature sophisticated style, premium quality'
  },
  jjwxc: {
    label: '晋江',
    ratio: DEFAULT_COVER_RATIO,
    prompt: 'dreamy ethereal aesthetic, soft pastel tones, elegant romantic, delicate beauty, flower petals and bokeh'
  },
  zhihu: {
    label: '知乎盐言',
    ratio: DEFAULT_COVER_RATIO,
    prompt:
      'minimalist literary style, clean composition with negative space, subtle moody atmosphere, independent film poster aesthetic'
  },
  qimao: {
    label: '七猫',
    ratio: DEFAULT_COVER_RATIO,
    prompt:
      'striking high-impact design, vivid dramatic colors, spectacular visual effects, attention-grabbing poster style'
  },
  ciweimao: {
    label: '刺猬猫',
    ratio: DEFAULT_COVER_RATIO,
    prompt: 'anime illustration style, vibrant colorful, detailed character art, Japanese light novel aesthetic'
  },
  other: {
    label: '其他（默认竖版）',
    ratio: DEFAULT_COVER_RATIO,
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
   番茄榜单视觉样本 → 可复用封面风格

   只提炼构图、配色、字体层级和媒介质感等共性，不对应或复刻具体作品。
   ========================================================= */

export interface CoverStyleDefinition {
  label: string
  description: string
  prompt: string
  colorPalette: string
  lighting: string
  titleFont: string
  authorFont: string
  /** 未手动选择时，使用从同类榜单样本归纳出的标题布局。 */
  titlePosition?: string
  /** 未手动选择时，使用从同类榜单样本归纳出的标题字效。 */
  titleEffect?: string
  /** 未手动选择时，使用从同类榜单样本归纳出的作者名布局。 */
  authorPosition?: string
  /** 该风格天然要求无人物主体（如概念符号封面） */
  noPeople?: boolean
}

export const COVER_STYLE_PRESETS: Record<Exclude<CoverStylePreset, 'auto'>, CoverStyleDefinition> = {
  fanqie_impact: {
    label: '高饱和爽文海报',
    description: '强对比、主体醒目、超大标题，适合脑洞、系统、逆袭与强爽点题材。',
    prompt:
      'high-impact Chinese mobile web novel poster, vibrant saturated color blocks, one instantly readable focal subject, exaggerated depth, bold commercial key art, energetic motion accents, strong thumbnail readability',
    colorPalette: 'high-saturation orange, red, electric blue and gold with deep shadow contrast',
    lighting: 'dramatic rim light, bright flare accents, punchy highlights and deep cinematic shadows',
    titleFont: 'oversized stacked bold Chinese display lettering, white or gold fill with dark outline and dimensional shadow',
    authorFont: 'small clean high-contrast text on a simple dark or light strip',
    titlePosition: 'stacked across the lower third, occupying roughly 25 to 32 percent of the cover height without covering the face',
    titleEffect: 'thick high-contrast outline, compact extrusion and a controlled drop shadow for thumbnail readability',
    authorPosition: 'small and centered along the bottom safe area'
  },
  ancient_romance: {
    label: '古风人物言情',
    description: '精致古装人物、红金华服与情绪关系，适合古言、宫斗、甜宠和女强。',
    prompt:
      'polished ancient Chinese romance character illustration, elegant hanfu, expressive faces, luxurious fabric and hair ornaments, romantic narrative atmosphere, refined commercial poster finish',
    colorPalette: 'crimson, warm gold, ivory and ink black with restrained floral accents',
    lighting: 'soft golden backlight, warm lantern glow, luminous skin and delicate atmospheric haze',
    titleFont: 'large expressive Chinese brush calligraphy in white, red or metallic gold, clearly separated from the figures',
    authorFont: 'small elegant Song-style Chinese text with a thin ornamental divider',
    titlePosition: 'across the lower third or vertically beside the main figure, leaving the face and ornate costume unobstructed',
    titleEffect: 'white or metallic gold lettering with a restrained dark-red shadow or fine outline',
    authorPosition: 'small near the lower center or beside a restrained seal mark'
  },
  ink_minimal: {
    label: '国风水墨留白',
    description: '大面积留白、山水花枝与书法标题，适合传统古言、仙侠和文学向作品。',
    prompt:
      'minimal Chinese ink-wash book cover, handmade rice-paper texture, poetic negative space, restrained landscape or botanical motifs, elegant asymmetrical composition, refined editorial design',
    colorPalette: 'warm paper white, ink black, mineral green and a restrained cinnabar red accent',
    lighting: 'diffuse natural paper glow, subtle mist, no harsh highlights',
    titleFont: 'dominant hand-brushed Chinese calligraphy with expressive ink edges and generous breathing room',
    authorFont: 'small vertical seal-style Chinese text beside a restrained red seal mark',
    titlePosition: 'vertically along one side or asymmetrically through the central negative space',
    titleEffect: 'flat black or cinnabar ink with authentic dry-brush edges and no artificial glow',
    authorPosition: 'small and vertical beside a restrained red seal'
  },
  dark_suspense: {
    label: '暗黑悬疑电影',
    description: '低照度、局部红色警示与强阴影，适合悬疑、灵异、犯罪和末世。',
    prompt:
      'dark cinematic thriller poster, unsettling negative space, partial silhouette or obscured face, layered fog and texture, restrained horror imagery, premium streaming-series key art',
    colorPalette: 'charcoal black, cold blue-grey and dirty white with a single blood-red accent',
    lighting: 'low-key chiaroscuro, one directional light source, wet reflections and thin volumetric fog',
    titleFont: 'large condensed Chinese display type with distressed edges and one sharp red accent',
    authorFont: 'small pale grey text with wide tracking, kept quiet near the lower edge',
    titlePosition: 'anchored across the lower third with a dark quiet field behind it',
    titleEffect: 'cold white or dirty grey lettering with a thin red accent, distressed texture and a deep hard shadow',
    authorPosition: 'small near the bottom edge with generous tracking'
  },
  urban_cinematic: {
    label: '都市电影感',
    description: '写实人物、城市空间和电影光影，适合都市、职场、现实与现代言情。',
    prompt:
      'cinematic contemporary Chinese drama poster, believable modern characters, polished city environment, photographic realism blended with refined digital painting, premium streaming drama key art',
    colorPalette: 'deep navy, steel grey, warm amber and selective neon reflections',
    lighting: 'cinematic sunset or practical city lighting, controlled rim light, shallow depth of field and soft bokeh',
    titleFont: 'bold modern Chinese sans-serif with clean geometry and strong white-gold contrast',
    authorFont: 'small minimal sans-serif text aligned to a thin divider line',
    titlePosition: 'across the lower third below the characters eye line',
    titleEffect: 'clean white or warm gold with a subtle outline and cinematic shadow',
    authorPosition: 'small at the bottom center aligned to a thin divider line'
  },
  anime_light: {
    label: '二次元轻小说',
    description: '角色立绘、明亮色彩和图形贴纸感，适合校园、恋爱、异能与轻喜剧。',
    prompt:
      'high-quality Chinese anime light-novel cover, expressive character illustration, bright layered graphic shapes, playful icons and motion accents, crisp cel shading, polished commercial key visual',
    colorPalette: 'bright cyan, cherry pink, violet and warm yellow balanced by clean white areas',
    lighting: 'sparkling rim light, soft bloom, luminous eyes and clean high-key highlights',
    titleFont: 'large playful Chinese display lettering with thick outline, sticker-like layers and energetic tilt',
    authorFont: 'small rounded text in a simple colored capsule or clean footer strip',
    titlePosition: 'layered through the lower third and side margin without covering the characters eyes',
    titleEffect: 'white or pastel fill with a thick colored outline, small sticker accents and minimal shadow',
    authorPosition: 'small in a clean bottom strip or colored capsule'
  },
  retro_period: {
    label: '年代复古宣传画',
    description: '旧海报质感、年代建筑与暖色调，适合年代文、历史建设和家国题材。',
    prompt:
      'mid-20th-century Chinese period poster aesthetic, screen-print and aged paper texture, heroic everyday realism, period architecture and clothing, clear narrative silhouette, tasteful vintage print design',
    colorPalette: 'faded vermilion, mustard yellow, teal green, cream and weathered navy',
    lighting: 'warm directional sunlight with print-like simplified shadows and subtle paper grain',
    titleFont: 'strong retro Chinese display type inspired by vintage printed posters, bold but highly legible',
    authorFont: 'small neat printed Chinese text on an aged cream footer area',
    titlePosition: 'stacked across the lower third like a printed propaganda headline',
    titleEffect: 'cream, red or mustard ink with a dark screen-print shadow and lightly worn edges',
    authorPosition: 'small on the bottom cream margin'
  },
  epic_fantasy: {
    label: '玄幻史诗大片',
    description: '宏大世界、英雄主体和能量特效，适合玄幻、仙侠、科幻和战争升级流。',
    prompt:
      'epic fantasy blockbuster poster, monumental world scale, heroic central silhouette, layered foreground and distant environment, controlled magical energy effects, cinematic concept art, premium game key art quality',
    colorPalette: 'deep indigo, obsidian, molten gold and a focused cyan or crimson energy accent',
    lighting: 'volumetric god rays, strong rim light, atmospheric depth and controlled magical glow',
    titleFont: 'monumental metallic Chinese calligraphy or carved display lettering with restrained energy glow',
    authorFont: 'small refined light text centered above a thin metallic ornamental line',
    titlePosition: 'monumental across the lower third beneath the heroic silhouette',
    titleEffect: 'metallic gold or silver bevel with restrained energy glow and a deep cinematic shadow',
    authorPosition: 'small and centered along the bottom safe area'
  },
  glamour_romance: {
    label: '女频精致人像',
    description: '高完成度单人或双人近景、柔光与装饰字，适合现言、豪门、职场和甜虐言情。',
    prompt:
      'polished female-audience Chinese mobile novel cover, beautiful close portrait or intimate couple, editorial fashion styling, clean face visibility, elegant decorative framing, premium romantic key visual, avoid generic stock-photo appearance',
    colorPalette: 'ivory, blush pink, champagne gold, deep burgundy and selective emerald or midnight blue accents',
    lighting: 'soft luminous skin light, warm bokeh, restrained rim light and glossy editorial highlights',
    titleFont: 'large elegant Chinese calligraphy or refined high-contrast display lettering with flowing strokes',
    authorFont: 'small refined Song-style Chinese text with generous tracking',
    titlePosition: 'across the lower third or along a clear side field, never crossing the eyes or key facial features',
    titleEffect: 'white, champagne gold or deep burgundy with a fine outline and soft dimensional shadow',
    authorPosition: 'small at the bottom center under a thin ornamental divider'
  },
  cute_doodle: {
    label: '沙雕简笔脑洞',
    description: '白底手绘、表情包式角色和超大标题，适合轻松脑洞、系统、搞笑与反套路。',
    prompt:
      'playful minimalist Chinese web-novel cover, hand-drawn doodle characters, meme-like visual joke, generous white space, intentionally simple line art, one instantly understandable comedic situation, crisp mobile thumbnail readability',
    colorPalette: 'paper white with black line work, bright tomato red, sunny yellow and one light blue accent',
    lighting: 'flat clean illustration lighting with no cinematic effects and no realistic shadows',
    titleFont: 'oversized hand-drawn Chinese marker lettering with irregular playful rhythm',
    authorFont: 'small simple handwritten Chinese text kept visually quiet',
    titlePosition: 'dominant through the center and lower half, sharing the composition with one small doodle character',
    titleEffect: 'flat black or red marker strokes with a simple white knockout, no bevel and no glow',
    authorPosition: 'small at the bottom edge'
  },
  warm_period_life: {
    label: '年代生活群像',
    description: '年代服装、家庭或伴侣群像与暖金日光，适合年代婚恋、家长里短和军婚。',
    prompt:
      'warm Chinese period-life novel cover, late-20th-century clothing and architecture, believable couple or family ensemble, domestic narrative details, polished illustrated realism, nostalgic but clean commercial finish',
    colorPalette: 'military green, warm cream, brick red, faded teal and sunlit amber',
    lighting: 'golden afternoon sunlight, soft nostalgic haze and warm practical interior light',
    titleFont: 'large friendly bold Chinese display lettering mixing retro print character with modern readability',
    authorFont: 'small clean printed Chinese text in a quiet footer area',
    titlePosition: 'stacked across the lower third beneath the group faces',
    titleEffect: 'cream or warm yellow fill with a dark brown outline and compact poster shadow',
    authorPosition: 'small and centered along the bottom safe area'
  },
  rural_healing: {
    label: '田园种田治愈',
    description: '乡野日常、作物与烟火生活，适合种田、美食、经营和温馨家庭题材。',
    prompt:
      'warm Chinese rural-life illustration, farmland, courtyard, food or village market, approachable family or couple, visible seasonal crops and everyday work, gentle storybook realism, comforting mobile novel cover',
    colorPalette: 'wheat gold, leaf green, warm clay, cream and a restrained cinnabar title accent',
    lighting: 'clear warm daylight, soft natural shadows and fresh pastoral atmosphere',
    titleFont: 'large friendly Chinese brush or rounded display lettering with handcrafted warmth',
    authorFont: 'small neat handwritten or Song-style Chinese text',
    titlePosition: 'across the upper or lower open field without covering faces, food or crops',
    titleEffect: 'dark brown, green or cinnabar flat lettering with a thin cream outline',
    authorPosition: 'small near the bottom center'
  },
  male_power_type: {
    label: '男频强字效爽文',
    description: '英雄主体、强透视与粗黑堆叠标题，适合高武、系统、逆袭、都市脑洞和升级流。',
    prompt:
      'high-conversion male-audience Chinese mobile web-novel cover, assertive hero or symbolic power object, dramatic perspective, one clear conflict, dense energy focused around the subject, commercial action-poster finish, title designed for tiny thumbnail recognition',
    colorPalette: 'obsidian, electric blue, flame orange, white and metallic gold with hard contrast',
    lighting: 'hard rim light, explosive backlight, sharp highlights and controlled energy particles',
    titleFont: 'massive stacked ultra-bold Chinese display lettering with compressed proportions and aggressive diagonals',
    authorFont: 'small strong sans-serif Chinese text in a clean bottom strip',
    titlePosition: 'stacked across the lower third and occupying roughly one quarter of the cover height',
    titleEffect: 'white, gold or orange fill with thick black outline, compact 3D extrusion and hard drop shadow',
    authorPosition: 'small at the bottom center below the title'
  },
  folk_horror: {
    label: '中式民俗灵异',
    description: '纸扎、棺木、古宅与红黑禁忌物，适合民俗怪谈、灵异探险和中式恐怖。',
    prompt:
      'Chinese folk-horror mobile novel cover, one culturally specific ominous object such as a red coffin, paper effigy, ritual mask or ancestral hall, restrained human presence, tactile old-paper and carved-wood texture, unsettling symmetry, no western gothic clichés',
    colorPalette: 'lacquer red, soot black, old paper beige, tarnished gold and cold moonlit blue',
    lighting: 'single candle or doorway glow, deep surrounding darkness, thin cold fog and hard red reflections',
    titleFont: 'large distressed Chinese brush calligraphy with ritual-seal character and sharp broken edges',
    authorFont: 'small faded grey or old-gold Chinese text',
    titlePosition: 'across the lower third or centered beneath the ominous object',
    titleEffect: 'dirty white, blood red or tarnished gold with dry-brush texture and a deep black shadow',
    authorPosition: 'small along the bottom edge'
  },
  war_spy_epic: {
    label: '战争谍战纪实',
    description: '战场、列车、密信与孤胆人物，适合抗战、谍战、军旅和历史行动题材。',
    prompt:
      'cinematic Chinese wartime and espionage novel cover, historically grounded clothing and equipment, lone operative or small unit, battlefield smoke, train station, coded document or shadowed safe house, realistic narrative poster, avoid celebratory fantasy spectacle',
    colorPalette: 'khaki, smoke grey, dark olive, burnt orange and aged paper cream',
    lighting: 'smoky sunrise or moonlit low-key illumination, practical lamps and restrained fire glow',
    titleFont: 'large sturdy Chinese brush or slab display lettering with documentary authority',
    authorFont: 'small condensed printed Chinese text with wide tracking',
    titlePosition: 'stacked across the lower third beneath the operative or battlefield horizon',
    titleEffect: 'aged cream or muted gold with dark outline, rough print texture and restrained shadow',
    authorPosition: 'small at the bottom center'
  },
  game_neon: {
    label: '游戏科幻霓虹',
    description: '角色全身、技能光效和蓝橙霓虹标题，适合游戏、电竞、末世与科幻升级流。',
    prompt:
      'energetic Chinese game and sci-fi web-novel cover, full-body protagonist in action, readable equipment silhouette, futuristic vehicle or ruined city, focused skill effects, polished game key art, controlled neon UI accents, no cluttered interface screenshots',
    colorPalette: 'electric cyan, deep navy, neon violet, flame orange and bright white',
    lighting: 'strong cyan-orange rim lighting, volumetric beams, focused particles and glossy high-energy highlights',
    titleFont: 'oversized angular Chinese game-logo lettering with strong forward motion',
    authorFont: 'small clean techno sans-serif Chinese text',
    titlePosition: 'stacked across the lower third below the protagonist torso',
    titleEffect: 'white-to-gold gradient, dark navy outline, compact extrusion and restrained cyan edge glow',
    authorPosition: 'small at the bottom center'
  },
  western_adventure: {
    label: '西幻冒险轻快',
    description: '明亮异世界角色、城镇与冒险道具，适合领主、穿越、西幻经营和轻冒险。',
    prompt:
      'bright western-fantasy adventure novel cover for Chinese mobile readers, charismatic adventurer or small party, recognizable medieval town or magical workshop, clear prop-driven story hook, polished anime-realism blend, inviting rather than grimdark',
    colorPalette: 'parchment cream, sky blue, warm copper, forest green and selective ruby red',
    lighting: 'bright adventure daylight, warm shop-window glow and restrained magical sparkles',
    titleFont: 'large bold Chinese display lettering with playful adventure-poster character',
    authorFont: 'small clean serif or sans-serif Chinese text',
    titlePosition: 'across the lower third in a clear field below the character face',
    titleEffect: 'cream or white fill with dark brown outline, warm orange shadow and slight embossed depth',
    authorPosition: 'small and centered at the bottom'
  },
  minimal_typographic: {
    label: '纯字极简概念',
    description: '用书名排版、色块和单一符号完成封面，适合短书名、文学、职场和高概念题材。',
    prompt:
      'typography-led minimal Chinese book cover, the exact title is the main visual object, one restrained geometric shape or symbolic line, generous negative space, sophisticated editorial grid, two-color print discipline, no character illustration',
    colorPalette: 'one dominant neutral plus one high-contrast accent such as red, cobalt, jade or metallic gold',
    lighting: 'flat print-like treatment with subtle paper texture and no cinematic lighting',
    titleFont: 'monumental clean Chinese display typography with carefully controlled line breaks and spacing',
    authorFont: 'small precise Chinese serif or sans-serif text with wide tracking',
    titlePosition: 'dominant in the center or upper-middle, occupying 30 to 45 percent of the cover area',
    titleEffect: 'flat solid color with crisp edges, no glow, no bevel and no pictorial texture inside the glyphs',
    authorPosition: 'small at the bottom center or lower right',
    noPeople: true
  },
  concept_symbol: {
    label: '无人物概念符号',
    description: '用一件关键物、徽记或空间表达故事，适合悬疑、现实、文学和高概念作品。',
    prompt:
      'minimal high-concept book cover centered on one symbolic object, no people, iconic silhouette, strong negative space, sophisticated editorial poster design, immediately readable metaphor at thumbnail size',
    colorPalette: 'two or three restrained dominant colors with one precise high-contrast accent',
    lighting: 'single controlled spotlight, crisp silhouette and subtle atmospheric falloff',
    titleFont: 'large clean Chinese title integrated with the symbolic composition without covering the object',
    authorFont: 'small understated Chinese text with generous spacing near the bottom',
    titlePosition: 'centered in the upper-middle or lower third, balanced against the single symbolic object',
    titleEffect: 'flat high-contrast lettering with precise spacing and a restrained shadow only when needed',
    authorPosition: 'small and centered along the bottom safe area',
    noPeople: true
  }
}

/* =========================================================
   文字设计：书名/作者名的字体、位置和特效
   ========================================================= */

export const TITLE_FONT_STYLES: Record<Exclude<CoverTitleFontStyle, 'auto'>, string> = {
  impact: 'oversized ultra-bold stacked Chinese display lettering with compact spacing and powerful commercial poster energy',
  brush: 'expressive hand-brushed Chinese calligraphy with confident stroke variation and natural ink edges',
  elegant: 'refined elegant Chinese Song-style or Kai-style lettering with balanced thin-and-thick strokes',
  modern: 'clean geometric modern Chinese sans-serif lettering with precise spacing and premium editorial finish',
  suspense: 'condensed sharp-edged Chinese display lettering with controlled distressed texture and tense rhythm',
  anime: 'playful energetic Chinese display lettering with thick outline, layered sticker shapes and slight dynamic tilt',
  retro: 'bold vintage Chinese printed-poster lettering with authentic period typography and subtle aged texture'
}

export const TITLE_POSITIONS: Record<Exclude<CoverTitlePosition, 'auto'>, string> = {
  top: 'across the upper third, centered horizontally, leaving clear breathing room from the top edge',
  center: 'in the visual center as the dominant typographic focal point, without covering the subject face',
  lower_third: 'across the lower third above the author line, balanced against the main subject',
  vertical_left: 'set vertically from top to bottom along the left side inside the safe area',
  vertical_right: 'set vertically from top to bottom along the right side inside the safe area'
}

export const TITLE_EFFECTS: Record<Exclude<CoverTitleEffect, 'auto'>, string> = {
  flat: 'flat solid color, crisp edges, no 3D extrusion and no glow',
  outline_shadow: 'high-contrast outline plus a controlled dimensional drop shadow for thumbnail readability',
  metallic: 'metallic gold or silver material with restrained bevel, highlights and embossed depth',
  ink: 'authentic dry-brush ink texture with feathered edges and a subtle cinnabar accent',
  glow: 'restrained luminous edge glow with a bright core, never blurry or neon-heavy',
  embossed: 'carved or embossed relief with tactile depth and controlled directional shadow'
}

export const AUTHOR_FONT_STYLES: Record<Exclude<CoverAuthorFontStyle, 'auto'>, string> = {
  sans: 'small clean modern Chinese sans-serif lettering with generous tracking',
  serif: 'small refined Chinese Song-style serif lettering with formal editorial character',
  seal: 'small traditional Chinese seal-script inspired lettering paired with a restrained red seal motif',
  handwritten: 'small natural handwritten Chinese lettering, warm and personal but fully legible',
  metallic: 'small elegant metallic gold Chinese lettering with very subtle highlights and no heavy extrusion'
}

export const AUTHOR_POSITIONS: Record<Exclude<CoverAuthorPosition, 'auto'>, string> = {
  bottom_center: 'at the bottom center inside the safe area, clearly separated from the title',
  bottom_right: 'at the lower right inside the safe area, aligned to a short divider line',
  vertical_side: 'set vertically near the outer side of the title, inside the safe area and visually secondary'
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
  stylePreset?: CoverStylePreset
  typography?: CoverTypographyOptions
  styleHint?: string
  /** 从本地学习库读取的风格定义；提供时优先于内置风格。 */
  learningPreset?: CoverStyleDefinition
  /** 从本地学习库读取的跨题材通用规律。 */
  learningRules?: string[]
  /**
   * 从小说内容提炼的画面要素。逐字段覆盖 GENRE_STYLES 模板，
   * 缺省字段仍回退题材默认值。
   */
  scene?: CoverScene
}

/** 取覆盖值，空串/全空白视为未提供 */
function pick(override: string | undefined, fallback: string): string {
  const trimmed = override?.trim()
  return trimmed ? trimmed : fallback
}

/** 句尾补句点，避免提炼结果自带句点时出现 ".." */
function sentence(text: string): string {
  const t = text.trim().replace(/[.,;，。；]+$/, '')
  return t + '.'
}

/**
 * 构建完整英文提示词（文字层 + 风格层 + 画面层 + 通用修饰）。
 * 对齐 SKILL.md 的完整提示词模板。
 *
 * `scene` 为空时行为与旧版一致（纯题材模板）；给了 scene 则按字段覆盖，
 * 让同题材的不同作品得到各自的人物 / 场景 / 色调。
 */
export function buildCoverPrompt(args: BuildPromptArgs): string {
  const platform = PLATFORM_STYLES[args.platform]
  const style = GENRE_STYLES[args.genre]
  const preset = args.learningPreset ?? (
    args.stylePreset && args.stylePreset !== 'auto'
      ? COVER_STYLE_PRESETS[args.stylePreset]
      : undefined
  )
  const effectiveComposition = preset?.noPeople ? 'scene' : args.composition
  const composition = COMPOSITION_DESC[effectiveComposition]
  const scene = args.scene
  const typography = args.typography
  const titleFont = typography?.titleFont && typography.titleFont !== 'auto'
    ? TITLE_FONT_STYLES[typography.titleFont]
    : preset?.titleFont ?? style.titleFont
  const titlePosition = typography?.titlePosition && typography.titlePosition !== 'auto'
    ? TITLE_POSITIONS[typography.titlePosition]
    : preset?.titlePosition ?? 'across the upper third, centered horizontally, leaving clear breathing room from the top edge'
  const titleEffect = typography?.titleEffect && typography.titleEffect !== 'auto'
    ? TITLE_EFFECTS[typography.titleEffect]
    : preset?.titleEffect ?? 'strong subject-appropriate contrast and subtle dimensional separation from the background'
  const authorFont = typography?.authorFont && typography.authorFont !== 'auto'
    ? AUTHOR_FONT_STYLES[typography.authorFont]
    : preset?.authorFont ?? style.authorFont
  const authorPosition = typography?.authorPosition && typography.authorPosition !== 'auto'
    ? AUTHOR_POSITIONS[typography.authorPosition]
    : preset?.authorPosition ?? 'at the bottom center inside the safe area, clearly separated from the title'

  const lines: string[] = []
  // 风格层
  if (preset) {
    // 已明确选风格时只保留平台的移动端可读性与比例要求，避免平台默认的
    // “人物占满画面”等描述和水墨/无人物风格互相打架。
    lines.push(`Chinese web novel cover design for ${platform.label}, optimized for mobile thumbnail readability.`)
    lines.push(`Selected visual style lock (${preset.label}): ${preset.prompt}.`)
  } else {
    lines.push(`Chinese web novel cover design, ${platform.prompt}.`)
  }
  // 文字层
  lines.push(`Title text '${args.bookName}' ${titlePosition}, in ${titleFont}, with ${titleEffect}.`)
  lines.push(
    `Author name '${args.authorName}' ${authorPosition}, in ${authorFont}.`
  )
  lines.push(
    'Typography hierarchy: the title is the largest and most readable text, usually occupying 20 to 35 percent of the cover area; for a long Chinese title, use intentional 2-to-4-line grouping at semantic phrase boundaries instead of shrinking it; the author name is clearly secondary; render the exact Simplified Chinese characters once only, with correct spelling, no duplicated glyphs, and keep the background behind both text areas visually uncluttered.'
  )
  if (args.learningRules?.length) {
    lines.push(`Learned cover rules: ${args.learningRules.join(' ')}`)
  }
  // 题材 + 构图 + 画面层
  lines.push(`${style.tag}.`)
  lines.push(`${composition}.`)
  // 纯场景构图不描述主体人物，否则与「no human figure as main subject」自相矛盾
  if (effectiveComposition !== 'scene') {
    lines.push(sentence(pick(scene?.characterDesc, style.characterDesc)))
  }
  lines.push('Background: ' + sentence(pick(scene?.backgroundDesc, style.backgroundDesc)))
  if (scene?.keyProps?.trim()) {
    lines.push('Key symbolic elements: ' + sentence(scene.keyProps))
  }
  lines.push(`Color palette: ${sentence(pick(scene?.colorPalette, preset?.colorPalette ?? style.colorPalette))}`)
  lines.push(`Lighting: ${sentence(pick(scene?.lighting, preset?.lighting ?? style.lighting))}`)
  // 用户风格偏好
  if (args.styleHint && args.styleHint.trim()) {
    lines.push(sentence(args.styleHint))
  }
  // 通用修饰
  const finish = preset
    ? 'professional print-ready cover art, faithfully preserve the selected medium and visual language'
    : 'professional book cover, high detail digital painting style'
  lines.push(
    `${finish}, portrait ${platform.ratio} ratio, keep title and author name inside the central safe area away from edges (inner ~85%), no watermark, no text other than the title and author name`
  )

  return lines.join('\n')
}
