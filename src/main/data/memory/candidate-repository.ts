import { promises as fs } from 'fs'
import { join } from 'path'
import type { MemoryCandidateSummary, MemoryExtraction } from '../../../shared/types'
import type { MemoryCandidateItemKind } from '../memory-evidence-validator'
import { writeJsonAtomic } from '../atomic'

/**
 * 写后同步的记忆候选记录。
 *
 * syncChapterAfterWrite 每章都会往 .cache/memory-candidates/chapter-N.json 写一份，
 * 但此前全仓库没有任何地方读它：被挡下的条目落盘即失踪，界面上只剩一行红字。
 * 这个仓库把它读回来，让「哪些章有条目没入库」变成可查、可补跑的东西。
 */
const CANDIDATE_DIR = join('.cache', 'memory-candidates')
const FILE_RE = /^chapter-(\d+)\.json$/

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * 列出还没完全落地的候选（status 为 pending / partial）。
 * 已经 applied / validated 的不返回——那些没有待办。
 */
export async function listMemoryCandidates(projectDir: string): Promise<MemoryCandidateSummary[]> {
  const dir = join(projectDir, CANDIDATE_DIR)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return [] // 还没跑过写后同步
  }
  const out: MemoryCandidateSummary[] = []
  for (const name of files) {
    const matched = FILE_RE.exec(name)
    if (!matched) continue
    let parsed: StoredMemoryCandidate
    try {
      parsed = JSON.parse(await fs.readFile(join(dir, name), 'utf-8')) as StoredMemoryCandidate
    } catch {
      continue // 单个文件坏掉不该拖垮整张清单
    }
    const status = typeof parsed.status === 'string' ? parsed.status : 'pending'
    if (status !== 'pending' && status !== 'partial') continue
    const record = parsed as StoredMemoryCandidate
    out.push({
      chapterNumber: Number(matched[1]),
      status: status === 'partial' ? 'partial' : 'pending',
      chapterIssues: stringList(storedChapterIssues(record)),
      itemIssues: stringList(record.itemIssues),
      legacy: isLegacyCandidate(record),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
    })
  }
  return out.sort((a, b) => a.chapterNumber - b.chapterNumber)
}

/** 候选文件的完整内容（写入方见 WriteService.syncChapterAfterWrite） */
export interface StoredMemoryCandidate {
  chapterNumber: number
  sourceHash?: string
  extraction: MemoryExtraction
  issues?: string[]
  chapterIssues?: string[]
  itemIssues?: string[]
  status?: string
  updatedAt?: string
  appliedEntities?: {
    characters: number
    locations: number
    items: number
    foreshadowings: number
  }
  /**
   * 作者确认属实后强制写入的条目，不再报为待核对。
   * 存 key 不存 index：重跑会重新提取一次，数组顺序变了 index 就认错人。
   */
  forced?: { kind: MemoryCandidateItemKind; key: string }[]
}

/**
 * 这份候选记录里的章级问题。
 *
 * chapterIssues/itemIssues 是分级之后才有的字段。旧文件只有拍平的 issues，
 * 分不出级别，一律保守算作章级——与它写下时「一条不过整章不入库」的实际行为一致。
 * 展示、状态判定都必须走这一个函数，否则两边对同一个字段读法会相反。
 */
export function storedChapterIssues(candidate: StoredMemoryCandidate | null): string[] {
  if (!candidate) return []
  if (Array.isArray(candidate.chapterIssues) || Array.isArray(candidate.itemIssues)) {
    return candidate.chapterIssues ?? []
  }
  return candidate.issues ?? []
}

/** 这份记录是不是分级之前的旧格式（级别未知，需重跑一次才准） */
export function isLegacyCandidate(candidate: StoredMemoryCandidate | null): boolean {
  return !!candidate && !Array.isArray(candidate.chapterIssues) && !Array.isArray(candidate.itemIssues)
}

function candidatePath(projectDir: string, chapterNumber: number): string {
  return join(projectDir, CANDIDATE_DIR, `chapter-${chapterNumber}.json`)
}

/** 读一章的候选记录；没有或坏掉返回 null */
export async function readMemoryCandidate(
  projectDir: string,
  chapterNumber: number
): Promise<StoredMemoryCandidate | null> {
  try {
    const raw = await fs.readFile(candidatePath(projectDir, chapterNumber), 'utf-8')
    const parsed = JSON.parse(raw) as StoredMemoryCandidate
    return parsed && typeof parsed === 'object' && parsed.extraction ? parsed : null
  } catch {
    return null
  }
}

/** 合并写回候选记录（只覆盖给出的字段） */
export async function updateMemoryCandidate(
  projectDir: string,
  chapterNumber: number,
  patch: Partial<StoredMemoryCandidate>
): Promise<void> {
  const current = await readMemoryCandidate(projectDir, chapterNumber)
  if (!current) return
  await writeJsonAtomic(candidatePath(projectDir, chapterNumber), {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  })
}

/** 某条是否已被作者强制写入过（按内容 key 认，不按下标） */
export function isForced(
  candidate: StoredMemoryCandidate | null,
  kind: MemoryCandidateItemKind,
  key: string
): boolean {
  return (candidate?.forced ?? []).some((f) => f.kind === kind && f.key === key)
}
