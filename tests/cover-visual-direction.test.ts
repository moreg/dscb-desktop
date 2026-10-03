import { describe, expect, it } from 'vitest'
import { analyzeCoverVisualDirection, stripCoverVisualDirectionEnvelope, withVisualDirection } from '../src/main/data/cover-visual-direction'
import { withCoverChannel } from '../src/main/data/cover-channel'
import { buildCoverPrompt, COVER_STYLE_PRESETS } from '../src/main/data/skill-prompts/cover/cover-styles'

const base = { bookName: '长夜', authorName: '作者', platform: 'fanqie' as const,
  genre: 'urban' as const, composition: 'fullbody' as const,
  scene: { characterDesc: 'a sixty-year-old female detective in a grey raincoat', backgroundDesc: 'an old train station' } }

describe('封面方向按明确维度生效', () => {
  it.each(['不要二次元，只改光线', '别画成二次元，只改光线', '不走二次元路线', '二次元不要', 'I do not want anime', 'no anime'])('否定方向 %s 不会被识别成要二次元', (direction) => {
    expect(analyzeCoverVisualDirection(direction).medium).toBeUndefined()
  })
  it('否定二次元只改光线时保留写实媒介、原角色、服饰和构图', () => {
    const prompt = buildCoverPrompt({ ...base, stylePreset: 'photorealistic' })
    const output = withVisualDirection(prompt, '不要二次元，只改光线')
    expect(analyzeCoverVisualDirection('不要二次元，只改光线').medium).toBeUndefined()
    expect(output).toContain('写实媒介约束')
    expect(output).toContain(COVER_STYLE_PRESETS.photorealistic.prompt)
    expect(output).toContain(base.scene.characterDesc)
    expect(output).toContain('全身构图')
  })

  it('仅光线或颜色方向保留完整预设媒介以及无人物约束', () => {
    const photo = buildCoverPrompt({ ...base, stylePreset: 'photorealistic', visualDirection: '光线调暗，改成冷色调' })
    expect(photo).toContain('写实媒介约束')
    expect(photo).toContain(COVER_STYLE_PRESETS.photorealistic.prompt)
    const concept = buildCoverPrompt({ ...base, stylePreset: 'concept_symbol', visualDirection: '光线调暗' })
    expect(concept).toContain('无主体人物')
    expect(concept).not.toContain(base.scene.characterDesc)
  })

  it('明确更换媒介与人物时方向仍优先，并保留未请求更换的其他维度', () => {
    const output = withVisualDirection(buildCoverPrompt({ ...base, stylePreset: 'photorealistic' }),
      '主角画韩国财阀女性，嚣张跋扈的坐姿，二次元风格')
    expect(output).not.toContain('写实媒介约束')
    expect(output).not.toContain('photorealistic live-action')
    expect(analyzeCoverVisualDirection('主角画韩国财阀女性，嚣张跋扈的坐姿，二次元风格').subjectFields).toEqual(['gender', 'ethnicity', 'identity', 'pose'])
    expect(output).toContain('保留未提及的角色属性')
  })

  it('明确不要人物改成纯场景时移除主体与人物构图，保留选择的画风', () => {
    const output = withVisualDirection(buildCoverPrompt({ ...base, stylePreset: 'photorealistic' }), '不要人物，纯场景')
    expect(output).not.toContain('主体人物：')
    expect(output).not.toContain('全身构图')
    expect(output).toContain('写实媒介约束')
    expect(analyzeCoverVisualDirection('不要人物，纯场景').composition).toBe('scene')
  })
})


