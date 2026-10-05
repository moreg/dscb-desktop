import type { ShortStoryIdea, ShortStoryIdeaFingerprint, ShortStoryRewriteFocus } from '../../shared/short-story'
import { isShortStoryIdea, normalizeShortStoryIdeaText, shortStoryIdeaExclusion, shortStoryIdeaFingerprint, shortStoryIdeaKey } from '../../shared/short-story-idea-utils'

export const SHORT_STORY_BRAINSTORM_PREFIX = 'ai-writer:short-story:brainstorm:'
export const BRAINSTORM_BATCH_LIMIT = 5
export const BRAINSTORM_FAVORITE_LIMIT = 30
export type BrainstormStatus = 'idle' | 'generating' | 'completed' | 'stopped' | 'failed'
export interface BrainstormBatch { id: string; createdAt: string; source: string; ideas: ShortStoryIdea[] }
export interface BrainstormFavorite { createdAt: string; source: string; idea: ShortStoryIdea }
export interface BrainstormRewriteCandidate {
  idea: ShortStoryIdea
  focus: ShortStoryRewriteFocus
  instruction: string
  source: string
  createdAt: string
}
export interface BrainstormRewrite {
  original: ShortStoryIdea
  originalSource: string
  focus: ShortStoryRewriteFocus
  instruction: string
  candidate: BrainstormRewriteCandidate | null
}
export interface BrainstormRecovery {
  version: 2
  direction: string
  ideas: ShortStoryIdea[]
  /** 旧版 history 保留为模型提示排除摘要。 */
  history: string[]
  previousIdeas: ShortStoryIdeaFingerprint[]
  batches: BrainstormBatch[]
  favorites: BrainstormFavorite[]
  rewrite: BrainstormRewrite | null
  raw: string
  status: BrainstormStatus
  task: 'batch' | 'rewrite'
  source: string
  adoptedBrief: string
  responseWarning: string
}
export type BrainstormStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
interface ReadResult { recovery: BrainstormRecovery; warning: string; found: boolean; corrupt: boolean }
const STATUSES: BrainstormStatus[] = ['idle', 'generating', 'completed', 'stopped', 'failed']
const FOCUSES: ShortStoryRewriteFocus[] = ['twist', 'ending', 'emotion', 'custom']
const activeSnapshots = new Map<string, BrainstormRecovery>()
const transferredKeys = new Set<string>()
const unsafeReadKeys = new Set<string>()

export function emptyShortStoryBrainstormRecovery(): BrainstormRecovery {
  return { version: 2, direction: '', ideas: [], history: [], previousIdeas: [], batches: [], favorites: [], rewrite: null,
    raw: '', status: 'idle', task: 'batch', source: '', adoptedBrief: '', responseWarning: '' }
}

