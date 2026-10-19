import type { GenerateCoverInput } from '../../shared/types'
import { analyzeCoverVisualDirection, withVisualDirection } from './cover-visual-direction'
import { COVER_STYLE_PRESETS, COVER_STYLE_MEDIUM_REQUIREMENTS } from './skill-prompts/cover/cover-styles'

export function requestsCoverVisualPlanChange(direction?: string): boolean {
  return (direction ?? '').split(/[，,。;；\n]/).some(clause =>
    !/(?:不要|不用|无需|不想|别)(?:再)?(?:换|改)|不换|保持.*(?:画风|风格|方案)/.test(clause) &&
    /(?:换|改|尝试)(?:一种|一套|一个|个|种|套|成|为|一下|不同的|新的|别的|另一种|另一套|其他的|\s)*(?:画风|风格|方案)/.test(clause)
  )
}

/** Apply current controls even when extraction has frozen an older prompt. */
export function applyCoverGenerationStyle(prompt: string, input: GenerateCoverInput, variant = 0): string {
  const requestedMedium = analyzeCoverVisualDirection(input.visualDirection).medium
  const selected = input.stylePreset && input.stylePreset !== 'auto' ? COVER_STYLE_PRESETS[input.stylePreset] : undefined
  const selectedMedium = input.stylePreset === 'anime_illustration' || input.stylePreset === 'anime_light'
    ? 'anime' : input.stylePreset === 'photorealistic' ? 'photo' : undefined
  const medium = requestedMedium ?? selectedMedium ?? analyzeCoverVisualDirection(prompt).medium
  let body = prompt
  if (selected || requestedMedium || (variant > 0 && medium === 'anime')) {
    body = body.split('\n').filter(line => !/^(?:画风约束[（(]|画风参考[（(]|Selected visual style lock|Photographic medium lock:|2D anime medium lock:|写实媒介约束：|二次元媒介约束：|二次元成品标准：)/i.test(line)).join('\n')
  }
  // A direction changing the medium supersedes the preset, not the novel's characters.
  if (selected && !requestedMedium && !(variant > 0 && medium === 'anime')) body = `画风约束（${selected.label}）：${selected.prompt}。\n${body}`
  const enforceMedium = Boolean(requestedMedium || selectedMedium || variant > 0)
  if (medium === 'anime' && enforceMedium) {
    const requirement = variant > 0
      ? COVER_STYLE_MEDIUM_REQUIREMENTS.anime_illustration!.replace('线稿清晰生动，赛璐璐阴影分层', '采用本次方案指定的二维绘制语言')
      : COVER_STYLE_MEDIUM_REQUIREMENTS.anime_illustration
    body = `${requirement}。人物和背景统一采用二维动漫表现；旧画面资料中的摄影、写实肤质等媒介措辞不生效，只保留角色与场景内容。\n${body}`
    const animeAcceptance = '二次元成品标准：人物必须一眼可辨为二维漫画角色，轮廓用清晰手绘线条定义，鼻口简化、眼睛采用漫画化表达，肤色采用平涂或手绘色块。赛璐璐方案采用两至三阶硬边阴影，水彩方案采用二维线稿和水彩色块；禁止乙游半写实人像、照片描摹、真实皮肤纹理、真人面部建模和三维渲染。保持角色原有年龄和身份，动漫化不等于幼态化。'
    body = body.split('\n').map(line => /^(?:光线：|Lighting:)/i.test(line)
      ? line.replace(/肤光/g, '二维色块明暗').replace(/精致杂志高光/g, '手绘亮部') : line).join('\n')
    body = `${body}\n${animeAcceptance}`
  }
  if (medium === 'photo' && enforceMedium) body = `${COVER_STYLE_MEDIUM_REQUIREMENTS.photorealistic}。\n${body}`
  if (variant > 0) {
    const direction = analyzeCoverVisualDirection(input.visualDirection)
    body = body.split('\n').filter(line =>
      !(!direction.palette && /^(?:配色：|Color palette:)/i.test(line)) &&
      !(!direction.lighting && /^(?:光线：|Lighting:)/i.test(line))
    ).join('\n')
    body += '\n换方案要求：在指定媒介内结合故事重新设计绘制语言和画面组织，不重复原来的通用人像构图，不只是换脸、花瓣或颜色。保留小说人物身份、服饰、关键道具、故事场景与准确书名署名；明确指定的构图、字体和作者方向仍优先。'
  }
  return withVisualDirection(body, input.visualDirection, input.channel)
}
