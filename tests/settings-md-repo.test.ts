import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { SettingsMdRepo } from '../src/main/data/skill-format/settings-md-repo'

const GENRE_POSITIONING = `# 题材定位

## 核心梗
民国乱世，重生武术传奇苏九凭【运势罗盘】在天津卫摆摊算命。

## 主角人设
- **姓名**：苏九
- **金手指**：【运势罗盘】
`

const WORLDVIEW_JINSHOUZHI = `# 金手指

## 形态
【运势罗盘】——一枚古铜色罗盘，可看到任何人的"运势线"。

## 限制
- 每次使用消耗精神力
- 调整幅度只能 1-2 级
`

const WORLDVIEW_LILIANGTIXI = `# 力量体系

## 武术等级
明劲 → 暗劲 → 化劲 → 见神不坏
`

const FACTION_QINGBANG = `# 青帮

## 核心成员
| 姓名 | 身份 |
|------|------|
| 段老虎 | 天津分堂堂主 |
`

const FACTION_RIBEN = `# 日本特务机关

## 核心成员
| 姓名 | 身份 |
|------|------|
| 山本一夫 | 特务头子 |
`

const CUSTOM_RULE = `# 罗盘指认功能规则

## 判定规则
- 转到底+稳定 = 大势力亲自出现
- 转一半就停 = 残余势力暗中观察
`

describe('SettingsMdRepo', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-settings-'))
    await mkdir(path.join(dir, '设定'), { recursive: true })
    await mkdir(path.join(dir, '设定', '世界观'), { recursive: true })
    await mkdir(path.join(dir, '设定', '势力'), { recursive: true })
  })

  it('returns null when 设定/ directory does not exist', async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), 'aw-settings-empty-'))
    const result = await new SettingsMdRepo(emptyDir).read()
    expect(result).toBeNull()
  })

  it('reads genre positioning, worldview, factions, custom rules', async () => {
    await writeFile(path.join(dir, '设定', '题材定位.md'), GENRE_POSITIONING)
    await writeFile(path.join(dir, '设定', '世界观', '金手指.md'), WORLDVIEW_JINSHOUZHI)
    await writeFile(path.join(dir, '设定', '世界观', '力量体系.md'), WORLDVIEW_LILIANGTIXI)
    await writeFile(path.join(dir, '设定', '势力', '青帮.md'), FACTION_QINGBANG)
    await writeFile(path.join(dir, '设定', '势力', '日本特务机关.md'), FACTION_RIBEN)
    await writeFile(path.join(dir, '设定', '罗盘指认功能规则.md'), CUSTOM_RULE)

    const result = await new SettingsMdRepo(dir).read()
    expect(result).not.toBeNull()
    expect(result!.genrePositioning).toContain('运势罗盘')
    expect(result!.genrePositioning).toContain('苏九')

    expect(result!.worldview).toHaveLength(2)
    expect(result!.worldview[0].name).toBe('力量体系')
    expect(result!.worldview[1].name).toBe('金手指')
    expect(result!.worldview[1].body).toContain('运势罗盘')

    expect(result!.factions).toHaveLength(2)
    expect(result!.factions[0].name).toBe('日本特务机关')
    expect(result!.factions[1].name).toBe('青帮')

    expect(result!.customRules).toHaveLength(1)
    expect(result!.customRules[0].name).toBe('罗盘指认功能规则')
    expect(result!.customRules[0].body).toContain('转一半就停')
  })

  it('handles partial settings (only genre positioning)', async () => {
    await writeFile(path.join(dir, '设定', '题材定位.md'), GENRE_POSITIONING)
    const result = await new SettingsMdRepo(dir).read()
    expect(result).not.toBeNull()
    expect(result!.genrePositioning).toContain('运势罗盘')
    expect(result!.worldview).toEqual([])
    expect(result!.factions).toEqual([])
    expect(result!.customRules).toEqual([])
  })

  it('returns null when all settings files are empty', async () => {
    // 设定/ 目录存在但无任何 .md 文件
    const result = await new SettingsMdRepo(dir).read()
    expect(result).toBeNull()
  })
})