function storagePort(storage?: BrainstormStorage): BrainstormStorage | null {
  if (storage) return storage
  try { return typeof window !== 'undefined' ? window.localStorage : null } catch { return null }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function fingerprintKey(value: ShortStoryIdeaFingerprint): string {
  return JSON.stringify([normalizeShortStoryIdeaText(value.title), normalizeShortStoryIdeaText(value.premise)])
}

function validFingerprint(value: unknown): value is ShortStoryIdeaFingerprint {
  const candidate = record(value)
  return !!candidate && typeof candidate.title === 'string' && !!candidate.title.trim() && candidate.title.length <= 120 &&
    typeof candidate.premise === 'string' && !!candidate.premise.trim() && candidate.premise.length <= 3000
}

function recentFingerprints(values: ShortStoryIdeaFingerprint[]): ShortStoryIdeaFingerprint[] {
  const unique = new Map<string, ShortStoryIdeaFingerprint>()
  for (const value of values) { const key = fingerprintKey(value); unique.delete(key); unique.set(key, { ...value }) }
  return [...unique.values()].slice(-30)
}

export function validShortStoryBrainstormBatch(value: unknown): value is ShortStoryIdea[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 3 && value.every(isShortStoryIdea)
}

function decode(raw: string): ReadResult {
  const recovery = emptyShortStoryBrainstormRecovery()
  try {
    const saved = record(JSON.parse(raw))
    if (!saved) throw new Error('恢复记录格式有误')
    let corrupt = false
    for (const field of ['direction', 'raw', 'source'] as const) {
      if (typeof saved[field] === 'string') recovery[field] = field === 'direction' ? saved[field].slice(0, 2000) : saved[field]
      else corrupt = true
    }
    if (Array.isArray(saved.ideas)) {
      recovery.ideas = saved.ideas.filter(isShortStoryIdea).slice(0, 3).map(idea => ({ ...idea }))
      if (recovery.ideas.length !== saved.ideas.length) corrupt = true
    } else corrupt = true
    if (Array.isArray(saved.history)) {
      recovery.history = saved.history.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.slice(0, 1500)).slice(-30)
      if (saved.history.some(item => typeof item !== 'string')) corrupt = true
    } else corrupt = true
    if (typeof saved.status === 'string' && STATUSES.includes(saved.status as BrainstormStatus)) {
      recovery.status = saved.status === 'generating' ? 'stopped' : saved.status as BrainstormStatus
    } else { recovery.status = recovery.raw ? 'failed' : 'idle'; corrupt = true }
    if (saved.task === 'rewrite') recovery.task = 'rewrite'
    for (const field of ['adoptedBrief', 'responseWarning'] as const) if (typeof saved[field] === 'string') recovery[field] = saved[field]
    if (Array.isArray(saved.previousIdeas)) {
      recovery.previousIdeas = recentFingerprints(saved.previousIdeas.filter(validFingerprint))
      if (saved.previousIdeas.some(item => !validFingerprint(item))) corrupt = true
    }
    if (Array.isArray(saved.batches)) {
      const batches: BrainstormBatch[] = []
      for (const value of saved.batches) {
        const batch = record(value)
        if (batch && typeof batch.id === 'string' && typeof batch.createdAt === 'string' && typeof batch.source === 'string' && validShortStoryBrainstormBatch(batch.ideas)) {
          batches.push({ id: batch.id, createdAt: batch.createdAt, source: batch.source, ideas: batch.ideas.map(idea => ({ ...idea })) })
        } else corrupt = true
      }
      recovery.batches = batches.slice(0, BRAINSTORM_BATCH_LIMIT)
    } else if (saved.batches !== undefined) corrupt = true
    if (!recovery.batches.length && recovery.ideas.length) recovery.batches = [{ id: 'legacy-current', createdAt: '', source: recovery.source, ideas: recovery.ideas.map(idea => ({ ...idea })) }]
    if (!recovery.previousIdeas.length) recovery.previousIdeas = recentFingerprints(recovery.batches.flatMap(batch => batch.ideas).reverse().map(shortStoryIdeaFingerprint))
    if (Array.isArray(saved.favorites)) {
      const favorites = new Map<string, BrainstormFavorite>()
      for (const value of saved.favorites) {
        const favorite = record(value)
        if (favorite && isShortStoryIdea(favorite.idea) && typeof favorite.createdAt === 'string' && typeof favorite.source === 'string') {
          const key = shortStoryIdeaKey(favorite.idea)
          if (!favorites.has(key)) favorites.set(key, { createdAt: favorite.createdAt, source: favorite.source, idea: { ...favorite.idea } })
        } else corrupt = true
      }
      recovery.favorites = [...favorites.values()].slice(0, BRAINSTORM_FAVORITE_LIMIT)
    } else if (saved.favorites !== undefined) corrupt = true
    if (saved.rewrite != null) {
      const rewrite = record(saved.rewrite)
      if (rewrite && isShortStoryIdea(rewrite.original) && typeof rewrite.originalSource === 'string' &&
        FOCUSES.includes(rewrite.focus as ShortStoryRewriteFocus) && typeof rewrite.instruction === 'string') {
        recovery.rewrite = { original: { ...rewrite.original }, originalSource: rewrite.originalSource,
          focus: rewrite.focus as ShortStoryRewriteFocus, instruction: rewrite.instruction.slice(0, 2000), candidate: null }
        if (rewrite.candidate != null) {
          const candidate = record(rewrite.candidate)
          if (candidate && isShortStoryIdea(candidate.idea) && FOCUSES.includes(candidate.focus as ShortStoryRewriteFocus) &&
            typeof candidate.instruction === 'string' && typeof candidate.source === 'string' && typeof candidate.createdAt === 'string' &&
            isValidShortStoryRewrite(recovery.rewrite.original, candidate.idea, candidate.focus as ShortStoryRewriteFocus)) {
            recovery.rewrite.candidate = { idea: { ...candidate.idea }, focus: candidate.focus as ShortStoryRewriteFocus,
              instruction: candidate.instruction.slice(0, 2000), source: candidate.source, createdAt: candidate.createdAt }
          } else corrupt = true
        }
      } else corrupt = true
    }
    return { recovery, warning: corrupt ? '恢复记录有部分内容损坏，已保留能够读取的候选与文本。' : '', found: true, corrupt }
  } catch {
    return { recovery, warning: '脑洞恢复记录无法读取，本次可重新生成；原记录保留。', found: true, corrupt: true }
  }
}

