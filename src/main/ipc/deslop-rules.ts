import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import type { IpcMainInvokeEvent } from 'electron'
import { SettingsRepository } from '../data/settings-repository'
import { LlmService } from '../data/llm-service'
import { safeHandle } from './safe-handle'
import { validateInput } from './validation'
import type { DeslopRulesBundle } from '../../shared/types'
import {
  DESLOP_RULE_SECTIONS,
  serializeDeslopRulesToMd,
  buildDeslopRuleEditPrompt
} from '../data/skill-prompts/deslop/deslop-rules'
import {
  TOXIC_PATTERNS,
  PARALLELISM_PATTERNS,
  PSYCH_WORDS,
  FLATTENED_LEVEL1
} from '../data/deslop/banned-words'

const instructionSchema = z.string().min(1).max(2000)
const requestIdSchema = z.string().min(1)

/** 只读锁定区：正则/句式表（写错会让扫描崩溃，只展示不可编辑） */
function buildLockedSections(): DeslopRulesBundle['lockedSections'] {
  return [
    {
      key: 'toxicPatterns',
      title: '最毒句式表（锁定，正则匹配）',
      content: TOXIC_PATTERNS.map(
        (p) => `${'★'.repeat(p.stars)} ${p.name}\n  正则：${p.re.source}\n  修法：${p.fix}`
      ).join('\n')
    },
    {
      key: 'parallelismPatterns',
      title: '排比句式正则（锁定）',
      content: PARALLELISM_PATTERNS.map((re, i) => `${i + 1}. ${re.source}`).join('\n')
    },
    {
      key: 'psychWords',
      title: '心理词表（锁定，用于密度指标）',
      content: PSYCH_WORDS.join('、')
    }
  ]
}

export function registerDeslopRulesIpc(
  repo: SettingsRepository,
  llmService: LlmService
): void {
  /* 读取去 AI 味规则（可编辑分节 + 只读锁定区 + 当前覆盖 + 禁用词表） */
  safeHandle('deslop:getRules', async (): Promise<DeslopRulesBundle> => {
    const cfg = await repo.getDeslopRules()
    return {
      sections: DESLOP_RULE_SECTIONS.map((s) => ({
        key: s.key,
        title: s.title,
        defaultText: s.text
      })),
      lockedSections: buildLockedSections(),
      overrides: cfg.textOverrides ?? {},
      bannedWords: cfg.bannedWords ?? [...FLATTENED_LEVEL1]
    }
  })

  /* 保存去 AI 味规则（文本覆盖 + 禁用词表），保存后真正生效 */
  safeHandle(
    'deslop:setRules',
    async (
      _e: IpcMainInvokeEvent,
      payload: { textOverrides: Record<string, string>; bannedWords: string[] }
    ): Promise<DeslopRulesBundle> => {
      const validated = validateInput(
        z.object({
          textOverrides: z.record(z.string(), z.string().max(20000)),
          bannedWords: z.array(z.string().min(1).max(30)).max(500)
        }),
        payload
      )
      await repo.setDeslopRules({
        textOverrides: validated.textOverrides,
        bannedWords: validated.bannedWords
      })
      const cfg = await repo.getDeslopRules()
      return {
        sections: DESLOP_RULE_SECTIONS.map((s) => ({
          key: s.key,
          title: s.title,
          defaultText: s.text
        })),
        lockedSections: buildLockedSections(),
        overrides: cfg.textOverrides ?? {},
        bannedWords: cfg.bannedWords ?? [...FLATTENED_LEVEL1]
      }
    }
  )

  /* 用自然语言让 AI 改写去 AI 味规则（流式输出完整 Markdown） */
  ipcMain.handle(
    'deslop:editRulesStream',
    async (
      e,
      payload: { instruction: string; requestId: string }
    ): Promise<string> => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const validated = validateInput(
          z.object({ instruction: instructionSchema, requestId: requestIdSchema }),
          payload
        )
        // 读当前规则拼成 MD（含覆盖 + 禁用词），交给 AI 整体改写
        const cfg = await repo.getDeslopRules()
        const currentMd = serializeDeslopRulesToMd(
          cfg.textOverrides ?? {},
          cfg.bannedWords ?? [...FLATTENED_LEVEL1]
        )
        const prompt = buildDeslopRuleEditPrompt(currentMd, validated.instruction)
        const send = (token: string): void => {
          win?.webContents.send('deslopRules:token', {
            requestId: validated.requestId,
            token,
            done: false
          })
        }
        const output = await llmService.generateStream(prompt, {
          maxTokens: 8192,
          meta: { feature: 'deslop:editRules' },
          onToken: send
        })
        win?.webContents.send('deslopRules:token', {
          requestId: validated.requestId,
          token: '',
          done: true
        })
        return output
      } catch (err) {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
        win?.webContents.send('deslopRules:token', { requestId, token: '', done: true })
        throw err
      }
    }
  )
}
