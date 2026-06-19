const queues = new Map<string, Promise<void>>()

export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  queues.set(key, prev.then(() => gate))
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
}
