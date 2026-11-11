import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWritingProject } from './helpers/writing-project'
import { withPassingLongformGuard } from './helpers/passing-longform'
import { LibraryRepository } from '../src/main/data/library-repository'
import { OutlineRepository } from '../src/main/data/outline-repository'
import { ProjectService } from '../src/main/data/project-service'
import { SettingsRepository } from '../src/main/data/settings-repository'
import { WriteService } from '../src/main/data/write-service'
import type { GenerateOptions, LlmService } from '../src/main/data/llm-service'

const firstPoint = '雨水堵住排水槽，林舟只得从回廊绕过去。'
const secondPoint = '林舟用铜匙打开柜门，取出借阅簿并核对落款。'
const consequence = '落款早于换锁，林舟决定先查旧钥匙的去向。'
const ban = '柜门开启前禁止揭晓借阅者的身份。'
const instruction = '本轮不加围观者。'
const authorRule = '叙述始终贴近眼前人物。'
const existingText = '雨沿着檐角往下滴。林舟站在回廊尽头，手里捏着铜匙。'

describe('细纲文件到正文模型请求', () => {
  let root: string
  let dir: string
  let id: string
  let service: WriteService
  const generate = vi.fn<(user: string, options?: GenerateOptions) => Promise<string>>()

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'outline-prompt-'))
    await mkdir(join(root, 'config'))
    const settings = new SettingsRepository(join(root, 'config', 'settings.json'))
    await settings.update({ chapterRuleOverrides: { negative: authorRule } })
    const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
    const project = await createWritingProject(projects, { name: '回廊', genre: '悬疑' })
    dir = project.path
    id = project.id
    generate.mockReset().mockImplementation(async (_user, options) =>
      options?.meta?.feature === 'chapter' ? '铜匙转了一圈，柜门开了。' : '[]')
    service = new WriteService(projects, withPassingLongformGuard({ generateStream: generate } as unknown as LlmService),
      undefined, undefined, undefined, settings)
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  async function sentPrompt(prefix?: string) {
    await service.generateChapterStream(id, 1, { existingText: prefix, tempContext: instruction, autoDeslopAfterContinue: false })
    const requests = generate.mock.calls.filter(([, options]) => options?.meta?.feature === 'chapter')
    expect(requests).toHaveLength(1)
    const [user, options] = requests[0]
    expect(options?.systemPrompt).toContain(authorRule)
    expect(user).toContain(instruction)
    expect(user).toContain('落笔核对')
    return { system: options?.systemPrompt ?? '', user }
  }

  it.each([['新章', undefined], ['章内续写', existingText]])('%s保留节点正文、因果和作者要求，重复摘要改用引用', async (_mode, prefix) => {
    const file = join(dir, '细纲', '细纲_第001章_回廊.md')
    const outline = [
      '# 细纲', '## 第 1 章：回廊', '- **核心事件**：见情节点2',
      '- **本章写作要求**：保留钥匙上的缺口。', '- **写作要求**：保留柜门合页声。',
      '- **自定义补充要求**：只在当事人转身后写脚步声。',
      '## 内容概括（五段式）',
      `- **发展**：${secondPoint}（见情节点 2）`,
      `- **起因**：${firstPoint}`,
      '## 情节安排（多线）', `- **逻辑线**：${consequence}`,
      '## 人物关系和出场顺序', '- **视角 / 信息差**：陆青只听到开门声，尚不知道簿上落款。',
      '## 情节细化', '### 情节点序列',
      `1. ${firstPoint}【铺垫·疏，约 100 字】`,
      `2. ${secondPoint}【转折·密，约 200 字】`,
      '   柜门卡住时，林舟须先托起门板才能转动铜匙。',
      '## 写作禁区', `1. ${ban}`
    ].join('\n')
    await writeFile(file, outline)

    const { system, user } = await sentPrompt(prefix)
    expect(system).toContain('顺序铁律')
    expect(user).toContain('核心事件：参见下方情节点 2。')
    expect(user).toContain('发展：参见下方情节点 2。')
    expect(user).toContain('起因：参见下方情节点 1。')
    expect(user).not.toContain('细纲引用待核对')
    expect(user).toContain(`2. ${secondPoint}【转折·密，约 200 字】`)
    for (const text of [firstPoint, secondPoint, consequence, ban, instruction, '保留钥匙上的缺口。',
      '保留柜门合页声。', '只在当事人转身后写脚步声。', '陆青只听到开门声，尚不知道簿上落款。',
      '柜门卡住时，林舟须先托起门板才能转动铜匙。']) {
      expect((system + user).split(text)).toHaveLength(2)
    }
    if (prefix) {
      expect(user).toContain(prefix)
      expect(user).toContain('只输出新写的后续正文')
    } else {
      expect(user).not.toContain('本章已写正文前部')
    }
    expect(await readFile(file, 'utf8')).toBe(outline)
  })

  it('旧卷细纲无编号时保留段落及附加信息，兼容旧 JSON 回退', async () => {
    await writeFile(join(dir, '细纲', '第01卷.md'), [
      '# 第 1 卷', '## 第 1 章：回廊', `- **核心事件**：${secondPoint}`,
      '### 情节安排', secondPoint, consequence, '### 写作禁区', ban
    ].join('\n'))
    const { user } = await sentPrompt()
    expect(user).toContain(`核心事件：${secondPoint}`)
    expect(user).toContain(`情节安排：\n  ${secondPoint}\n  ${consequence}`)
    expect(user).toContain(ban)
    expect(user).not.toContain('参见下方情节点')

    await rm(join(dir, '细纲', '第01卷.md'))
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 1, plotSummary: secondPoint, writingRequirements: ban })
    generate.mockClear()
    const legacy = await sentPrompt()
    expect(legacy.user).toContain(`核心事件：${secondPoint}`)
    expect(legacy.user).toContain(ban)
  })

  it('缺号、重号和含独立信息的摘要均保留原文', async () => {
    const extraSummary = `${firstPoint} 陆青仍留在门外。（见情节点 1）`
    await writeFile(join(dir, '细纲', '细纲_第001章_回廊.md'), [
      '# 细纲', '## 第 1 章：回廊', '- **核心事件**：见情节点2',
      '## 内容概括（五段式）', '- **发展**：见情节点3', `- **起因**：${extraSummary}`,
      '- **转折**：见情节点 1 或 3',
      '## 情节细化', '### 情节点序列',
      `1. ${firstPoint}`, '   2. 查看门缝的子步骤。', `3. ${secondPoint}`, '3. 柜门又合上了。',
      '## 写作禁区', ban
    ].join('\n'))

    const { user } = await sentPrompt()
    expect(user).toContain('核心事件：见情节点2')
    expect(user).toContain('发展：见情节点3')
    expect(user).toContain(`起因：${extraSummary}`)
    expect(user).toContain('转折：见情节点 1 或 3')
    expect(user).toContain('情节点 2（未找到可确认的编号）')
    expect(user).toContain('情节点 3（编号不唯一或正文不明确）')
    expect(user).toContain(`3. ${secondPoint}`)
    expect(user).toContain('3. 柜门又合上了。')
    expect(user).toContain(ban)
  })
})