describe('direction and channel composition regressions', () => {
  const traits = 'a sixty-year-old one-armed woman in weathered bronze armor, holding a broken blade'
  const original = "Title text '长夜'.\nAuthor byline: '作者'.\nMain subject: " + traits + '.\nBackground: an old station.\nMY EDIT: keep the copper bracelet.\n'

  it.each(['不要人物变化，只改光线', '不要人物变成少年，只改光线', '不要人物的服装变化，只改光线', '不要人物换衣服', '不要人物发型变化', '不要无人物，保留主角', '不要纯场景，保留主角', 'no character changes, darker lighting'])('preserves subject for the negated direction %s', (direction) => {
    const analysis = analyzeCoverVisualDirection(direction)
    expect(analysis.noPeople).not.toBe(true)
    expect(analysis.composition).not.toBe('scene')
    expect(withVisualDirection(original, direction)).toContain('Main subject: ' + traits)
  })

  it.each(['不要人物，纯场景', '无人物，只画山谷', 'no people, landscape', 'without characters'])('keeps genuine no-people direction %s effective in automatic channel', (direction) => {
    expect(analyzeCoverVisualDirection(direction).noPeople).toBe(true)
    expect(withVisualDirection(original, direction)).not.toContain('Main subject:')
    expect(withVisualDirection(original, direction)).toContain('Background: an old station.')
  })

  it.each(['male', 'female'] as const)('resolves %s channel before removing character traits for a conflicting scene direction', (channel) => {
    const prompt = buildCoverPrompt({ ...base, channel, composition: 'duo', scene: { ...base.scene,
      characterDesc: traits + ' and a forty-year-old man in a grey suit' } })
    const output = withCoverChannel(withVisualDirection(prompt, '不要人物，纯场景', channel), channel)
    for (const detail of ['sixty-year-old', 'one-armed', 'bronze armor', 'broken blade', 'forty-year-old', 'grey suit']) expect(output).toContain(detail)
    expect(output).toContain('双人构图')
    expect(output).toContain('两个主体均为' + (channel === 'male' ? '男性' : '女性'))
    expect(output).not.toContain('no human figure as main subject')
    expect(output).not.toContain('reminder')
    expect(output.match(/优先级：/g)).toHaveLength(1)
  })

  it('changes medium without deleting keywords inside title, byline, subject, background or free edits', () => {
    const custom = [
      "Title text 'photorealistic live-action 午夜'.",
      "Author byline: '真人写实封面'.",
      'Main subject: photorealistic live-action portrait of ' + traits + '.',
      'Background: a photorealistic live-action railway station.',
      'MY EDIT: use no illustration, digital painting, anime for the antique poster within the scene.',
      'Photographic medium lock: render the cover as a photograph.',
      'Selected visual style lock (真人写实封面): photorealistic live-action novel cover.'
    ].join('\n')
    const output = withCoverChannel(withVisualDirection(custom, '二次元风格，只改变画风', 'female'), 'female')
    for (const line of custom.split('\n').slice(0, 5)) expect(output).toContain(line)
    expect(output).not.toContain('Photographic medium lock:')
    expect(output).not.toContain('Selected visual style lock (真人写实封面):')
  })

  it('reconciles known lighting and palette conflicts without discarding setup, accents or unrelated fields', () => {
    const prompt = original + 'Lighting: bright warm sunlight from the left, soft rim light, gentle bokeh.\nColor palette: warm gold with a crimson accent.'
    const output = withVisualDirection(prompt, '光线调暗，光线改成冷色调，配色改为冷色调')
    expect(output).toContain('Lighting: dim cool sunlight from the left, soft rim light, gentle bokeh.')
    expect(output).toContain('Color palette: cool gold with a crimson accent.')
    expect(output).toContain('Main subject: ' + traits)
    expect(output).toContain('MY EDIT: keep the copper bracelet.')
    const lightingOnly = withVisualDirection(prompt, '只把光线调暗')
    expect(lightingOnly).toContain('Lighting: dim warm sunlight from the left, soft rim light, gentle bokeh.')
    expect(lightingOnly).toContain('Color palette: warm gold with a crimson accent.')
  })

  it('keeps negated light/palette settings and unrecognized details as a conservative baseline', () => {
    const prompt = original + 'Lighting: bright warm light with natural skin texture.\nColor palette: warm gold and crimson.'
    const output = withVisualDirection(prompt, '不要调暗光线，不要冷色调，只调整灯光位置')
    expect(output).toContain('Lighting: bright warm light with natural skin texture.')
    expect(output).toContain('Color palette: warm gold and crimson.')
  })

  it('replacing the direction is idempotent and removes previous managed instructions without touching free edits', () => {
    const direction = '光线调暗\n保留雨伞和服饰'
    const first = withVisualDirection(original, direction)
    expect(withVisualDirection(first, direction)).toBe(first)
    expect(first.match(/光线调暗/g)).toHaveLength(1)
    expect(first).not.toContain('reminder')
    expect(stripCoverVisualDirectionEnvelope(first)).toBe(original)
    const authorLabel = first + 'Subordinate cover prompt:\nMY SECOND EDIT\n'
    expect(withVisualDirection(authorLabel, direction)).toContain('Subordinate cover prompt:\nMY SECOND EDIT\n')
    const next = withVisualDirection(first, '改为暖色调')
    expect(next).not.toContain('光线调暗')
    expect(next).toContain('MY EDIT: keep the copper bracelet.')
    expect(withVisualDirection(next)).toBe(original)
  })

  it('removes legacy direction headers/reminders and legacy channel reminders on a re-selection', () => {
    const old = 'Author visual direction, absolute highest priority. Apply this priority only to explicitly requested changes. Direction: OLD\n\nSubordinate cover prompt:\n' + original + '\nAuthor visual direction reminder: apply only the explicitly requested changes: OLD'
    const output = withCoverChannel(withVisualDirection(old, '只改光线', 'female'), 'female')
    expect(output).not.toContain('absolute highest priority')
    expect(output).not.toContain('OLD')
    expect(output).not.toContain('Subordinate cover prompt:')
    expect(output).toContain('MY EDIT: keep the copper bracelet.')
    const oldChannel = 'Cover channel subject lock [male]: old\n' + original + '\nCover channel subject reminder [male]: old'
    const selected = withCoverChannel(oldChannel, 'female')
    expect(selected.match(/^人物频道约束/gm)).toHaveLength(1)
    expect(selected).not.toContain('reminder')
    expect(withCoverChannel(selected, 'female')).toBe(selected)
  })
})


