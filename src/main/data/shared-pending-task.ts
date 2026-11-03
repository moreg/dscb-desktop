/** Share only in-flight work. Each caller can cancel without cancelling other callers. */
export class SharedPendingTask<T> {
  private readonly tasks = new Map<string, { controller: AbortController; promise: Promise<T>; waiters: number; settled: boolean }>()

  run(key: string, signal: AbortSignal | undefined, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error('LLM_ABORTED'))
    let entry = this.tasks.get(key)
    if (!entry || entry.controller.signal.aborted) {
      const controller = new AbortController()
      const created = { controller, promise: undefined as unknown as Promise<T>, waiters: 0, settled: false }
      created.promise = Promise.resolve().then(() => start(controller.signal)).finally(() => {
        created.settled = true
        if (this.tasks.get(key) === created) this.tasks.delete(key)
      })
      entry = created
      this.tasks.set(key, created)
    }
    const task = entry
    task.waiters++
    return new Promise<T>((resolve, reject) => {
      let finished = false
      const finish = (deliver: () => void): void => {
        if (finished) return
        finished = true
        signal?.removeEventListener('abort', abort)
        task.waiters--
        if (!task.waiters && !task.settled) task.controller.abort()
        deliver()
      }
      const abort = (): void => finish(() => reject(new Error('LLM_ABORTED')))
      signal?.addEventListener('abort', abort, { once: true })
      task.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
      if (signal?.aborted) abort()
    })
  }
}
