import type { DeslopService } from '../../src/main/data/deslop/deslop-service'
import { countWords } from '../../src/main/data/words'

/** 路由/上下文测试隔离成稿验收；真实验收由 dialogue-quality.test.ts 覆盖。 */
export const acceptedDeslop = {
  deslop: async (text: string) => ({
    rewritten: text, processedGates: [], beforeWords: countWords(text), afterWords: countWords(text),
    deleteRatio: 0, remainingFindings: [], changeSummary: [],
    dialogueQuality: { passed: true, beforeRatio: 0.7, afterRatio: 0.7, attempts: 0, issues: [] }
  })
} as unknown as DeslopService
