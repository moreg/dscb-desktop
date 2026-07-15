import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { DeslopService } from '../data/deslop/deslop-service'
import { ProjectService } from '../data/project-service'
import { StyleProfileService } from '../data/style-profile-service'
import { SettingsRepository } from '../data/settings-repository'
import {
  resolveDeslopTextOverrides,
  resolveDeslopBannedWords
} from '../data/skill-prompts/deslop/deslop-rules'
import { safeHandle } from './safe-handle'
import { validateInput, projectIdSchema } from './validation'
import { join } from 'path'
import type { DeslopStyleContext } from '../../shared/types'

const deslopTextSchema = z.string().min(1).max(500_000)
const levelSchema = z.enum(['mild', 'moderate', 'severe']).optional()
const wordListSchema = z.array(z.string().min(1).max(50)).max(2000)
const requestIdSchema = z.string().min(1)

export function registerDeslopIpc(
  deslopService: DeslopService,
  projectService: ProjectService,
  styleProfileService: StyleProfileService,
  settings: SettingsRepository
): void {
  /* 扫描正文（确定性，不调 LLM）—— 用户配置的禁用词表优先 */
  safeHandle(
    'deslop:scan',
    async (_e, payload: { projectId: string; text: string }) => {
      const validated = validateInput(
        z.object({ projectId: projectIdSchema, text: deslopTextSchema }),
        payload
      )
      const whitelist = await resolveWhitelist(projectService, validated.projectId)
      const deslopRules = await settings.getDeslopRules()
      const bannedWords = resolveDeslopBannedWords(deslopRules.bannedWords)
      return deslopService.scan(validated.text, { whitelist, bannedWords })
    }
  )

  /* 润色正文（流式） */
  ipcMain.handle(
    'deslop:run',
    async (
      e,
      payload: {
        projectId: string
        text: string
        levelOverride?: 'mild' | 'moderate' | 'severe'
        requestId: string
      }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const validated = validateInput(
          z.object({
            projectId: projectIdSchema,
            text: deslopTextSchema,
            levelOverride: levelSchema,
            requestId: requestIdSchema
          }),
          payload
        )
        const whitelist = await resolveWhitelist(projectService, validated.projectId)
        const styleContext = await resolveStyleContext(
          projectService,
          styleProfileService,
          validated.projectId
        )
        // 用户配置的禁用词表 + 文本规则覆盖优先（保存后真正生效）
        const deslopRules = await settings.getDeslopRules()
        const bannedWords = resolveDeslopBannedWords(deslopRules.bannedWords)
        const textOverrides = resolveDeslopTextOverrides(deslopRules.textOverrides ?? {})
        const send = (token: string): void => {
          win?.webContents.send('deslop:token', {
            requestId: validated.requestId,
            token,
            done: false
          })
        }
        const result = await deslopService.deslop(validated.text, {
          levelOverride: validated.levelOverride,
          onToken: send,
          whitelist,
          bannedWords,
          textOverrides,
          styleContext,
          meta: { projectId: validated.projectId }
        })
        win?.webContents.send('deslop:token', {
          requestId: validated.requestId,
          token: '',
          done: true
        })
        return result
      } catch (err) {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
        win?.webContents.send('deslop:token', { requestId, token: '', done: true })
        throw err
      }
    }
  )

  /* 读取项目级白名单 */
  safeHandle('deslop:getWhitelist', async (_e, projectId: string) => {
    const validated = validateInput(projectIdSchema, projectId)
    const dir = await projectService.resolveDir(validated)
    return DeslopService.readWhitelistFile(join(dir, '.deslop-whitelist'))
  })

  /* 写入项目级白名单 */
  safeHandle(
    'deslop:setWhitelist',
    async (_e, payload: { projectId: string; words: string[] }) => {
      const validated = validateInput(
        z.object({ projectId: projectIdSchema, words: wordListSchema }),
        payload
      )
      const dir = await projectService.resolveDir(validated.projectId)
      await DeslopService.writeWhitelistFile(join(dir, '.deslop-whitelist'), validated.words)
      return DeslopService.readWhitelistFile(join(dir, '.deslop-whitelist'))
    }
  )
}

/** 按 projectId 解析白名单（项目根的 .deslop-whitelist） */
async function resolveWhitelist(
  projectService: ProjectService,
  projectId: string
): Promise<Set<string> | undefined> {
  try {
    const dir = await projectService.resolveDir(projectId)
    const words = await DeslopService.readWhitelistFile(join(dir, '.deslop-whitelist'))
    return words.length > 0 ? new Set(words) : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析项目题材 + 默认文风档案，注入 deslop 改写提示词。
 * - genre：ProjectData.genre（默认"通用"），决定替换语感基调
 * - style：ProjectData.defaultStyleProfileId 指向的档案，可能不存在
 * 任何一步失败都不阻断改写（返回 undefined，按通则处理）。
 */
async function resolveStyleContext(
  projectService: ProjectService,
  styleProfileService: StyleProfileService,
  projectId: string
): Promise<DeslopStyleContext | undefined> {
  try {
    const project = await projectService.getProjectData(projectId)
    const profile = await styleProfileService.getById(projectId, project.defaultStyleProfileId ?? null)
    const genre = project.genre ?? '通用'
    if (!profile) return { genre }
    return {
      genre,
      style: {
        identifiedStyle: profile.identifiedStyle,
        tone: profile.tone,
        sentencePatterns: profile.sentencePatterns,
        vocabularyPreferences: profile.vocabularyPreferences,
        styleConstraints: profile.styleConstraints,
        plotConstraints: profile.plotConstraints
      }
    }
  } catch {
    return undefined
  }
}
