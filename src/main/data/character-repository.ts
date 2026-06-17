import { join } from 'path'
import { JsonCollectionRepository } from './json-collection-repository'
import type { Character, CreateCharacterInput, UpdateCharacterInput } from '../../shared/types'

export class CharacterRepository {
  constructor(private readonly projectDir: string) {}

  private repo(): JsonCollectionRepository<Character> {
    return new JsonCollectionRepository<Character>(
      join(this.projectDir, 'memory', 'characters.json')
    )
  }

  list(): Promise<Character[]> {
    return this.repo().list()
  }

  get(id: string): Promise<Character | null> {
    return this.repo().get(id)
  }

  async create(input: CreateCharacterInput): Promise<Character> {
    const now = new Date().toISOString()
    return this.repo().create({ ...input, createdAt: now, updatedAt: now })
  }

  async update(id: string, patch: UpdateCharacterInput): Promise<Character> {
    return this.repo().update(id, { ...patch, updatedAt: new Date().toISOString() })
  }

  delete(id: string): Promise<void> {
    return this.repo().delete(id)
  }
}
