import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { SettingsRepository } from '../src/main/data/settings-repository'
import { GATE_METHODS } from '../src/main/data/skill-prompts/deslop/anti-ai-methods'
import { DEFAULT_DESLOP_BANNED_WORDS } from '../src/main/data/skill-prompts/deslop/deslop-rules'

describe('SettingsRepository deslop rules', () => {
  let repo: SettingsRepository

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-sdr-'))
    repo = new SettingsRepository(path.join(dir, 'settings.json'))
  })

  it('未配置时返回空对象（全用内置默认）', async () => {
    const cfg = await repo.getDeslopRules()
    expect(cfg.textOverrides).toBeUndefined()
    expect(cfg.bannedWords).toBeUndefined()
  })

  it('持久化白名单 key，剔除未知 key', async () => {
    const saved = await repo.setDeslopRules({
      textOverrides: {
        gateB: '【自定义 Gate B】',
        notARealKey: '应被剔除'
      },
      bannedWords: ['眼眸', '凝视', '眼眸']
    })
    expect(saved.textOverrides).toEqual({ gateB: '【自定义 Gate B】' })
    expect(saved.bannedWords).toEqual(['眼眸', '凝视'])
    expect(await repo.getDeslopRules()).toEqual(saved)
  })

  it('禁用词表与内置默认等价时 prune（不存储，回落默认）', async () => {
    // 用默认词表的乱序副本 + 重复项（清洗后应等价于默认 → prune）
    const shuffled = [...DEFAULT_DESLOP_BANNED_WORDS].reverse().concat([DEFAULT_DESLOP_BANNED_WORDS[0]])
    const saved = await repo.setDeslopRules({ textOverrides: {}, bannedWords: shuffled })
    expect(saved.bannedWords).toBeUndefined()
    expect(saved.textOverrides).toBeUndefined()
  })

  it('禁用词表与默认不同时保留', async () => {
    const saved = await repo.setDeslopRules({
      textOverrides: {},
      bannedWords: [...DEFAULT_DESLOP_BANNED_WORDS, '眼眸']
    })
    expect(saved.bannedWords).toContain('眼眸')
    expect(saved.bannedWords!.length).toBe(DEFAULT_DESLOP_BANNED_WORDS.length + 1)
  })

  it('禁用词表为空数组时保留（用户显式清空扫描）', async () => {
    const saved = await repo.setDeslopRules({ textOverrides: {}, bannedWords: [] })
    expect(saved.bannedWords).toEqual([])
  })

  it('textOverrides 与默认文本相同的 key 不 prune（保留显式覆盖，即便内容等于默认）', async () => {
    // 注意：textOverrides 的 prune 在 resolveDeslopTextOverrides 层做（与默认相同则不生效），
    // 存储层保留原样以区分"未配置"与"配置了等于默认"——这是与续写规则一致的设计。
    const saved = await repo.setDeslopRules({
      textOverrides: { gateA: GATE_METHODS.A }, // 内容等于默认
      bannedWords: ['眼眸']
    })
    expect(saved.textOverrides).toEqual({ gateA: GATE_METHODS.A })
  })

  it('sanitize 非法值：textOverrides 非对象、bannedWords 含非字符串', async () => {
    const saved = await repo.setDeslopRules({
      textOverrides: 'not-an-object' as unknown as Record<string, string>,
      bannedWords: ['合法词', 123, '', '  ', null] as unknown as string[]
    })
    expect(saved.textOverrides).toBeUndefined()
    expect(saved.bannedWords).toEqual(['合法词'])
  })

  it('限长：单词 ≤30 字、总数 ≤500', async () => {
    const longWord = '啊'.repeat(50)
    const manyWords = Array.from({ length: 600 }, (_, i) => `词${i}`)
    const saved = await repo.setDeslopRules({
      textOverrides: {},
      bannedWords: [longWord, ...manyWords]
    })
    expect(saved.bannedWords!.length).toBeLessThanOrEqual(500)
    expect(saved.bannedWords![0]).toBe('啊'.repeat(30)) // 截断到 30 字
  })

  it('update 合并：deslopRules 与其它字段共存', async () => {
    await repo.update({ deslopRules: { bannedWords: ['眼眸'] }, theme: 'dark' })
    const settings = await repo.get()
    expect(settings.theme).toBe('dark')
    expect(settings.deslopRules?.bannedWords).toEqual(['眼眸'])
  })
})
