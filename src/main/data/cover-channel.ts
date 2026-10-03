import type { CoverChannel, CoverComposition } from '../../shared/types'

const CHANNEL_LOCK = /^\s*(?:Cover channel subject (?:lock|reminder)|人物频道(?:约束|提醒)) \[(?:male|female)\][:：]/i
const SUBJECT_PREFIX = /^(?:Main subject:|主体人物：)\s*/i
const STYLE_PREFIX = /^(?:Selected visual style lock\b|画风约束[（(])/i
const SCENE_PREFIX = /^(?:no human figure as main subject\b|无主体人物)/i
const NO_PEOPLE = /\bno (?:human figure as main subject|human figures?|human characters?|main characters?|characters?|people|humans?)\b|\bwithout (?:human figures?|characters?|people|humans?)\b|(?<!不要)(?<!避免)(?<!拒绝)无(?:主体)?人物|不绘制人物|不要人物(?!变化|改变|变成|年轻化|不变)|不要人像|不画人物|不出现人物|(?<!不要)(?<!避免)(?<!拒绝)纯场景/gi

/** 明确频道必须有人物；双人构图保留，两位主体使用同一频道性别。 */
export function resolveCoverChannelComposition(composition: CoverComposition, channel?: CoverChannel): CoverComposition {
  return channel && composition === 'scene' ? 'closeup' : composition
}

function replaceGenderWords(description: string, channel: CoverChannel): string {
  const replacements: Array<[RegExp, string]> = channel === 'male' ? [
    [/\bswordswomen\b/gi, 'swordsmen'], [/\bswordswoman\b/gi, 'swordsman'],
    [/\bheroines\b/gi, 'heroes'], [/\bheroine\b/gi, 'hero'],
    [/\bnoblewoman\b/gi, 'nobleman'], [/\bbusinesswoman\b/gi, 'businessman'], [/\bpolicewoman\b/gi, 'policeman'],
    [/\bwomen\b/gi, 'men'], [/\bwoman\b/gi, 'man'],
    [/\bladies\b/gi, 'gentlemen'], [/\blady\b/gi, 'gentleman'],
    [/\bgirls\b/gi, 'boys'], [/\bgirl\b/gi, 'boy'], [/\bfemale\b(?![- ]audience)/gi, 'male'],
    [/\bshe\b/gi, 'he'], [/\bhers\b/gi, 'his'], [/\bher\b/gi, 'his'],
    [/女主角|女主/g, '男主角'], [/女性/g, '男性'], [/女人/g, '男人'], [/女士/g, '男士'], [/女子/g, '男子'], [/少女/g, '少年'], [/女孩/g, '男孩'], [/姑娘/g, '小伙'], [/公主/g, '王子'], [/她/g, '他'],
    [/女(?=将军|剑客|刀客|侦探|战士|医生|骑士|侠|教师|警察|商人|诗人|总裁|修士|学生)/g, '男']
  ] : [
    [/\bswordsmen\b/gi, 'swordswomen'], [/\bswordsman\b/gi, 'swordswoman'],
    [/\bheroes\b/gi, 'heroines'], [/\bhero\b/gi, 'heroine'],
    [/\bnobleman\b/gi, 'noblewoman'], [/\bbusinessman\b/gi, 'businesswoman'], [/\bpoliceman\b/gi, 'policewoman'],
    [/\bgentlemen\b/gi, 'ladies'], [/\bgentleman\b/gi, 'lady'],
    [/\bmen\b/gi, 'women'], [/\bman\b/gi, 'woman'],
    [/\bboys\b/gi, 'girls'], [/\bboy\b/gi, 'girl'], [/\bmale\b(?![- ]audience)/gi, 'female'],
    [/\bhe\b/gi, 'she'], [/\bhis\b/gi, 'her'], [/\bhim\b/gi, 'her'],
    [/男主角|男主/g, '女主角'], [/男性/g, '女性'], [/男人/g, '女人'], [/男士/g, '女士'], [/男子/g, '女子'], [/少年/g, '少女'], [/男孩/g, '女孩'], [/小伙/g, '姑娘'], [/王子/g, '公主'], [/(?<!其|别)他(?=的|身|穿|拿|手|头|站|坐|跪|持|戴|有|是|在|以|与|和|[，。；]|$)/g, '她'],
    [/男(?=将军|剑客|刀客|侦探|战士|医生|骑士|侠|教师|警察|商人|诗人|总裁|修士|学生)/g, '女']
  ]
  return replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), description)
}

