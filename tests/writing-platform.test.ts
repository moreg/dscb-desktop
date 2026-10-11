import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseWritingPlatformConfig, readWritingPlatformConfig } from '../src/main/data/writing-platform'
import { buildSystemPrompt } from '../src/main/data/skill-prompts'

describe('writing platform config', () => {
  it.each(['七猫', '7猫', '七猫小说', '七猫中文网', 'qimao'])('recognizes %s', (name) => {
    expect(parseWritingPlatformConfig(`- **目标平台**：${name}`).platform).toBe('qimao')
  })
  it.each(['番茄', '番茄小说', 'fanqie'])('recognizes %s', (name) => {
    expect(parseWritingPlatformConfig(`目标平台: ${name}`).platform).toBe('fanqie')
  })
  it('supports tables and bare platform names', () => {
    expect(parseWritingPlatformConfig('| 平台 | 7猫 |').platform).toBe('qimao')
    expect(parseWritingPlatformConfig('# 平台配置\n\n七猫小说').platform).toBe('qimao')
  })
  it('uses the explicit field instead of platform comparisons elsewhere', () => {
    expect(parseWritingPlatformConfig('- 目标平台：七猫\n番茄项目采用短快章名').platform).toBe('qimao')
    expect(parseWritingPlatformConfig('- 目标平台：番茄\n七猫建议仅供参考').platform).toBe('fanqie')
    expect(parseWritingPlatformConfig('- 目标平台：待定\n七猫').platform).toBeNull()
    expect(parseWritingPlatformConfig('目标平台：七猫 / 番茄').platform).toBeNull()
  })
  it('defaults missing config to Tomato and keeps continuation rules last', () => {
    expect(buildSystemPrompt()).toContain('你是番茄小说风格')
    const config = parseWritingPlatformConfig('目标平台：七猫\n章名策略：清楚具体')
    for (const mode of ['extend', 'finish'] as const) {
      const prompt = buildSystemPrompt('玄幻', null, undefined, null, mode, config)
      expect(prompt).toContain('你是七猫小说')
      expect(prompt).not.toContain('你是番茄小说风格')
      expect(prompt).toContain('章名策略：清楚具体')
      expect(prompt.indexOf('续写模式覆盖声明（最高优先级）')).toBeGreaterThan(prompt.indexOf('项目平台配置（来源'))
    }
  })
  let dir: string | undefined
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
  it('reads edits on each request and returns null for missing or empty files', async () => {
    dir = await mkdtemp(join(tmpdir(), 'writing-platform-'))
    expect(await readWritingPlatformConfig(dir)).toBeNull()
    await mkdir(join(dir, '设定'))
    const file = join(dir, '设定', '平台配置.md')
    await writeFile(file, '目标平台：7猫', 'utf-8')
    expect((await readWritingPlatformConfig(dir))?.platform).toBe('qimao')
    await writeFile(file, '目标平台：番茄', 'utf-8')
    expect((await readWritingPlatformConfig(dir))?.platform).toBe('fanqie')
    await writeFile(file, '  ', 'utf-8')
    expect(await readWritingPlatformConfig(dir)).toBeNull()
  })
})
