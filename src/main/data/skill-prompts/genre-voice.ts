/**
 * 题材→语感替换表。
 * 出自「正文写作」技能 SKILL.md「小说类型语感适配」节。
 *
 * 核心原则：去 AI 味的原则在所有类型中通用，但替换的"语感"必须匹配题材，
 * 否则会违和（古风用"卧槽"、现代用"本座"都出戏）。
 *
 * 9 类题材：古风/仙侠、现代都市、玄幻/修仙、民国、悬疑/推理、搞笑/沙雕、虐文、军史/正剧、末日/废土
 */

export type GenreKey =
  | 'xianxia' // 古风/仙侠
  | 'urban' // 现代都市
  | 'fantasy' // 玄幻/修仙
  | 'minguo' // 民国
  | 'mystery' // 悬疑/推理
  | 'comedy' // 搞笑/沙雕
  | 'tragedy' // 虐文
  | 'historical' // 军史/正剧
  | 'wasteland' // 末日/废土

export interface GenreVoice {
  key: GenreKey
  /** 中文名（与项目 project.genre 字段做模糊匹配） */
  label: string
  /** 一句话风格定调 */
  tone: string
  /** 节奏特点 */
  pace: string
  /** 句式特点 */
  syntax: string
  /** 禁忌（题材内不能用的语言风格） */
  taboo: string
  /** 允许保留的虚词（在该题材内不算 AI 味） */
  allowedHedges?: string[]
  /** 题材专属的替换示例：左 AI 味 → 右本题材自然 */
  replacements: readonly [string, string][]
}

export const GENRE_VOICES: readonly GenreVoice[] = [
  {
    key: 'xianxia',
    label: '古风/仙侠',
    tone: '半文半白，江湖气、文气兼有',
    pace: '中等，层层递进',
    syntax: '长短句交替，文言虚词点缀（方/尚/约莫/竟）',
    taboo: '禁用现代口语（卧槽/牛逼/绝了/打工人）',
    allowedHedges: ['渐渐', '此刻', '一时之间', '似乎', '仿佛', '一丝', '一抹'],
    replacements: [
      ['嘴角带了点弧度', '勾了勾唇 / 笑了笑'],
      ['眼底闪过一丝复杂', '看了她一眼，没说话'],
      ['心跳慢了一拍', '顿了顿 / 愣了一瞬'],
      ['气氛微妙', '无人说话 / 两人都没再开口'],
      ['意味深长的笑', '笑了笑，没接话'],
      ['像是在思考什么', '沉默了一瞬'],
      ['弥漫着压抑感', '厅中无人说话'],
      ['隐约觉得不对', '微微蹙眉'],
      ['天边泛起鱼肚白', '天色将明 / 天光微亮'],
      ['夜色如墨', '夜色沉沉 / 四下无人'],
      ['莫名的情绪涌上心头', '心头一滞，没接话'],
      ['没说话', '没接话 / 未再言语'],
      ['愣了一下', '顿了顿 / 怔了一瞬']
    ]
  },
  {
    key: 'urban',
    label: '现代都市',
    tone: '口语化、接地气、带梗',
    pace: '快、干脆',
    syntax: '短句为主，对话多，内心吐槽多',
    taboo: '禁用文绉绉书面腔、古风称谓',
    replacements: [
      ['嘴角带了点弧度', '笑了一下'],
      ['眼底闪过一丝复杂', '看了她一眼，没说话'],
      ['心跳慢了一拍', '愣了一下'],
      ['气氛微妙', '没人说话'],
      ['意味深长的笑', '笑了一下但没解释'],
      ['像是在思考什么', '沉默了一会儿'],
      ['弥漫着压抑感', '没人说话'],
      ['隐约觉得不对', '皱了下眉'],
      ['他对此感到十分不满', '他心里直骂娘'],
      ['他决定采取行动', '他坐不住了'],
      ['天边泛起鱼肚白', '天刚亮 / 外面刚有点光'],
      ['夜色如墨', '街上只剩路灯']
    ]
  },
  {
    key: 'fantasy',
    label: '玄幻/修仙',
    tone: '偏白话，保留修炼术语',
    pace: '中等',
    syntax: '长短句交替，江湖气',
    taboo: '禁用现代网络用语（buff/MVP/打工人）',
    allowedHedges: ['似乎', '渐渐', '一丝', '一抹'],
    replacements: [
      ['嘴角带了点弧度', '笑了一下'],
      ['心跳慢了一拍', '顿了顿'],
      ['气氛微妙', '无人说话'],
      ['隐约觉得不对', '皱了下眉'],
      ['天边泛起鱼肚白', '天刚亮'],
      ['莫名的情绪涌上心头', '愣了一下，没接话']
    ]
  },
  {
    key: 'minguo',
    label: '民国',
    tone: '半文半白，有时代特色用语',
    pace: '中等',
    syntax: '长短句兼有，洋行/军阀/旗袍的时代细节',
    taboo: '禁用网络流行语、纯古风称谓',
    replacements: [
      ['嘴角带了点弧度', '笑了笑'],
      ['气氛微妙', '一时间没人说话'],
      ['天边泛起鱼肚白', '天刚蒙蒙亮']
    ]
  },
  {
    key: 'mystery',
    label: '悬疑/推理',
    tone: '克制、留白、信息量密',
    pace: '紧凑、步步紧逼',
    syntax: '短句、断句、倒装、碎片化',
    taboo: '禁用啰嗦解释、全盘托出',
    replacements: [
      ['嘴角带了点弧度', '没有表情'],
      ['心跳慢了一拍', '动作顿住'],
      ['气氛微妙', '没人说话'],
      ['弥漫着压抑感', '空气里只剩呼吸声']
    ]
  },
  {
    key: 'comedy',
    label: '搞笑/沙雕',
    tone: '玩梗、自嘲、荒诞',
    pace: '快、跳跃',
    syntax: '短句、感叹号、省略号',
    taboo: '禁用正经煽情',
    replacements: [
      ['嘴角带了点弧度', '咧着大嘴傻乐'],
      ['心跳慢了一拍', '整个人都不好了'],
      ['气氛微妙', '空气突然安静']
    ]
  },
  {
    key: 'tragedy',
    label: '虐文',
    tone: '压抑、细腻、隐忍',
    pace: '慢、刀刀见血',
    syntax: '长句、反复、细节堆叠',
    taboo: '禁用轻松玩梗',
    replacements: [
      ['嘴角带了点弧度', '没笑'],
      ['心跳慢了一拍', '那句话落下来，她一时没接住'],
      ['气氛微妙', '两个人都没再说话']
    ]
  },
  {
    key: 'historical',
    label: '军史/正剧',
    tone: '沉稳、厚重、克制',
    pace: '稳、不急',
    syntax: '长句、排比、对仗',
    taboo: '禁用轻浮、网络用语',
    replacements: [
      ['嘴角带了点弧度', '神色未动'],
      ['气氛微妙', '众人沉默']
    ]
  },
  {
    key: 'wasteland',
    label: '末日/废土',
    tone: '粗粝、冷硬、生存感',
    pace: '紧张、喘不过气',
    syntax: '短句、碎片、感官描写',
    taboo: '禁用温馨浪漫',
    replacements: [
      ['嘴角带了点弧度', '咬了咬牙'],
      ['心跳慢了一拍', '呼吸卡住'],
      ['气氛微妙', '只剩风声']
    ]
  }
] as const

