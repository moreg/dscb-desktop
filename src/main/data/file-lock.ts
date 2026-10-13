const queues = new Map<string, Promise<void>>()

export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const next = prev.then(() => gate, () => gate)
  queues.set(key, next)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (queues.get(key) === next) queues.delete(key)
  }
}
