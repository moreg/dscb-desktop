import { describe, it, expect } from 'vitest'
import {
  isAgentProcessNarration,
  assertNovelProse,
  LLM_AGENT_META_ERROR,
  LLM_PROSE_FORMAT_ERROR,
  LLM_PROSE_REPETITION_ERROR,
  LLM_EMPTY_PROSE_ERROR
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
  const priorPassage = '沈渡沿着堤岸走到渡口，停在最后一盏油灯下面，发现系船的绳索已经断了。守夜老人从仓房里出来，把一枚带着泥沙的铜扣递给他，说是清晨在水边捡到的。铜扣背面刻着一只缺角的鹤，与姐姐出门时穿的外衣一模一样。他没有立刻追问，只将铜扣放进衣袋，转身望向河对岸仍未熄灭的灯火。'
  it('旁白抛出 LLM_AGENT_META', () => {
    expect(() =>
      assertNovelProse('我会调用 story-long-write 技能，技能文件较长，正在补读完整规则。')
    ).toThrow(LLM_AGENT_META_ERROR)
  })

  it('正常正文通过', () => {
    expect(() => assertNovelProse('门被踹开，冷风灌了进来。')).not.toThrow()
  })

  it.each(['', ' \n\t', '\u200b\u2060'])('无已有正文时空稿 %j 被拦截', (text) => {
    expect(() => assertNovelProse(text)).toThrow(LLM_EMPTY_PROSE_ERROR)
    expect(() => assertNovelProse(text, '  \n')).toThrow(LLM_EMPTY_PROSE_ERROR)
  })

  it('已有完整正文时允许没有新增内容，不迫使模型继续填充', () => {
    expect(() => assertNovelProse('', '他终于推开了那扇门。')).not.toThrow()
    expect(() => assertNovelProse(' \n', priorPassage)).not.toThrow()
  })

  it.each([
    '# 第三章 夜渡\n\n门被推开。',
    '门被推开。\n\n## 事件一：船只失踪\n沈渡走向渡口。',
    '```markdown\n门被推开。\n```',
    '~~~text\n门被推开。\n~~~',
    `**${priorPassage}**`
  ])('拦截高置信 Markdown 格式泄漏：%s', (text) => {
    expect(() => assertNovelProse(text)).toThrow(LLM_PROSE_FORMAT_ERROR)
  })

  it.each([
    '门被推开。（此处省略一千字打斗描写）沈渡走了出去。',
    '门被推开。\n【待补充后续剧情】',
    '门被推开。\nTODO: 写出接下来的交锋'
  ])('拦截明确用占位代替剧情：%s', (text) => {
    expect(() => assertNovelProse(text)).toThrow(LLM_PROSE_FORMAT_ERROR)
  })

  it('短暂强调、人物谈论符号和省略文本、普通悬念不误报', () => {
    expect(() => assertNovelProse('他盯着屏幕上的 **警报**，按下了停止键。')).not.toThrow()
    expect(() => assertNovelProse('“请在纸上写 # 这个符号。”老师指着黑板。')).not.toThrow()
    expect(() => assertNovelProse('他读到纸条上的“（此处省略）”，把纸翻了过来。')).not.toThrow()
    expect(() => assertNovelProse('“我原本想告诉你……”门外忽然响起脚步声。')).not.toThrow()
  })

  it('合法末尾伏笔回执先从检查视图剥离，回执内术语/格式不参与检查', () => {
    const receipt = '【本章伏笔回执】' + JSON.stringify({
      planted: ['story-long-write 技能文件被截断了', '**' + priorPassage + '**', '括号 } 里的记号', '信封上印着【本章伏笔回执】'],
      collected: []
    })
    const text = '门被推开。\n\n' + receipt
    expect(() => assertNovelProse(text)).not.toThrow()
    expect(text).toBe('门被推开。\n\n' + receipt)
    expect(() => assertNovelProse(receipt)).toThrow(LLM_EMPTY_PROSE_ERROR)
    expect(() => assertNovelProse(receipt, priorPassage)).not.toThrow()
  })

  it.each([
    '【本章伏笔回执】{invalid json}',
    '【本章伏笔回执】{"planted":"正文不是数组"}',
    '【本章伏笔回执】{"planted":[]}\n# 不应被回执吞掉的内容'
  ])('损坏或非末尾回执不能掩盖非正文输出：%s', (receipt) => {
    expect(() => assertNovelProse('门被推开。\n' + receipt)).toThrow(LLM_PROSE_FORMAT_ERROR)
  })

  it('续写照搬已有长段并占输出大部分时拦截，忽略重排空行', () => {
    const copiedWithNewLines = priorPassage.replace(/。/g, '。\n\n')
    expect(() => assertNovelProse(copiedWithNewLines + '\n船夫朝他招了招手。', priorPassage))
      .toThrow(LLM_PROSE_REPETITION_ERROR)
    expect(() => assertNovelProse(priorPassage + '\n船夫朝他招手。', '更早的正文。\n' + priorPassage))
      .toThrow(LLM_PROSE_REPETITION_ERROR)
  })

  it('少量必要回引不作为高置信整段复制拦截', () => {
    const nextScene = '山顶已经落了雪，巡林人在避风处升起炉火，将冻住的药箱一层层拆开，等待从镇上赶来的医生。'
    expect(() => assertNovelProse(priorPassage + nextScene.repeat(12), priorPassage)).not.toThrow()
  })

  it('短台词和故意短句复沓不会因累计较长而误杀', () => {
    const chorus = '“别怕，我们还在这里！”'.repeat(20)
    expect(() => assertNovelProse(chorus, chorus)).not.toThrow()
    const refrain = '山还在，路还在，离开的人终究会走回来。'.repeat(10)
    expect(() => assertNovelProse(refrain, refrain)).not.toThrow()
    expect(() => assertNovelProse('“你先走。”她又说了一遍。', '他听见她说：“你先走。”')).not.toThrow()
  })

  it('未提供已有正文时不把自我重复误当成复制续写前部', () => {
    expect(() => assertNovelProse(priorPassage + priorPassage)).not.toThrow()
  })
})
