/** 实际出图画布和居中裁剪后的封面共用这一份尺寸约定。 */
export const COVER_GENERATION_WIDTH = 1024
export const COVER_GENERATION_HEIGHT = 1536
export const COVER_GENERATION_SIZE = `${COVER_GENERATION_WIDTH}x${COVER_GENERATION_HEIGHT}`
export const COVER_FINISHED_RATIO = 3 / 4
export const COVER_TEXT_SAFE_MARGIN = { horizontal: 0.06, vertical: 0.11 } as const

// 2:3 原图转 3:4 时上下各裁 5.56%；原图上下留 11% 后，成品仍有至少 6% 留白。
const croppedEdgePercent = (1 - COVER_GENERATION_WIDTH / COVER_FINISHED_RATIO / COVER_GENERATION_HEIGHT) * 50
export const COVER_FRAME_SAFETY_PROMPT =
  `画幅安全区：生成 ${COVER_GENERATION_SIZE}（2:3）的竖版画布，居中裁剪为 3:4 成品封面；上下各裁去 ${croppedEdgePercent.toFixed(1)}%。` +
  `书名与署名的每个字形距原画布上下边缘至少留出画布高度的 ${COVER_TEXT_SAFE_MARGIN.vertical * 100}%，距左右边缘至少留出画布宽度的 ${COVER_TEXT_SAFE_MARGIN.horizontal * 100}%。` +
  '人物面部和关键道具须位于居中裁剪范围内。背景延伸到画布四边，不添加边框或裁剪标记。'


/** 更新可识别的系统安全区行，手改正文不作全文替换；旧版提示词也使用实际画布。 */
export function withCoverFrameSafety(prompt: string): string {
  let replaced = false
  const lines = prompt.split('\n').flatMap((line) => {
    if (/^\s*(?:Frame safety:|画幅安全区：)/i.test(line)) {
      if (replaced) return []
      replaced = true
      return [COVER_FRAME_SAFETY_PROMPT]
    }
    // 只迁移旧版系统结尾，避免同时要求模型直接生成 3:4 原图。
    if (/^professional (?:print-ready cover art|book cover),/i.test(line)) {
      return [line.replace(/, portrait 3:4 ratio, keep title and author name inside the central safe area away from edges \(inner ~85%\)/i, '')]
    }
    return [line]
  })
  const body = lines.join('\n')
  return replaced ? body : `${body}${body.endsWith('\n') ? '' : '\n'}${COVER_FRAME_SAFETY_PROMPT}`
}
