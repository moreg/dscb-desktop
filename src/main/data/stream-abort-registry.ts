/**
 * 流式 LLM 请求的 AbortController 注册表。
 * 用 requestId 关联 IPC 调用与底层 generateStream 的 signal，
 * 渲染进程可随时 invoke abort 打断续写 / 重写。
 *
 * 支持「先 abort、后 begin」：渲染端取消时若主进程尚未 beginStream，
 * 会记入 pendingAborts，begin 时直接返回已 aborted 的 signal，避免空跑整次 LLM。
 */

const controllers = new Map<string, AbortController>()
/** 渲染端在 beginStream 之前就 abort 的 requestId */
const pendingAborts = new Set<string>()

/** 登记新流；同 id 若已存在则先 abort 旧的。返回供 generate 使用的 signal。 */
export function beginStream(requestId: string): AbortSignal {
  const prev = controllers.get(requestId)
  if (prev && !prev.signal.aborted) prev.abort()

  const controller = new AbortController()
  if (pendingAborts.has(requestId)) {
    pendingAborts.delete(requestId)
    controller.abort()
    // 已取消：仍短暂登记，便于 endStream 对称清理
    controllers.set(requestId, controller)
    return controller.signal
  }

  controllers.set(requestId, controller)
  return controller.signal
}

/** 正常结束或异常结束时移除登记（不触发 abort）。 */
export function endStream(requestId: string): void {
  controllers.delete(requestId)
  pendingAborts.delete(requestId)
}

/**
 * 用户取消：abort 并移除。
 * 若流尚未 begin，记入 pending，返回 true（取消意图已登记）。
 * @returns 是否已中止进行中的流，或已登记 pending abort
 */
export function abortStream(requestId: string): boolean {
  const controller = controllers.get(requestId)
  if (controller) {
    controllers.delete(requestId)
    pendingAborts.delete(requestId)
    if (!controller.signal.aborted) controller.abort()
    return true
  }
  // 尚未 begin：登记 pending，begin 时立刻 aborted
  if (pendingAborts.has(requestId)) return true
  pendingAborts.add(requestId)
  return true
}

/** 测试用：当前进行中的 controller 数量 */
export function activeStreamCount(): number {
  return controllers.size
}

/** 测试用：pending abort 数量 */
export function pendingAbortCount(): number {
  return pendingAborts.size
}

/** 测试用：清空全部 */
export function clearAllStreams(): void {
  for (const c of controllers.values()) {
    if (!c.signal.aborted) c.abort()
  }
  controllers.clear()
  pendingAborts.clear()
}
