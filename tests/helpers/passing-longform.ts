import type { LlmService } from '../../src/main/data/llm-service'

/** Isolate unrelated generation/repair tests from the mandatory semantic audit.
 * The real guard/parser still run; boundary rejection is exercised in chapter-boundary and longform tests.
 */
export function withPassingLongformGuard(llm: LlmService): LlmService {
  return Object.assign(Object.create(llm), {
    generateStream: (prompt, options) => options?.meta?.feature === 'longformGuard'
      ? Promise.resolve(JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item', 'boundary'], findings: [] }))
      : llm.generateStream(prompt, options)
  } satisfies Pick<LlmService, 'generateStream'>)
}
