import type { PaceTier, RhythmProfile, ScriptSettings, StoryboardUnit } from './script-studio'

export const PACE_LABELS: Record<PaceTier, string> = {
  'cinematic-mid': '电影感中速', 'short-high': '短视频中高密度',
  'high-hook': '高密度动作或强钩子', 'slow-info': '慢节奏但高信息'
}

export function rhythmProfile(settings: ScriptSettings): RhythmProfile {
  return settings.rhythmProfile ?? {
    first3: '【暂定】用可见动作或异常建立本集钩子。',
    first15: '【暂定】明确人物目标、阻碍与第一次局面变化。',
    first30: '【暂定】兑现首个信息增量或反转，推进人物选择。',
    breathing: '【暂定】仅保留服务情绪、悬念、关系或关键信息的停顿，每次留白不超过一个表演节拍。',
    avoidDragging: '【暂定】避免重复交代、无功能空镜、连续慢推和无信息沉默。',
    completionGoal: '【暂定】结尾落在决断、代价或新问题上，使观众有继续观看的理由。'
  }
}

export function paceExecution(unit: StoryboardUnit): string {
  if (unit.paceExecution?.trim()) return unit.paceExecution.trim()
  const actions: Record<PaceTier, string> = {
    'cinematic-mid': '按动作与反应自然推进，焦点落点清楚，停顿只用于人物选择或信息显露。',
    'short-high': '用动作、反应与道具变化交替推进，转接干脆，避免重复慢推，末镜落在新的可见变化。',
    'high-hook': '接触动作、受力反应和局面变化连续推进，切换紧凑，关键变化清晰可见，末镜保留威胁或反转。',
    'slow-info': '保持克制的摄影机运动，每次停顿必须露出新信息，通过视线、手部与道具变化推进局面。'
  }
  return actions[unit.paceTier]
}

export function shotDensity(tier: PaceTier, seconds: number): [number, number] {
  const bucket = seconds <= 6 ? 0 : seconds <= 9 ? 1 : seconds <= 12 ? 2 : 3
  const table: Record<PaceTier, [number, number][]> = {
    'cinematic-mid': [[1, 2], [2, 3], [3, 5], [4, 6]],
    'short-high': [[2, 2], [3, 4], [4, 6], [6, 8]],
    'high-hook': [[2, 3], [4, 5], [5, 7], [7, 10]],
    'slow-info': [[1, 2], [1, 3], [2, 4], [2, 5]]
  }
  return table[tier][bucket]
}
