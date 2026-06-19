import { randomUUID } from 'crypto'
import { readJson, writeJsonAtomic } from './atomic'
import { withFileLock } from './file-lock'

interface CollectionFile<T> {
  schemaVersion: number
  updatedAt: string
  items: T[]
}

const SCHEMA_VERSION = 1

export class JsonCollectionRepository<T extends { id: string }> {
  constructor(private readonly file: string) {}

  private async read(): Promise<CollectionFile<T>> {
    return readJson<CollectionFile<T>>(this.file, {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: '',
      items: []
    })
  }

  async list(): Promise<T[]> {
    return (await this.read()).items
  }

  async get(id: string): Promise<T | null> {
    return (await this.read()).items.find((x) => x.id === id) ?? null
  }

  async create(input: Omit<T, 'id'> & { id?: string }): Promise<T> {
    return withFileLock(this.file, async () => {
      const data = await this.read()
      const item = { ...input, id: input.id ?? randomUUID() } as T
      await writeJsonAtomic(this.file, {
        ...data,
        updatedAt: new Date().toISOString(),
        items: [...data.items, item]
      })
      return item
    })
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    return withFileLock(this.file, async () => {
      const data = await this.read()
      const idx = data.items.findIndex((x) => x.id === id)
      if (idx < 0) throw new Error(`item ${id} not found`)
      const updated = { ...data.items[idx], ...patch, id } as T
      const items = [...data.items]
      items[idx] = updated
      await writeJsonAtomic(this.file, { ...data, updatedAt: new Date().toISOString(), items })
      return updated
    })
  }

  async delete(id: string): Promise<void> {
    return withFileLock(this.file, async () => {
      const data = await this.read()
      const items = data.items.filter((x) => x.id !== id)
      await writeJsonAtomic(this.file, { ...data, updatedAt: new Date().toISOString(), items })
    })
  }
}