export function readShortStoryBrainstormRecovery(key: string, storage?: BrainstormStorage): ReadResult {
  transferredKeys.delete(key)
  const port = storagePort(storage)
  if (!port) { unsafeReadKeys.add(key); return { recovery: emptyShortStoryBrainstormRecovery(), warning: '无法访问本地脑洞恢复记录。', found: false, corrupt: true } }
  try {
    const raw = port.getItem(SHORT_STORY_BRAINSTORM_PREFIX + key)
    const result = raw ? decode(raw) : { recovery: emptyShortStoryBrainstormRecovery(), warning: '', found: false, corrupt: false }
    if (result.corrupt) unsafeReadKeys.add(key)
    else unsafeReadKeys.delete(key)
    return result
  } catch {
    unsafeReadKeys.add(key)
    return { recovery: emptyShortStoryBrainstormRecovery(), warning: '无法访问本地脑洞恢复记录。', found: false, corrupt: true }
  }
}

/** 仅在用户明确编辑方向、操作收藏或重新生成后允许更新损坏记录。 */
export function allowShortStoryBrainstormRecoveryWrite(key: string): void { unsafeReadKeys.delete(key) }

export function updateActiveShortStoryBrainstormRecovery(key: string, recovery: BrainstormRecovery): void {
  activeSnapshots.set(key, recovery)
}

export function releaseActiveShortStoryBrainstormRecovery(key: string): void { activeSnapshots.delete(key) }

export function writeShortStoryBrainstormRecovery(key: string, recovery: BrainstormRecovery, storage?: BrainstormStorage): boolean {
  // 创建作品后，旧的新建组件还会执行一次 cleanup；不能因此重建已迁移的记录。
  if (transferredKeys.has(key)) return true
  if (unsafeReadKeys.has(key)) return false
  const port = storagePort(storage)
  if (!port) return false
  try {
    if (!recovery.direction && !recovery.ideas.length && !recovery.history.length && !recovery.batches.length && !recovery.favorites.length &&
      !recovery.rewrite && !recovery.raw && recovery.status === 'idle') port.removeItem(SHORT_STORY_BRAINSTORM_PREFIX + key)
    else port.setItem(SHORT_STORY_BRAINSTORM_PREFIX + key, JSON.stringify(recovery))
    return true
  } catch { return false }
}

export function appendShortStoryBrainstormBatch(recovery: BrainstormRecovery, ideas: ShortStoryIdea[], source: string, createdAt: string, id: string): BrainstormRecovery {
  if (!validShortStoryBrainstormBatch(ideas)) return recovery
  const copies = ideas.map(idea => ({ ...idea }))
  const exclusions = copies.map(shortStoryIdeaExclusion)
  return { ...recovery, ideas: copies, source, batches: [{ id, createdAt, source, ideas: copies }, ...recovery.batches].slice(0, BRAINSTORM_BATCH_LIMIT),
    previousIdeas: recentFingerprints([...recovery.previousIdeas, ...copies.map(shortStoryIdeaFingerprint)]),
    history: [...recovery.history.filter(item => !exclusions.includes(item)), ...exclusions].slice(-30) }
}