/** 只对已分离的主体描述归一化，不触碰书名、署名或背景配角。 */
export function applyCoverChannelToCharacter(description: string, channel?: CoverChannel, composition?: CoverComposition): string {
  if (!channel) return description
  const gender = channel === 'male' ? '男性' : '女性'
  let normalized = replaceGenderWords(description, channel)
    .replace(NO_PEOPLE, `画面中有${gender}主体`)
  const hasGender = channel === 'male'
    ? /\bmale\b|\bman\b|\bmen\b|\bboy\b|\bboys\b|\bhero\b|\bheroes\b|\bswordsman\b|\bswordsmen\b|男性|男人|男主|少年|男孩|男士|男子|小伙|王子/i.test(normalized)
    : /\bfemale\b|\bwoman\b|\bwomen\b|\bgirl\b|\bgirls\b|\bheroine\b|\bheroines\b|\bswordswoman\b|\bswordswomen\b|女性|女人|女主|少女|女孩|女士|女子|姑娘|公主/i.test(normalized)
  if (!hasGender) normalized = `${gender}主体，${normalized}`
  if (composition === 'duo' && !normalized.startsWith(`两个主体均为${gender}。`) && !normalized.startsWith(`Both principal figures are ${channel}. `)) {
    normalized = `两个主体均为${gender}。${normalized}`
  }
  return normalized
}

/** 保留预设媒介、配色与构图特征，仅解除人物存在/性别的相反默认值。 */
export function applyCoverChannelToStyle(description: string, channel?: CoverChannel): string {
  if (!channel) return description
  const gender = channel === 'male' ? '男性' : '女性'
  return replaceGenderWords(description, channel)
    .replace(/no character illustration|不绘制人物插画|不画人物插画/gi, `绘制${gender}主体`)
    .replace(NO_PEOPLE, `画面中有${gender}主体`)
}

/**
 * 最终出图的人物锁。手改自由文本保持原文，由最外层明确覆盖冲突；
 * 标准主体/无人物构图行可确定性归一化，文字层与背景不做全文替换。
 * 重选频道剥离旧锁；返回自动模式时只解除本 helper 的锁，保留作者正文。
 */
export function withCoverChannel(prompt: string, channel?: CoverChannel): string {
  const body = prompt.split('\n').filter((line) => !CHANNEL_LOCK.test(line)).join('\n')
  if (!channel) return body
  const gender = channel === 'male' ? '男性' : '女性'
  const duo = /^(?:two figures|two (?:male|female) figures|duo composition|双人构图|两位人物)/im.test(body)
  const normalized = body.split('\n').map((line) => {
    if (SUBJECT_PREFIX.test(line)) {
      const prefix = line.match(SUBJECT_PREFIX)![0]
      return prefix + applyCoverChannelToCharacter(line.slice(prefix.length), channel, duo ? 'duo' : undefined)
    }
    if (STYLE_PREFIX.test(line)) {
      const colon = line.search(/[:：]/)
      return colon < 0 ? line : line.slice(0, colon + 1) + applyCoverChannelToStyle(line.slice(colon + 1), channel)
    }
    if (SCENE_PREFIX.test(line)) {
      return line.replace(SCENE_PREFIX, `人物特写，${gender}主体`)
        .replace(/,\s*landscape composition\b|[，,]\s*以环境场景为主/i, '')
    }
    if (/^two (?:male |female )?figures\b/i.test(line)) return line.replace(/^two (?:male |female )?figures/i, `两位${gender}人物`)
    if (/^两位(?:男性|女性)?人物/.test(line)) return line.replace(/^两位(?:男性|女性)?人物/, `两位${gender}人物`)
    return line
  }).join('\n')
  // 作者方向只覆盖明确修改的属性；人物性别和是否有人物仍以频道为准。
  const scoped = normalized
    .replace(/^Author visual direction \[managed\]: Author direction overrides conflicting baseline details; /m,
      'Author visual direction [managed]: Subject gender/presence follow the selected channel; ')
    .replace(/^作者画面方向 \[managed\][:：] 作者方向覆盖原提示词中冲突的细节；/m,
      '作者画面方向 [managed]: 人物性别与是否有人物以所选频道为准；')
  const lock = `人物频道约束 [${channel}]: 画面必须有可见的${gender}主体；双人构图时两个主体均为${gender}。优先级：所选人物性别与人物存在要求＞作者画面方向＞原提示词和参考图。保留未明确更改的角色属性、服饰、姿态、道具、环境与媒介。纯场景要求改为人物特写，已有双人构图保留。书名与署名保持原文，不引入读者或题材刻板印象。`
  return `${lock}\n${scoped}`
}
