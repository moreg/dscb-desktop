import { CharacterRepository } from './character-repository'
import { ForeshadowingRepository } from './foreshadowing-repository'
import { MemoryHistory } from './memory-history'
import type { ProjectService } from './project-service'
import type {
  Character,
  CreateCharacterInput,
  UpdateCharacterInput,
  HistoryEntry,
  Foreshadowing,
  CreateForeshadowingInput,
  UpdateForeshadowingInput
} from '../../shared/types'

export class MemoryService {
  constructor(private readonly projectService: ProjectService) {}

  private async charRepo(projectId: string): Promise<CharacterRepository> {
    const dir = await this.projectService.resolveDir(projectId)
    return new CharacterRepository(dir)
  }

  private async history(projectId: string): Promise<MemoryHistory> {
    const dir = await this.projectService.resolveDir(projectId)
    return new MemoryHistory(dir)
  }

  async listCharacters(projectId: string): Promise<Character[]> {
    return (await this.charRepo(projectId)).list()
  }

  async getCharacter(projectId: string, id: string): Promise<Character | null> {
    return (await this.charRepo(projectId)).get(id)
  }

  async createCharacter(projectId: string, input: CreateCharacterInput): Promise<Character> {
    const repo = await this.charRepo(projectId)
    const c = await repo.create(input)
    await (await this.history(projectId)).append({
      at: new Date().toISOString(),
      type: 'character',
      action: 'create',
      entityId: c.id,
      summary: c.name
    })
    return c
  }

  async updateCharacter(
    projectId: string,
    id: string,
    patch: UpdateCharacterInput
  ): Promise<Character> {
    const repo = await this.charRepo(projectId)
    const c = await repo.update(id, patch)
    await (await this.history(projectId)).append({
      at: new Date().toISOString(),
      type: 'character',
      action: 'update',
      entityId: c.id,
      summary: c.name
    })
    return c
  }

  async deleteCharacter(projectId: string, id: string): Promise<void> {
    const repo = await this.charRepo(projectId)
    const existing = await repo.get(id)
    await repo.delete(id)
    await (await this.history(projectId)).append({
      at: new Date().toISOString(),
      type: 'character',
      action: 'delete',
      entityId: id,
      summary: existing?.name
    })
  }

  async listHistory(projectId: string): Promise<HistoryEntry[]> {
    return (await this.history(projectId)).list()
  }

  private async fsRepo(projectId: string): Promise<ForeshadowingRepository> {
    const dir = await this.projectService.resolveDir(projectId)
    return new ForeshadowingRepository(dir)
  }

  async listForeshadowings(projectId: string): Promise<Foreshadowing[]> {
    return (await this.fsRepo(projectId)).list()
  }

  async createForeshadowing(
    projectId: string,
    input: CreateForeshadowingInput
  ): Promise<Foreshadowing> {
    const repo = await this.fsRepo(projectId)
    const f = await repo.create(input)
    await (await this.history(projectId)).append({
      at: new Date().toISOString(),
      type: 'foreshadowing',
      action: 'create',
      entityId: f.id,
      summary: f.content
    })
    return f
  }

  async updateForeshadowing(
    projectId: string,
    id: string,
    patch: UpdateForeshadowingInput
  ): Promise<Foreshadowing> {
    return (await this.fsRepo(projectId)).update(id, patch)
  }

  async deleteForeshadowing(projectId: string, id: string): Promise<void> {
    return (await this.fsRepo(projectId)).delete(id)
  }

  async plantForeshadowing(
    projectId: string,
    id: string,
    chapterNumber: number
  ): Promise<Foreshadowing> {
    return (await this.fsRepo(projectId)).plant(id, chapterNumber)
  }

  async collectForeshadowing(
    projectId: string,
    id: string,
    chapterNumber: number
  ): Promise<Foreshadowing> {
    return (await this.fsRepo(projectId)).collect(id, chapterNumber)
  }

  async markForeshadowingMissed(projectId: string, id: string): Promise<Foreshadowing> {
    return (await this.fsRepo(projectId)).markMissed(id)
  }
}
