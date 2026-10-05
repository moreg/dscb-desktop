import { isLongStoryIdea, longStoryIdeaKey } from '../../shared/long-story-brainstorm'
import type { LongStoryIdea } from '../../shared/long-story-brainstorm'

export const LONG_STORY_BRAINSTORM_PREFIX = 'ai-writer:long-story:brainstorm:'
export const LONG_BRAINSTORM_BATCH_LIMIT = 5
export const LONG_BRAINSTORM_FAVORITE_LIMIT = 30
export type LongBrainstormStatus = 'idle' | 'generating' | 'completed' | 'stopped' | 'failed'
export interface LongBrainstormBatch { id: string; createdAt: string; source: string; ideas: LongStoryIdea[] }
export interface LongBrainstormFavorite { createdAt: string; source: string; idea: LongStoryIdea }
export interface LongBrainstormRecovery {
  version: 1
  direction: string
  requirements: string
  ideas: LongStoryIdea[]
  previousIdeas: { title: string; premise: string }[]
  batches: LongBrainstormBatch[]
  favorites: LongBrainstormFavorite[]
  raw: string
  status: LongBrainstormStatus
  source: string
  adoptedBrief: string
  responseWarning: string
}
export type LongBrainstormStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
interface ReadResult { recovery: LongBrainstormRecovery; warning: string; found: boolean; corrupt: boolean }
const STATUSES: LongBrainstormStatus[] = ['idle', 'generating', 'completed', 'stopped', 'failed']
const activeSnapshots = new Map<string, LongBrainstormRecovery>()
const unsafeReadKeys = new Set<string>()

export function emptyLongStoryBrainstormRecovery(): LongBrainstormRecovery {
  return { version: 1, direction: '', requirements: '', ideas: [], previousIdeas: [], batches: [], favorites: [],
    raw: '', status: 'idle', source: '', adoptedBrief: '', responseWarning: '' }
}

