import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsRepository } from '../src/main/data/settings-repository'

describe('中短篇保存位置与并发设置更新', () => {
  let directory: string
  let file: string
  let repo: SettingsRepository

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'aw-settings-story-storage-'))
    file = join(directory, 'settings.json')
    repo = new SettingsRepository(file)
  })

  afterEach(() => vi.restoreAllMocks())

  it('同文件的两个实例并发更新目录、主题与定价，不丢失字段', async () => {
    const alias = new SettingsRepository(`${directory}${sep}.${sep}settings.json`)
    const root = join(directory, '小说保存目录')
    await Promise.all([
      repo.update({ shortStoriesRoot: root }),
      alias.update({ theme: 'dark' }),
      repo.update({ pricing: { inputRate: 4 } }),
      alias.update({ pricing: { outputRate: 7 } })
    ])
    const restarted = new SettingsRepository(file)
    expect(await restarted.getShortStoriesRoot('默认目录')).toBe(root)
    expect(await restarted.get()).toMatchObject({
      shortStoriesRoot: root, theme: 'dark', pricing: { inputRate: 4, outputRate: 7 }
    })
  })

  it('未配置或空白保存位置返回 fallback，重启可读取新的位置', async () => {
    const fallback = join(directory, '默认目录')
    expect(await repo.getShortStoriesRoot(fallback)).toBe(fallback)
    await repo.update({ shortStoriesRoot: ' \t ' })
    expect(await new SettingsRepository(file).getShortStoriesRoot(fallback)).toBe(fallback)
    const root = join(directory, '新位置')
    await repo.update({ shortStoriesRoot: root })
    expect(await new SettingsRepository(file).getShortStoriesRoot(fallback)).toBe(root)
  })

  it('原子写入失败保留旧设置，后续更新仍可继续', async () => {
    const oldRoot = join(directory, '旧位置')
    await repo.update({ shortStoriesRoot: oldRoot, theme: 'light' })
    const bytes = await fs.readFile(file)
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('模拟磁盘提交失败'))
    await expect(repo.update({ shortStoriesRoot: join(directory, '新位置') })).rejects.toThrow('模拟磁盘提交失败')
    rename.mockRestore()
    expect(await fs.readFile(file)).toEqual(bytes)
    expect(await repo.getShortStoriesRoot('默认目录')).toBe(oldRoot)
    await repo.update({ theme: 'dark' })
    expect(await repo.get()).toMatchObject({ shortStoriesRoot: oldRoot, theme: 'dark' })
  })

  it('写成功后不再读盘，返回值仍按读取规则规范化', async () => {
    await repo.update({ theme: 'light' })
    const original = await repo.get()
    const read = vi.spyOn(repo, 'get').mockResolvedValueOnce(original).mockRejectedValueOnce(new Error('提交后的磁盘读取失败'))
    const root = join(directory, '已提交位置')
    const result = await repo.update({
      shortStoriesRoot: root, pricing: { outputRate: 9 }, autoMemorySync: false,
      deslopRules: { bannedWords: ['眼眸', '眼眸', '  '], textOverrides: { notAKey: '丢弃' } },
      chapterRuleOverrides: { dialogue: '自然对话', notAKey: '丢弃' },
      aiHighFreq: { enabled: false, words: [{ word: '词语' }] }
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      shortStoriesRoot: root, pricing: { inputRate: 1, outputRate: 9 },
      autoPostWritePipeline: 'off', autoMemorySync: false,
      deslopRules: { bannedWords: ['眼眸'] }, chapterRuleOverrides: { dialogue: '自然对话' },
      aiHighFreq: { enabled: true, words: [{ word: '词语' }] }
    })
    read.mockRestore()
    expect(await new SettingsRepository(file).get()).toEqual(result)
  })

  it('返回结果与落盘 JSON 一致，省略 undefined 后恢复默认字段', async () => {
    const result = await repo.update({ shortStoriesRoot: join(directory, '作品'), dailyWordGoal: undefined })
    expect(result.dailyWordGoal).toBe(3000)
    expect(await new SettingsRepository(file).get()).toEqual(result)
  })
})
