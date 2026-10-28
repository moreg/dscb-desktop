import { describe, expect, it } from 'vitest'
import { DIALOGUE_PARAGRAPHS, migrateLegacyProseDefaults, serializeProseOverrides, READER_NOTE_BOUNDARY } from '../src/shared/prose-policy'
import { buildDeslopPrompt, DESLOP_SYSTEM_PROMPT } from '../src/main/data/skill-prompts/deslop/anti-ai-methods'
import { PLANNING_RULES } from '../src/main/data/skill-prompts/opening/planning-rules'

describe('历史内置表达规则迁移', () => {
  it('规划、精修与旧 Gate 覆盖使用相同对白分段默认，保留独立作者要求', () => {
    const old = '**台词按语气断句**：每段对话独立成段，同一对引号内禁止出现中文句号「。」（包括闭合引号前）；陈述台词以闭合引号收尾，问号、感叹号按语气保留。同一人多句发言按语意保留，不机械拆引号；必要动作保留原有顺序。确实一口气说完的短句才用逗号连接，不要把人物本来会分开说的两件事硬接成一条长句，也不要为制造口语感无故打断。'
    const custom = '作者要求：宣誓词保持原有长段，不拆句。'
    const overrides = { E: old + '\r\n' + custom }
    const original = JSON.stringify(overrides)
    const prompt = buildDeslopPrompt('“钱没收。收条在她手里。”', 'severe', [], ['E'], undefined, { textOverrides: overrides })
    for (const sent of [PLANNING_RULES, DESLOP_SYSTEM_PROMPT, prompt]) {
      expect(sent).toContain(DIALOGUE_PARAGRAPHS)
      expect(sent).not.toContain('不机械拆引号')
    }
    expect(prompt).toContain(custom)
    expect(JSON.stringify(overrides)).toBe(original)
  })

  it('嵌套覆盖在JSON转义前迁移，不把旧硬性排版重新注入整章精修', () => {
    const old = '- **一句一段**：每句完整的叙述独立成段，不在逗号处拆碎句子，不靠逗号硬接独立句子。'
    const custom = '作者自定：“账目别漏。”\n本项目对白可达70%，但不能补剧情。'
    const overrides = { systemPrompt: old + '\r\n' + custom, gates: { D: old } }
    const original = JSON.stringify(overrides)
    const sent = JSON.parse(serializeProseOverrides(overrides))
    expect(sent.systemPrompt).not.toContain(old)
    expect(sent.gates.D).not.toContain(old)
    expect(sent.systemPrompt).toContain(custom)
    expect(sent.gates.D).toContain('不要为合段改变原意或搬动动作')
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
    expect(migrated.style_targets).toContain('默认一句一段，段间空一行')
    expect(migrated.gates.D).toContain('既有前部保持原样')
    expect(migrated.style_targets).toContain(author)
    expect(migrated.style_targets).not.toContain(old)
    expect(JSON.stringify(overrides)).toBe(original)
  })
})


describe('番茄首章读者互动约定', () => {
  it('默认不再自动生成首章寄存语，规划与精修提示不再包含生成约定', () => {
    for (const prompt of [PLANNING_RULES, DESLOP_SYSTEM_PROMPT]) {
      expect(prompt).not.toContain('脑子寄存处】这是作者指定')
      expect(prompt).not.toContain('第二章起、七猫和平台未明项目不自动生成')
    }
    expect(READER_NOTE_BOUNDARY).toContain('现行默认不再自动生成')
    expect(READER_NOTE_BOUNDARY).toContain('不按关键词删除正文')
  })
})
