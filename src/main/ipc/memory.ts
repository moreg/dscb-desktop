import { promises as fs } from 'fs'
import { join, resolve, relative, isAbsolute } from 'path'
import { shell } from 'electron'
import { MemoryService } from '../data/memory-service'
import { MemoryEntityService } from '../data/memory-entity-service'
import { MemorySyncService } from '../data/memory/sync-service'
import { migrateProjectV3ToV4 } from '../data/memory/migration-v3-to-v4'
import { safeHandle } from './safe-handle'
import { registerCollectionIpc } from './register-collection'
import type {
  MemoryEntityType,
  CreateMemoryEntityInput,
  UpdateMemoryEntityInput
} from '../../shared/types'
import type { ProjectService } from '../data/project-service'

export function registerMemoryIpc(
  service: MemoryService,
  entityService: MemoryEntityService,
  projectService: ProjectService
): void {
  registerCollectionIpc('memory:character', {
    list: (pid) => service.listCharacters(pid),
    get: (pid, id) => service.getCharacter(pid, id),
    create: (pid, input) => service.createCharacter(pid, input),
    update: (pid, id, patch) => service.updateCharacter(pid, id, patch),
    delete: (pid, id) => service.deleteCharacter(pid, id)
  })

  registerCollectionIpc('memory:relationship', {
    list: (pid) => service.listRelationships(pid),
    create: (pid, input) => service.createRelationship(pid, input),
    update: (pid, id, patch) => service.updateRelationship(pid, id, patch),
    delete: (pid, id) => service.deleteRelationship(pid, id)
  })

  registerCollectionIpc('memory:foreshadowing', {
    list: (pid) => service.listForeshadowings(pid),
    create: (pid, input) => service.createForeshadowing(pid, input),
    update: (pid, id, patch) => service.updateForeshadowing(pid, id, patch),
    delete: (pid, id) => service.deleteForeshadowing(pid, id)
  })
  safeHandle('memory:foreshadowing:plant', (_e, pid: string, id: string, n: number) =>
    service.plantForeshadowing(pid, id, n)
  )
  safeHandle('memory:foreshadowing:collect', (_e, pid: string, id: string, n: number) =>
    service.collectForeshadowing(pid, id, n)
  )
  safeHandle('memory:foreshadowing:markMissed', (_e, pid: string, id: string) =>
    service.markForeshadowingMissed(pid, id)
  )

  safeHandle('memory:entity:list', (_e, pid: string, type: MemoryEntityType) =>
    entityService.list(pid, type)
  )
  safeHandle(
    'memory:entity:create',
    (_e, pid: string, type: MemoryEntityType, input: CreateMemoryEntityInput) =>
      entityService.create(pid, type, input)
  )
  safeHandle(
    'memory:entity:update',
    (_e, pid: string, type: MemoryEntityType, id: string, patch: UpdateMemoryEntityInput) =>
      entityService.update(pid, type, id, patch)
  )
  safeHandle('memory:entity:delete', (_e, pid: string, type: MemoryEntityType, id: string) =>
    entityService.delete(pid, type, id)
  )

  // ===== v4 新增 IPC =====

  /**
   * 增量同步：把 设定/ + 追踪/ + 细纲/ 派生到 记忆/。
   * UI 在 MemoryCenterPage 顶部"🔄 刷新记忆索引"按钮调用。
   */
  safeHandle('memory:syncIndex', async (_e, pid: string) => {
    const dir = await projectService.resolveDir(pid)
    const svc = new MemorySyncService(dir)
    return svc.syncAll()
  })

  /**
   * 获取实体完整 Markdown 内容（用于详情面板）。
   * type: 'character' | 'location' | 'worldview' | 'timeline' | 'plot_point' | 'relationship' | 'foreshadowing'
   * id: 实体 id
   * 返回 { markdown, sources }，markdown 是 记忆/<type>/<file>.md 的原文。
   */
  safeHandle(
    'memory:getDetail',
    async (_e, pid: string, type: string, id: string) => {
      // 收紧 id 字符集，避免特殊字符被注入到后续 includes/startsWith 匹配
      if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        throw new Error('非法 id：仅允许字母、数字、下划线、连字符')
      }
      const dir = await projectService.resolveDir(pid)
      const subDir = subDirForType(type)
      if (!subDir) throw new Error(`未知实体类型：${type}`)
      const root = join(dir, '记忆', subDir)
      const relPrefix = `记忆/${subDir}/`

      // 快速路径：优先按文件名匹配（FB-NNN.md / rel-xxx.md 等），无需读文件内容
      const directFile = `${id}.md`
      try {
        const directText = await fs.readFile(join(root, directFile), 'utf-8')
        return { markdown: directText, sources: [{ path: relPrefix + directFile }] }
      } catch {
        /* 文件名不匹配，走内容扫描 */
      }

      // 慢速路径：枚举目录，用 mtime 缓存避免重复读未变文件
      let files: string[] = []
      try {
        files = await fs.readdir(root)
      } catch {
        files = []
      }
      const idLineRe = new RegExp(`^id:\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm')
      for (const f of files) {
        if (!f.endsWith('.md') || f === directFile) continue
        const absPath = join(root, f)
        const text = await readCached(absPath)
        // 匹配规则：front-matter 整行 `id: <id>`，或文件名恰好为 `<id>.md`
        if (idLineRe.test(text) || f === `${id}.md`) {
          return { markdown: text, sources: [{ path: relPrefix + f }] }
        }
      }
      return null
    }
  )

  /**
   * 在系统资源管理器/默认编辑器中打开源文件。
   * relativePath 形如 '记忆/人物/苏铭.md' 或 '设定/角色/苏铭.md'
   */
  safeHandle('memory:openSource', async (_e, pid: string, relativePath: string) => {
    const dir = await projectService.resolveDir(pid)
    const root = resolve(dir)
    const abs = resolve(root, relativePath)
    // 防路径遍历：relative 结果不得为 .. 前缀或绝对路径；也不允许指向项目根本身
    const rel = relative(root, abs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('非法路径：禁止访问项目目录之外的文件')
    }
    const err = await shell.openPath(abs)
    if (err) throw new Error(`无法打开文件：${err}`)
    return { ok: true }
  })

  /**
   * 老项目 v3 → v4 一次性迁移（dryRun=true 时只返回报告不实际改）。
   */
  safeHandle('memory:migrateV3ToV4', async (_e, pid: string, options?: { dryRun?: boolean }) => {
    const dir = await projectService.resolveDir(pid)
    return migrateProjectV3ToV4(dir, options)
  })
}

function subDirForType(type: string): string | null {
  switch (type) {
    case 'character':
      return '人物'
    case 'location':
      return '地点'
    case 'worldview':
      return '世界观'
    case 'timeline':
      return '时间线'
    case 'plot_point':
      return '剧情点'
    case 'item':
      return '道具'
    case 'relationship':
      return '关系'
    case 'foreshadowing':
      return '伏笔'
    default:
      return null
  }
}

/**
 * 进程级文件内容缓存：key=绝对路径，value={ mtimeMs, text }。
 * mtime 未变则复用缓存的文本，避免 getDetail 每次枚举目录都重读所有 .md。
 * 用户在 app 内或外部编辑文件后 mtime 推进，下次自动重读。
 * LRU 上限：缓存条目超过 MAX_CACHE_ENTRIES 时按插入顺序淘汰最旧条目，防长期运行内存泄漏。
 */
const detailCache = new Map<string, { mtimeMs: number; text: string }>()
const MAX_CACHE_ENTRIES = 500

async function readCached(absPath: string): Promise<string> {
  let stat
  try {
    stat = await fs.stat(absPath)
  } catch {
    detailCache.delete(absPath)
    return ''
  }
  const cached = detailCache.get(absPath)
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text
  const text = await fs.readFile(absPath, 'utf-8')
  // LRU 淘汰：Map 保持插入顺序，超限时删除最早条目
  detailCache.set(absPath, { mtimeMs: stat.mtimeMs, text })
  if (detailCache.size > MAX_CACHE_ENTRIES) {
    const oldest = detailCache.keys().next().value
    if (oldest !== undefined) detailCache.delete(oldest)
  }
  return text
}
