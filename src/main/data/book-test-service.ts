import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { writeJsonAtomic } from './atomic'
import type { CoverService } from './cover-service'
import type { LlmService } from './llm-service'
import type { OutlineService } from './outline-service'
import type { ProjectService } from './project-service'
import {
  BOOK_TEST_BATCH_MAX,
  BOOK_TEST_POOL_MAX,
  BOOK_TEST_STYLE_PRESETS,
  buildBookTestTitlePrompt,
  clampChars,
  fanqieTestTitleIssues,
  normalizeFanqieTestTitle,
  parseBookTestDrafts,
  selectOutlineExcerpt
} from '../../shared/book-test'
import type { BookTestCandidate, BookTestState, CoverStylePreset, GenerateCoverInput } from '../../shared/types'

const FILE_NAME = '书测.json'

export const BOOK_TEST_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Test title, at most 15 characters including punctuation.' },
          hook: { type: 'string', description: 'Chinese. The selling point this title tests.' },
          coverHint: { type: 'string', description: 'Chinese. What this title cover should depict.' }
        },
        required: ['title', 'hook', 'coverHint'],
        additionalProperties: false
      }
    }
  },
  required: ['candidates'],
  additionalProperties: false
} as const

const STYLE_SET = new Set<string>(BOOK_TEST_STYLE_PRESETS)

function emptyState(): BookTestState {
  return {
    schemaVersion: 1,
    authorName: '',
    stylePreset: 'auto',
    direction: '',
    candidates: [],
    updatedAt: new Date().toISOString()
  }
}

function isStyle(value: string): value is CoverStylePreset {
  return STYLE_SET.has(value)
}

function sanitize(raw: unknown): BookTestState {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const rows = Array.isArray(obj.candidates) ? obj.candidates : []
  const candidates: BookTestCandidate[] = []
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (!id || id.length > 80 || candidates.some((candidate) => candidate.id === id)) continue
    const coverFileName =
      typeof row.coverFileName === 'string' && /^封面_v\d+\.png$/.test(row.coverFileName)
        ? row.coverFileName
        : undefined
    candidates.push({
      id,
      title: normalizeFanqieTestTitle(typeof row.title === 'string' ? row.title : ''),
      hook: clampChars(typeof row.hook === 'string' ? row.hook.trim() : '', 80),
      coverHint: clampChars(typeof row.coverHint === 'string' ? row.coverHint.trim() : '', 200),
      kept: row.kept === true,
      ...(coverFileName ? { coverFileName } : {}),
      ...(typeof row.coverTitle === 'string' && row.coverTitle.trim()
        ? { coverTitle: normalizeFanqieTestTitle(row.coverTitle) }
        : {}),
      createdAt: typeof row.createdAt === 'string' && row.createdAt ? row.createdAt : new Date().toISOString()
    })
  }
  const style = typeof obj.stylePreset === 'string' && isStyle(obj.stylePreset) ? obj.stylePreset : 'auto'
  return {
    schemaVersion: 1,
    authorName: typeof obj.authorName === 'string' ? obj.authorName.trim().slice(0, 60) : '',
    stylePreset: style,
    direction: typeof obj.direction === 'string' ? clampChars(obj.direction.trim(), 200) : '',
    candidates: candidates.slice(0, BOOK_TEST_POOL_MAX),
    updatedAt: typeof obj.updatedAt === 'string' && obj.updatedAt ? obj.updatedAt : new Date().toISOString()
  }
}

function coverHintOf(candidate: Pick<BookTestCandidate, 'hook' | 'coverHint'>): string | undefined {
  const parts = [`卖点：${candidate.hook}`, `画面：${candidate.coverHint}`].filter((part) => [...part].length > 3)
  const hint = parts.join('。')
  return hint ? clampChars(hint, 500) : undefined
}

/**
 * 番茄多书名实验的本地准备。
 * 只在项目的「书测/书测.json」里追加测试书名和封面记录，不改作品当前书名。
 * 封面仍走现有封面出图，文件落在「封面/」，封面页也能看到。
 */
export class BookTestService {
  private readonly tails = new Map<string, Promise<void>>()

