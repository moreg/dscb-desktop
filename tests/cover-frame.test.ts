import { describe, expect, it } from 'vitest'
import { Canvas, loadImage } from 'skia-canvas'
import { COVER_FRAME_SAFETY_PROMPT, COVER_GENERATION_HEIGHT, COVER_GENERATION_WIDTH, COVER_TEXT_SAFE_MARGIN, withCoverFrameSafety } from '../src/main/data/cover-frame'
import { renderCoverImage } from '../src/main/data/cover-image-output'

describe('封面生图画布与文字裁剪安全区', () => {
  it.each(['1023x1364', '600x800'])('原图约定的文字安全区经过实际裁剪到 %s 后仍留足 6%% 边距', async (target) => {
    const source = new Canvas(COVER_GENERATION_WIDTH, COVER_GENERATION_HEIGHT)
    const context = source.getContext('2d')
    const x = Math.ceil(COVER_GENERATION_WIDTH * COVER_TEXT_SAFE_MARGIN.horizontal)
    const y = Math.ceil(COVER_GENERATION_HEIGHT * COVER_TEXT_SAFE_MARGIN.vertical)
    context.fillStyle = '#ff0000'
    context.fillRect(x, y, COVER_GENERATION_WIDTH - 2 * x, COVER_GENERATION_HEIGHT - 2 * y)
    const result = await loadImage(await renderCoverImage(await source.toBuffer('png'), target))
    const canvas = new Canvas(result.width, result.height)
    const output = canvas.getContext('2d')
    output.drawImage(result, 0, 0)
    const column = output.getImageData(Math.floor(result.width / 2), 0, 1, result.height).data
    const row = output.getImageData(0, Math.floor(result.height / 2), result.width, 1).data
    const coloredIndices = (data: Uint8ClampedArray): number[] => Array.from({ length: data.length / 4 }, (_, index) => index).filter((index) => data[index * 4 + 3] > 128)
    const vertical = coloredIndices(column)
    const horizontal = coloredIndices(row)
    expect(vertical.length).toBeGreaterThan(result.height * 0.8)
    expect(vertical[0]).toBeGreaterThanOrEqual(Math.floor(result.height * 0.06))
    expect(result.height - vertical.at(-1)! - 1).toBeGreaterThanOrEqual(Math.floor(result.height * 0.06))
    expect(horizontal[0]).toBeGreaterThanOrEqual(Math.floor(result.width * 0.06))
    expect(result.width - horizontal.at(-1)! - 1).toBeGreaterThanOrEqual(Math.floor(result.width * 0.06))
  })

  it('旧版系统安全区与结尾迁移为实际画布，保留文字和手改行且重复应用不膨胀', () => {
    const original = "Title text '3:4 世界' above the scene.\nAuthor byline: the author name '6 percent' in white.\n\nMY EDIT: keep a 3:4 painting on the wall.\nFrame safety: leave 6 percent on each edge.\nprofessional print-ready cover art, faithfully preserve the selected medium and visual language, portrait 3:4 ratio, keep title and author name inside the central safe area away from edges (inner ~85%), no watermark, no text other than the title and author name\n"
    const updated = withCoverFrameSafety(original)
    expect(updated).toContain("Title text '3:4 世界' above the scene.")
    expect(updated).toContain("Author byline: the author name '6 percent' in white.")
    expect(updated).toContain('\n\nMY EDIT: keep a 3:4 painting on the wall.\n')
    expect(updated.match(/^画幅安全区：/gm)).toHaveLength(1)
    expect(updated).toContain(COVER_FRAME_SAFETY_PROMPT)
    expect(updated).not.toContain('inner ~85%')
    expect(updated).not.toContain('portrait 3:4 ratio')
    expect(updated).toContain('1024x1536（2:3）')
    expect(withCoverFrameSafety(updated)).toBe(updated)
  })

  it('自由手写提示词保留正文与末尾换行，只追加一份统一安全区', () => {
    const original = '  KEEP MY COMPOSITION\n\n'
    expect(withCoverFrameSafety(original)).toBe(original + COVER_FRAME_SAFETY_PROMPT)
    expect(withCoverFrameSafety(withCoverFrameSafety(original))).toBe(withCoverFrameSafety(original))
  })
})


it('中文安全区与英文旧安全区合并为一份中文约束，不改其他正文', () => {
  const prompt = "书名文字：'安全区 3:4'，顶部。\n作者署名：作者名'画幅安全区'，底部。\n画幅安全区：旧的边距。\nFrame safety: old.\n手改说明：保持旧照片中的Frame safety文字。\n"
  const output = withCoverFrameSafety(prompt)
  expect(output.match(/^画幅安全区：/gm)).toHaveLength(1)
  expect(output).toContain("书名文字：'安全区 3:4'，顶部。")
  expect(output).toContain("作者署名：作者名'画幅安全区'，底部。")
  expect(output).toContain('手改说明：保持旧照片中的Frame safety文字。')
  expect(output).toContain('上下各裁去 5.6%')
  expect(output).toContain('画布高度的 11%')
  expect(withCoverFrameSafety(output)).toBe(output)
})
