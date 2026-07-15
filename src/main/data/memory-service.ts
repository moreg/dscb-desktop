import { CharacterRepo } from './memory/character-repo'
import { RelationshipRepo } from './memory/relationship-repo'
import { ForeshadowingMdRepo } from './skill-format/foreshadowing-md-repo'
import type { ProjectService } from './project-service'
import type {
  Character,
  CreateCharacterInput,
  UpdateCharacterInput,
  HistoryEntry,
  Foreshadowing,
  CreateForeshadowingInput,
  UpdateForeshadowingInput,
  Relationship,
  CreateRelationshipInput,
  UpdateRelationshipInput
} from '../../shared/types'

const NOT_IMPLEMENTED = '该操作需 Phase 3 支持，当前为只读阶段。'

/**
 * 记忆服务（v4）：
 * - 角色 → CharacterRepo（记忆/人物/*.md，fallback 设定/角色/*.md）
 * - 关系 → RelationshipRepo（记忆/关系/*.md，fallback 设定/关系.md）
 * - 伏笔 → ForeshadowingMdRepo（PR3 再切换为单一真相；目前维持旧实现）
 * - 历史 → 永远空（已废弃接口）
 */
export class MemoryService {
  constructor(private readonly projectService: ProjectService) {}

  // ===== 角色 =====
  async listCharacters(projectId: string): Promise<Character[]> {
    const dir = await this.projectService.resolveDir(projectId)
    return new CharacterRepo(dir).list()
  }

  async getCharacter(projectId: string, id: string): Promise<Character | null> {
    const list = await this.listCharacters(projectId)
    return list.find((c) => c.id === id) ?? null
  }

  async createCharacter(projectId: string, input: CreateCharacterInput): Promise<Character> {
    const dir = await this.projectService.resolveDir(projectId)
    return new CharacterRepo(dir).create(input)
  }

  async updateCharacter(
    projectId: string,
    id: string,
    patch: UpdateCharacterInput
  ): Promise<Character> {
    const dir = await this.projectService.resolveDir(projectId)
    const repo = new CharacterRepo(dir)
    const updated = await repo.update(id, patch)
    if (!updated) throw new Error(`角色不存在：${id}`)
    return updated
  }

  async deleteCharacter(projectId: string, id: string): Promise<void> {
    const dir = await this.projectService.resolveDir(projectId)
    await new CharacterRepo(dir).delete(id)
  }

  // ===== 历史（废弃） =====
  async listHistory(_projectId: string): Promise<HistoryEntry[]> {
    return []
  }

  // ===== 伏笔（PR3 再切换为单一真相；当前维持旧实现保持兼容） =====
  async listForeshadowings(projectId: string): Promise<Foreshadowing[]> {
    const dir = await this.projectService.resolveDir(projectId)
    return new ForeshadowingMdRepo(dir).list()
  }
  async createForeshadowing(
    projectId: string,
    input: CreateForeshadowingInput
  ): Promise<Foreshadowing> {
    const dir = await this.projectService.resolveDir(projectId)
    return new ForeshadowingMdRepo(dir).create(input)
  }
  async updateForeshadowing(
    projectId: string,
    id: string,
    patch: UpdateForeshadowingInput
  ): Promise<Foreshadowing> {
    const dir = await this.projectService.resolveDir(projectId)
    const updated = await new ForeshadowingMdRepo(dir).update(id, patch)
    if (!updated) throw new Error(`伏笔不存在：${id}`)
    return updated
  }
  async deleteForeshadowing(projectId: string, id: string): Promise<void> {
    const dir = await this.projectService.resolveDir(projectId)
    await new ForeshadowingMdRepo(dir).delete(id)
  }
  async plantForeshadowing(projectId: string, id: string, n: number): Promise<Foreshadowing> {
    const dir = await this.projectService.resolveDir(projectId)
    await new ForeshadowingMdRepo(dir).plant(id, n)
    return this.getForeshadowing(projectId, id)
  }
  async collectForeshadowing(projectId: string, id: string, n: number): Promise<Foreshadowing> {
    const dir = await this.projectService.resolveDir(projectId)
    await new ForeshadowingMdRepo(dir).collect(id, n)
    return this.getForeshadowing(projectId, id)
  }
  async markForeshadowingMissed(projectId: string, id: string): Promise<Foreshadowing> {
    const dir = await this.projectService.resolveDir(projectId)
    await new ForeshadowingMdRepo(dir).markMissed(id)
    return this.getForeshadowing(projectId, id)
  }

  private async getForeshadowing(projectId: string, id: string): Promise<Foreshadowing> {
    const list = await this.listForeshadowings(projectId)
    const f = list.find((x) => x.id === id)
    if (!f) throw new Error(`伏笔不存在：${id}`)
    return f
  }

  // ===== 关系 =====
  async listRelationships(projectId: string): Promise<Relationship[]> {
    const dir = await this.projectService.resolveDir(projectId)
    return new RelationshipRepo(dir).list()
  }
  async createRelationship(
    projectId: string,
    input: CreateRelationshipInput
  ): Promise<Relationship> {
    const dir = await this.projectService.resolveDir(projectId)
    return new RelationshipRepo(dir, new CharacterRepo(dir)).create(input)
  }
  async updateRelationship(
    projectId: string,
    id: string,
    patch: UpdateRelationshipInput
  ): Promise<Relationship | null> {
    const dir = await this.projectService.resolveDir(projectId)
    return new RelationshipRepo(dir, new CharacterRepo(dir)).update(id, patch)
  }
  async deleteRelationship(projectId: string, id: string): Promise<void> {
    const dir = await this.projectService.resolveDir(projectId)
    await new RelationshipRepo(dir, new CharacterRepo(dir)).delete(id)
  }
}
