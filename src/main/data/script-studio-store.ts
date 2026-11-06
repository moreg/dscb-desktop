import { promises as fs } from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { readJson, writeJsonAtomic } from './atomic'
import { withFileLock } from './file-lock'
import { renderMarkdown } from './script-prompt-kit'
import {
  OUTLINE_HINT_MAX_CHARS,
  SCRIPT_CONFLICT,
  SCRIPT_EXPORT_BLOCKED,
  SCRIPT_RUN_ACTIVE,
  SCRIPT_SCHEMA_VERSION,
  SCRIPT_SOURCE_MISSING,
  SCRIPT_STALE,
  SOURCE_MAX_CHARS,
  type AdoptScriptCandidateInput,
  type AdoptScriptCandidateResult,
  type BasedOn,
  type CreateScriptProjectInput,
  type GateIssue,
  type GenerationRun,
  type PromptPackage,
  type RecoverStudioRunsResult,
  type RunKind,
  type SaveScriptProjectResult,
  type SaveScriptStoryboardInput,
  type SaveScriptStoryboardResult,
  type ScriptCandidate,
  type ScriptProject,
  type ScriptProjectSummary,
  type ScriptSettings,
  type ScriptVersion,
  type SourceRange,
  type SourceSnapshot,
  type StoryboardUnit
} from '../../shared/script-studio'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type StoredProject = Omit<ScriptProject, 'source'>

interface IndexFile {
  schemaVersion: number
  projects: ScriptProjectSummary[]
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function now(): string {
  return new Date().toISOString()
}

function safeFileName(name: string): string {
  const cleaned = (name || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim()
  return `${(cleaned || '剧本创作').slice(0, 80)}-视频提示词.md`
}

/** 服务端兜底：按 Unicode 码点截断来源，并显式标注 truncated，不静默截断。 */
function truncateRaw(text: string): { text: string; truncated: boolean; charCount: number } {
  const chars = Array.from(text)
  if (chars.length <= SOURCE_MAX_CHARS) return { text, truncated: false, charCount: chars.length }
  return { text: chars.slice(0, SOURCE_MAX_CHARS).join(''), truncated: true, charCount: SOURCE_MAX_CHARS }
}

// ---------------------------------------------------------------------------
// 指纹
// ---------------------------------------------------------------------------

export function computeSourceFingerprint(text: string, ranges: SourceRange[]): string {
  return sha256(JSON.stringify([text, ranges]))
}

export function computeScriptFingerprint(settings: ScriptSettings, versions: ScriptVersion[]): string {
  return sha256(JSON.stringify([settings, versions.map(version => version.body)]))
}

/** 内容指纹含分镜，用于保存冲突双校验；剧本/分镜失配另有独立指纹。 */
export function computeContentFingerprint(
  settings: ScriptSettings,
  versions: ScriptVersion[],
  units: StoryboardUnit[] | null
): string {
  return sha256(JSON.stringify([settings, versions.map(version => version.body), units ?? null]))
}

export function computeStoryboardFingerprint(units: StoryboardUnit[]): string {
  return sha256(JSON.stringify(units))
}

export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 8)
}

function summaryOf(project: ScriptProject): ScriptProjectSummary {
  return {
    id: project.id,
    title: project.title,
    format: project.settings.format,
    revision: project.revision,
    hasCandidate: project.candidate !== null,
    versionCount: project.scriptVersions.length,
    hasStoryboard: project.storyboard !== null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  }
}

/**
 * 剧本创作项目本地仓库。
 * 目录：index.json / <id>/project.json / <id>/source.json /
 *       <id>/revisions/<rev>.json / <id>/runs/<runId>.json
 */
export class ScriptStudioStore {
  /** 从登记到最终落盘始终持有，取消流也不能提前释放项目互斥。 */
  private readonly liveRuns = new Set<string>()
  constructor(private readonly root: string) {}

  private assertId(id: string): void {
    if (!UUID_RE.test(id)) throw new Error(`${SCRIPT_SOURCE_MISSING}: 非法项目 id`)
  }

  private dir(id: string): string {
    return path.join(this.root, id)
  }

  private projectFile(id: string): string {
    return path.join(this.dir(id), 'project.json')
  }

  private sourceFile(id: string): string {
    return path.join(this.dir(id), 'source.json')
  }

  private revisionsDir(id: string): string {
    return path.join(this.dir(id), 'revisions')
  }

