/**
 * 开书去 AI 味辅助函数（从 opening-service.ts 提取，避免 service 文件过长）。
 * 落盘前对叙述性文件跑 deslop；失败降级为原文（不阻塞落盘）。
 * 保留边界：不删结构字段（节奏标注/字数/伏笔编号/表格列头），只清洗叙述性段落。
 */

import type { DeslopService } from './deslop/deslop-service'
import { splitByChapterMarker } from './opening-markdown'

/**
 * 对单个文件内容去 AI 味。
 * - 大纲层级用轻量（levelOverride: 'mild'，Gate A+B+G）
 * - 失败/超时降级为原文（不阻塞落盘）
 * - 保留结构字段：deslop 天然只清洗叙述性段落，表格/字段行不受影响
 */
export async function deslopSingleContent(
  content: string,
  deslopService?: DeslopService
): Promise<string> {
  if (!deslopService || !content.trim()) return content
  try {
    const result = await deslopService.deslop(content, { levelOverride: 'mild' })
    return result.rewritten || content
  } catch (err) {
    console.warn('[opening-service] 去 AI 味失败，降级为原文:', err)
    return content
  }
}

/** 对设定/大纲目录的多文件内容去 AI 味 */
export async function deslopFileMap(
  fileMap: Record<string, string>,
  deslopService?: DeslopService
): Promise<Record<string, string>> {
  if (!deslopService) return fileMap
  const result: Record<string, string> = {}
  for (const [relPath, content] of Object.entries(fileMap)) {
    result[relPath] = await deslopSingleContent(content, deslopService)
  }
  return result
}

/** 对细纲合并内容去 AI 味（按章拆分后逐章 deslop，保留章节分隔符） */
export async function deslopChapterContent(
  chaptersMd: string,
  deslopService?: DeslopService
): Promise<string> {
  if (!deslopService) return chaptersMd
  const chapters = splitByChapterMarker(chaptersMd)
  if (chapters.length === 0) return deslopSingleContent(chaptersMd, deslopService)
  const deslopedParts: string[] = []
  for (const ch of chapters) {
    const desloped = await deslopSingleContent(ch.content, deslopService)
    deslopedParts.push(desloped)
  }
  // 重新拼接：用 === 第N章 === 分隔符还原
  return deslopedParts
    .map((c, i) => (i === 0 ? c : `\n\n=== 第${chapters[i].chapterNumber}章 ===\n${c}`))
    .join('')
}
