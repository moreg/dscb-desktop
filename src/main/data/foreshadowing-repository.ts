import { join } from 'path'
import { JsonCollectionRepository } from './json-collection-repository'
import type {
  Foreshadowing,
  CreateForeshadowingInput,
  UpdateForeshadowingInput
} from '../../shared/types'

export class ForeshadowingRepository {
  constructor(private readonly projectDir: string) {}

  private repo(): JsonCollectionRepository<Foreshadowing> {
    return new JsonCollectionRepository<Foreshadowing>(
      join(this.projectDir, 'memory', 'foreshadowings.json')
    )
  }

  list(): Promise<Foreshadowing[]> {
    return this.repo().list()
  }

  get(id: string): Promise<Foreshadowing | null> {
    return this.repo().get(id)
  }

  async create(input: CreateForeshadowingInput): Promise<Foreshadowing> {
    const now = new Date().toISOString()
    return this.repo().create({
      content: input.content,
      status: 'pending',
      expectedCollect: input.expectedCollect,
      note: input.note,
      createdAt: now,
      updatedAt: now
    })
  }

  async update(id: string, patch: UpdateForeshadowingInput): Promise<Foreshadowing> {
    return this.repo().update(id, { ...patch, updatedAt: new Date().toISOString() })
  }

  async plant(id: string, chapterNumber: number): Promise<Foreshadowing> {
    return this.repo().update(id, {
      status: 'planted',
      plantChapter: chapterNumber,
      updatedAt: new Date().toISOString()
    })
  }

  async collect(id: string, chapterNumber: number): Promise<Foreshadowing> {
    return this.repo().update(id, {
      status: 'collected',
      actualCollect: chapterNumber,
      updatedAt: new Date().toISOString()
    })
  }

  async markMissed(id: string): Promise<Foreshadowing> {
    return this.repo().update(id, { status: 'missed', updatedAt: new Date().toISOString() })
  }

  delete(id: string): Promise<void> {
    return this.repo().delete(id)
  }
}