  private runsDir(id: string): string {
    return path.join(this.dir(id), 'runs')
  }

  private indexFile(): string {
    return path.join(this.root, 'index.json')
  }

  private async readIndex(): Promise<IndexFile> {
    return readJson<IndexFile>(this.indexFile(), { schemaVersion: SCRIPT_SCHEMA_VERSION, projects: [] })
  }

  private async writeIndex(summaries: ScriptProjectSummary[]): Promise<void> {
    await withFileLock('script-studio:index', async () => {
      await writeJsonAtomic(this.indexFile(), { schemaVersion: SCRIPT_SCHEMA_VERSION, projects: summaries })
    })
  }

  private async upsertIndex(summary: ScriptProjectSummary): Promise<void> {
    await withFileLock('script-studio:index', async () => {
      const index = await this.readIndex()
      const next = index.projects.filter(item => item.id !== summary.id)
      next.push(summary)
      next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      await writeJsonAtomic(this.indexFile(), { schemaVersion: SCRIPT_SCHEMA_VERSION, projects: next })
    })
  }

  /** 保存前把旧版写入 revisions/<rev>.json，只保留最近 5 份。 */
  private async writeRevision(project: ScriptProject): Promise<void> {
    const dir = this.revisionsDir(project.id)
    await fs.mkdir(dir, { recursive: true })
    await writeJsonAtomic(path.join(dir, `${project.revision}.json`), {
      revision: project.revision,
      project: (({ source: _source, ...rest }) => rest)(project),
      source: project.source,
      savedAt: now()
    })
    const files = (await fs.readdir(dir)).filter(name => /^\d+\.json$/.test(name))
    files.sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))
    for (const stale of files.slice(5)) {
      await fs.rm(path.join(dir, stale), { force: true }).catch(() => undefined)
    }
  }

  private async persist(project: ScriptProject): Promise<void> {
    const { source: _source, ...stored } = project
    await writeJsonAtomic(this.projectFile(project.id), stored)
    await writeJsonAtomic(this.sourceFile(project.id), project.source)
    await this.upsertIndex(summaryOf(project))
  }

  activeVersion(project: ScriptProject): ScriptVersion | null {
    return project.scriptVersions.find(item => item.id === project.activeVersionId) ?? null
  }

  makeBasedOn(project: ScriptProject, unitId = '', overrides: Partial<BasedOn> = {}): BasedOn {
    const active = this.activeVersion(project)
    return {
      projectId: project.id,
      projectName: project.title,
      versionId: active?.id ?? '',
      versionNumber: active?.number ?? 0,
      contentFingerprint: project.contentFingerprint,
      scriptFingerprint: project.scriptFingerprint,
      storyboardFingerprint: project.storyboard?.storyboardFingerprint ?? computeStoryboardFingerprint([]),
      sourceFingerprint: project.source.sourceFingerprint,
      scriptRevision: project.revision,
      unitId,
      stale: false,
      generatedAt: now(),
      ...overrides
    }
  }

  /** 过期产物判定：版本、剧本指纹、分镜指纹、来源指纹任一失配即过期。 */
  isStale(project: ScriptProject, basedOn: BasedOn): { stale: boolean; reason?: string } {
    if (basedOn.versionId !== project.activeVersionId) {
      return { stale: true, reason: '当前正式稿版本已变更，分镜基于旧版本' }
    }
    if (basedOn.scriptFingerprint !== project.scriptFingerprint) {
      return { stale: true, reason: '剧本内容已修改，分镜基于旧稿' }
    }
    if (basedOn.sourceFingerprint !== project.source.sourceFingerprint) {
      return { stale: true, reason: '来源选材已变更，需重新生成' }
    }
    if (basedOn.contentFingerprint !== project.contentFingerprint) {
      return { stale: true, reason: '项目内容已变更，需重新构建提示词包' }
    }
    if (basedOn.storyboardFingerprint !== (project.storyboard?.storyboardFingerprint ?? computeStoryboardFingerprint([]))) {
      return { stale: true, reason: '分镜已修改，提示词包基于旧分镜' }
    }
    return { stale: false }
  }

  async list(): Promise<ScriptProjectSummary[]> {
    const index = await this.readIndex()
    if (index.projects.length) return index.projects
    let entries: string[]
    try {
      entries = await fs.readdir(this.root)
    } catch {
      return []
    }
    const rebuilt: ScriptProjectSummary[] = []
    for (const entry of entries) {
      if (!UUID_RE.test(entry)) continue
      try {
        const stored = await readJson<StoredProject | null>(this.projectFile(entry), null)
        const source = await readJson<SourceSnapshot | null>(this.sourceFile(entry), null)
        if (stored && source) rebuilt.push(summaryOf({ ...stored, source } as ScriptProject))
      } catch {
        // 损坏项目不影响其他项目列表
      }
    }
    if (rebuilt.length) await this.writeIndex(rebuilt)
    return rebuilt.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async create(input: CreateScriptProjectInput): Promise<ScriptProject> {
    const id = randomUUID()
    const clipped = truncateRaw(input.sourceText)
    const outlineChars = Array.from(input.outlineHint)
    const outlineHint = outlineChars.slice(0, OUTLINE_HINT_MAX_CHARS).join('')
    const timestamp = now()
    const ranges = input.sourceRanges
    const source: SourceSnapshot = {
      kind: input.sourceKind,
      text: clipped.text,
      ranges,
      outlineHint,
      sourceFingerprint: computeSourceFingerprint(clipped.text, ranges),
      truncated: clipped.truncated || input.truncated,
      charCount: clipped.charCount,
      createdAt: timestamp
    }
    const scriptVersions: ScriptVersion[] = []
    let activeVersionId: string | null = null
    if (input.sourceKind === 'pasteScript' && clipped.text.trim()) {
      const versionId = randomUUID()
      scriptVersions.push({
        id: versionId,
        number: 1,
        body: clipped.text,
        note: '粘贴已有剧本',
        sourceFingerprint: source.sourceFingerprint,
        createdAt: timestamp
      })
      activeVersionId = versionId
    }
    const settings = input.settings
    const scriptFingerprint = computeScriptFingerprint(settings, scriptVersions)
    const project: ScriptProject = {
      schemaVersion: SCRIPT_SCHEMA_VERSION,
      id,
      title: input.title.trim() || '未命名剧本',
      settings,
      source,
      candidate: null,
      scriptVersions,
      activeVersionId,
      storyboard: null,
      revision: 1,
      contentFingerprint: computeContentFingerprint(settings, scriptVersions, null),
      scriptFingerprint,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    await withFileLock(`script-studio:${id}`, async () => {
      await this.persist(project)
      await this.writeRevision(project)
    })
    return project
  }

  async get(id: string): Promise<ScriptProject> {
    this.assertId(id)
    const stored = await readJson<StoredProject | null>(this.projectFile(id), null)
    const source = await readJson<SourceSnapshot | null>(this.sourceFile(id), null)
    if (!stored || !source) throw new Error(`${SCRIPT_SOURCE_MISSING}: 剧本项目或来源快照不存在`)
    return { ...stored, source } as ScriptProject
  }

  /** revision + contentFingerprint 双校验；冲突时不覆盖并返回当前版本。 */
  async save(project: ScriptProject): Promise<SaveScriptProjectResult> {
    this.assertId(project.id)
    return withFileLock(`script-studio:${project.id}`, async () => {
      const persisted = await this.get(project.id)
      if (persisted.revision !== project.revision || persisted.contentFingerprint !== project.contentFingerprint) {
        return {
          ok: false,
          code: SCRIPT_CONFLICT,
          current: persisted,
          message: '项目已在其他窗口更新，请重新读取后再保存；当前草稿仍保留'
        }
      }
      const ranges = project.source.ranges
      const source: SourceSnapshot = {
        ...project.source,
        sourceFingerprint: computeSourceFingerprint(project.source.text, ranges),
        charCount: Array.from(project.source.text).length
      }
      const units = project.storyboard?.units ?? null
      const next: ScriptProject = {
        ...project,
        source,
        revision: project.revision + 1,
        scriptFingerprint: computeScriptFingerprint(project.settings, project.scriptVersions),
        contentFingerprint: computeContentFingerprint(project.settings, project.scriptVersions, units),
        updatedAt: now()
      }
      await this.writeRevision(persisted)
      await this.persist(next)
      return { ok: true, project: next }
    })
  }

  /** 采用候选：校验候选来源指纹与当前来源一致、expectedRevision 一致。 */
  async adoptCandidate(input: AdoptScriptCandidateInput): Promise<AdoptScriptCandidateResult> {
    this.assertId(input.projectId)
    return withFileLock(`script-studio:${input.projectId}`, async () => {
      const persisted = await this.get(input.projectId)
      if (persisted.revision !== input.expectedRevision) {
        return { ok: false, code: SCRIPT_CONFLICT, message: '项目已更新，请重新读取后再采用', current: persisted }
      }
      const candidate = persisted.candidate
      if (!candidate || candidate.id !== input.candidateId) {
        return { ok: false, code: SCRIPT_SOURCE_MISSING, message: '候选剧本不存在，请重新生成', current: persisted }
      }
      if (candidate.sourceFingerprint !== persisted.source.sourceFingerprint) {
        return { ok: false, code: SCRIPT_STALE, message: '候选基于旧来源，已过期，请重新生成', current: persisted }
      }
      if (candidate.expectedRevision !== persisted.revision) {
        return { ok: false, code: SCRIPT_STALE, message: '候选基于旧版本，已过期，请重新生成', current: persisted }
      }
      const body = input.body.trim()
      if (!body) {
        return { ok: false, code: SCRIPT_SOURCE_MISSING, message: '候选剧本正文为空', current: persisted }
      }
      const version: ScriptVersion = {
        id: randomUUID(),
        number: persisted.scriptVersions.length + 1,
        body,
        note: input.note.trim() || `采用候选（${candidate.parseFallback ? 'Markdown 降级' : '结构化'}）`,
        sourceFingerprint: persisted.source.sourceFingerprint,
        createdAt: now()
      }
      const versions = [...persisted.scriptVersions, version]
      const units = persisted.storyboard?.units ?? null
      const next: ScriptProject = {
        ...persisted,
        scriptVersions: versions,
        activeVersionId: version.id,
        candidate: null,
        revision: persisted.revision + 1,
        scriptFingerprint: computeScriptFingerprint(persisted.settings, versions),
        contentFingerprint: computeContentFingerprint(persisted.settings, versions, units),
        updatedAt: now()
      }
      await this.writeRevision(persisted)
      await this.persist(next)
      return { ok: true, project: next }
    })
  }

  /** 生成成功后只写回 candidate 字段，不自动采用、不新增剧本版本。 */
  async saveCandidate(projectId: string, candidate: ScriptCandidate): Promise<ScriptProject> {
    this.assertId(projectId)
    return withFileLock(`script-studio:${projectId}`, async () => {
      const persisted = await this.get(projectId)
      const next: ScriptProject = { ...persisted, candidate, updatedAt: now() }
      await this.persist(next)
      return next
    })
  }

  /** 显式保存分镜：失配则拒绝，绝不覆盖已保存分镜。 */
  async saveStoryboard(input: SaveScriptStoryboardInput): Promise<SaveScriptStoryboardResult> {
    this.assertId(input.projectId)
    return withFileLock(`script-studio:${input.projectId}`, async () => {
      const persisted = await this.get(input.projectId)
      if (persisted.revision !== input.expectedRevision) {
        return { ok: false, code: SCRIPT_CONFLICT, message: '项目已更新，请重新读取后再保存分镜', current: persisted }
      }
      if (!persisted.activeVersionId) {
        return { ok: false, code: SCRIPT_SOURCE_MISSING, message: '请先采用一版正式稿剧本', current: persisted }
      }
      if (input.expectedVersionId !== persisted.activeVersionId ||
        input.expectedScriptFingerprint !== persisted.scriptFingerprint ||
        input.expectedSourceFingerprint !== persisted.source.sourceFingerprint) {
        return { ok: false, code: SCRIPT_STALE, message: '剧本已修改，分镜基于旧稿，请重新生成', current: persisted }
      }
      const units = input.units
      const storyboardFingerprint = computeStoryboardFingerprint(units)
      const contentFingerprint = computeContentFingerprint(persisted.settings, persisted.scriptVersions, units)
      const basedOn = this.makeBasedOn(persisted, '', {
        contentFingerprint,
        storyboardFingerprint,
        stale: false
      })
      const next: ScriptProject = {
        ...persisted,
        storyboard: { units, basedOn, storyboardFingerprint, savedAt: now() },
        revision: persisted.revision + 1,
        contentFingerprint,
        updatedAt: now()
      }
      await this.writeRevision(persisted)
      await this.persist(next)
      return { ok: true, project: next }
    })
  }

  // -------------------------------------------------------------------------
  // 运行记录
  // -------------------------------------------------------------------------

  async writeRun(run: GenerationRun): Promise<void> {
    this.assertId(run.projectId)
    await fs.mkdir(this.runsDir(run.projectId), { recursive: true })
    await writeJsonAtomic(path.join(this.runsDir(run.projectId), `${run.runId}.json`), run)
  }

  async listRuns(projectId: string): Promise<GenerationRun[]> {
    this.assertId(projectId)
    let files: string[]
    try {
      files = await fs.readdir(this.runsDir(projectId))
    } catch {
      return []
    }
    const runs: GenerationRun[] = []
    for (const file of files.filter(name => name.endsWith('.json'))) {
      const run = await readJson<GenerationRun | null>(path.join(this.runsDir(projectId), file), null)
      if (run) runs.push(run)
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /** 只恢复上一进程留下的记录；活跃任务（包括正在取消、收尾的任务）不受影响。 */
  async recoverRuns(projectId?: string): Promise<RecoverStudioRunsResult> {
    const summaries = projectId ? [{ id: projectId }] : await this.list()
    let recovered = 0
    const all: GenerationRun[] = []
    for (const summary of summaries) {
      if (projectId) this.assertId(projectId)
      await withFileLock(`script-studio:${summary.id}`, async () => {
        const runs = await this.listRuns(summary.id)
        for (const run of runs) {
          if (run.status === 'running' && !this.liveRuns.has(run.runId)) {
            const next: GenerationRun = { ...run, status: 'interrupted', updatedAt: now() }
            await this.writeRun(next)
            recovered++
            all.push(next)
          } else {
            all.push(run)
          }
        }
      })
    }
    return { ok: true, recovered, runs: all }
  }

  /** 防止同一项目并行生成互相覆盖。 */
  async assertNoActiveRun(projectId: string, kind: RunKind): Promise<void> {
    this.assertId(projectId)
    const runs = await this.listRuns(projectId)
    if (runs.some(run => run.status === 'running')) {
      throw new Error(`${SCRIPT_RUN_ACTIVE}: 已有 ${kind} 生成任务在进行中，请等待完成或先停止`)
    }
  }

  /** 检查与登记必须在同一锁内，避免两个窗口同时通过空闲检查。 */
  async startRun(run: GenerationRun): Promise<void> {
    this.assertId(run.projectId)
    await withFileLock(`script-studio:${run.projectId}`, async () => {
      await this.assertNoActiveRun(run.projectId, run.kind)
      this.liveRuns.add(run.runId)
      try {
        await this.writeRun(run)
      } catch (error) {
        this.liveRuns.delete(run.runId)
        throw error
      }
    })
  }

  releaseRun(runId: string): void {
    this.liveRuns.delete(runId)
  }

  // -------------------------------------------------------------------------
  // 导出
  // -------------------------------------------------------------------------

  async export(projectId: string, packages: PromptPackage[], allowStale = false): Promise<
    { ok: true; text: string; fileName: string } |
    { ok: false; code: typeof SCRIPT_STALE | typeof SCRIPT_EXPORT_BLOCKED; message: string; issues: GateIssue[] }
  > {
    this.assertId(projectId)
    const project = await this.get(projectId)
    if (packages.some(pkg => pkg.meta.projectId !== projectId)) {
      return { ok: false, code: SCRIPT_EXPORT_BLOCKED, message: '提示词包不属于当前项目，不能导出', issues: [] }
    }
    // 过期状态来自磁盘上的当前项目，不能信任旧窗口携带的 stale=false。
    const checked = packages.map(pkg => {
      const status = this.isStale(project, pkg.meta)
      return { ...pkg, meta: { ...pkg.meta,
        stale: status.stale || pkg.meta.stale,
        staleReason: status.reason ?? pkg.meta.staleReason
      } }
    })
    if (!allowStale && checked.some(pkg => pkg.meta.stale)) {
      return { ok: false, code: SCRIPT_STALE, message: '提示词包已过期，请刷新分镜与提示词包，或明确选择导出旧版本', issues: [] }
    }
    const result = renderMarkdown(checked, { projectName: project.title, generatedAt: now() })
    if (!result.ok) return { ok: false, code: SCRIPT_EXPORT_BLOCKED, message: 'Markdown 渲染闸门未通过', issues: result.issues }
    return { ok: true, text: result.markdown, fileName: safeFileName(project.title) }
  }
}
