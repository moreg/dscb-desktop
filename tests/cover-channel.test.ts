import { describe, expect, it } from 'vitest'
import { applyCoverChannelToCharacter, resolveCoverChannelComposition, withCoverChannel } from '../src/main/data/cover-channel'
import { withVisualDirection } from '../src/main/data/cover-visual-direction'
import { buildCoverPrompt, patchCoverPromptTypography } from '../src/main/data/skill-prompts/cover/cover-styles'

const base = { bookName: '女将军和男人城', authorName: '少年她', platform: 'fanqie' as const,
  genre: 'xianxia' as const, composition: 'closeup' as const }

describe('明确封面主体频道', () => {
  it('未选频道严格保留普通提示词的正文、空行和尾换行', () => {
    const prompt = 'Title text 女主\n\n画一个女将军，她拿着剑。\n'
    expect(withCoverChannel(prompt)).toBe(prompt)
    expect(resolveCoverChannelComposition('scene')).toBe('scene')
  })

  it.each(['male', 'female'] as const)('%s 仅转换相反性别，保留故事人物的年龄、残疾、服饰与道具', (channel) => {
    const description = channel === 'male'
      ? 'a sixty-year-old one-armed woman in weathered bronze armor, her grey hair braided, holding a broken blade'
      : 'a sixty-year-old one-armed man in weathered bronze armor, his grey hair braided, holding a broken blade'
    const normalized = applyCoverChannelToCharacter(description, channel)
    expect(normalized).toContain(channel === 'male' ? 'one-armed man' : 'one-armed woman')
    for (const detail of ['sixty-year-old', 'weathered bronze armor', 'grey hair braided', 'broken blade']) expect(normalized).toContain(detail)
  })

  it('女频仙侠将默认男剑客改为女剑客，保持年龄和服饰', () => {
    const prompt = withCoverChannel('主体人物：一位年轻男剑客，穿飘逸的白色丝袍，黑色长发束髻并戴玉冠。', 'female')
    expect(prompt).toContain('一位年轻女剑客')
    expect(prompt).not.toContain('年轻男剑客')
    expect(prompt).toContain('飘逸的白色丝袍，黑色长发束髻并戴玉冠')
  })

  it('男频宫廷模板转换默认女性，保留宫廷服饰和背景，不改变题材', () => {
    const prompt = withCoverChannel('古代宫廷爱情题材。\n主体人物：气质优雅的女性，穿华丽宫廷汉服，戴凤冠和金簪。\n背景场景：宏伟宫殿。', 'male')
    expect(prompt).toContain('气质优雅的男性，穿华丽宫廷汉服，戴凤冠和金簪')
    expect(prompt).toContain('宏伟宫殿')
    expect(prompt).toContain('古代宫廷爱情题材')
  })

  it.each(['concept_symbol', 'minimal_typographic'] as const)('明确频道解除 %s 无人物要求并将 scene 回退 closeup', (stylePreset) => {
    const prompt = buildCoverPrompt({ ...base, channel: 'female', composition: 'scene', stylePreset,
      scene: { characterDesc: 'an elderly male detective in a grey coat', backgroundDesc: 'an old railway station' },
      visualDirection: '不要人物，纯场景，只改为冷色调' })
    expect(prompt).toContain('人物特写')
    expect(prompt).toContain('an elderly female detective in a grey coat')
    expect(prompt).toContain('an old railway station')
    expect(prompt).not.toContain('no human figure as main subject')
    expect(prompt).not.toContain('no people,')
    expect(prompt).not.toContain('no character illustration')
    expect(prompt).not.toContain('不绘制人物')
    expect(prompt).not.toContain('无人物，')
  })

  it.each(['male', 'female'] as const)('duo 两位主体均为 %s，保留两种服饰和双人构图', (channel) => {
    const prompt = buildCoverPrompt({ ...base, genre: 'modern_romance', channel, composition: 'duo',
      stylePreset: 'concept_symbol', visualDirection: '不要人物', scene: { characterDesc: '一位穿飘逸长裙的女性和一位穿休闲典雅服装的男性' } })
    expect(prompt).toContain('双人构图')
    expect(prompt).toContain(`两个主体均为${channel === 'male' ? '男性' : '女性'}`)
    expect(prompt).toContain('飘逸长裙')
    expect(prompt).toContain('休闲典雅服装')
    expect(prompt).not.toMatch(channel === 'male' ? /\bwoman in/ : /\bman in/)
  })

  it('最终锁高于冲突方向，但保留方向、自由手改、参考图的其他画面要求', () => {
    const prompt = buildCoverPrompt({ ...base, stylePreset: 'photorealistic',
      scene: { characterDesc: 'a sixty-year-old female general in bronze armor', backgroundDesc: 'a ruined mountain fortress' } })
    const directed = withVisualDirection(prompt + '\n\nMY EDIT: a woman holding a red umbrella.\n', '主角改成女性，光线调暗', 'male')
    const output = withCoverChannel(directed, 'male')
    expect(output.startsWith('人物频道约束 [male]:')).toBe(true)
    expect(output).toContain('优先级：所选人物性别与人物存在要求＞作者画面方向＞原提示词')
    expect(output).toContain('参考图')
    expect(output).toContain('主体人物：a sixty-year-old male general in bronze armor')
    expect(output).toContain('MY EDIT: a woman holding a red umbrella.\n')
    expect(output).toContain('写实媒介约束')
    expect(output).toContain('a ruined mountain fortress')
    expect(output).toContain('光线调暗')
  })

  it('同频道重包幂等，改选后只剩一个有效锁，回自动只解除旧锁', () => {
    const prompt = "Title text '女人城'\nAuthor byline: '少年她'\n\nMain subject: a woman in a red coat.\nBackground: a man watching from a distant balcony.\nMY EDIT\n"
    const male = withCoverChannel(prompt, 'male')
    expect(withCoverChannel(male, 'male')).toBe(male)
    const female = withCoverChannel(male, 'female')
    expect(female.match(/^人物频道约束/gm)).toHaveLength(1)
    expect(female).not.toContain('[male]')
    expect(female).toContain("Title text '女人城'")
    expect(female).toContain("Author byline: '少年她'")
    expect(female).toContain('Background: a man watching from a distant balcony.')
    const auto = withCoverChannel(female)
    expect(auto).not.toContain('人物频道约束')
    expect(auto).toContain('\n\nMain subject: a woman in a red coat.\n')
    expect(auto.endsWith('MY EDIT\n')).toBe(true)
  })

  it('作者为旧锁添加缩进或改大小写后仍可回自动或重新选频道，正文缩进保留', () => {
    const body = '  MY EDIT: she is holding a red umbrella.\n\n'
    const previous = withCoverChannel(body, 'male').split('\n').map((line) =>
      line.startsWith('人物频道约束') ? '  ' + line.toUpperCase() : line).join('\n')
    expect(withCoverChannel(previous)).toBe(body)
    const female = withCoverChannel(previous, 'female')
    expect(female.match(/^人物频道约束/gm)).toHaveLength(1)
    expect(female).not.toContain('[MALE]')
    expect(female).toContain(body)
  })

  it('文字层重编也会更新/移除旧频道锁而保留人工画面', () => {
    const original = buildCoverPrompt({ ...base, channel: 'male', scene: { characterDesc: 'an elderly woman in a grey coat' } }) + '\n\nMY EDIT: red umbrella\n'
    const female = patchCoverPromptTypography(original, buildCoverPrompt({ ...base, channel: 'female', typography: { titlePosition: 'center' } }))
    expect(female).toContain('主体人物：an elderly woman in a grey coat')
    expect(female).not.toContain('[male]')
    expect(female).toContain('MY EDIT: red umbrella\n')
    const auto = patchCoverPromptTypography(female, buildCoverPrompt(base))
    expect(auto).not.toContain('Cover channel subject')
    expect(auto).toContain('MY EDIT: red umbrella\n')
  })
})


