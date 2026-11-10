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

  it('临时要求在操作边界内优先，只注入一次并放在输出任务之后', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aw-ws-tc-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    const ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    const projectId = (await ps.create({ name: '优先级项目', genre: '都市' })).id
    const service = new WriteService(ps, mockLlm('正文'))
    const instruction = '不要写跟第一章重复的东西'
    const prompt = await service.buildChapterPrompt(projectId, 1, null, instruction, '沈遥停在窗边。')

    // 注入点带最高优先级声明，覆盖细纲与硬性写作要求
    expect(prompt.user).toContain('最高优先级')
    expect(prompt.user).toContain('明确调整处覆盖本章细纲')
    expect(prompt.user.split(instruction)).toHaveLength(2)
    const instructionIdx = prompt.user.indexOf(instruction)
    const outputIdx = prompt.user.indexOf('现在请写第')
    expect(instructionIdx).toBeGreaterThan(outputIdx)
    expect(prompt.user).toContain('只输出新写的后续正文')
    expect(prompt.user).not.toContain('逐条落实')
  })
})
