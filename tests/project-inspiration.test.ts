import { describe, expect, it } from 'vitest'
import {
  buildProjectInspirationPrompt,
  parseProjectInspiration
} from '../src/renderer/src/project-inspiration'

describe('project inspiration', () => {
  it('builds a prompt with user direction', () => {
    const prompt = buildProjectInspirationPrompt({
      genre: '都市异能',
      projectName: '夜行者',
      synopsis: '主角能看见他人的剩余寿命',
      variationSeed: '悬念感 × 小人物逆袭',
      excludedNames: ['旧书名']
    })
    expect(prompt).toContain('都市异能')
    expect(prompt).toContain('夜行者')
    expect(prompt).toContain('剩余寿命')
    expect(prompt).toContain('旧书名')
    expect(prompt).toContain('主角身份与开局变故')
    expect(prompt).toContain('不得添加正文没有的')
    expect(prompt).toContain('冲突、选择、秘密或成长期待')
  })

  it('parses strict JSON', () => {
    expect(parseProjectInspiration('{"name":"借命人","description":"一段简介"}')).toEqual({
      name: '借命人',
      description: '一段简介'
    })
  })

  it('accepts fenced JSON and common alternate keys', () => {
    expect(
      parseProjectInspiration('```json\n{"title":"《星海余烬》","summary":"星舰坠落之后。"}\n```')
    ).toEqual({ name: '星海余烬', description: '星舰坠落之后。' })
  })

  it('rejects incomplete output', () => {
    expect(() => parseProjectInspiration('{"name":"只有书名"}')).toThrow('完整')
  })
})
