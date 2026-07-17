import { describe, it, expect } from 'vitest'
import {
  isAgentProcessNarration,
  assertNovelProse,
  LLM_AGENT_META_ERROR
} from '../src/main/data/agent-meta-detect'

describe('isAgentProcessNarration', () => {
  it('识别 story-long-write 流程旁白（用户截图同类）', () => {
    const text =
      '我会按 story-long-write 的章节写作流程先做规则与衔接自检，再直接给正文；这一步只用于确保细纲顺序、边界和章末卡点不跑偏。我会调用 story-long-write 技能做章节衔接、细纲边界和章末钩子校验；它会影响我对正文顺序与收尾方式的处理。技能文件较长，刚才读取被截断了。我正在补读完整规则，随后会直接输出正文，不会把流程说明混进小说。'
    expect(isAgentProcessNarration(text)).toBe(true)
  })

  it('识别无技能名的软旁白（「按长篇网文写作流程…再直接给出正文」）', () => {
    const text =
      '我会按长篇网文写作流程先核对本章的衔接、细纲边界和章末卡点，再直接给出正文。'
    expect(isAgentProcessNarration(text)).toBe(true)
  })

  it('正常小说正文不误报', () => {
    const text =
      '沈渡推开门，雨气扑面而来。巷子尽头的灯还亮着，像有人故意等他。\n\n「回来了？」屋里传来一声轻笑。\n\n他没应，只把湿透的外套挂到门后。'
    expect(isAgentProcessNarration(text)).toBe(false)
  })

  it('长正文里偶然出现「细纲」类词但不构成 agent 旁白', () => {
    // isAgentProcessNarration 只管 agent 旁白特征，不管「细纲」工程词（那是 deslop 的事）
    const text =
      '他记得父亲说过，做人要有纲有目。夜里风大，纸窗哗哗响。'.repeat(30)
    expect(isAgentProcessNarration(text)).toBe(false)
  })

  it('长正文里单句「再直接给出正文」不因强特征误杀', () => {
    const text =
      '沈渡皱眉，把那封信撕了。他想起有人说过「再直接给出正文」这种玩笑。雨还在下。'.repeat(
        20
      )
    expect(isAgentProcessNarration(text)).toBe(false)
  })
})

describe('assertNovelProse', () => {
  it('旁白抛出 LLM_AGENT_META', () => {
    expect(() =>
      assertNovelProse('我会调用 story-long-write 技能，技能文件较长，正在补读完整规则。')
    ).toThrow(LLM_AGENT_META_ERROR)
  })

  it('正常正文通过', () => {
    expect(() => assertNovelProse('门被踹开，冷风灌了进来。')).not.toThrow()
  })
})
