/**
 * 内置题材趋势知识（源自 oh-story-claudecode genre-trends.md / real-market-data.md）。
 *
 * 当采集失败时作为「候选假设」注入 LLM 选题决策 prompt，明确标注为假设而非实时数据。
 * 不伪造具体榜单条目。
 */

export interface GenreTrend {
  genre: string
  /** 热度态势 */
  trend: 'rising' | 'stable' | 'declining' | 'saturated'
  /** 当前热门卖点/流派 */
  hotSpots: string[]
  /** 读者画像要点 */
  readerProfile: string
  /** 风险 */
  risk: string
}

/** 长篇题材趋势（候选假设，非实时数据） */
export const LONG_GENRE_TRENDS: GenreTrend[] = [
  {
    genre: '玄幻/仙侠',
    trend: 'stable',
    hotSpots: ['极道流', '凡人流', '长生流', '苟道流', '诡异修仙'],
    readerProfile: '追求成长爽感与世界观探索，男性为主，耐受长线',
    risk: '传统升级流饱和，需脑洞/反套路切入'
  },
  {
    genre: '都市',
    trend: 'rising',
    hotSpots: ['神豪系统', '重生逆袭', '都市修真', '战神赘婿', '年代文'],
    readerProfile: '追求即时爽感与代入，节奏快，男性为主',
    risk: '赘婿/战神套路过度饱和，需新金手指'
  },
  {
    genre: '科幻/末世',
    trend: 'rising',
    hotSpots: ['废土生存', '全民领主', '规则怪谈', '星际机甲'],
    readerProfile: '追求设定新奇与策略感，容忍慢热',
    risk: '设定门槛高，开局留存难'
  },
  {
    genre: '历史',
    trend: 'stable',
    hotSpots: ['三国谋士', '大明种田', '大唐争霸', '抗战谍战'],
    readerProfile: '追求历史代入与种田成就感，男性为主',
    risk: '小众，需强卖点破圈'
  },
  {
    genre: '系统文/脑洞',
    trend: 'rising',
    hotSpots: ['全民觉醒', '规则类系统', '签到流', '模拟器流'],
    readerProfile: '追求金手指新奇与即时反馈',
    risk: '同质化快，需差异化金手指'
  }
]

/** 短篇题材趋势（候选假设） */
export const SHORT_GENRE_TRENDS: GenreTrend[] = [
  {
    genre: '追妻火葬场',
    trend: 'stable',
    hotSpots: ['死遁', '假离婚', '迟来追悔', '重生复仇'],
    readerProfile: '追求情绪拉扯与爽感释放，女性为主，强代入',
    risk: '套路成熟但同质化，需新颖反转钩子'
  },
  {
    genre: '重生复仇',
    trend: 'rising',
    hotSpots: ['宅斗重生', '职场逆袭', '渣男渣女报应'],
    readerProfile: '追求爽感与正义感，女性为主',
    risk: '需强反派与递进报应设计'
  },
  {
    genre: '世情/现实',
    trend: 'rising',
    hotSpots: ['原生家庭', '婆媳', '扶弟魔', '重男轻女'],
    readerProfile: '追求共鸣与社会话题讨论，男女通吃',
    risk: '需真实痛点，避免悬浮'
  },
  {
    genre: '悬疑反转',
    trend: 'stable',
    hotSpots: ['认知反转', '套娃反转', '信息差碾压'],
    readerProfile: '追求智力快感与回看惊喜',
    risk: '反转设计门槛高，铺垫不足会烂尾'
  }
]

/** 构建「内置知识兜底」报告 markdown（明确标注为候选假设） */
export function buildBuiltinKnowledgeMarkdown(isLong: boolean): string {
  const trends = isLong ? LONG_GENRE_TRENDS : SHORT_GENRE_TRENDS
  const lines: string[] = []
  lines.push(`# 内置题材趋势（${isLong ? '长篇' : '短篇'}）`)
  lines.push('')
  lines.push('> ⚠️ **这是内置的候选假设，非实时采集数据。** 来源：oh-story-claudecode 题材趋势知识库。')
  lines.push('> 跨样本重复模式才算信号；本表仅供选题方向参考。')
  lines.push('')
  lines.push('| 题材 | 态势 | 热门卖点/流派 | 读者画像 | 风险 |')
  lines.push('|------|------|---------------|----------|------|')
  for (const t of trends) {
    lines.push(
      `| ${t.genre} | ${trendLabel(t.trend)} | ${t.hotSpots.join('、')} | ${t.readerProfile} | ${t.risk} |`
    )
  }
  return lines.join('\n')
}

function trendLabel(t: GenreTrend['trend']): string {
  return { rising: '↑ 上升', stable: '→ 稳定', declining: '↓ 下行', saturated: '⚠ 饱和' }[t]
}
