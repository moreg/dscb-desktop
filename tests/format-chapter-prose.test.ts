import { describe, expect, it } from 'vitest'
import { formatChapterProse, joinContinuation, needsChapterProseFormat, separateDialogueInterruption } from '../src/shared/format-chapter-prose'

describe('formatChapterProse：最小格式化', () => {
  it.each([
    '她把账本摊开。已付八百，余款两百。\n\n“我先付了八百。剩下的明天给。”',
    '“等等。”她抬起手拦住他，“这笔钱还没算清。”',
    '“你……”“等等——”他打断她，“先别签。”',
    '“不急，”她说，“先核对证据。”',
    '“他说‘别走。’你听见了吗？！我听见了。”',
    '“先签字。\n别等了。再见！”',
    '“先签字。',
    '【甲。乙。】丙。丁。',
    '浓度3.5%，版本v1.2。结果（待定。需要复查）仍未确认！',
    '他拿起“钥匙”走了。门关了。',
    '“Hello, World!” he said.'
  ])('保留语意段落、合法标点和信息顺序：%s', source => {
    expect(formatChapterProse(source)).toBe(source)
    expect(formatChapterProse(formatChapterProse(source))).toBe(source)
    expect(needsChapterProseFormat(source)).toBe(false)
    expect(separateDialogueInterruption(source)).toBe(source)
  })
  it('清理汉字间空白，保留英文分词和一个空行，兼容 CRLF', () => {
    expect(formatChapterProse('  沈 渡　皱眉\r\n\r\n\r\n  Hello   World  ')).toBe('沈渡皱眉\n\nHello World')
    expect(formatChapterProse('Take\t40\u00a0kg to the café.')).toBe('Take 40 kg to the café.')
    expect(formatChapterProse('用 iPhone 拍照')).toBe('用iPhone拍照')
    expect(formatChapterProse('他说 “Hello,   World!” 然后走了。')).toBe('他说“Hello, World!”然后走了。')
    expect(formatChapterProse('')).toBe('')
    expect(needsChapterProseFormat('有 空格')).toBe(true)
    expect(needsChapterProseFormat('有\r\n回车')).toBe(true)
  })
  it('把抄进正文的章号改成故事内说法，书中章节保留', () => {
    expect(formatChapterProse(
      '这一次取出的样本与第九章检测所用样本来自同一批封存物。'
    )).toBe('这一次取出的样本与先前检测所用样本来自同一批封存物。')
    expect(formatChapterProse('与第 9 章检测所用样本相同。')).toBe('与先前检测所用样本相同。')
    expect(formatChapterProse('上一章里他说过这句话。')).toBe('先前他说过这句话。')
    expect(formatChapterProse('他翻开《验尸录》第九章，对照封存记录。')).toBe(
      '他翻开《验尸录》第九章，对照封存记录。'
    )
    expect(formatChapterProse('他读到第九章，才合上笔记。')).toBe('他读到第九章，才合上笔记。')
    expect(formatChapterProse('第九章\n他推开门。')).toBe('他推开门。')
    expect(formatChapterProse('话说完了。下章见。')).toBe('话说完了。')
  })

})

describe('joinContinuation', () => {
  it('原文停在句末时补换行，避免续写内容焊进原文最后一段', () => {
    // 回归：模型被要求「开头不需要承接词」，首 token 不是换行；裸拼会粘连
    expect(joinContinuation('“别走”', '他停下脚步。')).toBe('“别走”\n\n他停下脚步。')
    expect(joinContinuation('他推开门。', '屋里没人。')).toBe('他推开门。\n\n屋里没人。')
    expect(joinContinuation('「你是谁？」', '没人应声。')).toBe('「你是谁？」\n\n没人应声。')
    expect(joinContinuation('他愣住了……', '风停了。')).toBe('他愣住了……\n\n风停了。')
  })

  it('原文停在句子中间时直接拼接——补换行会把一句话劈成两段', () => {
    // 回归：早先无条件补换行，「他推开」+「门，屋里没人。」会变成两段
    expect(joinContinuation('他推开', '门，屋里没人。')).toBe('他推开门，屋里没人。')
    expect(joinContinuation('他说这件事', '恐怕没那么简单。')).toBe(
      '他说这件事恐怕没那么简单。'
    )
  })

  it('英文词间已有的接缝空格保留，词内断点仍直接接续', () => {
    expect(joinContinuation('He said ', 'hello.')).toBe('He said hello.')
    expect(joinContinuation('He said', ' hello.')).toBe('He said hello.')
    expect(joinContinuation('He whis', 'pered.')).toBe('He whispered.')
  })

  it('原文本就以换行结尾时，尊重作者已分好的段', () => {
    // 末行停在句中，但作者显式换了行 → 仍然分段
    expect(joinContinuation('他推开\n', '门，屋里没人。')).toBe('他推开\n\n门，屋里没人。')
  })

  it('接缝两侧已有的换行/空白归一成一个空行', () => {
    expect(joinContinuation('他推开门。\n\n', '\n\n屋里没人。')).toBe('他推开门。\n\n屋里没人。')
    expect(joinContinuation('他推开门。\n', '屋里没人。')).toBe('他推开门。\n\n屋里没人。')
  })

  it('新增段落空一行，前文的合段、原有换行与账目原样保留', () => {
    const base = '已付八百，余款两百。她把收条收好。\n前天的签名仍在。\n\n“先别走。”'
    expect(joinContinuation(base, '她又翻开账本。')).toBe(base + '\n\n她又翻开账本。')
    expect(formatChapterProse(base)).toBe(base)
  })

  it('原文为空时直接返回续写内容，不留空行', () => {
    expect(joinContinuation('', '屋里没人。')).toBe('屋里没人。')
    expect(joinContinuation('   \n', '屋里没人。')).toBe('屋里没人。')
  })

  it('续写内容还没出实字时保持原文不变（流式首帧只有空白）', () => {
    expect(joinContinuation('他推开门。', '')).toBe('他推开门。')
    expect(joinContinuation('他推开门。', '\n')).toBe('他推开门。')
  })

  it('逐 token 累积时结果稳定（流式重算不会抖）', () => {
    const base = '他推开门。'
    const full = '屋里没人。'
    const frames = [1, 2, 3, 4, 5].map((n) => joinContinuation(base, full.slice(0, n)))
    expect(frames[frames.length - 1]).toBe('他推开门。\n\n屋里没人。')
    for (const f of frames) expect(f.startsWith('他推开门。\n\n')).toBe(true)
  })
})
