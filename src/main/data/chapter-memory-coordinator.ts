/** Per-chapter cancellation plus per-project commit ordering. No model call holds the commit queue. */
export interface MemorySyncTicket {
  key: string
  projectId: string
  controller: AbortController
}

export class ChapterMemoryCoordinator {
  private readonly active = new Map<string, MemorySyncTicket>()
  private readonly commits = new Map<string, Promise<unknown>>()

  begin(projectId: string, chapter: number): MemorySyncTicket {
    this.invalidate(projectId, chapter)
    const key = JSON.stringify([projectId, chapter])
    const ticket = { key, projectId, controller: new AbortController() }
    this.active.set(key, ticket)
    return ticket
  }

  invalidate(projectId: string, chapter: number): void {
    const key = JSON.stringify([projectId, chapter])
    this.active.get(key)?.controller.abort()
    this.active.delete(key)
  }

  current(ticket: MemorySyncTicket): boolean {
    return this.active.get(ticket.key) === ticket && !ticket.controller.signal.aborted
  }

  finish(ticket: MemorySyncTicket): void {
    if (this.active.get(ticket.key) === ticket) this.active.delete(ticket.key)
  }

  async exclusive<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.commits.get(projectId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(action)
    this.commits.set(projectId, next)
    try { return await next } finally {
      if (this.commits.get(projectId) === next) this.commits.delete(projectId)
    }
  }
}
