import { AsyncLocalStorage } from 'async_hooks'
import { runChapterExecution, recordChapterStage } from './chapter-execution'
import { contentRevision } from './chapter-revision'

export type ChapterWorkflowMode = 'generate' | 'continue' | 'repair' | 'sync' | 'refine'
interface Workflow { dir: string; chapter: number; mode: ChapterWorkflowMode; expressionRuns: number }
const current = new AsyncLocalStorage<Workflow>()

/** One backend execution contract for all entry points. Nested stages share budgets. */
export class ChapterWorkflow {
  static async run<T>(dir: string, chapter: number, mode: ChapterWorkflowMode, action: () => Promise<T>): Promise<T> {
    const parent = current.getStore()
    if (parent?.dir === dir && parent.chapter === chapter) return action()
    return runChapterExecution(dir, chapter, () => current.run({ dir, chapter, mode, expressionRuns: 0 }, async () => {
      try {
        const value = await action()
        const incomplete = value && typeof value === 'object' && 'error' in value && value.error
        recordChapterStage({ stage: `workflow:${mode}`, verdict: incomplete ? 'incomplete' : 'passed' })
        return value
      } catch (error) {
        recordChapterStage({ stage: `workflow:${mode}`, verdict: 'incomplete' })
        throw error
      }
    }))
  }

  /** A later factual repair must not silently start another whole-chapter polish. */
  static claimExpression(): boolean {
    const state = current.getStore()
    if (!state) return true
    return state.expressionRuns++ === 0
  }

  static async stage<T>(stage: string, content: string, action: () => Promise<T>,
    verdict: (result: T) => 'passed' | 'rejected' | 'incomplete' = () => 'passed'): Promise<T> {
    const started = Date.now()
    try {
      const result = await action()
      recordChapterStage({ stage, inputRevision: contentRevision(content), verdict: verdict(result), durationMs: Date.now() - started })
      return result
    } catch (error) {
      recordChapterStage({ stage, inputRevision: contentRevision(content), verdict: 'incomplete', durationMs: Date.now() - started })
      throw error
    }
  }
}
