import { CharacterCardMdRepo } from './skill-format/character-card-md-repo'
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

const NOT_IMPLEMENTED = '该操作需 Phase 2/3（读写 记忆系统/*.md）支持，当前为只读阶段。'

/**
 * 记忆服务。Phase 1：
 * - 角色读取从 记忆系统/角色卡.md（CharacterCardMdRepo）就绪。
 * - 伏笔 / 关系 / 历史 / 所有 mutation 留 Phase 2/3。
 */
export class MemoryService {
  constructor(private readonly projectService: ProjectService) {}

  // ===== 角色 =====
  async listCharacters(projectId: string): Promise<Character[]> {
    const dir = await this.projectService.resolveDir(projectId)
    return new CharacterCardMdRepo(dir).list()
  }

  async getCharacter(projectId: string, id: string): Promise<Character | null> {
    const list = await this.listCharacters(projectId)
    return list.find((c) => c.id === id) ?? null
  }

  async createCharacter(projectId: string, input: CreateCharacterInput): Promise<Character> {
    const dir = await this.projectService.resolveDir(projectId)
    return new CharacterCardMdRepo(dir).create(input)
  }

  async updateCharacter(
    projectId: string,
    id: string,
    patch: UpdateCharacterInput
  ): Promise<Character> {
    const dir = await this.projectService.resolveDir(projectId)
    const repo = new CharacterCardMdRepo(dir)
    const existing = (await repo.list()).find((c) => c.id === id)
    if (!existing) throw new Error(`角色不存在：${id}`)
    const updated = await repo.update(existing.name, patch)
    return updated ?? existing
  }

  async deleteCharacter(projectId: string, id: string): Promise<void> {
    const dir = await this.projectService.resolveDir(projectId)
    const repo = new CharacterCardMdRepo(dir)
    const existing = (await repo.list()).find((c) => c.id === id)
    if (!existing) return
    await repo.delete(existing.name)
  }

  // ===== 历史 =====
  async listHistory(_projectId: string): Promise<HistoryEntry[]> {
    return []
  }

  // ===== 伏笔（Phase 2 读 / Phase 3b 写：伏笔追踪.md） =====
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

  // ===== 关系（Phase 4：从 角色卡.md 关系变更日志读取） =====
  async listRelationships(projectId: string): Promise<Relationship[]> {
    const dir = await this.projectService.resolveDir(projectId)
    return new CharacterCardMdRepo(dir).listRelationships()
  }
  async createRelationship(
    _projectId: string,
    _input: CreateRelationshipInput
  ): Promise<Relationship> {
    throw new Error(NOT_IMPLEMENTED)
  }
  async updateRelationship(
    _projectId: string,
    _id: string,
    _patch: UpdateRelationshipInput
  ): Promise<Relationship> {
    throw new Error(NOT_IMPLEMENTED)
  }
  async deleteRelationship(_projectId: string, _id: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED)
  }
}
