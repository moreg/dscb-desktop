/** 单次批量写作上限，界面、IPC 和服务共同使用。 */
export const MAX_BATCH_CHAPTERS = 100

export interface BatchRangeState {
  fromChapter: number
  total: number
  completed: number[]
  /** 正文已保存，恢复时先补跑该章的后处理。 */
  pendingPostProcessChapter?: number
}

/** 返回可直接显示的范围错误；null 表示可开始或恢复这一批。 */
export function getBatchRangeError(
  fromChapter: number,
  toChapter: number,
  batchState?: BatchRangeState
): string | null {
  const isChapter = (value: number) => Number.isSafeInteger(value) && value > 0
  if (!isChapter(fromChapter) || !isChapter(toChapter)) return '章号必须为正整数'
  if (fromChapter > toChapter) return '结束章号不能小于起始章号'
  if (toChapter - fromChapter + 1 > MAX_BATCH_CHAPTERS) {
    return `单次最多生成 ${MAX_BATCH_CHAPTERS} 章`
  }
  if (!batchState) return null
  if (
    !isChapter(batchState.fromChapter) ||
    batchState.fromChapter > fromChapter ||
    !Number.isSafeInteger(batchState.total) ||
    batchState.total < 1 ||
    batchState.total > MAX_BATCH_CHAPTERS ||
    batchState.total !== toChapter - batchState.fromChapter + 1
  ) return '整批进度与当前章节范围不一致，请重新选择范围'
  if (
    !Array.isArray(batchState.completed) ||
    batchState.completed.length > MAX_BATCH_CHAPTERS ||
    batchState.completed.some((chapter) =>
      !isChapter(chapter) || chapter < batchState.fromChapter || chapter > toChapter
    )
  ) return '已完成章节超出本批范围，请重新选择范围'
  if (
    batchState.pendingPostProcessChapter !== undefined &&
    (batchState.pendingPostProcessChapter !== fromChapter ||
      !batchState.completed.includes(batchState.pendingPostProcessChapter))
  ) return '待补跑后处理的章节与已保存进度不一致'
  return null
}
