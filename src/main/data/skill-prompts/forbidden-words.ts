/**
 * 12 类禁用高频词清单。
 * 出自「正文写作」技能 SKILL.md 「禁用高频词」节 + zh-humanizer v3.1.1。
 * Prompt 注入时把全表喂给 LLM，要求"出现即视作 AI 味"。
 *
 * 维护原则：
 * - 只增不删（一旦判定某词是 AI 套路，就长期禁用）
 * - 类别内按字面排序，便于人眼审阅
 * - 每个词条都是字面匹配片段，不写正则——LLM 读字面更容易理解
 * - 题材例外：allowedGenres 列出的题材里该词降为 info（不阻断），其余题材仍为 warn
 *
 * 字面词 vs 正则：forbiddenPatterns 字段允许声明正则。
 *   - 用例：「嘴角+弧度」的底层模式（任何变体动词/量词都算）
 *   - 命中时 word 字段填正则 source id，便于 renderer 标记
 */

import type { GenreKey } from './genre-voice'

export type ForbiddenWordSeverity = 'warn' | 'info'

export interface ForbiddenWordCategory {
  /** 类别名，对应技能文档里的"第N类" */
  name: string
  /** 类别描述，1 句话说明命中场景 */
  hint: string
  /** 字面词条（命中时记入 word 字段） */
  words: readonly string[]
  /**
   * 正则模式（命中时不计入 word 字段，word 字段填 pattern.source.id）。
   * 用例：嘴角+弧度 底层模式（嘴角带了点弧度 / 嘴角微微上扬 / 嘴角弯了弯 / 嘴角挂着一丝笑）
   */
  patterns?: readonly ForbiddenPattern[]
  /**
   * 题材例外：这些题材里该类词降为 info（不阻断）。
   * 出处：技能「古风/仙侠特殊规则」节——古风允许的虚词清单。
   */
  allowedGenres?: readonly GenreKey[]
}

export interface ForbiddenPattern {
  /** 模式 id，命中时作为 word 字段的值 */
  id: string
  /** 模式说明，用于 message */
  reason: string
  pattern: RegExp
}