/** 当 project.genre 文本无法精确匹配时回退到 urban。urban 风格最普适。 */
const DEFAULT_GENRE: GenreKey = 'urban'

/**
 * 根据 project.genre 字段（中文用户输入）解析出 GenreVoice。
 * 规则：包含关键字即命中（古风 → xianxia、修仙/玄幻 → fantasy 等）。
 */
export function resolveGenreVoice(genre?: string): GenreVoice {
  if (!genre || !genre.trim()) return GENRE_VOICES.find((g) => g.key === DEFAULT_GENRE)!
  const g = genre.trim()
  // 顺序敏感：先匹配更具体的（仙侠 优先于 玄幻；末日 优先于 都市）
  const rules: Array<[RegExp, GenreKey]> = [
    [/仙侠|古风|宫廷|江湖/, 'xianxia'],
    [/末日|废土|丧尸|生存/, 'wasteland'],
    [/玄幻|修仙|修真|奇幻/, 'fantasy'],
    [/民国|穿越.*民国|抗战/, 'minguo'],
    [/悬疑|推理|犯罪|侦探/, 'mystery'],
    [/搞笑|沙雕|轻松|穿越.*搞笑/, 'comedy'],
    [/虐|BE|be|苦情/, 'tragedy'],
    [/军史|历史|正剧|战争/, 'historical'],
    [/都市|现代|职场|娱乐圈|校园/, 'urban']
  ]
  for (const [pattern, key] of rules) {
    if (pattern.test(g)) {
      const found = GENRE_VOICES.find((v) => v.key === key)
      if (found) return found
    }
  }
  return GENRE_VOICES.find((g) => g.key === DEFAULT_GENRE)!
}

/** 把单个题材的语感渲染为 markdown 段落（注入 system prompt） */
export function renderGenreVoiceMarkdown(voice: GenreVoice): string {
  const lines: string[] = []
  lines.push(`**题材**：${voice.label}`)
  lines.push(`- 风格：${voice.tone}`)
  lines.push(`- 节奏：${voice.pace}`)
  lines.push(`- 句式：${voice.syntax}`)
  lines.push(`- 禁忌：${voice.taboo}`)
  if (voice.allowedHedges?.length) {
    lines.push(`- 该题材允许保留的虚词：${voice.allowedHedges.join('、')}`)
  }
  lines.push('')
  lines.push('**语感替换示例**（左 AI 味 → 右本题材自然写法）：')
  for (const [bad, good] of voice.replacements) {
    lines.push(`- "${bad}" → "${good}"`)
  }
  return lines.join('\n')
}