it('preserves author environment details appended to a standard scene-only composition line', () => {
  const prompt = 'no human figure as main subject, landscape composition, snow-covered canyon with a ruined bridge.\nBackground: distant mountains.'
  const output = withCoverChannel(withVisualDirection(prompt, '不要人物，纯场景', 'male'), 'male')
  expect(output).toContain('人物特写，男性主体, snow-covered canyon with a ruined bridge.')
  expect(output).toContain('Background: distant mountains.')
})


it('中文标准行切媒介不删除文字、人物属性、背景和自由手改', () => {
  const prompt = [
    "书名文字：'真人写实封面'，白字。", "作者署名：作者名'摄影'，小字。",
    '主体人物：六十岁的断臂女性，身穿旧铜甲，拿着断刀。',
    '背景场景：旧摄影馆，石桥断裂。', '作者手改：保留场景内写实媒介约束的纸质标牌。',
    '写实媒介约束：摄影表现，保留故事角色的年龄、身份和符合时代的服饰。',
    '画风约束（真人写实封面）：写实摄影表现。',
    '全身构图，姿态富有动感。',
    '专业印刷级封面，保持所选媒介与视觉语言；不加水印。'
  ].join('\n')
  const output = withCoverChannel(withVisualDirection(prompt, '改为二次元风格，只改变画风', 'male'), 'male')
  expect(output).not.toContain('写实媒介约束：摄影表现')
  expect(output).not.toContain('画风约束（真人写实封面）')
  expect(output).toContain('主体人物：六十岁的断臂男性，身穿旧铜甲，拿着断刀。')
  for (const line of prompt.split('\n').slice(0, 2).concat(prompt.split('\n').slice(3, 5))) expect(output).toContain(line)
  expect(output).toContain('采用作者明确指定的画面媒介')
  expect(output).not.toMatch(/Author visual direction|Cover channel subject|Priority:|reminder/)
})

it('中文二次元切写实与无人物方向保持对应媒介、主体和构图规则', () => {
  const prompt = '二次元媒介约束：二维手绘，不采用摄影。\n双人构图，两位人物相对而立。\n主体人物：老年女子穿红衣，中年男子穿灰色西装。\n背景场景：旧车站。'
  const photo = withCoverChannel(withVisualDirection(prompt, '改用真人摄影，不要人物，纯场景', 'female'), 'female')
  expect(photo).not.toContain('二次元媒介约束：')
  expect(photo).toContain('双人构图，两位人物相对而立。')
  expect(photo).toContain('主体人物：两个主体均为女性。老年女子穿红衣，中年女子穿灰色西装。')
  const noPeople = withVisualDirection(prompt, '不要人物，纯场景')
  expect(noPeople).not.toContain('主体人物：')
  expect(noPeople).not.toContain('双人构图')
  expect(noPeople).toContain('二次元媒介约束：二维手绘，不采用摄影。')
  expect(noPeople).toContain('背景场景：旧车站。')
})

it('中文光线与配色校正保留灯光位置、散景、点缀和其他角色资料', () => {
  const prompt = '主体人物：老年女子，断臂，穿铜甲。\n光线：明亮暖光从左侧照入，柔和轮廓光和散景。\n配色：暖色金色，点缀猩红。'
  const output = withVisualDirection(prompt, '光线调暗，光线改为冷色调，配色改为冷色调')
  expect(output).toContain('光线：柔暗冷光从左侧照入，柔和轮廓光和散景。')
  expect(output).toContain('配色：冷色金色，点缀猩红。')
  expect(output).toContain('主体人物：老年女子，断臂，穿铜甲。')
  const changedLight = withVisualDirection(prompt, '只把光线调暗')
  expect(changedLight).toContain('配色：暖色金色，点缀猩红。')
})

it('英文与中文作者方向封装互迁，重包幂等，方向原文和自由正文仍保留', () => {
  const body = '主体人物：一位老年女士。\nSubordinate cover prompt:\n作者手改：retain this text\n'
  const old = 'Author visual direction [managed]: old\n<author-visual-direction>\nOLD\n</author-visual-direction>\n' + body
  const direction = '只调整光线\n保留红色雨伞'
  const updated = withVisualDirection(old, direction, 'female')
  expect(updated.startsWith('作者画面方向 [managed]:')).toBe(true)
  expect(updated).not.toContain('OLD')
  expect(updated).toContain(direction)
  expect(updated).toContain(body)
  expect(withVisualDirection(updated, direction, 'female')).toBe(updated)
  expect(stripCoverVisualDirectionEnvelope(updated)).toBe(body)
})


it('中文温暖光线只在明确冷色光方向下校正，保留光源和无关特征', () => {
  const prompt = '光线：温暖灯光从右侧照入，柔和轮廓光、自然肤质和散景。\n主体人物：老年女士穿铜甲。'
  const cool = withVisualDirection(prompt, '把光线改为冷色调')
  expect(cool).toContain('光线：冷调灯光从右侧照入，柔和轮廓光、自然肤质和散景。')
  expect(cool).toContain('主体人物：老年女士穿铜甲。')
  expect(withVisualDirection(prompt, '不要冷色调，只调整光线位置')).toContain(prompt)
})