  constructor(
    private readonly projects: ProjectService,
    private readonly outlines: OutlineService,
    private readonly llm: LlmService,
    private readonly covers: CoverService
  ) {}

  async getState(projectId: string): Promise<BookTestState> {
    // 跟写入排进同一条队列，避免刚勾选完立刻出封面时读到旧记录。
    return this.run(projectId, () => this.load(projectId))
  }

  async patchSettings(
    projectId: string,
    patch: { authorName?: string; stylePreset?: CoverStylePreset; direction?: string }
  ): Promise<BookTestState> {
    return this.run(projectId, async () => {
      const state = await this.load(projectId)
      this.applySettings(state, patch)
      return this.save(projectId, state)
    })
  }

  async generateTitles(
    projectId: string,
    input: { count: number; direction?: string; authorName?: string; stylePreset?: CoverStylePreset }
  ): Promise<BookTestState> {
    return this.run(projectId, async () => {
      const state = await this.load(projectId)
      this.applySettings(state, input)
      await this.save(projectId, state)
      const room = BOOK_TEST_POOL_MAX - state.candidates.length
      if (room <= 0) throw new Error('BOOK_TEST_POOL_FULL: 已经有 40 套了，先去掉不要的再生成')
      const count = Math.min(BOOK_TEST_BATCH_MAX, Math.max(1, Math.floor(input.count) || 1), room)
      const drafts = await this.askTitles(projectId, state, count)
      const existing = new Set(state.candidates.map((candidate) => candidate.title))
      const created = drafts
        .filter((draft) => draft.title && !existing.has(draft.title))
        .slice(0, count)
        .map((draft) => this.newCandidate(draft))
      if (created.length === 0) {
        throw new Error('BOOK_TEST_PARSE_FAILED: 模型没有给出新的书名，请再生成一次')
      }
      state.candidates = [...created, ...state.candidates]
      return this.save(projectId, state)
    })
  }

  async replaceTitle(projectId: string, candidateId: string): Promise<BookTestState> {
    return this.run(projectId, async () => {
      const state = await this.load(projectId)
      const current = state.candidates.find((candidate) => candidate.id === candidateId)
      if (!current) throw new Error('BOOK_TEST_NOT_FOUND: 这套方案不在列表里')
      const drafts = await this.askTitles(projectId, state, 1, current.hook)
      const draft = drafts[0]
      if (!draft) throw new Error('BOOK_TEST_PARSE_FAILED: 模型没有给出新的书名，请再试一次')
      current.title = draft.title
      current.hook = draft.hook
      current.coverHint = draft.coverHint
      return this.save(projectId, state)
    })
  }

  async updateCandidate(
    projectId: string,
    candidateId: string,
    patch: { title?: string; hook?: string; coverHint?: string; kept?: boolean }
  ): Promise<BookTestState> {
    return this.run(projectId, async () => {
      const state = await this.load(projectId)
      const current = state.candidates.find((candidate) => candidate.id === candidateId)
      if (!current) throw new Error('BOOK_TEST_NOT_FOUND: 这套方案不在列表里')
      if (patch.title !== undefined) current.title = clampChars(normalizeFanqieTestTitle(patch.title), 40)
      if (patch.hook !== undefined) current.hook = clampChars(patch.hook.trim(), 80)
      if (patch.coverHint !== undefined) current.coverHint = clampChars(patch.coverHint.trim(), 200)
      if (patch.kept !== undefined) current.kept = patch.kept
      return this.save(projectId, state)
    })
  }

  async deleteCandidate(projectId: string, candidateId: string): Promise<BookTestState> {
    return this.run(projectId, async () => {
      const state = await this.load(projectId)
      const next = state.candidates.filter((candidate) => candidate.id !== candidateId)
      if (next.length === state.candidates.length) {
        throw new Error('BOOK_TEST_NOT_FOUND: 这套方案不在列表里')
      }
      state.candidates = next
      return this.save(projectId, state)
    })
  }

