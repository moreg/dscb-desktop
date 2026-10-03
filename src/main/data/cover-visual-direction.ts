import type { CoverChannel, CoverComposition } from '../../shared/types'

export interface CoverVisualDirectionAnalysis {
  medium?: 'anime' | 'photo' | 'illustration'
  noPeople?: boolean
  composition?: CoverComposition
  subjectFields: Array<'age' | 'gender' | 'ethnicity' | 'identity' | 'pose' | 'clothing'>
  lighting: boolean
  palette: boolean
}

/** 否定某种画风不等于要求采用它；未写到的维度保持原选择。 */
function hasAffirmative(text: string, pattern: RegExp): boolean {
  for (const clause of text.split(/[，,。;；\n]/)) {
    for (const match of clause.matchAll(new RegExp(pattern.source, 'gi'))) {
      const before = clause.slice(Math.max(0, (match.index ?? 0) - 16), match.index).trim()
      const after = clause.slice((match.index ?? 0) + match[0].length)
      if (/(?:不要|不用|不想要|不需要|不走|不采用|不使用|拒绝|避免|禁止|别用|别画|不是|并非|非|without|\bno|\bnot(?: want)?|\bdon't want|\bdo not want|\bavoid)(?:任何|采用|使用|画成|成|the|any|a|\s)*$/i.test(before)) continue
      if (/^\s*(?:不要|不用|禁止|不采用|不使用|is prohibited|is not desired)/i.test(after)) continue
      return true
    }
  }
  return false
}

/** A complete absence predicate cannot be a prefix of "don't change the character's clothes". */
function requestsNoPeople(clause: string): boolean {
  if (/背景|background/i.test(clause)) return false
  const chineseAbsence = /(?:不要|不画|不出现|不需要|别画)(?:任何)?(?:人物|人像)(?:出现|入镜|了)?(?=$|[.!！？]|\s*$|只画|仅画|只保留|只要|改成|改为)/
  const englishAbsence = /\b(?:no|without) (?:people|humans?|persons?|characters?)(?: (?:in|on) (?:the )?(?:cover|scene|frame|image))?(?=$|[.!?])/i
  if (hasAffirmative(clause, /无人物|纯场景/)) return true
  if (/(?:do not|don't) (?:want )?(?:no|without) (?:people|characters)|not (?:without|a no-people)/i.test(clause)) return false
  return hasAffirmative(clause.trim(), chineseAbsence) || englishAbsence.test(clause.trim())
}

export function analyzeCoverVisualDirection(direction?: string): CoverVisualDirectionAnalysis {
  const text = direction?.trim() ?? ''
  const anime = hasAffirmative(text, /二次元|动漫|漫画|赛璐璐|国漫|日漫|anime|manga|cel[- ]?shad/)
  const photo = hasAffirmative(text, /写实|真人|摄影|照片|photorealistic|live-action|photograph/)
  const illustration = hasAffirmative(text, /油画|水彩|水墨|插画|卡通|oil painting|watercolou?r|ink wash|illustration|cartoon/)
  const subjectFields: CoverVisualDirectionAnalysis['subjectFields'] = []
  const clauses = text.split(/[，,。;；\n]/).filter((clause) => !/人物不变|主角不变|不改人物|不改主角|不改变人物|不改变主角|不要(?:让)?(?:人物|主角)(?!出现|入镜)(?:的)?[^，,。;；\n]+|character unchanged|keep the same character|do not change (?:the )?character/i.test(clause))
  const subjectText = clauses.join(' ')
  const fields: Array<[CoverVisualDirectionAnalysis['subjectFields'][number], RegExp]> = [
    ['age', /\d+\s*岁|老年|中年|青年|少年|少女|儿童|elderly|middle-aged|young|child|years? old/i],
    ['gender', /女性|男性|女人|男人|女主|男主|女将军|男将军|少女|少年|\bwoman\b|\bman\b|\bfemale\b|\bmale\b|\bgirl\b|\bboy\b/i],
    ['ethnicity', /韩国|中国|日本|欧美|非洲|族裔|Korean|Chinese|Japanese|African|ethnicity/i],
    ['identity', /换主角|改主角|主角改|主角画|人物改|人物画|财阀|将军|侦探|刀客|剑客|职业|chaebol|general|detective|protagonist.*(?:replace|change)/i],
    ['pose', /坐姿|站姿|跪姿|坐着|站着|跪着|姿态|姿势|动作|seated|standing|kneeling|pose/i],
    ['clothing', /服装|服饰|衣服|裙|袍|甲|西装|穿着|clothing|costume|dress|robe|armor|suit/i]
  ]
  for (const [field, pattern] of fields) if (pattern.test(subjectText)) subjectFields.push(field)
  const noPeople = text.split(/[，,。;；\n]/).some(requestsNoPeople)
  let composition: CoverComposition | undefined
  if (noPeople) composition = 'scene'
  else if (hasAffirmative(text, /双人|两人|duo|two figures/)) composition = 'duo'
  else if (hasAffirmative(text, /全身|full[- ]?body/)) composition = 'fullbody'
  else if (hasAffirmative(text, /特写|半身|close[- ]?up/)) composition = 'closeup'
  return {
    ...(anime !== photo ? { medium: anime ? 'anime' as const : 'photo' as const } : illustration && !anime && !photo ? { medium: 'illustration' as const } : {}),
    ...(noPeople ? { noPeople: true } : subjectFields.length ? { noPeople: false } : {}),
    composition,
    subjectFields,
    lighting: /光线|灯光|光照|照明|调暗|调亮|lighting|light|darker|brighter/i.test(text),
    palette: /色调|颜色|冷色|暖色|色彩|配色|palette|colou?r|saturation/i.test(text)
  }
}

/** Remove only our own direction envelope, including the previous header/reminder format. */
export function stripCoverVisualDirectionEnvelope(prompt: string): string {
  const lines = prompt.split('\n')
  const output: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (/^(?:Author visual direction \[managed\]:|作者画面方向 \[managed\][:：])/i.test(line) && lines[index + 1] === '<author-visual-direction>') {
      const end = lines.indexOf('</author-visual-direction>', index + 2)
      if (end >= 0) { index = end; continue }
    }
    if (/^Author visual direction, absolute highest priority\./.test(line)) {
      // Only the immediately adjacent label belongs to the legacy wrapper. A later identical line may be an author edit.
      const label = lines[index + 1] === '' ? index + 2 : index + 1
      if (lines[label] === 'Subordinate cover prompt:') index = label
      continue
    }
    if (/^Author visual direction reminder: apply only the explicitly requested changes:/.test(line)) continue
    output.push(line)
  }
  return output.join('\n')
}

function isSystemMediumLine(line: string): boolean {
  return /^(?:Photographic medium lock:|2D anime medium lock:|Selected visual style lock \([^\n]+\):|写实媒介约束：|二次元媒介约束：|画风约束[（(][^\n]+[）)][:：])/i.test(line)
}

/** Change recognized tonal conflicts, preserving the light source, effects and palette accents. */
function reconcileStandardTone(line: string, direction: string, analysis: CoverVisualDirectionAnalysis): string {
  const lighting = /^(?:Lighting:|光线：)/i.test(line) && analysis.lighting
  const palette = /^(?:Color palette:|配色：)/i.test(line) && analysis.palette
  if (!lighting && !palette) return line
  const clauses = direction.split(/[，,。;；\n]/)
  const relevant = clauses.filter((clause) => palette
    ? /色调|颜色|冷色|暖色|色彩|配色|palette|colou?r|saturation/i.test(clause)
    : /光线|灯光|光照|照明|调暗|调亮|冷光|暖光|lighting|light|darker|brighter/i.test(clause)).join(' ')
  let updated = line
  const cool = hasAffirmative(relevant, /冷色|冷光|冷调|\b(?:cool|cold|blue)\b/)
  const warm = hasAffirmative(relevant, /暖色|暖光|暖调|\b(?:warm|amber)\b/)
  if (cool !== warm) {
    updated = cool
      ? updated.replace(/\bwarm\b/gi, 'cool').replace(/暖色|暖光|暖调|温暖/g, (value) => value === '温暖' ? '冷调' : value.replace('暖', '冷'))
      : updated.replace(/\b(?:cool|cold)\b/gi, 'warm').replace(/冷色|冷光|冷调/g, (value) => value.replace('冷', '暖'))
  }
  if (lighting) {
    const darker = hasAffirmative(relevant, /调暗|变暗|暗一点|昏暗|\b(?:darker|dim)\b/)
    const brighter = hasAffirmative(relevant, /调亮|变亮|亮一点|明亮|\bbrighter\b/)
    if (darker !== brighter) updated = darker
      ? updated.replace(/\b(?:bright|brilliant|intense)\b/gi, 'dim').replace(/明亮|强烈/g, '柔暗')
      : updated.replace(/\b(?:dim|faint)\b/gi, 'bright').replace(/昏暗|微弱/g, '明亮')
  }
  // Unparsed attributes remain a baseline; the envelope explicitly overrides only requested dimensions.
  return updated
}

export function withVisualDirection(prompt: string, direction?: string, channel?: CoverChannel): string {
  const text = direction?.trim()
  const clean = stripCoverVisualDirectionEnvelope(prompt)
  if (!text) return clean
  const analysis = analyzeCoverVisualDirection(text)
  // The channel already settles presence/gender. Do not erase the only copy of the character details.
  const noPeople = analysis.noPeople === true && !channel
  const body = clean.split('\n').filter((line) => {
    if (isSystemMediumLine(line)) {
      if (analysis.medium === 'anime' && /^写实媒介约束：|photographic medium lock|photorealistic live-action|真人写实封面/i.test(line)) return false
      if ((analysis.medium === 'photo' || analysis.medium === 'illustration') && /^二次元媒介约束：|2d anime medium lock|high-quality 2d anime novel cover|二次元动漫封面/i.test(line)) return false
      if (analysis.medium === 'illustration' && /^写实媒介约束：|photographic medium lock|photorealistic live-action|真人写实封面/i.test(line)) return false
    }
    if (noPeople && (/^(?:Main subject:|主体人物：)/i.test(line) || /^close-up portrait|^full body shot|^two (?:male |female )?figures|^人物特写|^全身构图|^双人构图|^两位(?:男性|女性)?人物/i.test(line))) return false
    return true
  }).map((line) => {
    let updated = line
    if ((analysis.noPeople === false || channel) && /^(?:no human figure as main subject|无主体人物)/i.test(updated)) {
      updated = updated.replace(/^(?:no human figure as main subject|无主体人物)/i, channel ? '人物特写，' + (channel === 'male' ? '男性' : '女性') + '主体' : '画面包含作者明确指定的人物')
        .replace(/,\s*landscape composition\b|[，,]\s*以环境场景为主/i, '')
    }
    if (/^professional print-ready cover art,|^专业印刷级封面[，,]/.test(updated) && analysis.medium) updated = updated
      .replace(/faithfully preserve the selected medium and visual language/gi, '采用作者明确指定的画面媒介')
      .replace(/保持所选媒介与视觉语言/g, '采用作者明确指定的画面媒介')
    if (/^Selected visual style lock\b|^画风约束[（(]/i.test(updated) && (analysis.noPeople === false || channel)) updated = updated.replace(/no people|no character illustration|无主体人物|无人物|不绘制人物插画|不绘制人物|不画人物插画|不出现人物/gi, '保留明确指定的人物')
    if (/^(?:Photographic medium lock:|2D anime medium lock:|写实媒介约束：|二次元媒介约束：)/i.test(updated) && analysis.subjectFields.length) updated = updated.replace(/preserve the story characters ages, identities and period-appropriate clothing|保留故事角色的年龄、身份和符合时代的服饰/gi,
      '保留作者方向未明确更改的角色属性')
    return reconcileStandardTone(updated, text, analysis)
  }).join('\n')
  const priority = channel ? '人物性别与是否有人物以所选频道为准；' : '作者方向覆盖原提示词中冲突的细节；'
  const header = '作者画面方向 [managed]: ' + priority + '仅应用明确要求的更改。保留未提及的角色属性、媒介、构图、书名、作者署名、画幅比例和安全区。被否定的选项表示禁止，不能当作要求。'
  return header + '\n<author-visual-direction>\n' + text + '\n</author-visual-direction>\n' + body
}
