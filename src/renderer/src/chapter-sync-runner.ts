export type SyncStepId = 'index' | 'outline' | 'memory' | 'summary' | 'rhythm' | 'figure'
export interface SyncStep {
  id: SyncStepId
  status: 'pending' | 'running' | 'preview' | 'written' | 'reused' | 'failed'
  elapsedMs: number
  startedAt?: number
  error?: string
}
export interface SyncTask {
  id: SyncStepId
  run: () => Promise<boolean | undefined>
  written?: boolean
  always?: boolean
}

/** Successful analysis is reusable only while all source dependencies stay identical. */
export class ChapterSyncRunner {
  private receipts = new Map<SyncStepId, string>()
  invalidate(id?: SyncStepId): void { if (id) this.receipts.delete(id); else this.receipts.clear() }
  seed(id: SyncStepId, key: string): void { this.receipts.set(id, key) }
  async run(tasks: SyncTask[], context: () => Promise<string | null>, current: () => boolean,
    update: (step: SyncStep) => void, force = false): Promise<void> {
    const check = async (): Promise<string | null> => {
      if (!current()) throw new Error('正文或章节已变化，本次同步已停止；请保存后重新同步。')
      const key = await context()
      if (!current()) throw new Error('正文或章节已变化，本次同步已停止；请保存后重新同步。')
      return key
    }
    await check()
    const runTask = async (task: SyncTask): Promise<void> => {
      const key = await check()
      if (!force && !task.always && key && this.receipts.get(task.id) === key) {
        update({ id: task.id, status: 'reused', elapsedMs: 0 })
        return
      }
      this.invalidate(task.id)
      const startedAt = performance.now()
      update({ id: task.id, status: 'running', startedAt, elapsedMs: 0 })
      let checking = false
      try {
        if (!await task.run()) throw new Error('未完成，请查看该步骤的问题提示后重试。')
        checking = true
        const after = await check()
        if (task.id !== 'index' && key && after !== key) throw new Error('同步期间相关内容或模型配置已变化，请重新同步。')
        if (key && !task.always) this.seed(task.id, key)
        update({ id: task.id, status: task.written ? 'written' : 'preview', elapsedMs: performance.now() - startedAt })
      } catch (error) {
        if (!current() || checking) throw error
        update({ id: task.id, status: 'failed', elapsedMs: performance.now() - startedAt, error: (error as Error).message })
      }
    }
    // Materialize derived views first. Limit independent model jobs to two;
    // summaries still use their backend source/continuity gate on every run.
    const index = tasks.find(task => task.id === 'index')
    if (index) await runTask(index)
    const rest = tasks.filter(task => task.id !== 'index')
    for (let offset = 0; offset < rest.length; offset += 2) {
      const results = await Promise.allSettled(rest.slice(offset, offset + 2).map(runTask))
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    }
  }
}