export function toggleShortStoryBrainstormFavorite(recovery: BrainstormRecovery, idea: ShortStoryIdea, source: string, createdAt: string): { recovery: BrainstormRecovery; error: string | null } {
  if (!isShortStoryIdea(idea)) return { recovery, error: '这个脑洞的内容不完整，无法收藏。' }
  const key = shortStoryIdeaKey(idea)
  if (recovery.favorites.some(item => shortStoryIdeaKey(item.idea) === key)) {
    return { recovery: { ...recovery, favorites: recovery.favorites.filter(item => shortStoryIdeaKey(item.idea) !== key) }, error: null }
  }
  if (recovery.favorites.length >= BRAINSTORM_FAVORITE_LIMIT) return { recovery, error: '最多收藏 30 个脑洞，请先取消收藏一个方案。' }
  return { recovery: { ...recovery, favorites: [{ idea: { ...idea }, source, createdAt }, ...recovery.favorites] }, error: null }
}

export function isValidShortStoryRewrite(original: ShortStoryIdea, candidate: ShortStoryIdea, focus: ShortStoryRewriteFocus): boolean {
  if (!isShortStoryIdea(original) || !isShortStoryIdea(candidate)) return false
  const locked = focus === 'twist' ? ['title', 'premise', 'hook', 'ending'] as const
    : focus === 'ending' ? ['title', 'premise', 'hook', 'twist'] as const
      : focus === 'emotion' ? ['title', 'premise', 'hook'] as const : ['title', 'premise'] as const
  return locked.every(field => original[field].trim() === candidate[field].trim())
}

export function shortStoryBrainstormSourceMatches(source: string, current: string, adoptedBrief: string): boolean {
  try {
    const prior = record(JSON.parse(source)); const next = record(JSON.parse(current))
    if (!prior || !next) return source === current
    return ['genre', 'requirements', 'targetWords', 'direction'].every(field => prior[field] === next[field]) &&
      (prior.brief === next.brief || (!!adoptedBrief && next.brief === adoptedBrief))
  } catch { return source === current }
}

/** 复制验证成功后才清源；复制失败、损坏记录或收藏合并溢出时保留两边。 */
export function transferShortStoryBrainstormRecovery(fromKey: string, toKey: string, storage?: BrainstormStorage): boolean {
  const port = storagePort(storage)
  if (!port) return false
  try {
    const sourceRaw = port.getItem(SHORT_STORY_BRAINSTORM_PREFIX + fromKey)
    if (unsafeReadKeys.has(fromKey) || unsafeReadKeys.has(toKey) || (sourceRaw && decode(sourceRaw).corrupt)) return false
    const source = activeSnapshots.get(fromKey) ?? (sourceRaw ? decode(sourceRaw).recovery : null)
    if (!source) return true
    if (!sourceRaw && !source.direction && !source.ideas.length && !source.history.length && !source.batches.length && !source.favorites.length && !source.rewrite && !source.raw && source.status === 'idle') return true
    if (fromKey === toKey) return true
    const destinationRaw = port.getItem(SHORT_STORY_BRAINSTORM_PREFIX + toKey)
    const destination = destinationRaw ? decode(destinationRaw) : null
    if (destination?.corrupt) return false
    let merged = source
    if (destination) {
      const favorites = new Map<string, BrainstormFavorite>()
      for (const favorite of [...source.favorites, ...destination.recovery.favorites]) if (!favorites.has(shortStoryIdeaKey(favorite.idea))) favorites.set(shortStoryIdeaKey(favorite.idea), favorite)
      if (favorites.size > BRAINSTORM_FAVORITE_LIMIT) return false
      const batches = new Map<string, BrainstormBatch>()
      for (const batch of [...source.batches, ...destination.recovery.batches]) if (!batches.has(batch.id)) batches.set(batch.id, batch)
      merged = { ...source, favorites: [...favorites.values()], batches: [...batches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, BRAINSTORM_BATCH_LIMIT),
        previousIdeas: recentFingerprints([...destination.recovery.previousIdeas, ...source.previousIdeas]),
        history: [...new Set([...destination.recovery.history, ...source.history])].slice(-30) }
    }
    const serialized = JSON.stringify(merged)
    port.setItem(SHORT_STORY_BRAINSTORM_PREFIX + toKey, serialized)
    if (port.getItem(SHORT_STORY_BRAINSTORM_PREFIX + toKey) !== serialized) return false
    port.removeItem(SHORT_STORY_BRAINSTORM_PREFIX + fromKey)
    if (port.getItem(SHORT_STORY_BRAINSTORM_PREFIX + fromKey) !== null) return false
    transferredKeys.add(fromKey)
    activeSnapshots.delete(fromKey)
    return true
  } catch { return false }
}