export const FORBIDDEN_WORD_CATEGORIES: readonly ForbiddenWordCategory[] = [
  {
    name: '夸张描写',
    hint: '物理动作过度修辞，破坏节奏',
    words: ['轰', '炸开', '轰然', '轰鸣', '波涛汹涌', '剧痛', '剧裂', '漆黑', '扭曲', '撕裂', '窒息', '沉闷']
  },
  {
    name: '表情动作模板',
    hint: '"嘴角+弧度""眼底闪过"等高频套路动作',
    words: [
      '嘴角勾起',
      '嘴角勾起一抹弧度',
      '眼中闪过一丝惊讶',
      '眼神深邃',
      '微微挑眉',
      '目光锐利',
      '目光热切',
      '目光坚定',
      '深吸一口气',
      '脸上堆满了笑',
      '指节泛白',
      '指节发白',
      '脸色变暗',
      '脸色变了',
      '目光扫过',
      '眼底闪过',
      '涌上心头',
      '眼中流露'
    ],
    // 「嘴角+弧度」底层模式：任何动词/量词变体都算 AI 味。
    // 技能说：无论动词/量词怎么换都算 AI 味（嘴角带了点弧度 / 嘴角微微上扬 / 嘴角弯了弯）。
    patterns: [
      {
        id: '嘴角_弧度_底层模式',
        reason: '"嘴角+弧度"底层模式：直接写"笑了"',
        pattern: /嘴角[^。\n]{0,12}弧度/
      },
      {
        id: '嘴角_上扬变体',
        reason: '"嘴角+动词"套路：直接写"笑了"',
        pattern: /嘴角[^。\n]{0,8}(微微|轻轻|轻轻一|淡淡|缓缓)?(上扬|上翘|微扬|一弯|一翘|带了点|弯了弯|勾了|微微一勾)/
      }
    ]
  },
  {
    name: '心理描写模板',
    hint: '直接给情绪结论，缺少行为佐证',
    words: [
      '心中一动',
      '心中一凛',
      '心下了然',
      '心中了然',
      '心中一片平静',
      '心中有了猜测',
      '他知道',
      '她知道',
      '他觉得',
      '她觉得',
      '心跳慢一拍',
      '心跳慢了一拍',
      '复杂的情绪',
      '莫名的情绪',
      '表面平静',
      '隐约觉得'
    ]
  },
  {
    name: '猜测虚词',
    hint: '"似乎/仿佛/像是"类模糊语，用多即 AI 味',
    words: [
      '似乎',
      '仿佛',
      '如同',
      '像是',
      '差不多',
      '大致',
      '可能',
      '或许',
      '恐怕',
      '显然',
      '明显',
      '像是在'
    ]
  },
  {
    name: '强度副词',
    hint: '"十分/极其/异常"无量化的强度描述',
    words: [
      '十分',
      '十分沉重',
      '格外',
      '极其',
      '异常',
      '绝对',
      '注定',
      '不可估量',
      '无法想象',
      '无法用言语形容'
    ]
  },
  {
    name: '时间频率',
    hint: '"接下来/此刻/这一刻"过渡套话',
    words: ['接下来', '渐渐', '更是', '一定', '再次', '一时之间', '这一刻', '此刻', '暂时'],
    // 技能「古风/仙侠特殊规则」：渐渐/此刻/一时之间 是古风正常时间词
    allowedGenres: ['xianxia', 'fantasy', 'minguo', 'historical']
  },
  {
    name: '对比结构',
    hint: '"不是…而是…""不仅…而且…"的工整对仗',
    words: ['取而代之的是', '不是…而是', '不仅…而且', '看似']
  },
  {
    name: '其他 AI 特征词',
    hint: '"郑重/平静地/坚定地"等高频修饰',
    words: [
      '不知道',
      '清淡',
      '郑重',
      '平静地',
      '略显兴奋',
      '激动地',
      '不卑不亢',
      '毋庸置疑',
      '坚定地',
      '纯粹',
      '清冷',
      '冰凉',
      '沸腾'
    ]
  },
  {
    name: '比喻过度',
    hint: '"像淬了毒的匕首"这类一眼即模板的比喻',
    words: [
      '像是淬了毒的匕首',
      '像在看一个死人',
      '像在看蝼蚁',
      '甜腻',
      '像是在说',
      '轻描淡写',
      '行云流水'
    ]
  },
  {
    name: '物理夸张',
    hint: '"炸雷/闷响/凝固"无依据的物理感',
    words: ['炸雷', '闷响', '僵住了', '凝固', '诅咒']
  },
  {
    name: '抽象氛围/修饰',
    hint: '"一丝+情绪""一抹+表情""微微+动作"模板',
    words: [
      '一丝',
      '一抹',
      '气氛微妙',
      '气氛变得',
      '惊涛骇浪',
      '空气凝固',
      '弥漫着',
      '表象之下',
      '显得格外'
    ],
    // 技能「古风/仙侠特殊规则」：一丝/一抹 在古风里可用（但要少，且不能和 AI 模板组合）
    allowedGenres: ['xianxia', 'minguo', 'historical']
  },
  {
    name: 'AI 套话与成语堆砌',
    hint: '"鱼肚白/夜色如墨/纷纷扬扬"等景物模板',
    words: [
      '鱼肚白',
      '夜色如墨',
      '大雨倾盆',
      '银装素裹',
      '如梦似幻',
      '余晖洒满大地',
      '纷纷扬扬',
      '踏上归途',
      '整个世界仿佛',
      '意味深长',
      '一丝不苟',
      '衣着整洁',
      '神情严肃',
      '似乎隐藏着什么',
      '哪里不对',
      '说不上来'
    ]
  }
] as const

/** 拍平所有字面词条供正则扫描（PR2 用） */
export function flattenForbiddenWords(): string[] {
  return FORBIDDEN_WORD_CATEGORIES.flatMap((c) => c.words as string[])
}

/** 拍平所有正则模式（含 source id）供 chapter-audit 扫描 */
export function flattenForbiddenPatterns(): Array<{
  category: string
  id: string
  reason: string
  pattern: RegExp
  allowedGenres?: readonly GenreKey[]
}> {
  const out: Array<{
    category: string
    id: string
    reason: string
    pattern: RegExp
    allowedGenres?: readonly GenreKey[]
  }> = []
  for (const cat of FORBIDDEN_WORD_CATEGORIES) {
    if (!cat.patterns) continue
    for (const p of cat.patterns) {
      out.push({
        category: cat.name,
        id: p.id,
        reason: p.reason,
        pattern: p.pattern,
        allowedGenres: cat.allowedGenres
      })
    }
  }
  return out
}

/** 渲染为 markdown 表格，供 system prompt 注入 */
export function renderForbiddenWordsMarkdown(): string {
  const lines: string[] = []
  for (const cat of FORBIDDEN_WORD_CATEGORIES) {
    lines.push(`- **${cat.name}**（${cat.hint}）：${cat.words.join('、')}`)
  }
  return lines.join('\n')
}
