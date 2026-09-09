import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import {
  SettingsMdRepo,
  isPlaceholderSettingBody
} from '../src/main/data/skill-format/settings-md-repo'
import { SettingsWriter } from '../src/main/data/settings-writer'

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

  it('filters open-book placeholder 核心设定 / empty worldview shells', async () => {
    await writeFile(
      path.join(dir, '设定', '核心设定.md'),
      `# 核心设定\n\n## 基本信息\n- **书名**：民国老六\n- **题材**：历史\n\n## 核心设定\n\n（待完善）\n`
    )
    await writeFile(path.join(dir, '设定', '题材定位.md'), `# 题材定位\n`)
    await writeFile(path.join(dir, '设定', '世界观', '背景设定.md'), `# 背景设定\n`)
    await writeFile(path.join(dir, '设定', '世界观', '力量体系.md'), `# 力量体系\n`)

    const result = await new SettingsMdRepo(dir).read()
    expect(result).toBeNull()
  })

  it('keeps real 核心设定 content after user fills it', async () => {
    await writeFile(
      path.join(dir, '设定', '核心设定.md'),
      `# 核心设定\n\n## 金手指\n运势罗盘可看运势线，每次消耗精神力。\n`
    )
    const result = await new SettingsMdRepo(dir).read()
    expect(result).not.toBeNull()
    expect(result!.customRules.some((r) => r.name === '核心设定')).toBe(true)
    expect(result!.customRules[0].body).toContain('运势罗盘')
  })

  it('章节读取只包含更早自动补丁，保留作者基线；无参读取仍显示全部', async () => {
    await writeFile(path.join(dir, '设定', '世界观', '金手指.md'), WORLDVIEW_JINSHOUZHI)
    const writer = new SettingsWriter(dir)
    await writer.applyPatches(3, [{ target: 'worldview', fileName: '金手指', op: 'append_bullet', sectionTitle: '限制', title: '冷却', content: '已经确认每次启动后要等待一炷香。' }])
    await writer.applyPatches(12, [
      { target: 'worldview', fileName: '金手指', op: 'append_h2', title: '未来能力解锁', content: '现在能够隔空移动整座仓库。' },
      { target: 'faction', fileName: '新势力', op: 'append_h2', title: '未来同盟', content: '海上各派已向主角归附。' },
      { target: 'customRule', fileName: '契约', op: 'append_bullet', title: '未来契约', content: '全员能够共享主角的视野。' },
      { target: 'relation', fileName: '关系', op: 'append_h2', title: '未来关系', content: '两家已经通过联姻结盟。' }
    ])
    const repo = new SettingsMdRepo(dir)
    const sameChapter = await repo.read(3)
    expect(sameChapter!.worldview[0].body).toContain('每次使用消耗精神力')
    expect(sameChapter!.worldview[0].body).not.toContain('一炷香')
    const priorOnly = await repo.read(12)
    expect(priorOnly!.worldview[0].body).toContain('一炷香')
    expect(JSON.stringify(priorOnly)).not.toContain('未来')
    expect(priorOnly!.factions).toEqual([])
    expect(priorOnly!.customRules).toEqual([])
    const after = await repo.read(13)
    expect(JSON.stringify(after)).toContain('隔空移动整座仓库')
    expect(JSON.stringify(after)).toContain('通过联姻结盟')
    expect(await repo.read()).toEqual(after)
    expect(JSON.stringify(after)).not.toContain('aw-settings-patch')
  })

  it('未记录章节的旧内容保持作者基线，不从文字里的未来章号猜删', async () => {
    const baseline = '# 力量体系\n\n## 作者规划\n预计第十二章揭晓暗劲，旧补丁无法确知来源。\n'
    await writeFile(path.join(dir, '设定', '世界观', '力量体系.md'), baseline)
    expect((await new SettingsMdRepo(dir).read(2))!.worldview[0].body).toContain('预计第十二章揭晓暗劲')
  })

  it('按地理表出现章节过滤同章和未来地点，保留无章号行与其他表格', async () => {
    await writeFile(path.join(dir, '设定', '世界观', '地理.md'), '# 地理\n\n| 地点 | 说明 | 出现章节 |\n|---|---|---|\n| 作者故乡 | 开书基线 | 未注明 |\n| 码头 | 已经到过 | 第 3 章 |\n| 孤岛 | 本章首次出现 | 第 5 章 |\n| 京城 | 未来出现 | 第 12 章 |\n\n## 距离\n| 地点 | 说明 |\n|---|---|\n| 作者故乡 | 距海岸十二里 |\n')
    const body = (await new SettingsMdRepo(dir).read(5))!.worldview[0].body
    expect(body).toContain('作者故乡')
    expect(body).toContain('码头')
    expect(body).not.toContain('孤岛')
    expect(body).not.toContain('京城')
    expect(body).toContain('距海岸十二里')
    expect((await new SettingsMdRepo(dir).read())!.worldview[0].body).toContain('京城')
  })
})

describe('isPlaceholderSettingBody', () => {
  it('detects empty and 待完善', () => {
    expect(isPlaceholderSettingBody('')).toBe(true)
    expect(isPlaceholderSettingBody('# 标题\n\n（待完善）\n')).toBe(true)
    expect(isPlaceholderSettingBody('明劲→暗劲→化劲')).toBe(false)
  })
})
