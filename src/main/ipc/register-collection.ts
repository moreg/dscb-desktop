import { safeHandle } from './safe-handle'

interface CollectionOps {
  list: (projectId: string) => Promise<unknown>
  get?: (projectId: string, id: string) => Promise<unknown>
  create: (projectId: string, input: any) => Promise<unknown>
  update: (projectId: string, id: string, patch: any) => Promise<unknown>
  delete: (projectId: string, id: string) => Promise<void>
}

export function registerCollectionIpc(prefix: string, ops: CollectionOps): void {
  safeHandle(`${prefix}:list`, (_e, pid: string) => ops.list(pid))
  if (ops.get) {
    safeHandle(`${prefix}:get`, (_e, pid: string, id: string) => ops.get!(pid, id))
  }
  safeHandle(`${prefix}:create`, (_e, pid: string, input: any) => ops.create(pid, input))
  safeHandle(`${prefix}:update`, (_e, pid: string, id: string, patch: any) =>
    ops.update(pid, id, patch)
  )
  safeHandle(`${prefix}:delete`, (_e, pid: string, id: string) => ops.delete(pid, id))
}
