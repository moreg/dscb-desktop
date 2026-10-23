import { FANQIE_OPENING_RULES, PLANNING_SKILL_CONTRACT, DIALOGUE_TARGET_RULES, CHARACTER_VOICE_RULES } from '../skill-contracts'
import { renderWritingPlatformConfig, type WritingPlatformConfig } from '../../writing-platform'

/** 立项、规划和审核共用的内容边界；不把正文排版套到管理说明。 */
export const PLANNING_RULES = `
${PLANNING_SKILL_CONTRACT}

${CHARACTER_VOICE_RULES}

${DIALOGUE_TARGET_RULES}

${FANQIE_OPENING_RULES}

【规划与审核统一规则】
- 用户本次明确要求优先，沿用项目平台、人设、文风和已确认事实；缺少平台配置时保留既有风格，不自动转平台。
- 人物目标、阻力、选择、代价和因果推动事件，不套固定开场、三章分工、每卷章数、打脸循环、高潮间隔或终章续写配额。
- 情节点序列是细纲唯一剧情骨架，核心事件、五段式和多线只是摘要，不新增事件、人物或结局；结构字段不规定正文固定段数或比例。
- 篇幅是参考，不是填充下限；预算估算合计与预算合计同源，偏差先查必要行动、因果和交锋，不补水、不擅改用户目标。用户明确硬上限时遵守剩余额度。
- 允许规划情绪标签和必要动机，不强制心理外化、节奏打碎、微动作限次或古风改现代口语。少写无用途环境和反复心理，保留关键过程，不给每句台词配动作。
- 规划细纲内必要交锋，不设强制对白比例，不强塞问答、独白或轮流震惊，不把无声行动改成自言自语。
- 可用于正文的台词按语气保留句末标点和引号，动作位置服从原有时序，不机械拆句。
- 章号与结构字段用于定位，不照搬进叙事；既往事实、当前情节点和未来安排分开，后续揭晓不提前兑现。标题真实、不剧透，细纲文件名、文件内标题与大纲标题一致，已有正文再核对正文文件名。
- 实际追踪只记录已保存正文的事实。未来人物变化、伏笔动作和事件留在细纲或细纲规划，不改实际角色态、实际回收章、时间线或正文进度。actualized 是实际回填标记，不是细纲完成标记，也不能仅凭 false 判断正文尚未写成。
- 审核依原文与来源给证据，缺上下文标待核对，不补造记忆或虚构统计。只有整章真正完成才验收章末，分轮续写不为完成清单跳点或强行收尾。
- 对标只参考一般表达方法，不复制具体桥段、独特设定或台词；示例不是本作事实。可选资料缺失就跳过，不为补库打断生成。
`.trim()

export function buildPlanningPlatformRules(config?: WritingPlatformConfig | null): string {
  return config ? renderWritingPlatformConfig(config) : '项目未提供平台配置：保留已有章名与篇幅约定，不自行切换平台或套用番茄专属规则。'
}
