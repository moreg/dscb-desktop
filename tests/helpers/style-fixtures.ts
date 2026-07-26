import type { CreateStyleProfileInput } from '../../src/shared/types'

/**
 * 建卡入参夹具。文风卡有 14 个必填字段，逐个内联会淹没用例真正想表达的差异，
 * 且 CreateStyleProfileInput 增删字段时要改到每一处副本。
 */
export function makeStyleInput(
  name: string,
  overrides: Partial<CreateStyleProfileInput> = {}
): CreateStyleProfileInput {
  return {
    name,
    sourceType: 'sampleText',
    sampleText: 'a'.repeat(500),
    identifiedStyle: '冷峻都市',
    sentencePatterns: ['短句推进'],
    vocabularyPreferences: ['冷硬动词'],
    punctuationAndRhythm: ['停顿多'],
    narrativePerspective: ['第三人称'],
    tone: ['冷静'],
    narrativeTemplates: ['冲突先行'],
    styleConstraints: ['保持现实质感'],
    characterConstraints: [],
    plotConstraints: [],
    stylePrompt: '保持冷峻都市感。',
    ...overrides
  }
}