  async generateCover(projectId: string, candidateId: string, authorName?: string): Promise<BookTestState> {
    return this.run(projectId, async () => {
      const state = await this.load(projectId)
      if (authorName !== undefined) state.authorName = authorName.trim().slice(0, 60)
      const current = state.candidates.find((candidate) => candidate.id === candidateId)
      if (!current) throw new Error('BOOK_TEST_NOT_FOUND: 这套方案不在列表里')
      if (!state.authorName.trim()) throw new Error('BOOK_TEST_NO_AUTHOR: 先填写笔名，番茄封面要有书名和笔名')
      const project = await this.projects.getProjectData(projectId)
      const inspected = fanqieTestTitleIssues(current.title, {
        originalTitle: project.name,
        otherTitles: state.candidates.filter((candidate) => candidate.id !== current.id).map((candidate) => candidate.title)
      })
      if (inspected.issues.length > 0) {
        throw new Error(`BOOK_TEST_TITLE_INVALID: ${inspected.issues.join('；')}`)
      }
      current.title = inspected.title
      const input: GenerateCoverInput = {
        projectId,
        bookName: inspected.title,
        authorName: state.authorName.trim(),
        platform: 'fanqie',
        stylePreset: state.stylePreset,
        styleHint: coverHintOf(current)
      }
      const file = await this.covers.generate(input)
      current.coverFileName = file.fileName
      current.coverTitle = inspected.title
      return this.save(projectId, state)
    })
  }

  private async askTitles(
    projectId: string,
    state: BookTestState,
    count: number,
    avoidHook?: string
  ) {
    const project = await this.projects.getProjectData(projectId)
    let outlineExcerpt: string
    try {
      const outline = await this.outlines.getOutlineSections(projectId)
      outlineExcerpt = selectOutlineExcerpt(outline.sections)
    } catch {
      outlineExcerpt = ''
    }
    const prompt = buildBookTestTitlePrompt({
      bookName: project.name,
      genre: project.genre,
      description: project.description,
      outlineExcerpt,
      existingTitles: state.candidates.map((candidate) => candidate.title).filter(Boolean),
      count,
      direction: state.direction,
      avoidHook
    })
    const raw = await this.llm.generateStream(prompt, {
      maxTokens: 1800,
      jsonSchema: BOOK_TEST_SCHEMA,
      strengthOverride: { temperature: 0.9 },
      meta: { feature: 'book-test', projectId }
    })
    return parseBookTestDrafts(raw).slice(0, count)
  }

  private newCandidate(draft: { title: string; hook: string; coverHint: string }): BookTestCandidate {
    return {
      id: randomUUID(),
      title: draft.title,
      hook: draft.hook,
      coverHint: draft.coverHint,
      kept: false,
      createdAt: new Date().toISOString()
    }
  }

  private applySettings(
    state: BookTestState,
    patch: { authorName?: string; stylePreset?: CoverStylePreset; direction?: string }
  ): void {
    if (patch.authorName !== undefined) state.authorName = patch.authorName.trim().slice(0, 60)
    if (patch.stylePreset !== undefined && isStyle(patch.stylePreset)) state.stylePreset = patch.stylePreset
    if (patch.direction !== undefined) state.direction = clampChars(patch.direction.trim(), 200)
  }

  private async fileOf(projectId: string): Promise<string> {
    const dir = await this.projects.resolveDir(projectId)
    return join(dir, '书测', FILE_NAME)
  }

  private async load(projectId: string): Promise<BookTestState> {
    const file = await this.fileOf(projectId)
    try {
      const raw = await fs.readFile(file, 'utf-8')
      return sanitize(JSON.parse(raw))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return emptyState()
      if (err instanceof SyntaxError) {
        throw new Error('BOOK_TEST_CORRUPT: 书测/书测.json 无法解析，没有覆盖它', { cause: err })
      }
      throw err
    }
  }

  private async save(projectId: string, state: BookTestState): Promise<BookTestState> {
    const next: BookTestState = { ...state, schemaVersion: 1, updatedAt: new Date().toISOString() }
    await writeJsonAtomic(await this.fileOf(projectId), next)
    return next
  }

  private run<T>(projectId: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(projectId) ?? Promise.resolve()
    const current = previous.then(job, job)
    this.tails.set(
      projectId,
      current.then(
        () => undefined,
        () => undefined
      )
    )
    return current
  }
}
