import type { StyleAnalysisResult } from '../../../../shared/types'

/**
 * 文风分析结果的全空初始值。供预览态在没有任何数据时兜底渲染。
 */
export const EMPTY_ANALYSIS: StyleAnalysisResult = {
  identifiedStyle: '',
  sentencePatterns: [],
  vocabularyPreferences: [],
  punctuationAndRhythm: [],
  narrativePerspective: [],
  tone: [],
  narrativeTemplates: [],
  styleConstraints: [],
  characterConstraints: [],
  plotConstraints: [],
  // 老字段保留默认空值，UI 不渲染（向后兼容 P28 之前的 styles.json）
  dos: [],
  donts: [],
  stylePrompt: ''
}
