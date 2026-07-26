import { safeHandle } from './safe-handle'

interface CollectionOps<TCreate = unknown, TPatch = unknown> {
  list: (projectId: string) => Promise<unknown>
  get?: (projectId: string, id: string) => Promise<unknown>
  create: (projectId: string, input: TCreate) => Promise<unknown>
  update: (projectId: string, id: string, patch: TPatch) => Promise<unknown>
  delete: (projectId: string, id: string) => Promise<void>
}

export function registerCollectionIpc<TCreate, TPatch>(
  prefix: string,
  ops: CollectionOps<TCreate, TPatch>
): void {
  safeHandle(`${prefix}:list`, (_e, pid: string) => ops.list(pid))
  if (ops.get) {
    safeHandle(`${prefix}:get`, (_e, pid: string, id: string) => ops.get!(pid, id))
  }
  safeHandle(`${prefix}:create`, (_e, pid: string, input: TCreate) => ops.create(pid, input))
  safeHandle(`${prefix}:update`, (_e, pid: string, id: string, patch: TPatch) =>
    ops.update(pid, id, patch)
  )
  safeHandle(`${prefix}:delete`, (_e, pid: string, id: string) => ops.delete(pid, id))
}
