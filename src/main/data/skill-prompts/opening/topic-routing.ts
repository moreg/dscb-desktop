/**
 * 开书 Phase 1：题材路由（源自 oh-story-claudecode story-long-write Phase 1）。
 *
 * 核心方法：情绪驱动 + 优势匹配 + 对标书召回。
 * 用户优势 → 推荐题材方向：
 * - 脑洞好 → 系统文、诸天流、无限流
 * - 文笔好 → 仙侠、历史、文艺向都市
 * - 节奏感好 → 都市爽文、重生文、游戏文
 * - 生活经验丰富 → 行业文、都市日常、种田文
 */

export type AuthorStrength = 'brain' | 'writing' | 'rhythm' | 'experience'

export const STRENGTH_LABELS: Record<AuthorStrength, string> = {
  brain: '脑洞好',
  writing: '文笔好',
  rhythm: '节奏感好',
  experience: '生活经验丰富'
}

/** 优势 → 推荐题材方向 */
export const STRENGTH_TO_GENRES: Record<AuthorStrength, string[]> = {
  brain: ['系统文', '诸天流', '无限流', '脑洞文'],
  writing: ['仙侠', '历史', '文艺向都市', '玄幻'],
  rhythm: ['都市爽文', '重生文', '游戏文', '战神赘婿'],
  experience: ['行业文', '都市日常', '种田文', '年代文']
}

/** 从用户脑洞描述推断优势（关键词匹配，用于默认推荐） */
export function inferStrength(brainDump: string): AuthorStrength {
  const text = brainDump.toLowerCase()
  if (/(系统|金手指|穿越|重生|开挂|外挂|设定|规则|脑洞|创意|点子)/.test(text)) return 'brain'
  if (/(文笔|细腻|唯美|诗意|古风|修仙|江湖)/.test(text)) return 'writing'
  if (/(爽|打脸|逆袭|节奏快|热血|战斗)/.test(text)) return 'rhythm'
  if (/(职场|行业|医生|律师|商战|种田|日常|年代)/.test(text)) return 'experience'
  return 'brain' // 默认脑洞优先（最通用）
}

export const OPENING_SYSTEM_PROMPT = `你是一名资深网文策划，专精长篇网络小说的开书定位。你的核心方法：

1. **情绪驱动**：每个故事必须服务一个明确的读者情绪目标（爽感/代入/共鸣/猎奇）。先确定"想让读者什么感觉"，再选题材和金手指。
2. **优势匹配**：作者的优势决定适合的题材——脑洞好→系统/诸天，文笔好→仙侠/历史，节奏感好→都市爽文，生活经验→行业文。
3. **对标借鉴**：从爆款对标书提取可复用模块（情绪链/功能位），保留结构替换素材，绝不照搬具体桥段。
4. **市场验证**：单本上榜是个例，跨样本重复才算信号；"能爆的原因"是假设，需拆文坐实。

题材调性差异（关键）：
| 平台 | 调性 | 主力读者 | 适合类型 |
|------|------|----------|----------|
| 起点 | 男频硬核爽文 | 18-35 男性 | 玄幻、都市、科幻 |
| 番茄 | 下沉免费，快节奏强爽 | 大众 | 脑洞、爽文 |
| 晋江 | 女频精品 | 16-30 女性 | 言情、纯爱、衍生 |
| 知乎盐言 | 短篇情绪驱动 | 20-35 通吃 | 追妻、复仇、世情 |`
