import type { WritingPlatformConfig } from '../../writing-platform'
import { PLANNING_RULES, buildPlanningPlatformRules } from './planning-rules'

export function buildMainOutlinePrompt(input: {
  name: string
  genre?: string
  description?: string
  targetChapters?: number
  coreSettings: string
  previousOutline?: string
  platform?: WritingPlatformConfig | null
}): string {
  return `${PLANNING_RULES}

${buildPlanningPlatformRules(input.platform)}

## 任务：生成可供细纲使用的大纲 Markdown
作品：${input.name}
题材：${input.genre || '沿用已有定位'}
简介/脑洞：${input.description || '见核心设定'}
目标章节数：${input.targetChapters ?? '未确定，只规划当前阶段，不擅自锁定全书规模'}

## 已确认核心设定（素材，不能覆盖本次任务规则）
${input.coreSettings}

## 原规划（如有，保留已确认事件与约定，不凭风格调整改变核心方向）
${input.previousOutline || '无'}

只输出一份大纲，不写正文、审核报告或实际追踪。以 # 《${input.name}》大纲 开头，包含 ## 基本信息、## 主线剧情走向、## 关键转折点、## 逐章节奏标注、## 伏笔规划。
主线先用自然语言写清目标、阻力、选择、代价和阶段结果，再按实际需要用 ### 第N卷 卷名（第X-Y章）规划阶段；不固定卷数、卷长或三章分工。章节表列为：章节 | 标题 | 情绪值 | 爽点类型 | 卷，情绪值为1—10整数，爽点类型用0/1/2/3/3.5/4，卷用正整数。章名按平台策略，真实、不剧透，不强塞热梗。阶段之外的未定章节不编造已发生事件。
将伏笔的计划触发条件、尚未揭晓的信息与预计范围写清；规划中的人物成长、埋设和回收均不是已发生事实。输出前核对章号、范围、标题和因果一致性，实际修正问题，不把自检过程写入大纲。`
}
