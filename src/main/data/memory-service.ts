import { CharacterRepository } from './character-repository'
import { MemoryHistory } from './memory-history'
import type { ProjectService } from './project-service'
import type {
  Character,
  CreateCharacterInput,
  UpdateCharacterInput,
  HistoryEntry
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
}
