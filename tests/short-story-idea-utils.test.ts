import { describe, expect, it } from 'vitest'
import type { ShortStoryIdea } from '../src/shared/short-story'
import {
  isShortStoryIdea, shortStoryIdeaExclusion, shortStoryIdeaFingerprint, shortStoryIdeaKey, shortStoryIdeaMatchesPrevious
} from '../src/shared/short-story-idea-utils'

const idea: ShortStoryIdea = {
  title: '雨中的信', premise: '邮递员要在今晚找到一封信真正的主人。', hook: '信封上的收件人就是他自己。',
  twist: '邮戳上的年份提前暗示这封信迟到了二十年。', ending: '他找到了寄信的母亲，亲自把错过的回应说出口。'
}

describe('短篇脑洞共享工具', () => {
  it('校验完整方案，拒绝数组、空白与超长字段', () => {
    expect(isShortStoryIdea(idea)).toBe(true)
    expect(isShortStoryIdea([idea])).toBe(false)
    expect(isShortStoryIdea({ ...idea, ending: '   ' })).toBe(false)
    expect(isShortStoryIdea({ ...idea, title: '信'.repeat(121) })).toBe(false)
    expect(isShortStoryIdea({ ...idea, twist: null })).toBe(false)
  })

  it('完整内容区分不同改写版本，规范化空格与标点', () => {
    expect(shortStoryIdeaKey({ ...idea, title: ' 雨 中 的 信！' })).toBe(shortStoryIdeaKey(idea))
    expect(shortStoryIdeaKey({ ...idea, ending: '他决定不再寄信，而是当面告别。' })).not.toBe(shortStoryIdeaKey(idea))
  })

  it('提示摘要保留设定和反转各自预算，程序指纹保留全文', () => {
    const long = { ...idea, premise: '设'.repeat(3000), twist: '关键反转开始' + '转'.repeat(1490) }
    const summary = shortStoryIdeaExclusion(long)
    expect(summary.length).toBeLessThanOrEqual(1500)
    expect(summary).toContain('设定：' + '设'.repeat(800))
    expect(summary).toContain('反转：关键反转开始')
    expect(shortStoryIdeaFingerprint(long)).toEqual({ title: long.title, premise: long.premise })
  })

  it('跨批按规范化标题或完整设定拦截重复', () => {
    const previous = [shortStoryIdeaFingerprint(idea)]
    expect(shortStoryIdeaMatchesPrevious({ ...idea, title: ' 雨中的信！', premise: '另一个设定' }, previous)).toBe(true)
    expect(shortStoryIdeaMatchesPrevious({ ...idea, title: '改过的标题', premise: '邮递员要在今晚，找到一封信真正的主人！' }, previous)).toBe(true)
    expect(shortStoryIdeaMatchesPrevious({ title: '新标题', premise: '钢琴师准备第一次演出。' }, previous)).toBe(false)
  })

  it('保守拦截长设定的轻微文字变体，不合并短句或明确不同的设定', () => {
    const long = '年轻的邮递员为了寻找寄信人，沿着雨天的街道逐户询问。'.repeat(12)
    const previous = [{ title: '原方案', premise: long }]
    expect(shortStoryIdeaMatchesPrevious({ title: '换名字', premise: long.replace('年轻', '年青') }, previous)).toBe(true)
    expect(shortStoryIdeaMatchesPrevious({ title: '完全不同', premise: '失聪的音乐家为了完成第一次演出，用振动辨认每一个音符。'.repeat(12) }, previous)).toBe(false)
    expect(shortStoryIdeaMatchesPrevious({ title: '短句变体', premise: '他找到的是仇人的信。' }, [{ title: '短句原稿', premise: '他找到的是亲人的信。' }])).toBe(false)
  })
})
