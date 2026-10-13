export class AsyncLimiter {
  private active = 0
  private readonly queued: Array<() => void> = []

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('并发数必须为正整数')
  }

  run<Value>(action: () => Promise<Value>, signal?: AbortSignal): Promise<Value> {
    return new Promise<Value>((resolve, reject) => {
      const cancel = () => {
        const position = this.queued.indexOf(start)
        if (position >= 0) this.queued.splice(position, 1)
        signal?.removeEventListener('abort', cancel)
        reject(new Error('操作已取消'))
      }
      const start = () => {
        signal?.removeEventListener('abort', cancel)
        if (signal?.aborted) { reject(new Error('操作已取消')); return }
        this.active++
        Promise.resolve().then(() => { signal?.throwIfAborted(); return action() }).then(resolve, reject).finally(() => {
          this.active--
          this.drain()
        })
      }
      if (signal?.aborted) { reject(new Error('操作已取消')); return }
      signal?.addEventListener('abort', cancel, { once: true })
      this.queued.push(start)
      this.drain()
    })
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queued.length) this.queued.shift()!()
  }
}
