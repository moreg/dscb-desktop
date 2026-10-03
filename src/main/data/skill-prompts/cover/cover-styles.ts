/**
 * 封面视觉风格库（源自 oh-story-claudecode cover-styles.md + SKILL.md）。
 *
 * 把人类作者读的散文风格定义转成结构化数据表 + prompt 构建器。
 * 供 cover-service 构建 图像模型的中文提示词。
 */

import type {
  CoverChannel,
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
import { LEGACY_COVER_TEXT_TABLES } from './cover-localization'
import { analyzeCoverVisualDirection } from '../../cover-visual-direction'
import { COVER_FRAME_SAFETY_PROMPT } from '../../cover-frame'
import { applyCoverChannelToCharacter, applyCoverChannelToStyle, resolveCoverChannelComposition, withCoverChannel } from '../../cover-channel'

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
export const DEFAULT_COVER_RATIO = '3:4'

export const PLATFORM_STYLES: Record<CoverPlatform, { label: string; ratio: string; prompt: string; uploadSize?: string }> = {
  fanqie: {
    label: '番茄小说',
    ratio: DEFAULT_COVER_RATIO,
    uploadSize: '600x800',
    prompt:
      '高饱和鲜艳配色，醒目的粗犷设计，以人物肖像为主要视觉，高对比大众小说封面'
  },
  qidian: {
    label: '起点',
    ratio: DEFAULT_COVER_RATIO,
    prompt:
      '精细插画与电影式构图，史诗氛围，成熟克制的高品质视觉'
  },
  jjwxc: {
    label: '晋江',
    ratio: DEFAULT_COVER_RATIO,
    prompt: '梦幻空灵美感，柔和粉彩，优雅浪漫，细腻人物与花瓣、散景'
  },
  zhihu: {
    label: '知乎盐言',
    ratio: DEFAULT_COVER_RATIO,
    prompt:
      '极简文学风，干净构图与留白，含蓄情绪，独立电影海报质感'
  },
  qimao: {
    label: '七猫',
    ratio: DEFAULT_COVER_RATIO,
    prompt:
      '高冲击设计，鲜明戏剧配色，壮观特效与醒目的海报表现'
  },
  ciweimao: {
    label: '刺猬猫',
    ratio: DEFAULT_COVER_RATIO,
    prompt: '二次元插画，明亮丰富的配色，精细角色设计与日式轻小说美感'
  },
  other: {
    label: '其他（默认竖版）',
    ratio: DEFAULT_COVER_RATIO,
    prompt: '专业数字插画，均衡构图，富有氛围'
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
    tag: '中国仙侠幻想画风，空灵氛围',
    colorPalette: '深蓝、金、白、黑',
    characterDesc:
      '年轻剑客，白色飘逸丝袍配金绣，长黑发束成发髻并佩玉冠，目光锐利，神态自信，手持泛蓝光的灵剑',
    backgroundDesc: '云雾在脚下翻涌，险峻山峰、古亭与灵气微粒',
    lighting: '上方金色光束，神秘薄雾与灵气辉光',
    titleFont: '粗厚金色毛笔书法，金属光泽与锐利笔锋',
    authorFont:
      '小号精致白色衬线字，微弱金光，两侧细云纹，下方一条细金线'
  },
  urban: {
    tag: '现代都市风，干净的电影式构图',
    colorPalette: '深蓝、灰、金，少量霓虹点缀',
    characterDesc:
      '自信的年轻男性，剪裁利落的西装，整洁现代发型，眼神坚定，具有都市职业气质',
    backgroundDesc: '暮色城市天际线、玻璃高楼、霓虹街道与湿润地面倒影',
    lighting: '城市锐利灯光、玻璃上的落日反光与霓虹轮廓光',
    titleFont: '现代粗体无衬线字，银色金属质感',
    authorFont:
      '小号干净白色现代字，轻微投影，位于细银色分隔线上方'
  },
  ancient_romance: {
    tag: '中国古代宫廷言情，优雅古典美感',
    colorPalette: '朱红、金、墨黑',
    characterDesc:
      '优雅女性，华贵宫廷汉服，凤冠与金簪，精致妆容，端庄从容',
    backgroundDesc: '宏伟宫殿、红墙、珠帘、屏风与明亮灯笼',
    lighting: '暖灯笼光与金色烛光，丝绸隐约闪亮',
    titleFont: '优雅金色楷书，精致装饰',
    authorFont:
      '小号深红传统字，置于带角饰的细金色矩形框内'
  },
  modern_romance: {
    tag: '现代言情封面，柔和梦幻的温暖氛围',
    colorPalette: '粉、暖白、浅金',
    characterDesc:
      '甜蜜伴侣，一位女性穿飘逸长裙，一位男性穿休闲雅致服装，温柔微笑并深情相望',
    backgroundDesc: '舒适咖啡馆、盛开花园、柔软窗帘的暖色室内或夕阳海滩',
    lighting: '柔和暖色逆光、梦幻散景与温柔落日光',
    titleFont: '柔和圆润手写字，白色配粉色微光',
    authorFont:
      '小号粉白手写字，左侧一枚小爱心，轻微闪光'
  },
  mystery: {
    tag: '暗黑悬疑惊悚，黑色电影氛围，高对比阴影',
    colorPalette: '黑、深灰、深蓝，血红点缀',
    characterDesc:
      '穿风衣的人物剪影，半张脸藏在阴影中，目光冷锐，姿态紧绷',
    backgroundDesc: '雨湿小巷、破败旧楼、昏暗房间与雾中街道',
    lighting: '强明暗对比，单一聚光，湿地反射',
    titleFont: '血红粗体字，扭曲裂纹质感',
    authorFont: '小号浅灰字，微弱模糊，隐于阴影，下方一条细裂纹线'
  },
  scifi: {
    tag: '科幻赛博朋克，未来技术与末世氛围',
    colorPalette: '深蓝、黑、银，霓虹蓝与电紫点缀',
    characterDesc:
      '穿流线型战术机甲的人物，全息界面、发光面罩、未来武器与机械强化细节',
    backgroundDesc: '未来废墟城市、空间站内部、霓虹赛博都市与全息显示',
    lighting: '全息蓝光、霓虹轮廓光与能量电弧',
    titleFont: '电蓝色发光未来感字体',
    authorFont: '小号清晰白色等宽字，浅青扫描线效果，两侧几何括饰'
  },
  western_fantasy: {
    tag: '西方高幻想，中世纪史诗氛围',
    colorPalette: '深蓝、暗金、银白，火红与魔法紫点缀',
    characterDesc:
      '英勇骑士，华丽板甲与飘动斗篷，手持发光魔法剑，天空中一条威严巨龙相伴',
    backgroundDesc: '石堡、龙穴、发光法阵、辽阔幻想平原与风暴天空',
    lighting: '法术辉光、戏剧风暴天光与火炬光',
    titleFont: '金属浮雕幻想字体，微光点缀',
    authorFont:
      '小号青铜色中世纪字，旧羊皮纸质感，置于小盾牌或旗饰内'
  },
  historical: {
    tag: '中国历史战争史诗，宏大战场全景',
    colorPalette: '铁灰、暗红、土黄，金甲与烽火橙点缀',
    characterDesc:
      '威武将军，精细金甲与红披风，持长戟骑马，气势威严',
    backgroundDesc: '宏大战场、古城墙、军营、烽火与烟雾天空',
    lighting: '战场火光，烟雾中的天空与战争落日',
    titleFont: '厚重深红篆书，石刻质感',
    authorFont: '小号端庄白色宋体，下方深红双横线'
  },
  supernatural: {
    tag: '中式灵异恐怖，诡异幽魂氛围',
    colorPalette: '墨黑、病绿、暗红，纸白与烛黄点缀',
    characterDesc:
      '深色道袍的道人，手持纸符，周围幽影与纸扎人',
    backgroundDesc: '旧墓地、废庙、暗巷、诡异棺木与散落纸钱',
    lighting: '诡异绿光、摇曳烛光与冷色幽光',
    titleFont: '病绿色诡异手写字，滴落质感',
    authorFont: '小号灰绿字，略倾斜，下方一条细滴痕线'
  },
  light_novel: {
    tag: '二次元轻小说封面，明亮多彩的萌系画风',
    colorPalette: '明亮多色，星光与花瓣点缀',
    characterDesc:
      '可爱的大头幼态角色，大而明亮的眼睛、猫耳、粉彩发色，俏皮神态与魔法配饰',
    backgroundDesc: '幻想世界、缤纷校园、异世界景观、星空与漂浮魔法微粒',
    lighting: '闪烁星光、魔法粒子与柔和辉光',
    titleFont: '多彩卡通描边圆润字',
    authorFont: '小号俏皮白色圆润字，粉彩描边，两侧小星饰'
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
  /** 标题占画面面积的范围；在统一文字层输出，避免预设重复声明。 */
  titleArea?: string
  /** 未手动选择时，使用从同类榜单样本归纳出的作者名布局。 */
  authorPosition?: string
  /** 该风格天然要求无人物主体（如概念符号封面） */
  noPeople?: boolean
}

/** 显式媒介选择优先于题材模板与学习库的画风建议。 */
export const COVER_STYLE_MEDIUM_REQUIREMENTS: Partial<Record<CoverStylePreset, string>> = {
  photorealistic:
    '写实媒介约束：以真人电影海报或专业摄影表现当前构图；有人物时采用原创小说角色、可信人体结构、自然肤质与真实衣料。禁止插画、数字绘画、动漫、卡通和塑料肤质的三维渲染。保留故事角色的年龄、身份和符合时代的服饰',
  anime_illustration:
    '二次元媒介约束：以手绘二维动漫插画表现当前构图，线稿清晰生动，赛璐璐阴影分层；禁止真人摄影、写实肤质与三维渲染。有人物时保留故事角色的年龄、身份和符合时代的服饰，不自动改成大头幼态角色、儿童、学生或可爱吉祥物'
}

/** 选择明确媒介时，题材只补充故事内容，不再携带另一种媒介或人物画法。 */
const GENRE_SUBJECTS: Record<CoverGenre, string> = {
  xianxia: '中国修炼幻想、灵性冒险与空灵氛围',
  urban: '现代都市生活、当代奋斗与城市剧情',
  ancient_romance: '中国古代言情、宫廷剧情与情感关系',
  modern_romance: '现代言情、亲密关系与温暖氛围',
  mystery: '悬疑惊悚、紧张感与黑色电影氛围',
  scifi: '科幻、未来技术与想象世界',
  western_fantasy: '西方高幻想、史诗冒险与中世纪背景',
  historical: '中国历史剧情、冲突与时代氛围',
  supernatural: '中式灵异恐怖、诡异谜团与幽魂氛围',
  light_novel: '轻小说叙事、奇想冒险与鲜明角色关系'
}

export const COVER_STYLE_PRESETS: Record<Exclude<CoverStylePreset, 'auto'>, CoverStyleDefinition> = {
  fanqie_impact: {
    label: '高饱和爽文海报',
    description: '强对比、主体醒目、超大标题，适合脑洞、系统、逆袭与强爽点题材。',
    prompt:
      '高冲击中文手机网文海报，鲜艳高饱和色块，单一清晰主体，夸张纵深、强商业视觉与动感点缀，缩略图易读',
    colorPalette: '高饱和橙、红、电蓝与金，配深色阴影',
    lighting: '戏剧轮廓光、明亮耀斑、强高光与深电影阴影',
    titleFont: '超大堆叠中文粗体，白或金填色，深色描边与立体投影',
    authorFont: '小号干净高对比字，置于简洁深色或浅色条带',
    titlePosition: '在下三分之一区域堆叠，约占封面高度的25%至32%，不遮挡面部',
    titleEffect: '厚高对比描边、紧凑立体厚度与受控投影，保证缩略图可读',
    authorPosition: '小号，居中位于底部安全区'
  },
  ancient_romance: {
    label: '古风人物言情',
    description: '精致古装人物、红金华服与情绪关系，适合古言、宫斗、甜宠和女强。',
    prompt:
      '精致中国古风言情人物插画，优雅汉服、富有神情的面部、华丽衣料与发饰，浪漫叙事氛围与细腻商业海报质感',
    colorPalette: '朱红、暖金、象牙白与墨黑，少量花色点缀',
    lighting: '柔和金色逆光、暖灯笼光、明亮肤色与细腻薄雾',
    titleFont: '大型富有表现力的中文毛笔书法，白、红或金属金色，与人物清楚分离',
    authorFont: '小号优雅宋体，配细装饰分隔线',
    titlePosition: '位于下三分之一区域，或竖排在主体旁，面部与华服细节保持完整',
    titleEffect: '白或金属金字，克制的深红投影或细描边',
    authorPosition: '小号，靠近下方中央或素雅印章旁'
  },
  ink_minimal: {
    label: '国风水墨留白',
    description: '大面积留白、山水花枝与书法标题，适合传统古言、仙侠和文学向作品。',
    prompt:
      '极简国风水墨封面，手工宣纸肌理，诗意留白，克制的山水或花枝，优雅非对称构图与精致书刊设计',
    colorPalette: '暖纸白、墨黑、石绿与克制的朱砂红',
    lighting: '柔和自然纸面光，淡雾，不使用强高光',
    titleFont: '主体手写中文书法，自然墨边与宽松留白',
    authorFont: '小号竖排篆意字，旁置克制红印',
    titlePosition: '竖排于一侧，或非对称地穿过中央留白',
    titleEffect: '平面墨黑或朱砂色，真实干笔边缘，不加人工辉光',
    authorPosition: '小号竖排，置于克制红印旁'
  },
  dark_suspense: {
    label: '暗黑悬疑电影',
    description: '低照度、局部红色警示与强阴影，适合悬疑、灵异、犯罪和末世。',
    prompt:
      '暗黑电影式惊悚海报，不安留白，局部剪影或遮蔽面部，层叠薄雾与肌理，克制恐怖意象与精细剧集主视觉',
    colorPalette: '炭黑、冷蓝灰与旧白，单一血红点缀',
    lighting: '低照度明暗对比，单一方向光、湿地反射与轻薄体积雾',
    titleFont: '大号窄体中文标题，做旧边缘与一道锐利红色点缀',
    authorFont: '小号浅灰字，宽字距，低调置于下缘',
    titlePosition: '位于下三分之一区域，背后预留安静深色区域',
    titleEffect: '冷白或旧灰，细红点缀、做旧肌理与深硬投影',
    authorPosition: '小号，靠近底缘，字距宽松'
  },
  urban_cinematic: {
    label: '都市电影感',
    description: '写实人物、城市空间和电影光影，适合都市、职场、现实与现代言情。',
    prompt:
      '中国现代都市剧情电影海报，可信现代人物、精致城市环境，摄影写实融合细腻数字绘画，成熟剧集主视觉',
    colorPalette: '深海军蓝、钢灰、暖琥珀，少量霓虹倒影',
    lighting: '电影落日光或实际城市灯光，受控轮廓光、浅景深与柔和散景',
    titleFont: '粗体现代中文无衬线字，几何简洁，强白金对比',
    authorFont: '小号极简无衬线字，沿细分隔线排列',
    titlePosition: '位于下三分之一区域，在人物视线下方',
    titleEffect: '干净白或暖金，轻微描边与电影式投影',
    authorPosition: '小号，底部居中，配细分隔线'
  },
  photorealistic: {
    label: '真人写实封面',
    description: '原创小说角色的真人摄影质感、真实肤质与电影光影，适合现代、古装、悬疑和幻想题材。',
    prompt:
      '真人摄影质感的原创小说封面，电影式摄影构图与精细海报质感；有人物时采用可信人体结构、自然肤质与精细真实服饰材质',
    colorPalette: '自然肤色、深炭灰、柔和蓝与暖琥珀，随故事环境调整',
    lighting: '符合物理的电影主光，柔和阴影过渡，受控轮廓光与摄影景深',
    titleFont: '大型精致中文标题，字形清晰，克制的白或暖金对比',
    authorFont: '小号干净中文衬线或无衬线字，字距宽松',
    titlePosition: '位于下三分之一区域的安静文字区，不遮挡面部和关键服饰细节',
    titleEffect: '轻微摄影海报式投影，细高对比描边，不使用夸张立体厚度',
    authorPosition: '小号，底部安全区居中，与标题清楚分隔'
  },
  anime_illustration: {
    label: '二次元动漫封面',
    description: '精致二维动漫人物、清晰线稿与赛璐璐层次，适合古风、都市、玄幻、冒险和言情题材。',
    prompt:
      '高品质二维动漫小说封面，干净流畅线稿、分层赛璐璐阴影与有氛围的插画环境，精致叙事主视觉；有人物时保留原创角色的生动神情、故事适配比例与丰富服装设计',
    colorPalette: '协调动漫配色，明确主色，少量鲜艳点缀与受控深色阴影',
    lighting: '插画式电影主光，分层赛璐璐阴影，克制发光轮廓与环境纵深',
    titleFont: '大型富有表现力的中文标题，笔画清晰，字形随故事气质调整',
    authorFont: '小号清晰中文字体，细微对比描边',
    titlePosition: '位于下三分之一区域留白内，保留面部、轮廓与关键角色细节',
    titleEffect: '与插画配色相适应的受控描边及分层投影',
    authorPosition: '小号，底部中央安全区，与标题清楚分隔'
  },
  anime_light: {
    label: '二次元轻小说',
    description: '角色立绘、明亮色彩和图形贴纸感，适合校园、恋爱、异能与轻喜剧。',
    prompt:
      '高品质中文二次元轻小说封面，生动角色插画，明亮分层图形、俏皮图标与动感点缀，清晰赛璐璐阴影和商业主视觉',
    colorPalette: '亮青、樱粉、紫与暖黄，以干净白色区域平衡',
    lighting: '闪亮轮廓光、柔光、明亮眼神与干净高调高光',
    titleFont: '大型俏皮中文标题，厚描边、贴纸层次与活泼倾斜',
    authorFont: '小号圆润字，置于简洁彩色胶囊形或干净底栏',
    titlePosition: '分层位于下三分之一区域及侧边，不遮挡人物眼睛',
    titleEffect: '白或粉彩填色，厚彩色描边，小贴纸点缀与轻投影',
    authorPosition: '小号，置于干净底栏或彩色胶囊形'
  },
  retro_period: {
    label: '年代复古宣传画',
    description: '旧海报质感、年代建筑与暖色调，适合年代文、历史建设和家国题材。',
    prompt:
      '二十世纪中叶中国年代海报美感，丝网印刷与旧纸肌理，富有力量的日常写实，时代建筑服饰，清晰叙事剪影与雅致复古印刷设计',
    colorPalette: '褪色朱红、芥黄、青绿、奶油白与旧海军蓝',
    lighting: '暖方向日光，印刷式简化阴影与微细纸纹',
    titleFont: '源自老印刷海报的醒目复古中文粗体，保持清晰可读',
    authorFont: '小号整洁中文印刷字，置于旧奶油色底栏',
    titlePosition: '在下三分之一区域堆叠，如旧宣传画标题',
    titleEffect: '奶油白、红或芥黄墨色，深色丝印投影与轻微磨损边缘',
    authorPosition: '小号，位于底部奶油色边区'
  },
  epic_fantasy: {
    label: '玄幻史诗大片',
    description: '宏大世界、英雄主体和能量特效，适合玄幻、仙侠、科幻和战争升级流。',
    prompt:
      '史诗幻想大片海报，宏大世界尺度，中心英雄剪影，前景与远景层次，受控魔法能量效果，电影概念画与高品质游戏主视觉',
    colorPalette: '深靛蓝、黑曜石、熔金，聚焦的青色或朱红能量点缀',
    lighting: '体积光束、强轮廓光、环境纵深与受控魔法辉光',
    titleFont: '宏大金属中文书法或雕刻标题，克制能量微光',
    authorFont: '小号精致浅色字，居中置于细金属装饰线上方',
    titlePosition: '宏大标题位于下三分之一区域，在英雄剪影下方',
    titleEffect: '金或银金属斜面，克制能量辉光与深电影投影',
    authorPosition: '小号，居中位于底部安全区'
  },
  glamour_romance: {
    label: '女频精致人像',
    description: '高完成度单人或双人近景、柔光与装饰字，适合现言、豪门、职场和甜虐言情。',
    prompt:
      '精致女频中文手机小说封面，漂亮近景人像或亲密双人，时尚杂志造型、清晰面部、优雅装饰框与高品质浪漫主视觉，避免普通素材照感',
    colorPalette: '象牙白、浅腮红、香槟金、深酒红，少量祖母绿或午夜蓝点缀',
    lighting: '柔和明亮肤光、暖色散景、克制轮廓光与精致杂志高光',
    titleFont: '大型优雅中文书法或精细高对比标题，笔势流畅',
    authorFont: '小号精致宋体，字距宽松',
    titlePosition: '位于下三分之一区域或清晰侧边空区，不穿过眼睛和关键面部细节',
    titleEffect: '白、香槟金或深酒红，细描边与柔和立体投影',
    authorPosition: '小号，底部居中，位于细装饰分隔线下方'
  },
  cute_doodle: {
    label: '沙雕简笔脑洞',
    description: '白底手绘、表情包式角色和超大标题，适合轻松脑洞、系统、搞笑与反套路。',
    prompt:
      '轻松极简中文网文封面，手绘简笔人物、表情包式视觉笑点，大面积白色留白，刻意简洁线条，单一一眼能懂的喜剧情境，手机缩略图清晰',
    colorPalette: '纸白与黑色线条，番茄红、阳光黄及一处浅蓝点缀',
    lighting: '平面干净插画光，不加电影特效和写实阴影',
    titleFont: '超大手绘中文马克笔字，不规则而俏皮的节奏',
    authorFont: '小号简洁中文手写字，视觉低调',
    titlePosition: '标题主导中央与下半区，搭配一位小型简笔人物',
    titleEffect: '平面黑或红马克笔笔触，简单白色镂空，不加斜面或辉光',
    authorPosition: '小号，靠近底缘'
  },
  warm_period_life: {
    label: '年代生活群像',
    description: '年代服装、家庭或伴侣群像与暖金日光，适合年代婚恋、家长里短和军婚。',
    prompt:
      '温暖中国年代生活封面，二十世纪后期服饰建筑，可信伴侣或家庭群像，日常生活叙事细节，精致写实插画，怀旧而干净的商业质感',
    colorPalette: '军绿、暖奶油色、砖红、褪色青绿与阳光琥珀',
    lighting: '金色午后日光，柔和怀旧薄雾与暖色室内实际灯光',
    titleFont: '大型亲切中文粗体，结合复古印刷气质与现代可读性',
    authorFont: '小号干净中文印刷字，置于安静底栏',
    titlePosition: '位于下三分之一区域堆叠，在群像面部下方',
    titleEffect: '奶油白或暖黄填色，深棕描边与紧凑海报投影',
    authorPosition: '小号，居中位于底部安全区'
  },
  rural_healing: {
    label: '田园种田治愈',
    description: '乡野日常、作物与烟火生活，适合种田、美食、经营和温馨家庭题材。',
    prompt:
      '温暖中国乡村生活插画，农田、院落、食物或乡村集市，亲切家庭或伴侣，清晰季节作物与日常劳作，温柔绘本写实感与舒适手机封面',
    colorPalette: '麦金、叶绿、暖陶土、奶油白，标题少量朱砂点缀',
    lighting: '清晰暖日光，柔和自然阴影与清新田园氛围',
    titleFont: '大型亲切中文毛笔字或圆润标题，手工温度',
    authorFont: '小号整洁中文手写字或宋体',
    titlePosition: '位于上方或下方的空区，不遮挡面部、食物或作物',
    titleEffect: '深棕、绿或朱砂平面字，细奶油色描边',
    authorPosition: '小号，靠近底部中央'
  },
  male_power_type: {
    label: '男频强字效爽文',
    description: '英雄主体、强透视与粗黑堆叠标题，适合高武、系统、逆袭、都市脑洞和升级流。',
    prompt:
      '高冲击男频中文手机网文封面，有力量的英雄或象征力量的物件，戏剧透视，单一明确冲突，主体周围聚焦能量，动作海报质感，标题适应小缩略图',
    colorPalette: '黑曜石、电蓝、火橙、白与金属金，强硬对比',
    lighting: '硬轮廓光、爆发逆光、锐利高光与受控能量微粒',
    titleFont: '巨大堆叠中文超粗体，压缩比例与强势斜向笔势',
    authorFont: '小号有力中文无衬线字，置于干净底栏',
    titlePosition: '下三分之一区域堆叠，约占封面高度四分之一',
    titleEffect: '白、金或橙填色，厚黑描边，紧凑三维厚度与硬投影',
    authorPosition: '小号，底部中央，位于标题下方'
  },
  folk_horror: {
    label: '中式民俗灵异',
    description: '纸扎、棺木、古宅与红黑禁忌物，适合民俗怪谈、灵异探险和中式恐怖。',
    prompt:
      '中式民俗恐怖手机封面，以红棺、纸扎、仪式面具或祠堂等特定不祥物为中心，克制人物存在，旧纸与木刻触感，不安的对称构图，避免西方哥特套路',
    colorPalette: '漆红、烟黑、旧纸米色、暗金与冷月蓝',
    lighting: '单一烛光或门口光，周围深暗，薄冷雾与硬红反光',
    titleFont: '大型做旧中文毛笔字，仪式印记感与锐利断裂边缘',
    authorFont: '小号褪色灰或旧金中文字体',
    titlePosition: '位于下三分之一区域，或居中置于不祥物下方',
    titleEffect: '旧白、血红或暗金，干笔肌理与深黑投影',
    authorPosition: '小号，沿底缘排列'
  },
  war_spy_epic: {
    label: '战争谍战纪实',
    description: '战场、列车、密信与孤胆人物，适合抗战、谍战、军旅和历史行动题材。',
    prompt:
      '电影式中国战争谍战小说封面，符合时代的服饰装备，孤胆行动人物或小队，战场烟雾、车站、密信或暗处安全屋，写实叙事海报，避免庆典般幻想奇观',
    colorPalette: '卡其、烟灰、深橄榄、焦橙与旧纸奶油色',
    lighting: '烟雾日出或月光低照度，实际灯具与克制火光',
    titleFont: '大型结实中文毛笔字或粗衬线标题，纪实权威感',
    authorFont: '小号窄体中文印刷字，字距宽松',
    titlePosition: '下三分之一区域堆叠，在行动人物或战场地平线下方',
    titleEffect: '旧奶油白或暗金，深色描边、粗糙印刷肌理与克制投影',
    authorPosition: '小号，位于底部中央'
  },
  game_neon: {
    label: '游戏科幻霓虹',
    description: '角色全身、技能光效和蓝橙霓虹标题，适合游戏、电竞、末世与科幻升级流。',
    prompt:
      '有活力的中文游戏科幻网文封面，全身主角动作、清晰装备轮廓、未来载具或废墟城市，聚焦技能效果，精细游戏主视觉与受控霓虹界面点缀，不使用杂乱界面截图',
    colorPalette: '电青、深海军蓝、霓虹紫、火橙与亮白',
    lighting: '强青橙轮廓光、体积光束、聚焦微粒与亮泽高能高光',
    titleFont: '超大棱角中文游戏标志字，强前冲动势',
    authorFont: '小号干净科技感中文无衬线字',
    titlePosition: '下三分之一区域堆叠，在主角躯干下方',
    titleEffect: '白至金渐变、深海军蓝描边、紧凑立体厚度与克制青色边光',
    authorPosition: '小号，位于底部中央'
  },
  western_adventure: {
    label: '西幻冒险轻快',
    description: '明亮异世界角色、城镇与冒险道具，适合领主、穿越、西幻经营和轻冒险。',
    prompt:
      '面向中文手机读者的明亮西幻冒险封面，有魅力的冒险者或小队，可识别中世纪城镇或魔法工坊，以道具引出明确故事，精致动漫写实融合，亲切而不阴郁',
    colorPalette: '羊皮纸奶油色、天蓝、暖铜、森林绿与少量宝石红',
    lighting: '明亮冒险日光、暖商店窗光与克制魔法闪烁',
    titleFont: '大型中文粗体，俏皮冒险海报气质',
    authorFont: '小号干净中文衬线或无衬线字',
    titlePosition: '下三分之一区域的清晰空区，在角色面部下方',
    titleEffect: '奶油白或白填色，深棕描边、暖橙投影与轻浮雕纵深',
    authorPosition: '小号，底部居中'
  },
  minimal_typographic: {
    label: '纯字极简概念',
    description: '用书名排版、色块和单一符号完成封面，适合短书名、文学、职场和高概念题材。',
    prompt:
      '以排版为主的极简中文封面，准确书名作为主要视觉，一处克制几何形或象征线条，大量留白、精细网格与双色印刷纪律，不绘制人物',
    colorPalette: '一种主要中性色，加红、钴蓝、翡翠绿或金属金等高对比点缀',
    lighting: '平面印刷光，轻微纸纹，不加电影式光效',
    titleFont: '宏大干净中文标题，精细控制断句与间距',
    authorFont: '小号精确中文衬线或无衬线字，宽字距',
    titlePosition: '主导中央或中上方',
    titleArea: '30至45',
    titleEffect: '平面纯色，边缘清晰，不加辉光、斜面或字内图案',
    authorPosition: '小号，位于底部中央或右下方',
    noPeople: true
  },
  concept_symbol: {
    label: '无人物概念符号',
    description: '用一件关键物、徽记或空间表达故事，适合悬疑、现实、文学和高概念作品。',
    prompt:
      '极简高概念封面，单一象征物居中，无人物，标志性轮廓、强留白与精细书刊海报设计，缩略图中隐喻立即可辨',
    colorPalette: '两至三种克制主色，配一处精确高对比点缀',
    lighting: '单一受控聚光，清晰剪影与轻微氛围衰减',
    titleFont: '大型干净中文标题，与象征构图融合且不遮挡物件',
    authorFont: '小号低调中文字体，底部附近留白宽松',
    titlePosition: '中上方或下三分之一区域居中，与单一象征物平衡',
    titleEffect: '平面高对比字，间距精确，仅必要时加克制投影',
    authorPosition: '小号，居中位于底部安全区',
    noPeople: true
  }
}

/* =========================================================
   文字设计：书名/作者名的字体、位置和特效
   ========================================================= */

export const TITLE_FONT_STYLES: Record<Exclude<CoverTitleFontStyle, 'auto'>, string> = {
  impact: '超大堆叠中文超粗标题，紧凑间距与强商业海报气势',
  brush: '富有表现力的手写中文书法，笔势自然变化与墨边',
  elegant: '精致优雅的中文宋体或楷体，粗细笔画均衡',
  modern: '干净几何感现代中文无衬线字，间距精确、质感精致',
  suspense: '窄体锐边中文标题，受控做旧肌理与紧张节奏',
  anime: '俏皮有活力的中文标题，厚描边、分层贴纸图形与轻微动感倾斜',
  retro: '粗体复古中文印刷海报字，时代排版与轻微旧纸肌理'
}

export const TITLE_POSITIONS: Record<Exclude<CoverTitlePosition, 'auto'>, string> = {
  top: '横排于上三分之一区域，水平居中，上方留出呼吸空间',
  center: '位于视觉中央，作为主要文字焦点，不遮挡主体面部',
  lower_third: '横排于下三分之一区域，位于署名上方，与主体平衡',
  vertical_left: '在左侧安全区自上而下竖排',
  vertical_right: '在右侧安全区自上而下竖排'
}

export const TITLE_EFFECTS: Record<Exclude<CoverTitleEffect, 'auto'>, string> = {
  flat: '平面纯色，边缘清晰，不加三维厚度或辉光',
  outline_shadow: '高对比描边与受控立体投影，保证缩略图易读',
  metallic: '金或银金属材质，克制斜面、高光与浮雕纵深',
  ink: '真实干笔墨纹，羽化墨边与轻微朱砂点缀',
  glow: '克制的亮边与明亮字芯，不模糊或过度霓虹化',
  embossed: '雕刻或浮雕质感，具触感纵深与受控方向光'
}

export const AUTHOR_FONT_STYLES: Record<Exclude<CoverAuthorFontStyle, 'auto'>, string> = {
  sans: '小号干净现代中文无衬线字，字距宽松',
  serif: '小号精致中文宋体，正式书刊气质',
  seal: '小号传统篆意中文字体，搭配克制红印',
  handwritten: '小号自然中文手写字，温暖亲切且清晰可读',
  metallic: '小号优雅金属金中文字体，极轻高光，不加厚重立体效果'
}

export const AUTHOR_POSITIONS: Record<Exclude<CoverAuthorPosition, 'auto'>, string> = {
  bottom_center: '位于下方居中，与标题清楚分离，底缘上方留足距离',
  bottom_right: '位于右下方安全区，沿短分隔线排列，底缘上方留足距离',
  vertical_side: '在标题外侧附近竖排，位于安全区内，视觉次于书名'
}

/* =========================================================
   构图变体
   ========================================================= */

export const COMPOSITION_DESC: Record<CoverComposition, string> = {
  closeup: '人物特写，面部占画面上半部',
  fullbody: '全身构图，姿态富有动感',
  scene: '无主体人物，以环境场景为主',
  duo: '双人构图，两位人物相对而立，体现情绪关系'
}

/** 仅将完整命中的旧内置文本转换为中文，不按子串翻译手改文案。 */
const knownCoverText = new Map<string, string>()
function registerKnownCoverText(previous: unknown, current: unknown): void {
  if (typeof previous === 'string' && typeof current === 'string') {
    if (previous !== current) knownCoverText.set(previous, current)
    return
  }
  if (!previous || !current || typeof previous !== 'object' || typeof current !== 'object') return
  for (const [key, value] of Object.entries(previous)) registerKnownCoverText(value, (current as Record<string, unknown>)[key])
}
registerKnownCoverText(LEGACY_COVER_TEXT_TABLES, {
  PLATFORM_STYLES, GENRE_STYLES, COVER_STYLE_PRESETS, COVER_STYLE_MEDIUM_REQUIREMENTS,
  TITLE_FONT_STYLES, TITLE_POSITIONS, TITLE_EFFECTS, AUTHOR_FONT_STYLES, AUTHOR_POSITIONS, COMPOSITION_DESC
})

export function localizeKnownCoverText(text: string): string {
  return knownCoverText.get(text) ?? text
}

/** 同一预设同一字段精确等于旧默认值才迁移，保留用户自定义和附加元数据。 */
export function migrateBuiltinCoverStyle(key: CoverStylePreset | undefined, definition: CoverStyleDefinition): CoverStyleDefinition {
  if (!key || key === 'auto') return { ...definition }
  const previous = LEGACY_COVER_TEXT_TABLES.COVER_STYLE_PRESETS[key]
  const current = COVER_STYLE_PRESETS[key]
  const localized = { ...definition }
  for (const field of Object.keys(previous) as Array<keyof CoverStyleDefinition>) {
    if (definition[field] === previous[field as keyof typeof previous] && typeof definition[field] === 'string') {
      Object.assign(localized, { [field]: current[field] })
    }
  }
  return localized
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
  /** 明确选择时优先锁定主体性别和人物存在；未选择保持自动。 */
  channel?: CoverChannel
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
  /**
   * 作者填写了提炼方向。风格锁和题材默认人物让路，只保留方向没写到的场景和排版。
   */
  directionWins?: boolean
  /** 逐维覆盖作者明确指定的方向，未提及的画风与人物属性保留。 */
  visualDirection?: string
}

/** 取覆盖值，空串/全空白视为未提供 */
function pick(override: string | undefined, fallback: string): string {
  const trimmed = override?.trim()
  return trimmed ? trimmed : fallback
}

/** 句尾补句点，避免提炼结果自带句点时出现 ".." */
function sentence(text: string): string {
  const t = text.trim().replace(/[.,;，。；]+$/, '')
  return t + '。'
}

/** 学习建议让位于成品比例、文字安全与用户选定的布局。 */
export function compileCoverLearningRules(rules: string[], typography?: CoverTypographyOptions): string[] {
  const explicitPosition = typography?.titlePosition && typography.titlePosition !== 'auto'
  const explicitAuthorPosition = typography?.authorPosition && typography.authorPosition !== 'auto'
  const locationDirective = /upper|middle|lower|position|placement|candidate|band|top|bottom|center|vertical|horizontal|left|right|上方|上部|上侧|上三分|上半|顶部|顶端|下方|下部|下侧|下三分|下半|底部|底端|中间|居中|中央|中部|左侧|右侧|左边|右边|竖排|横排|位置|三分之一/i
  return [...new Set(rules.map((rule) => rule.trim()).filter((rule) => {
    if (!rule) return false
    const ratios = rule.match(/\b\d+\s*[:：]\s*\d+\b/g) ?? []
    if (ratios.some((ratio) => ratio.replace(/\s/g, '').replace('：', ':') !== DEFAULT_COVER_RATIO)) return false
    // 数值面积统一由文字层决定，样本中的观察不能变成第二条硬约束。
    const concernsTitle = /title|typography|标题|书名|文字排版/i.test(rule)
    if (concernsTitle && /occupy|occupying|percent|[%％]|cover area|百分之|百分比|(?:占|面积|覆盖).*(?:\d|[一二三四五六七八九十两半]+(?:成|分之|半))/i.test(rule)) return false
    if (explicitPosition && concernsTitle && locationDirective.test(rule)) return false
    const concernsByline = /\bbyline\b|\bauthor(?:['’]s)?\s+(?:name|text|signature|position|placement)\b|\b(?:place|position|put|set)\s+(?:the\s+)?author\b|署名|作者名|作者落款|笔名|落款/i.test(rule)
    if (explicitAuthorPosition && concernsByline && locationDirective.test(rule)) return false
    return true
  }))]
}

/** 只重编已有的标准文字层，保留小说画面和作者对其余行的所有修改。 */
export function filterCoverPromptLearningRules(basePrompt: string, rules: string[], typography?: CoverTypographyOptions): string[] {
  return compileCoverLearningRules(rules.filter((rule) => basePrompt.includes(rule)), typography)
}

export function patchCoverPromptTypography(basePrompt: string, replacementPrompt: string, typography?: CoverTypographyOptions, originalRules?: string[]): string {
  const layers = [/^(?:Title text |书名文字[:：])/, /^(?:Author byline:|作者署名[:：])/,
    /^(?:Typography hierarchy:|文字层级[:：])/, /^(?:Frame safety:|画幅安全区[:：])/]
  const replacement = new Map<number, string>()
  for (const line of replacementPrompt.split('\n')) {
    const layer = layers.findIndex((pattern) => pattern.test(line))
    if (layer >= 0) replacement.set(layer, line)
  }
  const patched = basePrompt.split('\n').map((line) => {
    if (/^(?:Learned cover rules|学习规则)/.test(line)) {
      const colon = line.search(/[:：]/)
      if (colon < 0) return line
      const rules = originalRules ?? line.slice(colon + 1).trim().split(/(?<=[.。；])\s+/)
      const filtered = filterCoverPromptLearningRules(basePrompt, rules, typography)
      const prefix = line.startsWith('Learned cover rules') ? '学习规则（建议，服从所选画风、显式排版和安全区）：' : line.slice(0, colon + 1)
      return filtered.length ? prefix + filtered.join(' ') : undefined
    }
    const layer = layers.findIndex((pattern) => pattern.test(line))
    return layer >= 0 ? replacement.get(layer) ?? line : line
  }).filter((line): line is string => line !== undefined).join('\n')
  const channel = replacementPrompt.match(/^(?:Cover channel subject lock|人物频道约束) \[(male|female)\][:：]/m)?.[1] as CoverChannel | undefined
  return withCoverChannel(patched, channel)
}

/**
 * 构建完整中文提示词（文字层 + 风格层 + 画面层 + 通用修饰）。
 * 对齐 SKILL.md 的完整提示词模板。
 *
 * `scene` 为空时行为与旧版一致（纯题材模板）；给了 scene 则按字段覆盖，
 * 让同题材的不同作品得到各自的人物 / 场景 / 色调。
 */
export function buildCoverPrompt(args: BuildPromptArgs): string {
  const platform = PLATFORM_STYLES[args.platform]
  const style = GENRE_STYLES[args.genre]
  const previousPreset = args.learningPreset ?? (
    args.stylePreset && args.stylePreset !== 'auto'
      ? COVER_STYLE_PRESETS[args.stylePreset]
      : undefined
  )
  const preset = previousPreset ? migrateBuiltinCoverStyle(args.stylePreset, previousPreset) : undefined
  const direction = analyzeCoverVisualDirection(args.visualDirection)
  const fullDirectionOverride = Boolean(args.directionWins && !args.visualDirection)
  const mediumOverride = fullDirectionOverride || Boolean(direction.medium)
  const subjectOverride = fullDirectionOverride || direction.subjectFields.length > 0
  const baseMediumRequirement = mediumOverride
    ? undefined
    : args.stylePreset ? COVER_STYLE_MEDIUM_REQUIREMENTS[args.stylePreset] : undefined
  const mediumRequirement = subjectOverride && baseMediumRequirement
    ? baseMediumRequirement.replace(/Preserve the story characters ages, identities and period-appropriate clothing|保留故事角色的年龄、身份和符合时代的服饰/i,
      '保留作者方向未明确更改的角色属性')
    : baseMediumRequirement
  const requestedComposition = direction.noPeople === true && args.channel ? args.composition : direction.composition ?? args.composition
  const effectiveComposition = args.channel && requestedComposition === 'duo' ? 'duo' : resolveCoverChannelComposition(direction.composition ?? (direction.noPeople === true
    ? 'scene'
    : !fullDirectionOverride && direction.noPeople !== false && preset?.noPeople ? 'scene' : args.composition), args.channel)
  const composition = COMPOSITION_DESC[effectiveComposition]
  const scene = args.scene
  const typography = args.typography
  const titleFont = typography?.titleFont && typography.titleFont !== 'auto'
    ? TITLE_FONT_STYLES[typography.titleFont]
    : preset?.titleFont ?? style.titleFont
  const titlePosition = typography?.titlePosition && typography.titlePosition !== 'auto'
    ? TITLE_POSITIONS[typography.titlePosition]
    : preset?.titlePosition ?? '横排于上三分之一区域，水平居中，上方留出呼吸空间'
  const titleEffect = typography?.titleEffect && typography.titleEffect !== 'auto'
    ? TITLE_EFFECTS[typography.titleEffect]
    : preset?.titleEffect ?? '与主体相适应的强对比，和背景有细微层次分离'
  const authorFont = typography?.authorFont && typography.authorFont !== 'auto'
    ? AUTHOR_FONT_STYLES[typography.authorFont]
    : preset?.authorFont ?? style.authorFont
  const authorPosition = typography?.authorPosition && typography.authorPosition !== 'auto'
    ? AUTHOR_POSITIONS[typography.authorPosition]
    : preset?.authorPosition ?? AUTHOR_POSITIONS.bottom_center

  const lines: string[] = []
  // 风格层
  if (preset) {
    // 已明确选风格时只保留平台的移动端可读性与比例要求，避免平台默认的
    // “人物占满画面”等描述和水墨/无人物风格互相打架。
    lines.push(`为${platform.label}设计中文网文封面，保证手机缩略图清晰易读。`)
    lines.push(mediumOverride
      ? `画风参考（${preset.label}）：只补充作者方向未指定的细节，不替换方向指定的主体或媒介。`
      : `画风约束（${preset.label}）：${applyCoverChannelToStyle(direction.noPeople === false
        ? preset.prompt.replace(/no people|no character illustration|无人物|不绘制人物/gi, '保留方向指定的人物主体')
        : preset.prompt, args.channel)}。`)
  } else {
    lines.push(`中文网文封面，${platform.prompt}。`)
  }
  if (mediumRequirement) lines.push(sentence(mediumRequirement))
  // 文字层
  lines.push(`书名文字：'${args.bookName}'，${titlePosition}；字体为${titleFont}；字效为${titleEffect}。`)
  lines.push(
    `作者署名：作者名'${args.authorName}'，紧接一个简体'著'字作为小号后缀，约为作者名字高的55%至70%，前留小间距，不添加其他标点；${authorPosition}；字体为${authorFont}。`
  )
  const verticalTitle = /\bvertical(?:ly)?\b|竖排/i.test(titlePosition)
  const sideByline = /\bvertical(?:ly)?\b|竖排/i.test(authorPosition)
  const titleLength = Array.from(args.bookName.replace(/\s/g, '')).length
  const grouping = verticalTitle
    ? titleLength > 8
      ? `${titleLength <= 24 ? '分为两至四列竖排' : '采用均衡竖排列数'} ，按语义短语断列，每列自上而下、列间自右向左阅读`
      : '采用单列竖排，自上而下阅读'
    : titleLength > 8
      ? `${titleLength <= 24 ? '分为两至四行横排' : '采用均衡横排行数'} ，按语义短语断行，自左向右、自上而下阅读`
      : '采用清晰单行横排，仅必要时按语义换行'
  const bylineSpace = sideByline
    ? '在书名旁预留窄侧区供作者署名竖排'
    : '在标题下方预留独立底部署名区'
  lines.push(
    `文字层级：书名最大且最易读，约占封面面积的${preset?.titleArea ?? '20至35'}%；${grouping}；${bylineSpace}。文字背景保持干净，不遮挡面部和关键道具。准确呈现简体书名和署名各一次，不错字、不重复字形。`
  )
  lines.push(COVER_FRAME_SAFETY_PROMPT)
  const learningRules = compileCoverLearningRules(args.learningRules ?? [], typography)
  if (learningRules.length) {
    const learnedPrefix = args.directionWins
      ? '学习规则（建议，服从作者明确方向）：'
      : '学习规则（建议，服从所选画风、显式排版和安全区）：'
    lines.push(learnedPrefix + learningRules.join(' '))
  }
  // 题材 + 构图 + 画面层
  lines.push(`${preset || mediumOverride || mediumRequirement ? GENRE_SUBJECTS[args.genre] : style.tag}。`)
  lines.push(`${composition}。`)
  // 纯场景构图不描述主体人物，否则与「no human figure as main subject」自相矛盾
  if (effectiveComposition !== 'scene') {
    const defaultCharacter = subjectOverride
      ? `作者画面方向指定的主体，保留其中明确的${args.channel ? '族裔、身份、姿态、服饰和媒介，性别服从频道选择' : '性别、族裔、身份、姿态、服饰和媒介'}`
      : (preset || mediumRequirement) && args.genre === 'light_novel'
        ? '原创小说主角，年龄、外貌和服饰符合故事，人体比例自然，神情生动'
        : style.characterDesc
    lines.push('主体人物：' + sentence(applyCoverChannelToCharacter(pick(scene?.characterDesc, defaultCharacter), args.channel, effectiveComposition)))
  }
  lines.push('背景场景：' + sentence(pick(scene?.backgroundDesc, style.backgroundDesc)))
  if (scene?.keyProps?.trim()) {
    lines.push('关键象征物：' + sentence(scene.keyProps))
  }
  lines.push(`配色：${sentence(pick(scene?.colorPalette, preset?.colorPalette ?? style.colorPalette))}`)
  lines.push(`光线：${sentence(pick(scene?.lighting, preset?.lighting ?? style.lighting))}`)
  // 用户风格偏好
  if (args.styleHint && args.styleHint.trim()) {
    lines.push(sentence(args.styleHint))
  }
  // 通用修饰
  const finish = mediumOverride
    ? '专业印刷级封面，作者明确方向优先于画风参考'
    : preset
      ? '专业印刷级封面，保持所选媒介与视觉语言'
      : '专业书籍封面，高细节数字绘画质感'
  lines.push(
    `${finish}；不加水印，除书名和作者署名外不出现其他文字。`
  )

  return withCoverChannel(lines.join('\n'), args.channel)
}
