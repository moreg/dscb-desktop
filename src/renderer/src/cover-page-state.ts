import type { CoverChannel, CoverComposition, CoverTypographyOptions } from '../../shared/types'

export type CoverChannelSelection = CoverChannel | 'auto'

/** Automatic channel selection must remain absent from both generation and extraction requests. */
export function coverChannelFields(selection: CoverChannelSelection): { channel?: CoverChannel } {
  return selection === 'auto' ? {} : { channel: selection }
}

/** A locked character channel always needs people, including after automatic extraction. */
export function resolveCoverChannelComposition(composition: CoverComposition, channel?: CoverChannel): CoverComposition {
  return channel && composition === 'scene' ? 'closeup' : composition
}

export interface CoverPromptRequest { revision: number; request: number }

/** A response belongs to both the current author edit and the latest request. */
export class CoverPromptRequestGuard {
  private revision = 0
  private request = 0

  invalidate(): void { this.revision++; this.request++ }
  begin(): CoverPromptRequest { return { revision: this.revision, request: ++this.request } }
  isCurrent(token: CoverPromptRequest): boolean {
    return token.revision === this.revision && token.request === this.request
  }
}

export function coverTextSettingsKey(bookName: string, authorName: string, typography: CoverTypographyOptions): string {
  return JSON.stringify([bookName.trim(), authorName.trim(), typography.titleFont ?? 'auto', typography.titlePosition ?? 'auto', typography.titleEffect ?? 'auto', typography.authorFont ?? 'auto', typography.authorPosition ?? 'auto'])
}

export function coverCustomTextConfirmationKey(prompt: string, settingsKey: string): string {
  return JSON.stringify([prompt, settingsKey])
}

export type CoverPromptTextState = 'empty' | 'matches' | 'mismatch' | 'custom'
export function inspectCoverPromptText(prompt: string, bookName: string, authorName: string): CoverPromptTextState {
  if (!prompt.trim()) return 'empty'
  const lines = prompt.split('\n')
  const title = lines.filter((line) => /^(?:书名文字：|Title text )/.test(line))
  const author = lines.filter((line) => /^(?:作者署名：|Author byline:)/.test(line))
  if (title.length !== 1 || author.length !== 1) return 'custom'
  const titleMatches = title[0].startsWith(`书名文字：'${bookName.trim()}'，`)
    || title[0].startsWith(`Title text '${bookName.trim()}' `)
  const authorMatches = author[0].startsWith(`作者署名：作者名'${authorName.trim()}'，`)
    || author[0].startsWith('Author byline:') && author[0].includes(`the author name '${authorName.trim()}' `)
  return titleMatches && authorMatches
    ? 'matches' : 'mismatch'
}

export function isCoverGenerationActive(phase?: string): boolean {
  return !!phase && ['preparing', 'generating', 'saving'].includes(phase)
}

export function describeCoverGenerationPhase(phase?: string): string {
  switch (phase) {
    case 'preparing': return '正在准备生成'
    case 'generating': return '图像模型正在生成，请稍候'
    case 'saving': return '正在保存封面与上传版'
    case 'completed': return '封面生成完成'
    case 'cancelled': return '封面生成已取消'
    case 'failed': return '封面生成失败'
    default: return '正在读取生成任务'
  }
}

export function coverCropObjectPosition(offsetX: number, offsetY: number): string {
  const clamp = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5))
  return `${clamp(offsetX) * 100}% ${clamp(offsetY) * 100}%`
}
