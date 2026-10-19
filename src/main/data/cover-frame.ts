/** 从生图请求开始使用 3:4，成品仅等比缩放。 */
export const COVER_GENERATION_WIDTH = 1536
export const COVER_GENERATION_HEIGHT = 2048
export const COVER_GENERATION_SIZE = `${COVER_GENERATION_WIDTH}x${COVER_GENERATION_HEIGHT}`
export const COVER_FINISHED_RATIO = 3 / 4
export const COVER_TEXT_SAFE_MARGIN = { horizontal: 0.06, vertical: 0.06 } as const

export const COVER_FRAME_SAFETY_PROMPT =
  `画幅安全区：直接生成 ${COVER_GENERATION_SIZE}（3:4）的竖版封面，完整画面即成品构图，不生成其他比例再裁剪。` +
  `书名与署名的每个字形距原画布上下边缘至少留出画布高度的 ${COVER_TEXT_SAFE_MARGIN.vertical * 100}%，距左右边缘至少留出画布宽度的 ${COVER_TEXT_SAFE_MARGIN.horizontal * 100}%。` +
  '人物面部和关键道具须完整呈现。背景延伸到画布四边，不添加边框或裁剪标记。'


/** 更新可识别的系统安全区行，手改正文不作全文替换；旧版提示词也使用实际画布。 */
export function withCoverFrameSafety(prompt: string): string {
  let replaced = false
  const lines = prompt.split('\n').flatMap((line) => {
    if (/^\s*(?:Frame safety:|画幅安全区：)/i.test(line)) {
      if (replaced) return []
      replaced = true
      return [COVER_FRAME_SAFETY_PROMPT]
    }
    // 只迁移旧版系统结尾，画幅与文字边距统一由安全区行约束。
    if (/^professional (?:print-ready cover art|book cover),/i.test(line)) {
      return [line.replace(/, portrait 3:4 ratio, keep title and author name inside the central safe area away from edges \(inner ~85%\)/i, '')]
    }
    return [line]
  })
  const body = lines.join('\n')
  return replaced ? body : `${body}${body.endsWith('\n') ? '' : '\n'}${COVER_FRAME_SAFETY_PROMPT}`
}
