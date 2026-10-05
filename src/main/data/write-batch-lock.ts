/** 桌面和手机批量写作、批量精修共用的项目锁。 */
export const activeBatchProjects = new Set<string>()

export function acquireBatchProject(projectId: string): () => void {
  if (activeBatchProjects.has(projectId)) {
    throw new Error('BATCH_ALREADY_RUNNING: 该项目已有批量任务，请等待当前任务结束')
  }
  activeBatchProjects.add(projectId)
  let released = false
  return () => {
    if (released) return
    released = true
    activeBatchProjects.delete(projectId)
  }
}
