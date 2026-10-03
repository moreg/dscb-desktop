/** 旧版内置文案快照，仅用于逐字段精确迁移，勿按子串覆盖作者自定义内容。 */
export const LEGACY_COVER_TEXT_TABLES = {
  "PLATFORM_STYLES": {
    "fanqie": {
      "label": "番茄小说",
      "ratio": "3:4",
      "uploadSize": "600x800",
      "prompt": "vibrant saturated colors, eye-catching bold design, character portrait dominating frame, mass-market novel cover style, high contrast"
    },
    "qidian": {
      "label": "起点",
      "ratio": "3:4",
      "prompt": "polished refined illustration, detailed cinematic composition, epic atmospheric, mature sophisticated style, premium quality"
    },
    "jjwxc": {
      "label": "晋江",
      "ratio": "3:4",
      "prompt": "dreamy ethereal aesthetic, soft pastel tones, elegant romantic, delicate beauty, flower petals and bokeh"
    },
    "zhihu": {
      "label": "知乎盐言",
      "ratio": "3:4",
      "prompt": "minimalist literary style, clean composition with negative space, subtle moody atmosphere, independent film poster aesthetic"
    },
    "qimao": {
      "label": "七猫",
      "ratio": "3:4",
      "prompt": "striking high-impact design, vivid dramatic colors, spectacular visual effects, attention-grabbing poster style"
    },
    "ciweimao": {
      "label": "刺猬猫",
      "ratio": "3:4",
      "prompt": "anime illustration style, vibrant colorful, detailed character art, Japanese light novel aesthetic"
    },
    "other": {
      "label": "其他（默认竖版）",
      "ratio": "3:4",
      "prompt": "professional digital illustration, balanced composition, atmospheric"
    }
  },
  "GENRE_STYLES": {
    "xianxia": {
      "tag": "xianxia Chinese fantasy art style, ethereal atmosphere",
      "colorPalette": "deep blue, gold, white, black",
      "characterDesc": "a young swordsman in flowing white silk robes with gold embroidery, long black hair tied in a topknot with a jade crown, piercing dark eyes, confident expression, holding a glowing blue spirit sword",
      "backgroundDesc": "ethereal clouds swirling below, dramatic mountain peaks, ancient pavilions, spiritual energy particles",
      "lighting": "divine golden light rays from above, mystical mist, spiritual energy glow",
      "titleFont": "bold golden brush calligraphy with metallic glow and sharp strokes",
      "authorFont": "small refined white serif text with faint golden glow, flanked by delicate cloud-scroll ornaments on both sides, resting on a thin horizontal gold line"
    },
    "urban": {
      "tag": "modern urban contemporary style, clean cinematic composition",
      "colorPalette": "deep blue, grey, gold, with neon accents",
      "characterDesc": "a confident young man in a sharp tailored suit, clean modern hairstyle, determined eyes, urban professional aura",
      "backgroundDesc": "city skyline at dusk, glass skyscrapers, neon-lit streets, reflective wet pavement",
      "lighting": "sharp city lights, sunset glow reflecting on glass buildings, neon rim light",
      "titleFont": "modern bold sans-serif with metallic silver finish",
      "authorFont": "small clean white modern text with subtle drop shadow, positioned above a thin silver horizontal divider line"
    },
    "ancient_romance": {
      "tag": "ancient Chinese romance palace drama, elegant classical beauty",
      "colorPalette": "crimson red, gold, ink black",
      "characterDesc": "an elegant woman in luxurious palace hanfu with phoenix crown and golden hairpins, delicate makeup, poised graceful demeanor",
      "backgroundDesc": "magnificent palace halls, red walls, beaded curtains, folding screens, glowing lanterns",
      "lighting": "warm lantern light, golden candle glow, silk fabric shimmering",
      "titleFont": "elegant golden traditional Kai script with ornate decoration",
      "authorFont": "small elegant dark red traditional text inside a thin golden rectangular border frame with corner decorations"
    },
    "modern_romance": {
      "tag": "modern romance cover art, soft dreamy warm atmosphere",
      "colorPalette": "pink, warm white, light gold",
      "characterDesc": "a sweet couple, woman in a flowing dress and man in casual elegant attire, gentle smiles, looking at each other with affection",
      "backgroundDesc": "cozy cafe, blooming garden, warm interior with soft curtains, sunset beach",
      "lighting": "soft warm backlighting, dreamy bokeh, gentle sunset glow",
      "titleFont": "soft rounded handwritten style in white with pink glow",
      "authorFont": "small soft pink-white handwritten text with a tiny heart motif on the left side, light sparkle effect"
    },
    "mystery": {
      "tag": "dark mystery thriller, noir atmosphere, high contrast shadows",
      "colorPalette": "black, dark grey, deep blue, with blood red accent",
      "characterDesc": "a silhouetted figure in a trench coat, half-face hidden in shadow, cold sharp gaze, tense posture",
      "backgroundDesc": "rain-soaked alley, old derelict building, dimly lit room, foggy street",
      "lighting": "dramatic chiaroscuro, single spotlight, rain-slicked reflections",
      "titleFont": "distorted bold cracked letters in blood red",
      "authorFont": "small pale grey text with slight blur effect, almost hidden in the shadows, a thin cracked line underneath"
    },
    "scifi": {
      "tag": "sci-fi cyberpunk, futuristic technology, post-apocalyptic",
      "colorPalette": "deep blue, black, silver, with neon blue and electric purple",
      "characterDesc": "a figure in sleek tactical mecha suit with holographic interface, glowing visor, futuristic weapon, cybernetic enhancements",
      "backgroundDesc": "ruined futuristic city, space station interior, neon-lit cyberpunk metropolis, holographic displays",
      "lighting": "holographic blue glow, neon rim lighting, energy arcs",
      "titleFont": "neon glowing futuristic font in electric blue",
      "authorFont": "small crisp white monospace text with subtle cyan scanline overlay, flanked by small geometric brackets"
    },
    "western_fantasy": {
      "tag": "western high fantasy, epic medieval atmosphere",
      "colorPalette": "deep blue, dark gold, silver white, with fire red and magic purple",
      "characterDesc": "a valiant knight in ornate plate armor with a flowing cloak, holding a glowing enchanted sword, accompanied by a majestic dragon in the sky",
      "backgroundDesc": "stone castle, dragon lair, glowing magic circle, vast fantasy plains, stormy sky",
      "lighting": "magic spell glow, dramatic stormy sky, firelight from torches",
      "titleFont": "metallic embossed fantasy lettering with glow effect",
      "authorFont": "small bronze medieval script text with aged parchment texture, enclosed in a small decorative shield or banner shape"
    },
    "historical": {
      "tag": "historical Chinese war epic, grand battlefield panorama",
      "colorPalette": "iron grey, dark red, earth yellow, with golden armor and beacon orange",
      "characterDesc": "a mighty general in detailed golden armor with a red cape, holding a halberd, commanding presence on horseback",
      "backgroundDesc": "grand battlefield, ancient city walls, military camps, beacon fires, smoke-filled sky",
      "lighting": "dramatic battlefield firelight, smoke-filled sky, sunset over war",
      "titleFont": "heavy stone-carved seal script in deep red",
      "authorFont": "small dignified white Song typeface text above a double horizontal line in dark red"
    },
    "supernatural": {
      "tag": "Chinese supernatural horror, eerie ghostly atmosphere",
      "colorPalette": "ink black, sickly green, dark red, with paper white and candlelight yellow",
      "characterDesc": "a Daoist priest in dark robes holding a paper talisman, surrounded by ghostly silhouettes and paper figures",
      "backgroundDesc": "old graveyard, abandoned temple, dark alley, eerie coffin, paper money scattered",
      "lighting": "eerie green glow, flickering candlelight, cold ghostly luminescence",
      "titleFont": "eerie dripping handwritten font in sickly green",
      "authorFont": "small faded grey-green text slightly tilted, with a thin dripping ink line above"
    },
    "light_novel": {
      "tag": "anime light novel cover, vibrant colorful moe style",
      "colorPalette": "bright multicolor, with sparkle stars and petals",
      "characterDesc": "a cute chibi character with big sparkling eyes, cat ears, pastel colored hair, playful expression, magical accessories",
      "backgroundDesc": "fantasy world, colorful school, isekai landscape, starry sky, floating magical particles",
      "lighting": "sparkly star effects, magical particle effects, soft luminous glow",
      "titleFont": "colorful cartoon outlined bubbly font",
      "authorFont": "small playful rounded white text with pastel color outline, tiny star decorations on both sides"
    }
  },
  "COVER_STYLE_PRESETS": {
    "fanqie_impact": {
      "label": "高饱和爽文海报",
      "description": "强对比、主体醒目、超大标题，适合脑洞、系统、逆袭与强爽点题材。",
      "prompt": "high-impact Chinese mobile web novel poster, vibrant saturated color blocks, one instantly readable focal subject, exaggerated depth, bold commercial key art, energetic motion accents, strong thumbnail readability",
      "colorPalette": "high-saturation orange, red, electric blue and gold with deep shadow contrast",
      "lighting": "dramatic rim light, bright flare accents, punchy highlights and deep cinematic shadows",
      "titleFont": "oversized stacked bold Chinese display lettering, white or gold fill with dark outline and dimensional shadow",
      "authorFont": "small clean high-contrast text on a simple dark or light strip",
      "titlePosition": "stacked across the lower third, occupying roughly 25 to 32 percent of the cover height without covering the face",
      "titleEffect": "thick high-contrast outline, compact extrusion and a controlled drop shadow for thumbnail readability",
      "authorPosition": "small and centered along the bottom safe area"
    },
    "ancient_romance": {
      "label": "古风人物言情",
      "description": "精致古装人物、红金华服与情绪关系，适合古言、宫斗、甜宠和女强。",
      "prompt": "polished ancient Chinese romance character illustration, elegant hanfu, expressive faces, luxurious fabric and hair ornaments, romantic narrative atmosphere, refined commercial poster finish",
      "colorPalette": "crimson, warm gold, ivory and ink black with restrained floral accents",
      "lighting": "soft golden backlight, warm lantern glow, luminous skin and delicate atmospheric haze",
      "titleFont": "large expressive Chinese brush calligraphy in white, red or metallic gold, clearly separated from the figures",
      "authorFont": "small elegant Song-style Chinese text with a thin ornamental divider",
      "titlePosition": "across the lower third or vertically beside the main figure, leaving the face and ornate costume unobstructed",
      "titleEffect": "white or metallic gold lettering with a restrained dark-red shadow or fine outline",
      "authorPosition": "small near the lower center or beside a restrained seal mark"
    },
    "ink_minimal": {
      "label": "国风水墨留白",
      "description": "大面积留白、山水花枝与书法标题，适合传统古言、仙侠和文学向作品。",
      "prompt": "minimal Chinese ink-wash book cover, handmade rice-paper texture, poetic negative space, restrained landscape or botanical motifs, elegant asymmetrical composition, refined editorial design",
      "colorPalette": "warm paper white, ink black, mineral green and a restrained cinnabar red accent",
      "lighting": "diffuse natural paper glow, subtle mist, no harsh highlights",
      "titleFont": "dominant hand-brushed Chinese calligraphy with expressive ink edges and generous breathing room",
      "authorFont": "small vertical seal-style Chinese text beside a restrained red seal mark",
      "titlePosition": "vertically along one side or asymmetrically through the central negative space",
      "titleEffect": "flat black or cinnabar ink with authentic dry-brush edges and no artificial glow",
      "authorPosition": "small and vertical beside a restrained red seal"
    },
    "dark_suspense": {
      "label": "暗黑悬疑电影",
      "description": "低照度、局部红色警示与强阴影，适合悬疑、灵异、犯罪和末世。",
      "prompt": "dark cinematic thriller poster, unsettling negative space, partial silhouette or obscured face, layered fog and texture, restrained horror imagery, premium streaming-series key art",
      "colorPalette": "charcoal black, cold blue-grey and dirty white with a single blood-red accent",
      "lighting": "low-key chiaroscuro, one directional light source, wet reflections and thin volumetric fog",
      "titleFont": "large condensed Chinese display type with distressed edges and one sharp red accent",
      "authorFont": "small pale grey text with wide tracking, kept quiet near the lower edge",
      "titlePosition": "anchored across the lower third with a dark quiet field behind it",
      "titleEffect": "cold white or dirty grey lettering with a thin red accent, distressed texture and a deep hard shadow",
      "authorPosition": "small near the bottom edge with generous tracking"
    },
    "urban_cinematic": {
      "label": "都市电影感",
      "description": "写实人物、城市空间和电影光影，适合都市、职场、现实与现代言情。",
      "prompt": "cinematic contemporary Chinese drama poster, believable modern characters, polished city environment, photographic realism blended with refined digital painting, premium streaming drama key art",
      "colorPalette": "deep navy, steel grey, warm amber and selective neon reflections",
      "lighting": "cinematic sunset or practical city lighting, controlled rim light, shallow depth of field and soft bokeh",
      "titleFont": "bold modern Chinese sans-serif with clean geometry and strong white-gold contrast",
      "authorFont": "small minimal sans-serif text aligned to a thin divider line",
      "titlePosition": "across the lower third below the characters eye line",
      "titleEffect": "clean white or warm gold with a subtle outline and cinematic shadow",
      "authorPosition": "small at the bottom center aligned to a thin divider line"
    },
    "photorealistic": {
      "label": "真人写实封面",
      "description": "原创小说角色的真人摄影质感、真实肤质与电影光影，适合现代、古装、悬疑和幻想题材。",
      "prompt": "photorealistic live-action novel cover, cinematic photographic composition, authentic camera depth and premium film-poster finish; when people are present, portray original fictional characters with believable anatomy, natural skin texture and detailed realistic costume materials",
      "colorPalette": "natural skin tones, deep charcoal, muted blue and warm amber, adapted to the story setting",
      "lighting": "physically believable cinematic key light, soft shadow transitions, controlled rim light and photographic depth of field",
      "titleFont": "large refined Chinese display lettering with strong clean shapes and restrained white or warm gold contrast",
      "authorFont": "small clean Chinese serif or sans-serif text with generous spacing",
      "titlePosition": "across the lower third within a quiet text area, leaving faces and defining costume details unobstructed",
      "titleEffect": "subtle photographic-poster shadow and a fine high-contrast outline, without excessive extrusion",
      "authorPosition": "small and centered along the bottom safe area with a clear gap below the title"
    },
    "anime_illustration": {
      "label": "二次元动漫封面",
      "description": "精致二维动漫人物、清晰线稿与赛璐璐层次，适合古风、都市、玄幻、冒险和言情题材。",
      "prompt": "high-quality 2D anime novel cover, clean confident linework, layered cel shading and atmospheric illustrated environments, polished narrative anime key visual; when people are present, portray original fictional characters with expressive faces, story-appropriate proportions and richly designed costumes",
      "colorPalette": "harmonious anime colors with a clear dominant hue, selective vivid accents and deep controlled shadows",
      "lighting": "illustrated cinematic key light, layered cel-shaded shadows, restrained luminous rim accents and atmospheric depth",
      "titleFont": "large expressive Chinese display lettering with clean readable strokes, shaped to the story tone",
      "authorFont": "small crisp Chinese text with a subtle contrasting outline",
      "titlePosition": "across the lower third in reserved negative space, preserving faces, silhouettes and key character details",
      "titleEffect": "a controlled outline and layered shadow matched to the illustration palette",
      "authorPosition": "small near the bottom center inside the safe area, clearly separated from the title"
    },
    "anime_light": {
      "label": "二次元轻小说",
      "description": "角色立绘、明亮色彩和图形贴纸感，适合校园、恋爱、异能与轻喜剧。",
      "prompt": "high-quality Chinese anime light-novel cover, expressive character illustration, bright layered graphic shapes, playful icons and motion accents, crisp cel shading, polished commercial key visual",
      "colorPalette": "bright cyan, cherry pink, violet and warm yellow balanced by clean white areas",
      "lighting": "sparkling rim light, soft bloom, luminous eyes and clean high-key highlights",
      "titleFont": "large playful Chinese display lettering with thick outline, sticker-like layers and energetic tilt",
      "authorFont": "small rounded text in a simple colored capsule or clean footer strip",
      "titlePosition": "layered through the lower third and side margin without covering the characters eyes",
      "titleEffect": "white or pastel fill with a thick colored outline, small sticker accents and minimal shadow",
      "authorPosition": "small in a clean bottom strip or colored capsule"
    },
    "retro_period": {
      "label": "年代复古宣传画",
      "description": "旧海报质感、年代建筑与暖色调，适合年代文、历史建设和家国题材。",
      "prompt": "mid-20th-century Chinese period poster aesthetic, screen-print and aged paper texture, heroic everyday realism, period architecture and clothing, clear narrative silhouette, tasteful vintage print design",
      "colorPalette": "faded vermilion, mustard yellow, teal green, cream and weathered navy",
      "lighting": "warm directional sunlight with print-like simplified shadows and subtle paper grain",
      "titleFont": "strong retro Chinese display type inspired by vintage printed posters, bold but highly legible",
      "authorFont": "small neat printed Chinese text on an aged cream footer area",
      "titlePosition": "stacked across the lower third like a printed propaganda headline",
      "titleEffect": "cream, red or mustard ink with a dark screen-print shadow and lightly worn edges",
      "authorPosition": "small on the bottom cream margin"
    },
    "epic_fantasy": {
      "label": "玄幻史诗大片",
      "description": "宏大世界、英雄主体和能量特效，适合玄幻、仙侠、科幻和战争升级流。",
      "prompt": "epic fantasy blockbuster poster, monumental world scale, heroic central silhouette, layered foreground and distant environment, controlled magical energy effects, cinematic concept art, premium game key art quality",
      "colorPalette": "deep indigo, obsidian, molten gold and a focused cyan or crimson energy accent",
      "lighting": "volumetric god rays, strong rim light, atmospheric depth and controlled magical glow",
      "titleFont": "monumental metallic Chinese calligraphy or carved display lettering with restrained energy glow",
      "authorFont": "small refined light text centered above a thin metallic ornamental line",
      "titlePosition": "monumental across the lower third beneath the heroic silhouette",
      "titleEffect": "metallic gold or silver bevel with restrained energy glow and a deep cinematic shadow",
      "authorPosition": "small and centered along the bottom safe area"
    },
    "glamour_romance": {
      "label": "女频精致人像",
      "description": "高完成度单人或双人近景、柔光与装饰字，适合现言、豪门、职场和甜虐言情。",
      "prompt": "polished female-audience Chinese mobile novel cover, beautiful close portrait or intimate couple, editorial fashion styling, clean face visibility, elegant decorative framing, premium romantic key visual, avoid generic stock-photo appearance",
      "colorPalette": "ivory, blush pink, champagne gold, deep burgundy and selective emerald or midnight blue accents",
      "lighting": "soft luminous skin light, warm bokeh, restrained rim light and glossy editorial highlights",
      "titleFont": "large elegant Chinese calligraphy or refined high-contrast display lettering with flowing strokes",
      "authorFont": "small refined Song-style Chinese text with generous tracking",
      "titlePosition": "across the lower third or along a clear side field, never crossing the eyes or key facial features",
      "titleEffect": "white, champagne gold or deep burgundy with a fine outline and soft dimensional shadow",
      "authorPosition": "small at the bottom center under a thin ornamental divider"
    },
    "cute_doodle": {
      "label": "沙雕简笔脑洞",
      "description": "白底手绘、表情包式角色和超大标题，适合轻松脑洞、系统、搞笑与反套路。",
      "prompt": "playful minimalist Chinese web-novel cover, hand-drawn doodle characters, meme-like visual joke, generous white space, intentionally simple line art, one instantly understandable comedic situation, crisp mobile thumbnail readability",
      "colorPalette": "paper white with black line work, bright tomato red, sunny yellow and one light blue accent",
      "lighting": "flat clean illustration lighting with no cinematic effects and no realistic shadows",
      "titleFont": "oversized hand-drawn Chinese marker lettering with irregular playful rhythm",
      "authorFont": "small simple handwritten Chinese text kept visually quiet",
      "titlePosition": "dominant through the center and lower half, sharing the composition with one small doodle character",
      "titleEffect": "flat black or red marker strokes with a simple white knockout, no bevel and no glow",
      "authorPosition": "small at the bottom edge"
    },
    "warm_period_life": {
      "label": "年代生活群像",
      "description": "年代服装、家庭或伴侣群像与暖金日光，适合年代婚恋、家长里短和军婚。",
      "prompt": "warm Chinese period-life novel cover, late-20th-century clothing and architecture, believable couple or family ensemble, domestic narrative details, polished illustrated realism, nostalgic but clean commercial finish",
      "colorPalette": "military green, warm cream, brick red, faded teal and sunlit amber",
      "lighting": "golden afternoon sunlight, soft nostalgic haze and warm practical interior light",
      "titleFont": "large friendly bold Chinese display lettering mixing retro print character with modern readability",
      "authorFont": "small clean printed Chinese text in a quiet footer area",
      "titlePosition": "stacked across the lower third beneath the group faces",
      "titleEffect": "cream or warm yellow fill with a dark brown outline and compact poster shadow",
      "authorPosition": "small and centered along the bottom safe area"
    },
    "rural_healing": {
      "label": "田园种田治愈",
      "description": "乡野日常、作物与烟火生活，适合种田、美食、经营和温馨家庭题材。",
      "prompt": "warm Chinese rural-life illustration, farmland, courtyard, food or village market, approachable family or couple, visible seasonal crops and everyday work, gentle storybook realism, comforting mobile novel cover",
      "colorPalette": "wheat gold, leaf green, warm clay, cream and a restrained cinnabar title accent",
      "lighting": "clear warm daylight, soft natural shadows and fresh pastoral atmosphere",
      "titleFont": "large friendly Chinese brush or rounded display lettering with handcrafted warmth",
      "authorFont": "small neat handwritten or Song-style Chinese text",
      "titlePosition": "across the upper or lower open field without covering faces, food or crops",
      "titleEffect": "dark brown, green or cinnabar flat lettering with a thin cream outline",
      "authorPosition": "small near the bottom center"
    },
    "male_power_type": {
      "label": "男频强字效爽文",
      "description": "英雄主体、强透视与粗黑堆叠标题，适合高武、系统、逆袭、都市脑洞和升级流。",
      "prompt": "high-conversion male-audience Chinese mobile web-novel cover, assertive hero or symbolic power object, dramatic perspective, one clear conflict, dense energy focused around the subject, commercial action-poster finish, title designed for tiny thumbnail recognition",
      "colorPalette": "obsidian, electric blue, flame orange, white and metallic gold with hard contrast",
      "lighting": "hard rim light, explosive backlight, sharp highlights and controlled energy particles",
      "titleFont": "massive stacked ultra-bold Chinese display lettering with compressed proportions and aggressive diagonals",
      "authorFont": "small strong sans-serif Chinese text in a clean bottom strip",
      "titlePosition": "stacked across the lower third and occupying roughly one quarter of the cover height",
      "titleEffect": "white, gold or orange fill with thick black outline, compact 3D extrusion and hard drop shadow",
      "authorPosition": "small at the bottom center below the title"
    },
    "folk_horror": {
      "label": "中式民俗灵异",
      "description": "纸扎、棺木、古宅与红黑禁忌物，适合民俗怪谈、灵异探险和中式恐怖。",
      "prompt": "Chinese folk-horror mobile novel cover, one culturally specific ominous object such as a red coffin, paper effigy, ritual mask or ancestral hall, restrained human presence, tactile old-paper and carved-wood texture, unsettling symmetry, no western gothic clichés",
      "colorPalette": "lacquer red, soot black, old paper beige, tarnished gold and cold moonlit blue",
      "lighting": "single candle or doorway glow, deep surrounding darkness, thin cold fog and hard red reflections",
      "titleFont": "large distressed Chinese brush calligraphy with ritual-seal character and sharp broken edges",
      "authorFont": "small faded grey or old-gold Chinese text",
      "titlePosition": "across the lower third or centered beneath the ominous object",
      "titleEffect": "dirty white, blood red or tarnished gold with dry-brush texture and a deep black shadow",
      "authorPosition": "small along the bottom edge"
    },
    "war_spy_epic": {
      "label": "战争谍战纪实",
      "description": "战场、列车、密信与孤胆人物，适合抗战、谍战、军旅和历史行动题材。",
      "prompt": "cinematic Chinese wartime and espionage novel cover, historically grounded clothing and equipment, lone operative or small unit, battlefield smoke, train station, coded document or shadowed safe house, realistic narrative poster, avoid celebratory fantasy spectacle",
      "colorPalette": "khaki, smoke grey, dark olive, burnt orange and aged paper cream",
      "lighting": "smoky sunrise or moonlit low-key illumination, practical lamps and restrained fire glow",
      "titleFont": "large sturdy Chinese brush or slab display lettering with documentary authority",
      "authorFont": "small condensed printed Chinese text with wide tracking",
      "titlePosition": "stacked across the lower third beneath the operative or battlefield horizon",
      "titleEffect": "aged cream or muted gold with dark outline, rough print texture and restrained shadow",
      "authorPosition": "small at the bottom center"
    },
    "game_neon": {
      "label": "游戏科幻霓虹",
      "description": "角色全身、技能光效和蓝橙霓虹标题，适合游戏、电竞、末世与科幻升级流。",
      "prompt": "energetic Chinese game and sci-fi web-novel cover, full-body protagonist in action, readable equipment silhouette, futuristic vehicle or ruined city, focused skill effects, polished game key art, controlled neon UI accents, no cluttered interface screenshots",
      "colorPalette": "electric cyan, deep navy, neon violet, flame orange and bright white",
      "lighting": "strong cyan-orange rim lighting, volumetric beams, focused particles and glossy high-energy highlights",
      "titleFont": "oversized angular Chinese game-logo lettering with strong forward motion",
      "authorFont": "small clean techno sans-serif Chinese text",
      "titlePosition": "stacked across the lower third below the protagonist torso",
      "titleEffect": "white-to-gold gradient, dark navy outline, compact extrusion and restrained cyan edge glow",
      "authorPosition": "small at the bottom center"
    },
    "western_adventure": {
      "label": "西幻冒险轻快",
      "description": "明亮异世界角色、城镇与冒险道具，适合领主、穿越、西幻经营和轻冒险。",
      "prompt": "bright western-fantasy adventure novel cover for Chinese mobile readers, charismatic adventurer or small party, recognizable medieval town or magical workshop, clear prop-driven story hook, polished anime-realism blend, inviting rather than grimdark",
      "colorPalette": "parchment cream, sky blue, warm copper, forest green and selective ruby red",
      "lighting": "bright adventure daylight, warm shop-window glow and restrained magical sparkles",
      "titleFont": "large bold Chinese display lettering with playful adventure-poster character",
      "authorFont": "small clean serif or sans-serif Chinese text",
      "titlePosition": "across the lower third in a clear field below the character face",
      "titleEffect": "cream or white fill with dark brown outline, warm orange shadow and slight embossed depth",
      "authorPosition": "small and centered at the bottom"
    },
    "minimal_typographic": {
      "label": "纯字极简概念",
      "description": "用书名排版、色块和单一符号完成封面，适合短书名、文学、职场和高概念题材。",
      "prompt": "typography-led minimal Chinese book cover, the exact title is the main visual object, one restrained geometric shape or symbolic line, generous negative space, sophisticated editorial grid, two-color print discipline, no character illustration",
      "colorPalette": "one dominant neutral plus one high-contrast accent such as red, cobalt, jade or metallic gold",
      "lighting": "flat print-like treatment with subtle paper texture and no cinematic lighting",
      "titleFont": "monumental clean Chinese display typography with carefully controlled line breaks and spacing",
      "authorFont": "small precise Chinese serif or sans-serif text with wide tracking",
      "titlePosition": "dominant in the center or upper-middle",
      "titleArea": "30 to 45",
      "titleEffect": "flat solid color with crisp edges, no glow, no bevel and no pictorial texture inside the glyphs",
      "authorPosition": "small at the bottom center or lower right",
      "noPeople": true
    },
    "concept_symbol": {
      "label": "无人物概念符号",
      "description": "用一件关键物、徽记或空间表达故事，适合悬疑、现实、文学和高概念作品。",
      "prompt": "minimal high-concept book cover centered on one symbolic object, no people, iconic silhouette, strong negative space, sophisticated editorial poster design, immediately readable metaphor at thumbnail size",
      "colorPalette": "two or three restrained dominant colors with one precise high-contrast accent",
      "lighting": "single controlled spotlight, crisp silhouette and subtle atmospheric falloff",
      "titleFont": "large clean Chinese title integrated with the symbolic composition without covering the object",
      "authorFont": "small understated Chinese text with generous spacing near the bottom",
      "titlePosition": "centered in the upper-middle or lower third, balanced against the single symbolic object",
      "titleEffect": "flat high-contrast lettering with precise spacing and a restrained shadow only when needed",
      "authorPosition": "small and centered along the bottom safe area",
      "noPeople": true
    }
  },
  "COVER_STYLE_MEDIUM_REQUIREMENTS": {
    "photorealistic": "Photographic medium lock: render the chosen composition as a live-action film poster or professional photograph; when people are present, portray original fictional novel characters with believable human anatomy, natural skin texture and realistic fabric. Use no illustration, digital painting, anime, cartoon or 3D-rendered plastic skin. Preserve the story characters ages, identities and period-appropriate clothing",
    "anime_illustration": "2D anime medium lock: render the chosen composition as hand-drawn 2D anime illustration with clean expressive linework and layered cel shading; no live-action photography, photorealistic skin or 3D rendering. When people are present, preserve the story characters ages, identities and period-appropriate clothing; do not automatically turn them into chibi figures, children, school students or cute mascots"
  },
  "TITLE_FONT_STYLES": {
    "impact": "oversized ultra-bold stacked Chinese display lettering with compact spacing and powerful commercial poster energy",
    "brush": "expressive hand-brushed Chinese calligraphy with confident stroke variation and natural ink edges",
    "elegant": "refined elegant Chinese Song-style or Kai-style lettering with balanced thin-and-thick strokes",
    "modern": "clean geometric modern Chinese sans-serif lettering with precise spacing and premium editorial finish",
    "suspense": "condensed sharp-edged Chinese display lettering with controlled distressed texture and tense rhythm",
    "anime": "playful energetic Chinese display lettering with thick outline, layered sticker shapes and slight dynamic tilt",
    "retro": "bold vintage Chinese printed-poster lettering with authentic period typography and subtle aged texture"
  },
  "TITLE_POSITIONS": {
    "top": "across the upper third, centered horizontally, leaving clear breathing room from the top edge",
    "center": "in the visual center as the dominant typographic focal point, without covering the subject face",
    "lower_third": "across the lower third above the author line, balanced against the main subject",
    "vertical_left": "set vertically from top to bottom along the left side inside the safe area",
    "vertical_right": "set vertically from top to bottom along the right side inside the safe area"
  },
  "TITLE_EFFECTS": {
    "flat": "flat solid color, crisp edges, no 3D extrusion and no glow",
    "outline_shadow": "high-contrast outline plus a controlled dimensional drop shadow for thumbnail readability",
    "metallic": "metallic gold or silver material with restrained bevel, highlights and embossed depth",
    "ink": "authentic dry-brush ink texture with feathered edges and a subtle cinnabar accent",
    "glow": "restrained luminous edge glow with a bright core, never blurry or neon-heavy",
    "embossed": "carved or embossed relief with tactile depth and controlled directional shadow"
  },
  "AUTHOR_FONT_STYLES": {
    "sans": "small clean modern Chinese sans-serif lettering with generous tracking",
    "serif": "small refined Chinese Song-style serif lettering with formal editorial character",
    "seal": "small traditional Chinese seal-script inspired lettering paired with a restrained red seal motif",
    "handwritten": "small natural handwritten Chinese lettering, warm and personal but fully legible",
    "metallic": "small elegant metallic gold Chinese lettering with very subtle highlights and no heavy extrusion"
  },
  "AUTHOR_POSITIONS": {
    "bottom_center": "centered in the lower area, clearly separated from the title and kept a generous margin above the bottom edge",
    "bottom_right": "at the lower right inside the safe area, aligned to a short divider line and kept a generous margin above the bottom edge",
    "vertical_side": "set vertically near the outer side of the title, inside the safe area and visually secondary"
  },
  "COMPOSITION_DESC": {
    "closeup": "close-up portrait, face filling upper half of the frame",
    "fullbody": "full body shot, dynamic pose",
    "scene": "no human figure as main subject, landscape composition",
    "duo": "two figures facing each other, emotional connection"
  }
} as const