it('中文性别称谓转换不改年龄、身体特征、服装，也不误改“其他”', () => {
  const original = '六十岁断臂男士，灰发，穿铜甲，他的手里拿着断刀；其他人物保持不变'
  const female = applyCoverChannelToCharacter(original, 'female')
  expect(female).toBe('六十岁断臂女士，灰发，穿铜甲，她的手里拿着断刀；其他人物保持不变')
  expect(applyCoverChannelToCharacter('年轻公主穿旧宫廷服装，她拿着油纸伞', 'male')).toBe('年轻王子穿旧宫廷服装，他拿着油纸伞')
})

it('中文标准行、中文方向、双人重选与返回自动兼容旧英文锁，文字背景和手改保留', () => {
  const original = "Cover channel subject lock [male]: old\n书名文字：'女士和少年'，白字。\n作者署名：作者名'她'，小字。\n双人构图，两位人物相对而立。\n主体人物：老年男士穿铜甲与中年男子穿黑袍。\n背景场景：另一名男性站在远处。\n作者手改：a man holds a red umbrella.\nCover channel subject reminder [male]: old"
  const selected = withCoverChannel(original, 'female')
  expect(selected.match(/^人物频道约束/gm)).toHaveLength(1)
  expect(selected).not.toContain('Cover channel subject')
  expect(selected).toContain('主体人物：两个主体均为女性。老年女士穿铜甲与中年女子穿黑袍。')
  for (const line of ["书名文字：'女士和少年'，白字。", "作者署名：作者名'她'，小字。", '背景场景：另一名男性站在远处。', '作者手改：a man holds a red umbrella.']) expect(selected).toContain(line)
  expect(withCoverChannel(selected, 'female')).toBe(selected)
  expect(withCoverChannel(selected)).not.toContain('人物频道约束')
})
