import { describe, expect, it } from 'vitest'
import { applyCoverGenerationStyle, requestsCoverVisualPlanChange } from '../src/main/data/cover-generation-style'
import type { GenerateCoverInput } from '../src/shared/types'

const input: GenerateCoverInput = { projectId: 'p', bookName: '学长，出场费结一下', authorName: '作者', platform: 'fanqie' }
const old = "画风约束（真人写实封面）：真人摄影。\n写实媒介约束：真实肤质。\n书名文字：'学长，出场费结一下'。\n作者署名：'作者 著'。\n主体人物：二十岁男性，白衬衫，手持收据。\n背景场景：校园礼堂。\n配色：金色。\n光线：强烈高光。"

describe('current cover style and replacement plans', () => {
  it('反复应用当前动漫风格不会重复叠加成品标准或媒介约束', () => {
    const selected = { ...input, stylePreset: 'anime_illustration' as const }
    const once = applyCoverGenerationStyle(old, selected)
    const twice = applyCoverGenerationStyle(once, selected)
    expect(twice).toBe(once)
    expect(twice.match(/^二次元成品标准：/gm)).toHaveLength(1)
    expect(twice.match(/^二次元媒介约束：/gm)).toHaveLength(1)
    expect(twice).toContain("作者署名：'作者 著'")
  })
  it('recognizes the actual request to change style without treating a negation as approval', () => {
    for (const request of ['不能换一种风格？', '换个画风', '换一套方案']) expect(requestsCoverVisualPlanChange(request)).toBe(true)
    for (const request of ['不要换一种风格', '别再换画风', '保持原画风', '不换方案，只改光线']) expect(requestsCoverVisualPlanChange(request)).toBe(false)
  })
  it.each(['anime_illustration', 'anime_light'] as const)('applies %s to a stale edited photographic prompt while retaining story details', stylePreset => {
    const output = applyCoverGenerationStyle(old, { ...input, stylePreset })
    expect(output).toContain('二次元媒介约束')
    expect(output).toContain('禁止乙游半写实人像')
    expect(output).not.toContain('画风约束（真人写实封面）')
    expect(output).not.toContain('写实媒介约束：')
    for (const line of old.split('\n').slice(2, 6)) expect(output).toContain(line)
  })
  it('honors an anime direction over the currently selected photography preset', () => {
    const output = applyCoverGenerationStyle(old, { ...input, stylePreset: 'photorealistic', visualDirection: '我要二次元' })
    expect(output).toContain('二次元媒介约束')
    expect(output).not.toContain('写实媒介约束：')
    expect(output).not.toContain('画风约束（真人写实封面）')
  })
  it('does not rotate stock styles or retain stale palette and lighting for a replacement plan', () => {
    const plans = [1, 2, 3].map(variant => applyCoverGenerationStyle(old, { ...input, stylePreset: 'anime_illustration' }, variant))
    for (const plan of plans) {
      expect(plan).toContain('二次元媒介约束')
      expect(plan).toContain('校园礼堂')
      expect(plan).not.toContain('配色：金色')
      expect(plan).not.toContain('光线：强烈高光')
      expect(plan).toContain('结合故事重新设计')
      expect(plan).not.toContain('本次采用二维平涂漫画')
    }
  })
  it('preserves explicit direction and does not introduce a replacement plan for ordinary generation', () => {
    expect(applyCoverGenerationStyle(old, input)).toBe(old)
    const output = applyCoverGenerationStyle(old, { ...input, visualDirection: '保持金色配色，光线调暗' }, 1)
    expect(output).toContain('配色：金色')
    expect(output).toContain('光线：')
  })
})
