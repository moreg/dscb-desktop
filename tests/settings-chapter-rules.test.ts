import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { SettingsRepository } from '../src/main/data/settings-repository'
import legacyFragments from './fixtures/legacy-dialogue-fragments.json'
import { buildSystemPrompt } from '../src/main/data/skill-prompts'

describe('SettingsRepository chapter rule overrides', () => {
  let repo: SettingsRepository

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-scr-'))
    repo = new SettingsRepository(path.join(dir, 'settings.json'))
  })

  it('returns empty object when unset (= 全用内置默认)', async () => {
    expect(await repo.getChapterRuleOverrides()).toEqual({})
  })

  it('persists whitelisted keys and drops unknown keys', async () => {
    const saved = await repo.setChapterRuleOverrides({
      dialogue: '【自定义】只许说真话。',
      ending: '', // 空串=停用，应保留
      notARealKey: '应被剔除'
    } as Record<string, string>)

    expect(saved).toEqual({
      dialogue: '【自定义】只许说真话。',
      ending: ''
    })
    expect(await repo.getChapterRuleOverrides()).toEqual(saved)
  })

  it('sanitizes non-object / malformed payloads to empty on read', async () => {
    await repo.update({ chapterRuleOverrides: 'not-an-object' as unknown as Record<string, string> })
    expect(await repo.getChapterRuleOverrides()).toEqual({})
  })
})


describe('saved legacy dialogue rules at prompt time', () => {
  it('retires stock recipes while keeping custom lines and saved settings unchanged', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-dialogue-upgrade-'))
    const file = path.join(dir, 'settings.json')
    const repo = new SettingsRepository(file)
    const legacy = [
      '【真人对话特征（按需选用，不强制每段都体现）】',
      '可选特征：',
      '- 会跑题："那个，我本来想说……算了，你吃饭了没？"',
      '- 会自相矛盾："你这人挺讨厌的——呃，也不是讨厌，就是……"',
      '- 会用错词/口误："我们去……不对，等等，让我先想想。"',
      '- 会有口癖/口头禅："啧，这事儿不好办。"',
      '- 自定义：沿用本书既定的方言分寸',
      '【我的对白要求】',
      '保留角色已有粗口，不新增口头禅'
    ].join('\n')
    await repo.setChapterRuleOverrides({ dialogue: legacy, ending: '【自定义章末】以当前事件结束' })
    const before = await readFile(file, 'utf8')
    const prompt = buildSystemPrompt('都市', null, await repo.getChapterRuleOverrides())
    expect(prompt).not.toContain('那个，我本来想说……算了，你吃饭了没？')
    expect(prompt).not.toContain('我们去……不对，等等，让我先想想。')
    expect(prompt).toContain('不是需要逐项植入的真人标志')
    expect(prompt).toContain('自定义：沿用本书既定的方言分寸')
    expect(prompt).toContain('保留角色已有粗口，不新增口头禅')
    expect(prompt).toContain('【自定义章末】以当前事件结束')
    expect(prompt).toContain('自检要求不进入故事')
    expect(prompt).toContain('整章对话占比目标 70%')
    expect(await readFile(file, 'utf8')).toBe(before)
    expect((await repo.getChapterRuleOverrides()).dialogue).toBe(legacy)
  })

  it.each(['\n', '\r\n'])('兼容旧默认包的所有冲突片段，保留未知自定义和配置原字节：%j', async newline => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-legacy-fragments-'))
    const file = path.join(dir, 'settings.json')
    const repo = new SettingsRepository(file)
    const legacy = ['【真人对话特征（按需选用，不强制每段都体现）】',
      '- 会跑题："那个，我本来想说……算了，你吃饭了没？"',
      '- 会自相矛盾："你这人挺讨厌的——呃，也不是讨厌，就是……"',
      '- 会用错词/口误："我们去……不对，等等，让我先想想。"',
      '- 自定义：保留本书已有方言', '【对话核心要求】', legacyFragments.old4, legacyFragments.old8,
      legacyFragments.oldAllow, legacyFragments.legacySentences, '作者自定义：这句不能丢'
    ].join('\n').replace(/\n/g, newline)
    await repo.setChapterRuleOverrides({ dialogue: legacy })
    const before = await readFile(file, 'utf8')
    const prompt = buildSystemPrompt('都市', null, await repo.getChapterRuleOverrides())
    expect(prompt).not.toContain(legacyFragments.old4)
    expect(prompt).not.toContain(legacyFragments.old8)
    expect(prompt).not.toContain(legacyFragments.oldAllow)
    expect(prompt).not.toContain('句号只保留在整段台词最末尾')
    expect(prompt).toContain('普通的“好”“嗯”和直接回答按语境保留')
    expect(prompt).toContain('不把造梗、跑题或自相矛盾作为互动任务')
    expect(prompt).toContain('包括闭合引号前')
    expect(prompt).toContain('自定义：保留本书已有方言')
    expect(prompt).toContain('作者自定义：这句不能丢')
    expect(prompt).toContain('整章对话占比目标 70%')
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('leaves custom-only text and disabled sections intact', () => {
    const custom = '【真人对话特征（按需选用，不强制每段都体现）】\n保留角色已有方言，少用感叹号'
    expect(buildSystemPrompt('都市', null, { dialogue: custom })).toContain(custom)
    expect(buildSystemPrompt('都市', null, { dialogue: '' })).not.toContain('## 9. 对话规则')
    expect(buildSystemPrompt('都市', null, { dialogue: '' })).not.toContain('不是需要逐项植入的真人标志')
  })
})
