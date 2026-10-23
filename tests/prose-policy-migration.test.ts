import { describe, expect, it } from 'vitest'
import { migrateLegacyProseDefaults, serializeProseOverrides } from '../src/shared/prose-policy'

describe('历史内置表达规则迁移', () => {
  it('嵌套覆盖在JSON转义前迁移，不把旧硬性排版重新注入整章精修', () => {
    const old = '- **一句一段**：每句完整的叙述独立成段，不在逗号处拆碎句子，不靠逗号硬接独立句子。'
    const custom = '作者自定：“账目别漏。”\n本项目对白可达70%，但不能补剧情。'
    const overrides = { systemPrompt: old + '\r\n' + custom, gates: { D: old } }
    const original = JSON.stringify(overrides)
    const sent = JSON.parse(serializeProseOverrides(overrides))
    expect(sent.systemPrompt).not.toContain(old)
    expect(sent.gates.D).not.toContain(old)
    expect(sent.systemPrompt).toContain(custom)
    expect(sent.gates.D).toContain('不搬动动作改变先后顺序')
    expect(JSON.stringify(overrides)).toBe(original)
  })

  it('不是已发布内置原句的作者要求不会被宽泛关键词替换', () => {
    const author = '作者要求：本章一句一段，信件原文保留，不改为一般对白。'
    expect(migrateLegacyProseDefaults(author)).toBe(author)
  })

  it('上一版内置自然段默认与嵌套覆盖同步升级，已有正文和作者独立要求不被重排', () => {
    const old = '段落按语意组织：同一行动及直接反馈可以同段，人物、时间、地点、视角或场景重心改变时再分段。不强制一句一段，不按句号机械拆分多句发言，不搬动动作改变先后顺序。'
    const author = '作者要求：本章信件保持原有长段。'
    const overrides = { style_targets: old + '\n' + author, gates: { D: old } }
    const original = JSON.stringify(overrides)
    const migrated = JSON.parse(serializeProseOverrides(overrides))
    expect(migrated.style_targets).toContain('默认以一句一段为主，段间空一行')
    expect(migrated.gates.D).toContain('已全绿正文保持原样')
    expect(migrated.style_targets).toContain(author)
    expect(migrated.style_targets).not.toContain(old)
    expect(JSON.stringify(overrides)).toBe(original)
  })
})
