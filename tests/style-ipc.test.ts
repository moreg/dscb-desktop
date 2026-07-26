import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { StyleProfile } from '../src/shared/types'
import { makeStyleInput } from './helpers/style-fixtures'

/** 模拟 ipcMain.handle 注册的 handler 池 */
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }
  },
  dialog: {},
  BrowserWindow: { fromWebContents: () => null }
}))

const { LibraryRepository } = await import('../src/main/data/library-repository')
const { ProjectService } = await import('../src/main/data/project-service')
const { StyleProfileService } = await import('../src/main/data/style-profile-service')
const { registerStyleIpc } = await import('../src/main/ipc/styles')

const mockSettings = {
  getProjectsRoot: async (fallback: string) => fallback
} as unknown as SettingsRepository

function mockLlm(reply: string): LlmService {
  return { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
}

const VALID_EXTRACT_JSON = JSON.stringify({
  identifiedStyle: '冷峻都市',
  sentencePatterns: ['短句推进'],
  vocabularyPreferences: [],
  punctuationAndRhythm: [],
  narrativePerspective: [],
  tone: [],
  narrativeTemplates: [],
  styleConstraints: ['保持现实质感'],
  characterConstraints: [],
  plotConstraints: [],
  stylePrompt: '保持冷峻都市感。'
})

describe('registerStyleIpc（文风库全局资产，增删改查不接受 projectId）', () => {
  let projectId: string
  let projectService: InstanceType<typeof ProjectService>

  beforeEach(async () => {
    handlers.clear()
    const root = await mkdtemp(path.join(tmpdir(), 'aw-style-ipc-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    projectService = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await projectService.create({ name: '文风测试', genre: '都市' })).id
    const styleService = new StyleProfileService(
      projectService,
      mockLlm(VALID_EXTRACT_JSON),
      path.join(root, 'styles.json')
    )
    registerStyleIpc(styleService, projectService)
  })

  it('styles:list 无需任何参数（全局导航进入文风库时没有项目上下文）', async () => {
    const list = handlers.get('styles:list')!
    expect((await list(null)) as StyleProfile[]).toEqual([])
  })

  it('styles:create/list/delete 全流程可用', async () => {
    const create = handlers.get('styles:create')!
    const list = handlers.get('styles:list')!
    const del = handlers.get('styles:delete')!

    const created = (await create(null, { input: makeStyleInput('全局文风卡') })) as StyleProfile
    expect(created.id).toBeTruthy()
    expect(((await list(null)) as StyleProfile[]).map((i) => i.id)).toEqual([created.id])

    await del(null, { styleProfileId: created.id })
    expect((await list(null)) as StyleProfile[]).toEqual([])
  })

  it('styles:update 按 id 改名', async () => {
    const create = handlers.get('styles:create')!
    const update = handlers.get('styles:update')!
    const created = (await create(null, { input: makeStyleInput('待改名') })) as StyleProfile
    const updated = (await update(null, {
      styleProfileId: created.id,
      patch: { name: '已改名' }
    })) as StyleProfile
    expect(updated.name).toBe('已改名')
  })

  it('styles:extract 的 projectId 可省略（回退到"文风库"项目名）', async () => {
    const extract = handlers.get('styles:extract')!
    const result = (await extract(null, { sampleText: 'a'.repeat(500) })) as {
      identifiedStyle: string
    }
    expect(result.identifiedStyle).toBe('冷峻都市')
  })

  it('styles:extract 传了 projectId 就必须是真实值', async () => {
    const extract = handlers.get('styles:extract')!
    await expect(
      extract(null, { projectId: '', sampleText: 'a'.repeat(500) })
    ).rejects.toThrow(/IPC_INPUT_INVALID/)
  })

  it('删除文风时清理项目残留的默认引用', async () => {
    const create = handlers.get('styles:create')!
    const del = handlers.get('styles:delete')!
    const setDefault = handlers.get('projects:setDefaultStyleProfile')!

    const created = (await create(null, {
      input: makeStyleInput('会被删掉的默认风')
    })) as StyleProfile
    await setDefault(null, { projectId, styleProfileId: created.id })

    await del(null, { styleProfileId: created.id })

    const data = await projectService.getProjectData(projectId)
    expect(data.defaultStyleProfileId).toBeUndefined()
  })

  it('projects:setDefaultStyleProfile 仍要求真实 projectId', async () => {
    const setDefault = handlers.get('projects:setDefaultStyleProfile')!
    await expect(
      setDefault(null, { projectId: '', styleProfileId: null })
    ).rejects.toThrow(/IPC_INPUT_INVALID/)
  })
})
