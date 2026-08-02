import type { ChapterMeta, ReasoningEffort } from './types'
import type { AntigravityModelTier } from './antigravity-model-tiers'

export interface ChapterStrengthSuggestion {
  /** 思考强度建议（openai-responses / codex） */
  effort: ReasoningEffort
  /** Gemini 档位建议（antigravity） */
  tier: AntigravityModelTier
  /** 温度建议（openai / anthropic） */
  temperature: number
  /** 一句话说明，展示给用户 */
  reason: string
}

/**
 * 按章节节奏数据（细纲的情绪值/爽点类型）给出本章生成强度建议。
 * 规则：大高潮（爽点≥3）或高情绪（≥9）拉满；平淡过渡（情绪≤3）求稳省预算；其余默认。
 */
export function suggestChapterStrength(meta: Pick<ChapterMeta, 'emotion' | 'climax'> | null | undefined): ChapterStrengthSuggestion {
  const emotion = meta?.emotion ?? 0
  const climax = meta?.climax ?? 0

  if (climax >= 3 || emotion >= 9) {
    return {
      effort: 'high',
      tier: 'High',
      temperature: 1.0,
      reason: climax >= 3 ? `爽点 ${climax} 级大高潮，放开写` : `情绪 ${emotion}/10，重场戏拉满`
    }
  }
  if (emotion > 0 && emotion <= 3 && climax === 0) {
    return {
      effort: 'low',
      tier: 'Low',
      temperature: 0.6,
      reason: `情绪 ${emotion}/10 的过渡章，求稳省预算`
    }
  }
  return {
    effort: 'medium',
    tier: 'Medium',
    temperature: 0.8,
    reason: emotion > 0 || climax > 0 ? `情绪 ${emotion}/10，常规推进` : '无节奏数据，用默认'
  }
}
