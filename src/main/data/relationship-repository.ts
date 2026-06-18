import { join } from 'path'
import { JsonCollectionRepository } from './json-collection-repository'
import type {
  Relationship,
  CreateRelationshipInput,
  UpdateRelationshipInput
} from '../../shared/types'

export class RelationshipRepository {
  constructor(private readonly projectDir: string) {}

  private repo(): JsonCollectionRepository<Relationship> {
    return new JsonCollectionRepository<Relationship>(
      join(this.projectDir, 'memory', 'relationships.json')
    )
  }

  list(): Promise<Relationship[]> {
    return this.repo().list()
  }

  get(id: string): Promise<Relationship | null> {
    return this.repo().get(id)
  }

  async create(input: CreateRelationshipInput): Promise<Relationship> {
    const now = new Date().toISOString()
    return this.repo().create({ ...input, createdAt: now, updatedAt: now })
  }

  async update(id: string, patch: UpdateRelationshipInput): Promise<Relationship> {
    return this.repo().update(id, { ...patch, updatedAt: new Date().toISOString() })
  }

  delete(id: string): Promise<void> {
    return this.repo().delete(id)
  }
}
