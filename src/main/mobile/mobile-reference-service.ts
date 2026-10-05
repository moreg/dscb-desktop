import type {
  Character,
  ChapterDetail,
  Foreshadowing,
  MemoryEntity,
  Volume
} from '../../shared/types'
import type { ProjectService } from '../data/project-service'
import { CharacterRepo } from '../data/memory/character-repo'
import { ItemRepo } from '../data/memory/item-repo'
import { LocationRepo } from '../data/memory/location-repo'
import { WorldviewRepo } from '../data/memory/worldview-repo'
import { DetailedOutlineMdRepo } from '../data/skill-format/detailed-outline-md-repo'
import { ForeshadowingMdRepo } from '../data/skill-format/foreshadowing-md-repo'
import { OutlineMdRepo } from '../data/skill-format/outline-md-repo'
import { ProseRepo } from '../data/skill-format/prose-repo'
import { RhythmHtmlRepo } from '../data/skill-format/rhythm-html-repo'

const MAX_SEARCH_RESULTS = 100
const SEARCH_CONTEXT_CHARS = 56

export interface MobileReferenceLibrary {
  outline: {
    synopsis: string
    theme?: string
    mainLine?: string
    volumes: Volume[]
  } | null
  details: ChapterDetail[]
  characters: Array<Omit<Character, 'sources'>>
  locations: Array<Omit<MemoryEntity, 'sources'>>
  worldviews: Array<Omit<MemoryEntity, 'sources'>>
  items: Array<Omit<MemoryEntity, 'sources'>>
  foreshadowings: Foreshadowing[]
}

export interface MobileSearchResult {
  chapterNumber: number
  title: string
  snippet: string
  occurrences: number
}

export interface MobileReferenceReader {
  getLibrary(projectId: string): Promise<MobileReferenceLibrary>
  getChapterDetail(projectId: string, chapterNumber: number): Promise<ChapterDetail | null>
  search(projectId: string, query: string): Promise<MobileSearchResult[]>
}

export class MobileReferenceService implements MobileReferenceReader {
  constructor(private readonly projects: ProjectService) {}

  async getLibrary(projectId: string): Promise<MobileReferenceLibrary> {
    const dir = await this.projects.resolveDir(projectId)
    const [outline, details, characters, locations, worldviews, items, foreshadowings] =
      await Promise.all([
        new OutlineMdRepo(dir).read(),
        new DetailedOutlineMdRepo(dir).listAll(),
        new CharacterRepo(dir).list(),
        new LocationRepo(dir).list(),
        new WorldviewRepo(dir).list(),
        new ItemRepo(dir).list(),
        new ForeshadowingMdRepo(dir).list()
      ])

    return {
      outline: outline
        ? {
            synopsis: outline.main.synopsis,
            theme: outline.main.theme,
            mainLine: outline.main.mainLine,
            volumes: outline.volumes
          }
        : null,
      details,
      characters: characters.map(withoutSources),
      locations: locations.map(withoutSources),
      worldviews: worldviews.map(withoutSources),
      items: items.map(withoutSources),
      foreshadowings
    }
  }

  async getChapterDetail(projectId: string, chapterNumber: number): Promise<ChapterDetail | null> {
    const dir = await this.projects.resolveDir(projectId)
    return new DetailedOutlineMdRepo(dir).readChapter(chapterNumber)
  }

  async search(projectId: string, query: string): Promise<MobileSearchResult[]> {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    if (!needle) return []

    const dir = await this.projects.resolveDir(projectId)
    const prose = new ProseRepo(dir)
    const [numbers, details, rhythm] = await Promise.all([
      prose.listChapterNumbers(),
      new DetailedOutlineMdRepo(dir).listAll(),
      new RhythmHtmlRepo(dir).read()
    ])
    const chapterRhythm = rhythm?.length
      ? rhythm
      : (await new OutlineMdRepo(dir).read())?.rhythmFallback ?? []
    const titles = new Map<number, string>()
    for (const entry of chapterRhythm) titles.set(entry.chapter, entry.title)
    for (const detail of details) {
      if (detail.title) titles.set(detail.chapterNumber, detail.title)
    }

    const results: MobileSearchResult[] = []
    const writtenChapters = new Set(numbers)
    const chapterNumbers = [...new Set([...numbers, ...titles.keys()])].sort((a, b) => a - b)
    for (const chapterNumber of chapterNumbers) {
      const title = titles.get(chapterNumber) || `第${chapterNumber}章`
      const content = writtenChapters.has(chapterNumber) ? await prose.read(chapterNumber) : ''
      const titleIndex = title.toLocaleLowerCase('zh-CN').indexOf(needle)
      const lowered = content.toLocaleLowerCase('zh-CN')
      const contentIndex = lowered.indexOf(needle)
      if (titleIndex < 0 && contentIndex < 0) continue

      let occurrences = titleIndex >= 0 ? 1 : 0
      let cursor = contentIndex
      while (cursor >= 0) {
        occurrences += 1
        cursor = lowered.indexOf(needle, cursor + Math.max(needle.length, 1))
      }
      results.push({
        chapterNumber,
        title,
        snippet: contentIndex >= 0 ? makeSnippet(content, contentIndex, query.trim().length) : '标题匹配',
        occurrences
      })
      if (results.length >= MAX_SEARCH_RESULTS) break
    }
    return results
  }
}

function withoutSources<T extends { sources?: unknown }>(value: T): Omit<T, 'sources'> {
  const { sources: _sources, ...safe } = value
  return safe
}

function makeSnippet(content: string, index: number, needleLength: number): string {
  const start = Math.max(0, index - SEARCH_CONTEXT_CHARS)
  const end = Math.min(content.length, index + needleLength + SEARCH_CONTEXT_CHARS)
  const snippet = content.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${snippet}${end < content.length ? '…' : ''}`
}
