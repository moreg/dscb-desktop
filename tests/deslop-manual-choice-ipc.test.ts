import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeslopResult } from '../src/shared/types'
import type { DeslopService } from '../src/main/data/deslop/deslop-service'
import type { ProjectService } from '../src/main/data/project-service'
import type { StyleProfileService } from '../src/main/data/style-profile-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import { activeStreamCount } from '../src/main/data/stream-abort-registry'
import { countWords } from '../src/main/data/words'
import { measureDialogue } from '../src/main/data/dialogue-quality'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler) },
  BrowserWindow: { fromWebContents: () => null }
}))
import { registerDeslopIpc } from '../src/main/ipc/deslop'

const original = '林远把账册交给守门人，站在门外等候。'
const candidate = '“账册给你。”林远站在门外。\n“在这里等。”守门人接过账册。'
const failed = (): DeslopResult => ({
  rewritten: original, beforeWords: countWords(original), afterWords: countWords(original), deleteRatio: 0,
  processedGates: ['E'], remainingFindings: [], changeSummary: ['对白验收需复核'],
  dialogueQuality: { passed: false, pendingDraft: candidate, beforeRatio: 0, afterRatio: 0, attempts: 3,
    issues: ['整章直接对白占比未达到69%—71%'] },
  semanticVerification: { scope: 'full_chapter_facts_and_expression', originalRevision: 'old', candidateRevision: 'old', prefixRevision: '' }
})
const deslop = vi.fn()
const scan = vi.fn()
beforeEach(() => {
  handlers.clear(); deslop.mockReset(); scan.mockReset()
  scan.mockResolvedValue({ findings: [] })
  registerDeslopIpc({ deslop, scan } as unknown as DeslopService,
    { resolveDir: async () => { throw new Error('没有白名单') } } as unknown as ProjectService,
    {} as StyleProfileService, { getDeslopRules: async () => ({}) } as unknown as SettingsRepository)
})
async function run(): Promise<DeslopResult> {
  return await handlers.get('deslop:run')!({ sender: {} }, { projectId: 'project-1', text: original, requestId: 'manual-polish' }) as DeslopResult
}

describe('manual deslop candidate acceptance', () => {
  it('returns a failed-check candidate for the author instead of rejecting the IPC or altering the service result', async () => {
    const result = failed()
    deslop.mockResolvedValue(result)
    const returned = await run()
    expect(returned.rewritten).toBe(candidate)
    expect(returned.dialogueQuality?.passed).toBe(false)
    expect(returned.dialogueQuality?.issues).toEqual(result.dialogueQuality!.issues)
    expect(returned.dialogueQuality?.afterRatio).toBe(measureDialogue(candidate).ratio)
    expect(returned.afterWords).toBe(countWords(candidate))
    expect(returned.deleteRatio).toBe(1 - countWords(candidate) / countWords(original))
    expect(returned.semanticVerification).toBeUndefined()
    expect(returned.remainingFindings[0].type).toBe('dialogue-quality-incomplete')
    expect(scan).toHaveBeenCalledWith(candidate, expect.any(Object))
    expect(result.rewritten).toBe(original)
    expect(activeStreamCount()).toBe(0)
  })
  it('returns diagnostic results without throwing even if there is no changed candidate', async () => {
    const result = failed(); delete result.dialogueQuality!.pendingDraft
    deslop.mockResolvedValue(result)
    expect((await run()).rewritten).toBe(original)
    expect(scan).not.toHaveBeenCalled()
    expect(activeStreamCount()).toBe(0)
  })
  it('keeps accepted results intact and leaves cancellation or actual generation failures as failures', async () => {
    const result = { ...failed(), rewritten: candidate, dialogueQuality: { ...failed().dialogueQuality!, passed: true } }
    deslop.mockResolvedValueOnce(result)
    expect(await run()).toBe(result)
    expect(scan).not.toHaveBeenCalled()
    deslop.mockRejectedValueOnce(new Error('LLM_ABORTED'))
    await expect(run()).rejects.toThrow('LLM_ABORTED')
    expect(activeStreamCount()).toBe(0)
  })
})