function storagePort(storage?: LongBrainstormStorage): LongBrainstormStorage | null {
  if (storage) return storage
  try { return typeof window !== 'undefined' ? window.localStorage : null } catch { return null }
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function validFingerprint(value: unknown): value is { title: string; premise: string } {
  const item = record(value)
  return !!item && typeof item.title === 'string' && !!item.title.trim() && item.title.length <= 120 &&
    typeof item.premise === 'string' && !!item.premise.trim() && item.premise.length <= 800
}
function recentFingerprints(values: { title: string; premise: string }[]): { title: string; premise: string }[] {
  const unique = new Map<string, { title: string; premise: string }>()
  for (const value of values) {
    const key = JSON.stringify([value.title.normalize('NFKC').replace(/\s+/g, '').toLowerCase(), value.premise.normalize('NFKC').replace(/\s+/g, '').toLowerCase()])
    unique.delete(key); unique.set(key, { title: value.title, premise: value.premise })
  }
  return [...unique.values()].slice(-30)
}
export function validLongStoryBrainstormBatch(value: unknown): value is LongStoryIdea[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 3 && value.every(isLongStoryIdea)
}

function decode(raw: string): ReadResult {
  const recovery = emptyLongStoryBrainstormRecovery()
  try {
    const saved = record(JSON.parse(raw))
    if (!saved) throw new Error('恢复记录格式有误')
    let corrupt = saved.version !== 1
    for (const field of ['direction', 'requirements', 'raw', 'source', 'adoptedBrief', 'responseWarning'] as const) {
      const value = saved[field]
      if (typeof value === 'string') {
        const limit = field === 'direction' ? 2000 : field === 'requirements' ? 10000 : Infinity
        recovery[field] = value.slice(0, limit)
        if (value.length > limit) corrupt = true
      } else corrupt = true
    }
    if (Array.isArray(saved.ideas)) {
      recovery.ideas = saved.ideas.filter(isLongStoryIdea).slice(0, 3).map(idea => ({ ...idea }))
      if (recovery.ideas.length !== saved.ideas.length) corrupt = true
    } else corrupt = true
    if (typeof saved.status === 'string' && STATUSES.includes(saved.status as LongBrainstormStatus)) {
      recovery.status = saved.status === 'generating' ? 'stopped' : saved.status as LongBrainstormStatus
    } else { recovery.status = recovery.raw ? 'failed' : 'idle'; corrupt = true }
    if (Array.isArray(saved.previousIdeas)) {
      recovery.previousIdeas = recentFingerprints(saved.previousIdeas.filter(validFingerprint))
      if (saved.previousIdeas.some(item => !validFingerprint(item))) corrupt = true
    } else corrupt = true
    if (Array.isArray(saved.batches)) {
      const batches = new Map<string, LongBrainstormBatch>()
      for (const value of saved.batches) {
        const batch = record(value)
        if (batch && typeof batch.id === 'string' && !!batch.id && typeof batch.createdAt === 'string' &&
          typeof batch.source === 'string' && validLongStoryBrainstormBatch(batch.ideas)) {
          if (!batches.has(batch.id)) batches.set(batch.id, { id: batch.id, createdAt: batch.createdAt, source: batch.source, ideas: batch.ideas.map(idea => ({ ...idea })) })
        } else corrupt = true
      }
      recovery.batches = [...batches.values()].slice(0, LONG_BRAINSTORM_BATCH_LIMIT)
    } else corrupt = true
    if (Array.isArray(saved.favorites)) {
      const favorites = new Map<string, LongBrainstormFavorite>()
      for (const value of saved.favorites) {
        const favorite = record(value)
        if (favorite && isLongStoryIdea(favorite.idea) && typeof favorite.createdAt === 'string' && typeof favorite.source === 'string') {
          const key = longStoryIdeaKey(favorite.idea)
          if (!favorites.has(key)) favorites.set(key, { createdAt: favorite.createdAt, source: favorite.source, idea: { ...favorite.idea } })
        } else corrupt = true
      }
      recovery.favorites = [...favorites.values()].slice(0, LONG_BRAINSTORM_FAVORITE_LIMIT)
      if (favorites.size > LONG_BRAINSTORM_FAVORITE_LIMIT) corrupt = true
    } else corrupt = true
    return { recovery, warning: corrupt ? '恢复记录有部分内容损坏，已保留能够读取的候选与文本；原记录暂不覆盖。' : '', found: true, corrupt }
  } catch {
    return { recovery, warning: '脑洞恢复记录无法读取，本次可重新生成；原记录保留。', found: true, corrupt: true }
  }
}

export function readLongStoryBrainstormRecovery(key: string, storage?: LongBrainstormStorage): ReadResult {
  const port = storagePort(storage)
  if (!port) { unsafeReadKeys.add(key); return { recovery: emptyLongStoryBrainstormRecovery(), warning: '无法访问本地脑洞恢复记录。', found: false, corrupt: true } }
  try {
    const raw = port.getItem(LONG_STORY_BRAINSTORM_PREFIX + key)
    const result = raw !== null ? decode(raw) : { recovery: emptyLongStoryBrainstormRecovery(), warning: '', found: false, corrupt: false }
    if (result.corrupt) unsafeReadKeys.add(key)
    else unsafeReadKeys.delete(key)
    return result
  } catch {
    unsafeReadKeys.add(key)
    return { recovery: emptyLongStoryBrainstormRecovery(), warning: '无法访问本地脑洞恢复记录。', found: false, corrupt: true }
  }
}
/** 只有明确输入、生成、收藏或采用后，才允许更新损坏的恢复记录。 */
export function allowLongStoryBrainstormRecoveryWrite(key: string): void { unsafeReadKeys.delete(key) }
export function updateActiveLongStoryBrainstormRecovery(key: string, recovery: LongBrainstormRecovery): void { activeSnapshots.set(key, recovery) }
export function releaseActiveLongStoryBrainstormRecovery(key: string): void { activeSnapshots.delete(key) }
function emptyRecovery(recovery: LongBrainstormRecovery): boolean {
  return !recovery.direction && !recovery.requirements && !recovery.ideas.length && !recovery.previousIdeas.length &&
    !recovery.batches.length && !recovery.favorites.length && !recovery.raw && recovery.status === 'idle'
}
export function writeLongStoryBrainstormRecovery(key: string, recovery: LongBrainstormRecovery, storage?: LongBrainstormStorage): boolean {
  if (unsafeReadKeys.has(key)) return false
  const port = storagePort(storage)
  if (!port) return false
  try {
    if (emptyRecovery(recovery)) port.removeItem(LONG_STORY_BRAINSTORM_PREFIX + key)
    else port.setItem(LONG_STORY_BRAINSTORM_PREFIX + key, JSON.stringify(recovery))
    return true
  } catch { return false }
}
export function appendLongStoryBrainstormBatch(recovery: LongBrainstormRecovery, ideas: LongStoryIdea[], source: string, createdAt: string, id: string): LongBrainstormRecovery {
  if (!validLongStoryBrainstormBatch(ideas)) return recovery
  const copies = ideas.map(idea => ({ ...idea }))
  return { ...recovery, ideas: copies, source,
    batches: [{ id, createdAt, source, ideas: copies }, ...recovery.batches.filter(batch => batch.id !== id)].slice(0, LONG_BRAINSTORM_BATCH_LIMIT),
    previousIdeas: recentFingerprints([...recovery.previousIdeas, ...copies.map(({ title, premise }) => ({ title, premise }))]) }
}
export function toggleLongStoryBrainstormFavorite(recovery: LongBrainstormRecovery, idea: LongStoryIdea, source: string, createdAt: string): { recovery: LongBrainstormRecovery; error: string | null } {
  if (!isLongStoryIdea(idea)) return { recovery, error: '这个脑洞的内容不完整，无法收藏。' }
  const key = longStoryIdeaKey(idea)
  if (recovery.favorites.some(item => longStoryIdeaKey(item.idea) === key)) {
    return { recovery: { ...recovery, favorites: recovery.favorites.filter(item => longStoryIdeaKey(item.idea) !== key) }, error: null }
  }
  if (recovery.favorites.length >= LONG_BRAINSTORM_FAVORITE_LIMIT) return { recovery, error: '最多收藏 30 个脑洞，请先取消收藏一个方案。' }
  return { recovery: { ...recovery, favorites: [{ idea: { ...idea }, source, createdAt }, ...recovery.favorites] }, error: null }
}
export function longStoryBrainstormSourceMatches(source: string, current: string, adoptedBrief: string): boolean {
  try {
    const prior = record(JSON.parse(source)); const next = record(JSON.parse(current))
    if (!prior || !next) return source === current
    return ['genre', 'requirements', 'targetChapters', 'direction'].every(field => prior[field] === next[field]) &&
      (prior.brief === next.brief || (!!adoptedBrief && next.brief === adoptedBrief))
  } catch { return source === current }
}
/** 创建长篇后复制当前脑洞库；新建入口的收藏和历史仍保留。 */
export function copyLongStoryBrainstormRecovery(fromKey: string, toKey: string, storage?: LongBrainstormStorage): boolean {
  const port = storagePort(storage)
  if (!port) return false
  try {
    if (unsafeReadKeys.has(fromKey) || unsafeReadKeys.has(toKey)) return false
    const raw = port.getItem(LONG_STORY_BRAINSTORM_PREFIX + fromKey)
    const loaded = raw !== null ? decode(raw) : null
    if (loaded?.corrupt) return false
    const source = activeSnapshots.get(fromKey) ?? loaded?.recovery
    if (!source || emptyRecovery(source) || fromKey === toKey) return true
    const destinationRaw = port.getItem(LONG_STORY_BRAINSTORM_PREFIX + toKey)
    const destination = destinationRaw !== null ? decode(destinationRaw) : null
    if (destination?.corrupt) return false
    let merged = source
    if (destination) {
      const favorites = new Map<string, LongBrainstormFavorite>()
      for (const item of [...source.favorites, ...destination.recovery.favorites]) if (!favorites.has(longStoryIdeaKey(item.idea))) favorites.set(longStoryIdeaKey(item.idea), item)
      if (favorites.size > LONG_BRAINSTORM_FAVORITE_LIMIT) return false
      const batches = new Map<string, LongBrainstormBatch>()
      for (const item of [...source.batches, ...destination.recovery.batches]) if (!batches.has(item.id)) batches.set(item.id, item)
      merged = { ...source, favorites: [...favorites.values()],
        batches: [...batches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, LONG_BRAINSTORM_BATCH_LIMIT),
        previousIdeas: recentFingerprints([...destination.recovery.previousIdeas, ...source.previousIdeas]) }
    }
    const serialized = JSON.stringify(merged)
    port.setItem(LONG_STORY_BRAINSTORM_PREFIX + toKey, serialized)
    return port.getItem(LONG_STORY_BRAINSTORM_PREFIX + toKey) === serialized
  } catch { return false }
}
