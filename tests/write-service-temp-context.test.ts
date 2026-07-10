import { describe, it, expect, vi } from 'vitest'
import { ProjectService } from '../src/main/data/project-service'
import { WriteService } from '../src/main/data/write-service'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { LibraryRepository } from '../src/main/data/library-repository'

function mockLlm(reply: string): LlmService {
  return { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
}
const mockSettings = { getProjectsRoot: async (fallback: string) => fallback } as unknown as SettingsRepository

describe('WriteService tempContext', () => {
  it('buildChapterPrompt supports tempContext injection', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aw-ws-tc-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    const ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    const projectId = (await ps.create({ name: '临时上下文项目', genre: '都市' })).id
    const service = new WriteService(ps, mockLlm('正文'))
    const prompt = await service.buildChapterPrompt(projectId, 1, null, '这是临时要求文本')
    expect(prompt.user).toContain('【本章临时写作要求（临时上下文）】')
    expect(prompt.user).toContain('这是临时要求文本')
  })

  it('tempContext is treated as highest priority and reiterated near output instruction', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aw-ws-tc-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    const ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    const projectId = (await ps.create({ name: '优先级项目', genre: '都市' })).id
    const service = new WriteService(ps, mockLlm('正文'))
    const prompt = await service.buildChapterPrompt(projectId, 1, null, '不要写跟第一章重复的东西')

    // 注入点带最高优先级声明，覆盖细纲与硬性写作要求
    expect(prompt.user).toContain('最高优先级')
    expect(prompt.user).toContain('覆盖本章细纲')
    // 最终输出指令段复述 tempContext，紧贴"现在请写"
    expect(prompt.user).toContain('再次强调')
    const reiterateIdx = prompt.user.indexOf('再次强调')
    const outputIdx = prompt.user.indexOf('现在请写第')
    expect(reiterateIdx).toBeGreaterThan(outputIdx)
    // 自检指令覆盖 tempContext（逐条落实）
    expect(prompt.user).toContain('逐条落实')
  })
})
