import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_PAGE } from '../src/main/mobile/mobile-page'

type Listener = (event: Record<string, unknown>) => void

function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'"
  })[entity] || entity)
}

class TestElement {
  readonly children: TestElement[] = []
  readonly dataset: Record<string, string> = {}
  readonly attributes: Record<string, string> = {}
  readonly listeners = new Map<string, Listener[]>()
  readonly style = { setProperty: vi.fn(), removeProperty: vi.fn() }
  readonly classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() }
  parentElement: TestElement | null = null
  value = ''
  disabled = false
  checked = false
  selectionStart = 0
  selectionEnd = 0
  scrollTop = 0
  scrollLeft = 0
  href = ''
  download = ''
  ownText = ''
  private markup = ''

  constructor(readonly tagName: string, readonly ownerDocument: TestDocument) {}

  get id(): string { return this.attributes.id || '' }
  get innerHTML(): string { return this.markup }
  set innerHTML(value: string) {
    this.markup = value
    for (const child of this.children) child.parentElement = null
    this.children.splice(0)
    this.ownText = ''
    const stack: TestElement[] = [this]
    for (const token of value.match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
      if (token.startsWith('<')) {
        const tag = /^<([a-z][\w-]*)\b/i.exec(token)
        if (!tag) continue
        const element = new TestElement(tag[1].toUpperCase(), this.ownerDocument)
        for (const attribute of token.matchAll(/([\w-]+)(?:="([^"]*)"|='([^']*)')?/g)) {
          if (attribute.index === 1) continue
          element.setAttribute(attribute[1], decodeHtml(attribute[2] ?? attribute[3] ?? ''))
        }
        const parent = stack[stack.length - 1]
        element.parentElement = parent
        parent.children.push(element)
        if (!['INPUT', 'BR', 'HR', 'META', 'LINK', 'IMG'].includes(element.tagName)) stack.push(element)
      } else {
        const parent = stack[stack.length - 1]
        parent.ownText += decodeHtml(token)
        if (parent.tagName === 'TEXTAREA') parent.value += decodeHtml(token)
      }
    }
  }

  get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join('') }
  set textContent(value: string) { this.ownText = value; for (const child of this.children) child.parentElement = null; this.children.splice(0) }
  get isConnected(): boolean { return this === this.ownerDocument.root || Boolean(this.parentElement?.isConnected) }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value
    if (name === 'value') this.value = value
    if (name === 'disabled') this.disabled = true
    if (name === 'checked') this.checked = true
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value
  }
  removeAttribute(name: string): void { delete this.attributes[name]; if (name === 'disabled') this.disabled = false }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener])
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry !== listener))
  }
  emit(type: string, extra: Record<string, unknown> = {}): void {
    const event = { target: this, currentTarget: this, preventDefault: vi.fn(), ...extra }
    for (const listener of this.listeners.get(type) || []) listener(event)
  }
  matches(selector: string): boolean {
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()))
    const id = /^#([\w-]+)$/.exec(selector)
    if (id) return this.id === id[1]
    const tag = /^([a-z][\w-]*)/i.exec(selector)
    if (tag && this.tagName !== tag[1].toUpperCase()) return false
    const attributes = [...selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)]
    if (attributes.length) return attributes.every(([, name, value]) => name in this.attributes && (value === undefined || this.attributes[name] === value))
    return Boolean(tag)
  }
  closest(selector: string): TestElement | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null }
  querySelector(selector: string): TestElement | null { return this.querySelectorAll(selector)[0] || null }
  querySelectorAll(selector: string): TestElement[] {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)])
  }
  focus(): void { this.ownerDocument.activeElement = this }
  blur(): void { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; this.emit('blur') }
  setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end }
  appendChild(child: TestElement): void { child.remove(); child.parentElement = this; this.children.push(child) }
  remove(): void { const siblings = this.parentElement?.children; if (siblings) siblings.splice(siblings.indexOf(this), 1); this.parentElement = null }
  click(): void { if (this.tagName === 'A') this.ownerDocument.downloads.push(this); else this.ownerDocument.root.emit('click', { target: this }) }
  scrollIntoView(): void {}
}

class TestDocument {
  readonly root = new TestElement('MAIN', this)
  readonly documentElement = new TestElement('HTML', this)
  readonly body = new TestElement('BODY', this)
  readonly listeners = new Map<string, Listener[]>()
  readonly downloads: TestElement[] = []
  activeElement: TestElement | null = null
  visibilityState = 'visible'
  hidden = false

  getElementById(id: string): TestElement | null { return id === 'app' ? this.root : this.root.querySelector('#' + id) }
  createElement(tag: string): TestElement { return new TestElement(tag.toUpperCase(), this) }
  querySelector(selector: string): TestElement | null { return this.root.querySelector(selector) }
  querySelectorAll(selector: string): TestElement[] { return this.root.querySelectorAll(selector) }
  addEventListener(type: string, listener: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]) }
  emit(type: string): void { for (const listener of this.listeners.get(type) || []) listener({}) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

interface TestChapter { number: number; title: string; content: string; revision: string }
interface TestBrainIdea {
  title: string
  premise: string
  hook: string
  mainLine?: string
  progression?: string
  twist: string
  ending: string
}
interface TestBrainInput {
  kind: 'long' | 'short' | 'medium'
  genre: string
  direction: string
  requirements: string
  sourceBrief: string
  targetChapters?: number
  targetWords?: number
  previousIdeas: Array<{ title: string; premise: string }>
  variationSeed: string
}
interface TestBrainResult { ok: boolean; ideas?: TestBrainIdea[]; rawText?: string; warning?: string; error?: string }
interface TestBatchJob {
  id: string
  projectId: string
  requestId: string
  autoStrength: boolean
  running: boolean
  stopping: boolean
  progress: {
    total: number; current: number; currentChapter: number; fromChapter: number; toChapter: number
    status: string; completed: number[]; pendingPostProcessChapter?: number; pauseReason?: string; error?: string
  }
  stage?: string
  streamText: string
  summaries: Array<{ chapter: number; wordCount: number; saved: boolean; checks: string; deslop: string; memory: string }>
  retryWait?: { chapter: number; attempt: number; maxAttempts: number; waitMs: number; retryAt: number }
  updatedAt: number
}

function batchJob(projectId = 'project-1'): TestBatchJob {
  return {
    id: 'batch-' + projectId, projectId, requestId: 'saved-request', autoStrength: false, running: true, stopping: false,
    progress: { total: 10, current: 0, currentChapter: 3, fromChapter: 3, toChapter: 12, status: 'generating', completed: [] },
    stage: 'generating', streamText: '', summaries: [], updatedAt: Date.now()
  }
}

function brainstormIdea(kind: TestBrainInput['kind'], label: string): TestBrainIdea {
  return {
    title: '脑洞' + label,
    premise: '故事设定' + label,
    hook: '开篇钩子' + label,
    ...(kind === 'long' ? { mainLine: '长期主线' + label, progression: '成长与多卷推进' + label } : {}),
    twist: '关键反转' + label,
    ending: '结局' + label
  }
}

function createBackend() {
  const chapters = new Map<number, TestChapter>([
    [1, { number: 1, title: '初见', content: '第一章原始正文', revision: 'revision-1' }],
    [2, { number: 2, title: '重逢', content: '第二章原始正文', revision: 'revision-2' }]
  ])
  const writes: Array<{ number: number; content: string; baseRevision?: string }> = []
  let aiResult: Promise<{ mode: string; text: string }> | null = null
  let searchResult: Promise<{ results: unknown[] }> | null = null
  let saveGate: Promise<void> | null = null
  let activeWrites = 0
  let maxConcurrentWrites = 0
  let failingChapterRead: number | null = null
  const brainstormRequests: TestBrainInput[] = []
  const brainstormSignals: AbortSignal[] = []
  let brainstormResult: Promise<TestBrainResult> | null = null
  const batchJobs = new Map<string, TestBatchJob | null>()
  const batchReads: string[] = []
  const batchCommands: Array<{ projectId: string; action: string; body: Record<string, unknown> }> = []
  let nextBatchRead: Promise<{ job: TestBatchJob | null }> | null = null
  let nextBatchStart: Promise<{ job: TestBatchJob | null }> | null = null
  let nextBatchStop: Promise<{ job: TestBatchJob | null }> | null = null
  let activeBatchReads = 0
  let maxConcurrentBatchReads = 0
  let failBatchRead = false
  const meta = (chapter: TestChapter) => ({ chapterNumber: chapter.number, title: chapter.title, wordCount: chapter.content.length, status: 'draft' })
  const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) })
  const fetch = vi.fn(async (path: string, options: { method?: string; body?: string; signal?: AbortSignal } = {}) => {
    const url = new URL(path, 'http://mobile.test')
    const method = options.method || 'GET'
    const batchRoute = /^\/api\/projects\/([^/]+)\/batch(?:\/(resume|stop|clear))?$/.exec(url.pathname)
    if (batchRoute) {
      const projectId = decodeURIComponent(batchRoute[1])
      if (method === 'GET') {
        batchReads.push(projectId)
        activeBatchReads += 1
        maxConcurrentBatchReads = Math.max(maxConcurrentBatchReads, activeBatchReads)
        try {
          if (failBatchRead) { failBatchRead = false; return response({ error: '网络读取失败' }, 503) }
          const gate = nextBatchRead
          nextBatchRead = null
          return response(gate ? await gate : { job: batchJobs.get(projectId) || null })
        } finally { activeBatchReads -= 1 }
      }
      const action = batchRoute[2] || 'start'
      const body = JSON.parse(options.body || '{}') as Record<string, unknown>
      batchCommands.push({ projectId, action, body })
      let job = batchJobs.get(projectId) || null
      if (action === 'start') {
        job = batchJob(projectId)
        job.requestId = String(body.requestId)
        job.autoStrength = body.autoStrength === true
        job.progress.fromChapter = Number(body.fromChapter)
        job.progress.toChapter = Number(body.toChapter)
        job.progress.currentChapter = job.progress.fromChapter
        job.progress.total = job.progress.toChapter - job.progress.fromChapter + 1
        batchJobs.set(projectId, job)
        const gate = nextBatchStart
        nextBatchStart = null
        return response(gate ? await gate : { job }, 202)
      }
      if (!job || body.jobId !== job.id) return response({ error: '任务不存在' }, 404)
      if (action === 'clear') { batchJobs.set(projectId, null); return response({ job: null }) }
      if (action === 'stop') {
        job.stopping = true
        const gate = nextBatchStop
        nextBatchStop = null
        if (gate) return response(await gate)
      }
      if (action === 'resume') { job.running = true; job.stopping = false; job.stage = job.progress.pendingPostProcessChapter ? 'checking' : 'generating'; job.progress.status = 'generating'; delete job.progress.pauseReason; delete job.progress.error }
      return response({ job })
    }
    if (url.pathname === '/api/brainstorm' && method === 'POST') {
      const input = JSON.parse(options.body || '{}') as TestBrainInput
      brainstormRequests.push(input)
      if (options.signal) brainstormSignals.push(options.signal)
      const ideas = Array.from({ length: 3 }, (_, index) => brainstormIdea(input.kind, brainstormRequests.length + '-' + (index + 1)))
      return response(await (brainstormResult || Promise.resolve({ ok: true, ideas, rawText: JSON.stringify(ideas) })))
    }
    if (url.pathname === '/api/projects') return response({ projects: [{ id: 'project-1', name: '测试作品' }, { id: 'project-2', name: '另一部作品' }] })
    if (url.pathname.endsWith('/chapters')) return response({ chapters: [...chapters.values()].map(meta) })
    if (url.pathname.endsWith('/search')) return response(await (searchResult || Promise.resolve({ results: [] })))
    if (url.pathname.endsWith('/references')) return response({ library: { outline: null, details: [], characters: [], locations: [], worldviews: [], items: [], foreshadowings: [] } })
    const number = Number(/\/chapters\/(\d+)$/.exec(url.pathname)?.[1])
    const chapter = chapters.get(number)
    if (!chapter) throw new Error('Unexpected mobile request: ' + method + ' ' + path)
    if (method === 'POST' && url.searchParams.get('action') === 'ai') {
      const body = JSON.parse(options.body || '{}') as { mode: string }
      return response(await (aiResult || Promise.resolve({ mode: body.mode, text: 'AI 生成的正文' })))
    }
    if (method === 'PUT') {
      const body = JSON.parse(options.body || '{}') as { content: string; baseRevision?: string }
      writes.push({ number, ...body })
      activeWrites += 1
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites)
      try {
        const gate = saveGate
        saveGate = null
        if (gate) await gate
        if (body.baseRevision !== chapter.revision) return response({ error: '电脑端内容已发生变化，请重新打开章节' }, 409)
        chapter.content = body.content
        chapter.revision += '-saved'
        return response({ meta: meta(chapter), revision: chapter.revision })
      } finally { activeWrites -= 1 }
    }
    if (method === 'GET') {
      if (failingChapterRead === number) { failingChapterRead = null; return response({ error: '读取正文失败' }, 500) }
      return response({ chapter: { meta: meta(chapter), content: chapter.content }, detail: null, revision: chapter.revision })
    }
    throw new Error('Unexpected mobile request: ' + method + ' ' + path)
  })
  return {
    chapters, writes, fetch, brainstormRequests, brainstormSignals, batchJobs, batchReads, batchCommands,
    get activeBatchReads() { return activeBatchReads },
    get maxConcurrentBatchReads() { return maxConcurrentBatchReads },
    get activeWrites() { return activeWrites },
    get maxConcurrentWrites() { return maxConcurrentWrites },
    setAiResult: (result: typeof aiResult) => { aiResult = result },
    setSearchResult: (result: typeof searchResult) => { searchResult = result },
    setSaveGate: (gate: Promise<void>) => { saveGate = gate },
    failNextChapterRead: (number: number) => { failingChapterRead = number },
    setBrainstormResult: (result: typeof brainstormResult) => { brainstormResult = result },
    setNextBatchRead: (result: typeof nextBatchRead) => { nextBatchRead = result },
    setNextBatchStart: (result: typeof nextBatchStart) => { nextBatchStart = result },
    setNextBatchStop: (result: typeof nextBatchStop) => { nextBatchStop = result },
    failNextBatchRead: () => { failBatchRead = true }
  }
}

function createBatchBackend() {
  const backend = createBackend()
  for (let number = 3; number <= 12; number++) backend.chapters.set(number, { number, title: '第' + number + '章', content: '', revision: 'revision-' + number })
  return backend
}

async function flushRequests(): Promise<void> { for (let index = 0; index < 15; index++) await Promise.resolve() }

async function createPage(backend = createBackend(), saved = new Map<string, string>()) {
  const document = new TestDocument()
  const windowListeners = new Map<string, Listener[]>()
  const confirm = vi.fn(() => true)
  const alert = vi.fn()
  const downloadedBlobs: Blob[] = []
  class PageURL extends URL {
    static createObjectURL(blob: Blob): string { downloadedBlobs.push(blob); return 'blob:mobile-test-' + downloadedBlobs.length }
    static revokeObjectURL(): void {}
  }
  const localStorage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { saved.set(key, value) }),
    removeItem: vi.fn((key: string) => { saved.delete(key) })
  }
  const window = {
    setTimeout, clearTimeout, confirm, alert, prompt: vi.fn(() => null),
    innerHeight: 780, scrollY: 0, scrollX: 0, scrollTo: vi.fn(),
    addEventListener: (type: string, listener: Listener) => { windowListeners.set(type, [...(windowListeners.get(type) || []), listener]) },
    matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  }
  const navigator: { onLine: boolean; clipboard: { writeText: ReturnType<typeof vi.fn> } | undefined } = {
    onLine: true, clipboard: { writeText: vi.fn(async () => undefined) }
  }
  const script = /<script>([\s\S]*?)<\/script>/.exec(MOBILE_PAGE)?.[1]
  if (!script) throw new Error('Mobile page script missing')
  runInNewContext(script, {
    document, window, localStorage, fetch: backend.fetch, console, AbortController, URL: PageURL, Blob, Date,
    setTimeout, clearTimeout, navigator,
    requestAnimationFrame: (callback: () => void) => callback(),
    history: { pushState: vi.fn(), replaceState: vi.fn() }, location: { href: 'http://mobile.test/' }
  })
  await flushRequests()
  const get = (selector: string) => {
    const element = document.root.querySelector(selector)
    if (!element) throw new Error('Mobile control not rendered: ' + selector)
    return element
  }
  const click = async (selector: string) => {
    const target = get(selector)
    if (!target.disabled) document.root.emit('click', { target })
    await flushRequests()
  }
  const type = async (selector: string, value: string, extra: Record<string, unknown> = {}) => {
    const element = get(selector)
    element.focus()
    element.value = value
    element.selectionStart = element.selectionEnd = value.length
    element.emit('input', extra)
    await flushRequests()
  }
  const openChapter = async (number = 1) => { await click('[data-project="project-1"]'); await click('[data-chapter="' + number + '"]') }
  const submit = async (selector: string) => { get(selector).emit('submit'); await flushRequests() }
  return { backend, document, saved, confirm, alert, get, click, type, openChapter, submit, localStorage, windowListeners, downloadedBlobs, navigator }
}

describe('mobile page interactions', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('persists typing immediately and restores an unsynced draft after refreshing', async () => {
    const page = await createPage()
    await page.openChapter()
    await page.type('#prose', '刷新前手机刚输入的内容')
    expect(page.saved.get('writer-mobile-draft:project-1:1')).toContain('刷新前手机刚输入的内容')
    expect(page.backend.writes).toHaveLength(0)

    const refreshed = await createPage(page.backend, page.saved)
    await refreshed.openChapter()
    expect(refreshed.get('#prose').value).toBe('刷新前手机刚输入的内容')
  })

  it('automatically saves an adopted AI continuation without further typing', async () => {
    const page = await createPage()
    await page.openChapter()
    await page.click('[data-action="ai"]')
    await page.click('[data-ai-mode="continue"]')
    await page.click('[data-action="ai-apply"]')
    await vi.advanceTimersByTimeAsync(1600)
    expect(page.backend.chapters.get(1)?.content).toContain('AI 生成的正文')
    expect(page.backend.writes).toHaveLength(1)
  })

  it('does not restore discarded edits after typing back to the saved content', async () => {
    const page = await createPage()
    await page.openChapter()
    await page.type('#prose', '临时改写后决定不要')
    await page.type('#prose', '第一章原始正文')
    const refreshed = await createPage(page.backend, page.saved)
    await refreshed.openChapter()
    expect(refreshed.get('#prose').value).toBe('第一章原始正文')
  })

  it('retains a draft reverted to the old saved text while a changed version is still saving', async () => {
    const gate = deferred<void>()
    const backend = createBackend()
    backend.setSaveGate(gate.promise)
    const page = await createPage(backend)
    await page.openChapter()
    await page.type('#prose', '已经提交但还在保存的新正文')
    await page.click('[data-action="save"]')
    await page.type('#prose', '第一章原始正文')
    expect(page.saved.get('writer-mobile-draft:project-1:1')).toContain('第一章原始正文')
    expect(backend.activeWrites).toBe(1)
    gate.resolve()
    await flushRequests()
    expect(backend.chapters.get(1)?.content).toBe('已经提交但还在保存的新正文')
    const refreshed = await createPage(backend, page.saved)
    await refreshed.openChapter()
    expect(refreshed.get('#prose').value).toBe('第一章原始正文')
  })

  it('saves edits made while an earlier save is still in flight', async () => {
    const gate = deferred<void>()
    const backend = createBackend()
    backend.setSaveGate(gate.promise)
    const page = await createPage(backend)
    await page.openChapter()
    await page.type('#prose', '第一份提交的正文')
    await vi.advanceTimersByTimeAsync(1500)
    expect(backend.writes).toHaveLength(1)
    await page.type('#prose', '保存期间继续输入的最新正文')
    await vi.advanceTimersByTimeAsync(1500)
    gate.resolve()
    await flushRequests()
    await vi.advanceTimersByTimeAsync(1600)
    expect(backend.chapters.get(1)?.content).toBe('保存期间继续输入的最新正文')
    expect(backend.writes).toHaveLength(2)
  })

  it('serializes manual, automatic, and background saves without rolling the revision backward', async () => {
    const firstSave = deferred<void>()
    const secondSave = deferred<void>()
    const backend = createBackend()
    backend.setSaveGate(firstSave.promise)
    const page = await createPage(backend)
    await page.openChapter()
    await page.type('#prose', '第一次手动保存的正文')
    await page.click('[data-action="save"]')
    expect(backend.activeWrites).toBe(1)
    await page.type('#prose', '等待保存时继续写下的最新正文')
    await vi.advanceTimersByTimeAsync(1500)
    page.document.visibilityState = 'hidden'
    page.document.emit('visibilitychange')
    backend.setSaveGate(secondSave.promise)
    firstSave.resolve()
    await flushRequests()
    expect(backend.writes).toHaveLength(2)
    expect(backend.activeWrites).toBe(1)
    expect(backend.maxConcurrentWrites).toBe(1)
    secondSave.resolve()
    await flushRequests()
    await vi.advanceTimersByTimeAsync(1600)
    expect(backend.writes).toHaveLength(2)
    expect(backend.chapters.get(1)?.content).toBe('等待保存时继续写下的最新正文')
    expect(backend.writes[1].baseRevision).toBe('revision-1-saved')
    expect(backend.chapters.get(1)?.revision).toBe('revision-1-saved-saved')

    await page.type('#prose', '并发队列结束后继续写作')
    await vi.advanceTimersByTimeAsync(1600)
    expect(backend.writes.at(-1)?.baseRevision).toBe('revision-1-saved-saved')
    expect(backend.chapters.get(1)?.content).toBe('并发队列结束后继续写作')
    expect(backend.maxConcurrentWrites).toBe(1)
  })

  it('retains offline edits locally and automatically syncs when the connection returns', async () => {
    const page = await createPage()
    await page.openChapter()
    for (const listener of page.windowListeners.get('offline') || []) listener({})
    await page.type('#prose', '断网期间写下的手机正文')
    await vi.advanceTimersByTimeAsync(2000)
    expect(page.backend.writes).toHaveLength(0)
    expect(page.saved.get('writer-mobile-draft:project-1:1')).toContain('断网期间写下的手机正文')
    for (const listener of page.windowListeners.get('online') || []) listener({})
    await vi.advanceTimersByTimeAsync(300)
    expect(page.backend.chapters.get(1)?.content).toBe('断网期间写下的手机正文')
    expect(page.backend.writes).toHaveLength(1)
    expect(page.saved.has('writer-mobile-draft:project-1:1')).toBe(false)
  })

  it('does not save a previous project draft under another project after a chapter read fails', async () => {
    const page = await createPage()
    await page.openChapter()
    for (const listener of page.windowListeners.get('offline') || []) listener({})
    await page.type('#prose', '第一部作品尚未同步的正文')
    page.backend.failNextChapterRead(2)
    await page.click('[data-chapter="2"]')
    expect(page.document.root.textContent).toContain('读取正文失败')
    await page.click('[data-action="back"]')
    await page.click('[data-action="back"]')
    for (const listener of page.windowListeners.get('online') || []) listener({})
    await page.click('[data-project="project-2"]')
    for (const listener of page.windowListeners.get('pagehide') || []) listener({})
    expect(page.saved.get('writer-mobile-draft:project-1:1')).toContain('第一部作品尚未同步的正文')
    expect(page.saved.has('writer-mobile-draft:project-2:1')).toBe(false)
    expect(page.backend.writes).toHaveLength(0)
  })

  it('ignores an AI response that arrives after opening another chapter', async () => {
    const pending = deferred<{ mode: string; text: string }>()
    const backend = createBackend()
    backend.setAiResult(pending.promise)
    const page = await createPage(backend)
    await page.openChapter()
    await page.click('[data-action="ai"]')
    await page.click('[data-ai-mode="continue"]')
    await page.click('[data-action="back"]')
    await page.click('[data-chapter="2"]')
    pending.resolve({ mode: 'continue', text: '第一章迟到的 AI 结果' })
    await flushRequests()
    expect(page.get('#prose').value).toBe('第二章原始正文')
    expect(page.document.root.textContent).not.toContain('第一章迟到的 AI 结果')
    expect(page.document.root.querySelector('[data-action="ai-apply"]')).toBeNull()
  })

  it('keeps a stopped AI request from replacing a newer AI preview', async () => {
    const pending = deferred<{ mode: string; text: string }>()
    const backend = createBackend()
    backend.setAiResult(pending.promise)
    const page = await createPage(backend)
    await page.openChapter()
    await page.click('[data-action="ai"]')
    await page.click('[data-ai-mode="continue"]')
    await page.click('[data-action="ai-stop"]')
    backend.setAiResult(Promise.resolve({ mode: 'continue', text: '第二次生成的新结果' }))
    await page.click('[data-ai-mode="continue"]')
    pending.resolve({ mode: 'continue', text: '已经停止的旧结果' })
    await flushRequests()
    expect(page.document.root.textContent).toContain('第二次生成的新结果')
    expect(page.document.root.textContent).not.toContain('已经停止的旧结果')
    await page.click('[data-action="ai-apply"]')
    expect(page.get('#prose').value).toContain('第二次生成的新结果')
  })

  it('keeps a conflicting draft and does not silently overwrite the newer computer version', async () => {
    const page = await createPage()
    await page.openChapter()
    await page.type('#prose', '手机端未同步的正文')
    const chapter = page.backend.chapters.get(1)!
    chapter.content = '电脑端更新后的正文'
    chapter.revision = 'computer-new-revision'
    await vi.advanceTimersByTimeAsync(1600)
    expect(chapter.content).toBe('电脑端更新后的正文')
    expect(page.saved.get('writer-mobile-draft:project-1:1')).toContain('手机端未同步的正文')
    await page.click('[data-action="back"]')
    await page.click('[data-chapter="1"]')
    await vi.advanceTimersByTimeAsync(3000)
    expect(chapter.content).toBe('电脑端更新后的正文')
    expect(page.saved.get('writer-mobile-draft:project-1:1')).toContain('手机端未同步的正文')
  })

  it('saves a conflict only after comparison and an explicit merge confirmation', async () => {
    const page = await createPage()
    await page.openChapter()
    await page.type('#prose', '对照并合并后的手机正文')
    const chapter = page.backend.chapters.get(1)!
    chapter.content = '电脑端更新的正文'
    chapter.revision = 'computer-new-revision'
    await vi.advanceTimersByTimeAsync(1600)
    await page.click('[data-action="compare"]')
    expect(page.get('#prose').value).toBe('对照并合并后的手机正文')
    page.confirm.mockReturnValueOnce(false)
    await page.click('[data-action="merge"]')
    expect(chapter.content).toBe('电脑端更新的正文')
    page.confirm.mockReturnValueOnce(true)
    await page.click('[data-action="merge"]')
    expect(chapter.content).toBe('对照并合并后的手机正文')
    expect(page.backend.writes.at(-1)?.baseRevision).toBe('computer-new-revision')
  })

  it('downloads the retained mobile draft after a revision conflict', async () => {
    const page = await createPage()
    await page.openChapter()
    await page.type('#prose', '手机端要下载保留的正文')
    page.backend.chapters.get(1)!.revision = 'computer-new-revision'
    await vi.advanceTimersByTimeAsync(1600)
    await page.click('[data-action="download"]')
    expect(page.document.downloads).toHaveLength(1)
    expect(page.document.downloads[0].download).toBe('第1章-手机草稿.txt')
    expect(await page.downloadedBlobs[0].text()).toBe('手机端要下载保留的正文')
  })

  it('filters chapters without replacing the input during Chinese composition', async () => {
    const page = await createPage()
    await page.click('[data-project="project-1"]')
    await page.click('[data-nav="chapters"]')
    const input = page.get('#chapterFilter')
    input.emit('compositionstart')
    await page.type('#chapterFilter', '初', { isComposing: true })
    expect(page.get('#chapterFilter')).toBe(input)
    input.emit('compositionend')
    await flushRequests()
    expect(page.get('#chapterFilter')).toBe(input)
    expect(page.get('#chapterList').textContent).toContain('初见')
    expect(page.get('#chapterList').textContent).not.toContain('重逢')
  })

  it('does not reopen search when its request finishes after navigating home', async () => {
    const pending = deferred<{ results: unknown[] }>()
    const backend = createBackend()
    backend.setSearchResult(pending.promise)
    const page = await createPage(backend)
    await page.click('[data-project="project-1"]')
    await page.click('[data-nav="search"]')
    await page.type('#searchInput', '人物')
    page.get('#searchForm').emit('submit')
    await flushRequests()
    await page.click('[data-nav="home"]')
    pending.resolve({ results: [{ chapterNumber: 1, title: '初见', snippet: '人物找到的正文', occurrences: 1 }] })
    await flushRequests()
    expect(page.document.root.querySelector('#searchForm')).toBeNull()
    expect(page.get('[data-nav="home"]').getAttribute('aria-current')).toBe('page')
  })

  it('asks before a rewrite replaces edits made during AI generation', async () => {
    const pending = deferred<{ mode: string; text: string }>()
    const backend = createBackend()
    backend.setAiResult(pending.promise)
    const page = await createPage(backend)
    await page.openChapter()
    await page.click('[data-action="ai"]')
    await page.type('#aiInstruction', '重写人物对话')
    await page.click('[data-ai-mode="rewrite"]')
    await page.type('#prose', '生成期间新加入的重要内容')
    pending.resolve({ mode: 'rewrite', text: 'AI 重写的整章正文' })
    await flushRequests()
    page.confirm.mockReturnValueOnce(false)
    await page.click('[data-action="ai-apply"]')
    expect(page.confirm).toHaveBeenCalled()
    expect(page.get('#prose').value).toBe('生成期间新加入的重要内容')
    page.confirm.mockReturnValueOnce(true)
    await page.click('[data-action="ai-apply"]')
    expect(page.get('#prose').value).toBe('AI 重写的整章正文')
  })
})

describe('mobile brainstorm interactions', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('generates long-story ideas directly from the project list without opening a project', async () => {
    const page = await createPage()
    await page.click('[data-action="brainstorm"]')
    expect(page.get('#brainChapters').value).toBe('')
    await page.submit('#brainForm')
    const input = page.backend.brainstormRequests[0]
    expect(input.kind).toBe('long')
    expect(input.previousIdeas).toEqual([])
    expect(input.targetChapters).toBeUndefined()
    expect(input.targetWords).toBeUndefined()
    expect(input.variationSeed).toBeTruthy()
    expect(page.backend.fetch.mock.calls.some(([path]) => path.endsWith('/chapters'))).toBe(false)
    expect(page.get('#brainResults').textContent).toContain('长期主线1-1')
    expect(page.get('#brainResults').querySelectorAll('[data-brain-favorite]')).toHaveLength(3)
  })

  it('passes all long-story generation conditions and opens from the project home', async () => {
    const page = await createPage()
    await page.click('[data-project="project-1"]')
    await page.click('[data-action="brainstorm"]')
    await page.type('#brainGenre', '  悬疑  ')
    await page.type('#brainDirection', '调查员只能听见谎言')
    await page.type('#brainRequirements', '慢热感情线，每卷有完整悬案')
    await page.type('#brainSource', '一场没有证人的旧案')
    await page.type('#brainChapters', '240')
    await page.submit('#brainForm')
    expect(page.backend.brainstormRequests[0]).toMatchObject({
      kind: 'long', genre: '悬疑', direction: '调查员只能听见谎言', requirements: '慢热感情线，每卷有完整悬案',
      sourceBrief: '一场没有证人的旧案', targetChapters: 240, previousIdeas: []
    })
    expect(page.backend.brainstormRequests[0].targetWords).toBeUndefined()
  })

  it('rejects invalid chapter counts before requesting generation', async () => {
    const page = await createPage()
    await page.click('[data-action="brainstorm"]')
    for (const chapters of ['0', '1.5', '100001']) {
      await page.type('#brainChapters', chapters)
      await page.submit('#brainForm')
      expect(page.get('#brainNotice').textContent).toContain('1—100000 的整数')
    }
    expect(page.backend.brainstormRequests).toHaveLength(0)
    await page.type('#brainChapters', '')
    await page.submit('#brainForm')
    expect(page.backend.brainstormRequests).toHaveLength(1)
    expect(page.backend.brainstormRequests[0].targetChapters).toBeUndefined()
  })

  it('keeps long, short, and medium conditions independent and restores them after refreshing', async () => {
    const page = await createPage()
    await page.click('[data-action="brainstorm"]')
    await page.type('#brainGenre', '长篇玄幻')
    await page.type('#brainChapters', '300')
    await page.click('[data-brain-kind="short"]')
    expect(page.get('#brainWords').value).toBe('8000')
    await page.type('#brainGenre', '短篇悬疑')
    await page.type('#brainWords', '9000')
    await page.click('[data-brain-kind="medium"]')
    expect(page.get('#brainWords').value).toBe('30000')
    await page.type('#brainGenre', '中篇现实')
    await page.type('#brainDirection', '分开十年的姐妹重逢')
    await page.submit('#brainForm')
    expect(page.backend.brainstormRequests[0]).toMatchObject({ kind: 'medium', targetWords: 30000, genre: '中篇现实' })
    expect(page.backend.brainstormRequests[0].targetChapters).toBeUndefined()

    const refreshed = await createPage(page.backend, page.saved)
    await refreshed.click('[data-action="brainstorm"]')
    expect(refreshed.get('[data-brain-kind="medium"]').getAttribute('aria-pressed')).toBe('true')
    expect(refreshed.get('#brainGenre').value).toBe('中篇现实')
    expect(refreshed.get('#brainResults').textContent).toContain('脑洞1-1')
    await refreshed.click('[data-brain-kind="short"]')
    expect(refreshed.get('#brainGenre').value).toBe('短篇悬疑')
    expect(refreshed.get('#brainWords').value).toBe('9000')
    expect(refreshed.get('#brainResults').textContent).not.toContain('脑洞1-1')
    await refreshed.click('[data-brain-kind="long"]')
    expect(refreshed.get('#brainGenre').value).toBe('长篇玄幻')
    expect(refreshed.get('#brainChapters').value).toBe('300')
  })

  it('passes recent fingerprints on replacement batches and retains only five successful batches', async () => {
    const page = await createPage()
    await page.click('[data-action="brainstorm"]')
    for (let batch = 0; batch < 6; batch++) await page.submit('#brainForm')
    expect(page.backend.brainstormRequests[1].previousIdeas).toEqual(Array.from({ length: 3 }, (_, index) => ({
      title: '脑洞1-' + (index + 1), premise: '故事设定1-' + (index + 1)
    })))
    expect(new Set(page.backend.brainstormRequests.map((input) => input.variationSeed)).size).toBe(6)
    const stored = JSON.parse(page.saved.get('writer-mobile-brainstorm:long')!) as { history: Array<{ ideas: TestBrainIdea[] }>; previousIdeas: unknown[] }
    expect(stored.history).toHaveLength(5)
    expect(stored.history[0].ideas[0].title).toBe('脑洞6-1')
    expect(stored.history.at(-1)?.ideas[0].title).toBe('脑洞2-1')
    expect(stored.previousIdeas).toHaveLength(18)
    await page.click('[data-brain-tab="history"]')
    expect(page.get('#brainResults').querySelectorAll('[data-brain-download]')).toHaveLength(15)
    expect(page.get('#brainResults').textContent).not.toContain('脑洞1-1')
  })

  it('restores favorites and downloads every long-story field', async () => {
    const page = await createPage()
    await page.click('[data-action="brainstorm"]')
    await page.submit('#brainForm')
    await page.click('[data-brain-favorite="current:0"]')
    const refreshed = await createPage(page.backend, page.saved)
    await refreshed.click('[data-action="brainstorm"]')
    await refreshed.click('[data-brain-tab="favorites"]')
    expect(refreshed.get('#brainResults').textContent).toContain('脑洞1-1')
    await refreshed.click('[data-brain-download="favorite:0"]')
    expect(refreshed.document.downloads).toHaveLength(1)
    const text = await refreshed.downloadedBlobs[0].text()
    for (const field of Object.values(brainstormIdea('long', '1-1'))) expect(text).toContain(field)
    expect(refreshed.document.downloads[0].download).toBe('脑洞1-1-脑洞.txt')
    await refreshed.click('[data-brain-favorite="favorite:0"]')
    expect(refreshed.get('#brainResults').textContent).toContain('还没有收藏')
  })

  it('ignores a stopped long-story response after generating a short-story batch', async () => {
    const pending = deferred<TestBrainResult>()
    const backend = createBackend()
    backend.setBrainstormResult(pending.promise)
    const page = await createPage(backend)
    await page.click('[data-action="brainstorm"]')
    await page.submit('#brainForm')
    await page.click('[data-action="brain-stop"]')
    expect(backend.brainstormSignals[0].aborted).toBe(true)
    await page.click('[data-brain-kind="short"]')
    backend.setBrainstormResult(null)
    await page.submit('#brainForm')
    pending.resolve({ ok: true, ideas: [brainstormIdea('long', '迟到旧长篇')], rawText: '迟到原文' })
    await flushRequests()
    expect(page.get('[data-brain-kind="short"]').getAttribute('aria-pressed')).toBe('true')
    expect(page.get('#brainResults').textContent).toContain('脑洞2-1')
    expect(page.get('#brainResults').textContent).not.toContain('迟到旧长篇')
    expect(page.saved.get('writer-mobile-brainstorm:short')).not.toContain('迟到原文')
    expect(JSON.parse(page.saved.get('writer-mobile-brainstorm:long')!).status).toBe('stopped')
  })

  it('does not reopen the brainstorm page when a response arrives after leaving', async () => {
    const pending = deferred<TestBrainResult>()
    const backend = createBackend()
    backend.setBrainstormResult(pending.promise)
    const page = await createPage(backend)
    await page.click('[data-action="brainstorm"]')
    await page.submit('#brainForm')
    await page.click('[data-action="back"]')
    pending.resolve({ ok: true, ideas: [brainstormIdea('long', '离开后迟到')], rawText: '离开后收到的原文' })
    await flushRequests()
    expect(page.document.root.querySelector('#brainForm')).toBeNull()
    expect(page.document.root.querySelector('[data-action="brainstorm"]')).not.toBeNull()
    expect(page.document.root.textContent).not.toContain('离开后迟到')
    expect(JSON.parse(page.saved.get('writer-mobile-brainstorm:long')!).status).toBe('stopped')
  })

  it('restores generation controls after returning from the back-forward cache and ignores the canceled response', async () => {
    const pending = deferred<TestBrainResult>()
    const page = await createPage()
    await page.click('[data-action="brainstorm"]')
    await page.submit('#brainForm')
    page.backend.setBrainstormResult(pending.promise)
    await page.submit('#brainForm')
    expect(page.get('#brainGenerate').disabled).toBe(true)
    for (const listener of page.windowListeners.get('pagehide') || []) listener({ persisted: true })
    expect(page.backend.brainstormSignals[1].aborted).toBe(true)
    for (const listener of page.windowListeners.get('pageshow') || []) listener({ persisted: true })
    expect(page.get('#brainGenerate').disabled).toBe(false)
    expect(page.get('[data-brain-kind="short"]').disabled).toBe(false)
    expect(page.get('#brainNotice').textContent).toContain('生成已停止')
    expect(page.get('#brainResults').textContent).toContain('脑洞1-1')
    page.backend.setBrainstormResult(null)
    await page.submit('#brainForm')
    pending.resolve({ ok: true, ideas: [brainstormIdea('long', '缓存页已取消的旧结果')], rawText: '缓存页迟到的旧原文' })
    await flushRequests()
    expect(page.get('#brainResults').textContent).toContain('脑洞3-1')
    expect(page.get('#brainResults').textContent).not.toContain('缓存页已取消的旧结果')
    expect(page.saved.get('writer-mobile-brainstorm:long')).not.toContain('缓存页迟到的旧原文')
  })

  it('preserves successful candidates after a failed batch and retains the failed response text', async () => {
    const page = await createPage()
    await page.click('[data-action="brainstorm"]')
    await page.submit('#brainForm')
    page.backend.setBrainstormResult(Promise.resolve({ ok: false, error: '这次返回格式不完整', rawText: '失败但可以保存的模型原文' }))
    await page.submit('#brainForm')
    expect(page.get('#brainResults').textContent).toContain('脑洞1-1')
    expect(page.get('#brainNotice').textContent).toContain('这次返回格式不完整')
    const stored = JSON.parse(page.saved.get('writer-mobile-brainstorm:long')!) as { status: string; history: unknown[]; raw: string }
    expect(stored.history).toHaveLength(1)
    expect(stored.status).toBe('failed')
    expect(stored.raw).toBe('失败但可以保存的模型原文')
    await page.click('[data-action="brain-download-raw"]')
    expect(await page.downloadedBlobs[0].text()).toBe('失败但可以保存的模型原文')
    const refreshed = await createPage(page.backend, page.saved)
    await refreshed.click('[data-action="brainstorm"]')
    expect(refreshed.get('#brainNotice').textContent).toContain('这次返回格式不完整')
    expect(refreshed.get('#brainResults').textContent).toContain('脑洞1-1')
  })

  it('retains up to 200000 characters of raw text through refresh and download', async () => {
    const backend = createBackend()
    const raw = '原'.repeat(200000)
    backend.setBrainstormResult(Promise.resolve({ ok: false, error: '返回格式不完整', rawText: raw + '超过上限的内容' }))
    const page = await createPage(backend)
    await page.click('[data-action="brainstorm"]')
    await page.submit('#brainForm')
    expect(page.get('[aria-label="脑洞生成原文"]').value).toBe(raw)
    const refreshed = await createPage(backend, page.saved)
    await refreshed.click('[data-action="brainstorm"]')
    expect(refreshed.get('[aria-label="脑洞生成原文"]').value).toBe(raw)
    await refreshed.click('[data-action="brain-download-raw"]')
    expect(await refreshed.downloadedBlobs[0].text()).toBe(raw)
  })

  it('expands selectable text when the browser has no clipboard API', async () => {
    const page = await createPage()
    page.navigator.clipboard = undefined
    await page.click('[data-action="brainstorm"]')
    await page.submit('#brainForm')
    await page.click('[data-brain-copy="current:0"]')
    const preview = page.get('#brainCopyPreview')
    for (const field of Object.values(brainstormIdea('long', '1-1'))) expect(preview.value).toContain(field)
    expect(page.document.activeElement).toBe(preview)
    expect(preview.selectionStart).toBe(0)
    expect(preview.selectionEnd).toBe(preview.value.length)
    expect(page.get('#brainNotice').textContent).toContain('当前浏览器不支持直接复制')
  })

  it('shows failed persistence while keeping generated ideas available for download', async () => {
    const page = await createPage()
    await page.click('[data-action="brainstorm"]')
    page.localStorage.setItem.mockImplementation(() => { throw new Error('Storage quota exceeded') })
    await page.type('#brainGenre', '无法持久化的悬疑条件')
    expect(page.get('#brainNotice').textContent).toContain('当前浏览器无法保存脑洞记录')
    await page.submit('#brainForm')
    expect(page.get('#brainResults').textContent).toContain('脑洞1-1')
    expect(page.get('#brainNotice').textContent).toContain('当前浏览器无法保存脑洞记录')
    expect(page.saved.has('writer-mobile-brainstorm:long')).toBe(false)
    await page.click('[data-brain-download="current:0"]')
    expect(await page.downloadedBlobs[0].text()).toContain('无法持久化的悬疑条件')
  })
})

describe('mobile background batch interactions', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  async function openBatch(backend = createBatchBackend()) {
    const page = await createPage(backend)
    await page.click('[data-project="project-1"]')
    await page.click('[data-action="mobile-batch"]')
    return page
  }

  it('reads fresh chapters and defaults to ten unwritten chapters with automatic strength off', async () => {
    const page = await openBatch()
    expect(page.get('#mbFrom').value).toBe('3')
    expect(page.get('#mbTo').value).toBe('12')
    expect(page.get('#mbAutoStrength').checked).toBe(false)
    expect(page.backend.batchReads).toEqual(['project-1'])
    await page.submit('#mbForm')
    expect(page.backend.batchCommands).toHaveLength(1)
    expect(page.backend.batchCommands[0]).toMatchObject({ projectId: 'project-1', action: 'start', body: { fromChapter: 3, toChapter: 12, autoStrength: false } })
    expect(page.backend.batchCommands[0].body.requestId).toBeTruthy()
    expect(page.document.root.textContent).toContain('0 / 10 章已保存')
    expect(page.document.root.textContent).toContain('锁屏或手机断网后，电脑仍会继续')
  })

  it('shortens the default at a written chapter and at the last known chapter', async () => {
    const gaps = createBatchBackend()
    gaps.chapters.get(6)!.content = '已经写好的第六章'
    const gapPage = await openBatch(gaps)
    expect(gapPage.get('#mbFrom').value).toBe('3')
    expect(gapPage.get('#mbTo').value).toBe('5')
    const short = createBackend()
    short.chapters.get(2)!.content = ''
    const shortPage = await openBatch(short)
    expect(shortPage.get('#mbFrom').value).toBe('2')
    expect(shortPage.get('#mbTo').value).toBe('2')
    const writtenPage = await openBatch(createBackend())
    expect(writtenPage.document.root.textContent).toContain('当前已知章节全部已有正文')
  })

  it('validates the one-to-one-hundred chapter limit and rechecks overwrite risks before submitting', async () => {
    const page = await openBatch()
    for (const [from, to] of [['0', '12'], ['4', '3'], ['3', '103']]) {
      await page.type('#mbFrom', from)
      await page.type('#mbTo', to)
      await page.submit('#mbForm')
    }
    expect(page.backend.batchCommands).toHaveLength(0)
    expect(page.get('#mbNotice').textContent).toContain('每批最多生成 100 章')
    const stableFrom = page.get('#mbFrom')
    stableFrom.focus()
    await vi.advanceTimersByTimeAsync(2000)
    expect(page.get('#mbFrom')).toBe(stableFrom)
    expect(page.document.activeElement).toBe(stableFrom)
    expect(page.get('#mbNotice').textContent).toContain('每批最多生成 100 章')
    await page.type('#mbFrom', '3')
    await page.type('#mbTo', '12')
    page.backend.chapters.get(5)!.content = '电脑端刚刚写好的第五章'
    await page.submit('#mbForm')
    expect(page.backend.batchCommands).toHaveLength(0)
    expect(page.get('#mbNotice').textContent).toContain('第 5 章已有正文')
  })

  it('sends selected strength once even if the form is submitted again while the start request is pending', async () => {
    const pending = deferred<{ job: TestBatchJob | null }>()
    const backend = createBatchBackend()
    backend.setNextBatchStart(pending.promise)
    const page = await openBatch(backend)
    const checkbox = page.get('#mbAutoStrength')
    checkbox.checked = true
    checkbox.emit('change')
    await page.submit('#mbForm')
    await page.submit('#mbForm')
    expect(backend.batchCommands).toHaveLength(1)
    expect(backend.batchCommands[0].body.autoStrength).toBe(true)
    expect(page.get('#mbStart').disabled).toBe(true)
    pending.resolve({ job: backend.batchJobs.get('project-1')! })
    await flushRequests()
    expect(page.document.root.textContent).toContain('按节奏调整生成强度')
  })

  it('restores saved progress and per-chapter results, then resumes checks using only the server job id', async () => {
    const backend = createBatchBackend()
    const job = batchJob()
    job.running = false
    job.stage = undefined
    job.progress = { ...job.progress, current: 2, currentChapter: 4, completed: [3, 4], status: 'paused', pendingPostProcessChapter: 4, pauseReason: '第4章需要对照细纲', error: '存在需要核对的差异' }
    job.summaries = [
      { chapter: 3, wordCount: 3100, saved: true, checks: 'completed', deslop: '去 AI 味已完成', memory: '已写入 2 条，待确认 1 条' },
      { chapter: 4, wordCount: 2900, saved: true, checks: 'pending', deslop: '已完成', memory: '等待核对' }
    ]
    backend.batchJobs.set('project-1', job)
    const page = await openBatch(backend)
    expect(page.document.root.textContent).toContain('2 / 10 章已保存')
    expect(page.document.root.textContent).toContain('第4章需要对照细纲')
    expect(page.document.root.textContent).toContain('已写入 2 条，待确认 1 条')
    expect(page.document.root.textContent).toContain('检查：待补跑')
    expect(page.document.root.textContent).toContain('继续时复用正文补跑检查')
    await page.click('[data-action="mobile-batch-resume"]')
    expect(backend.batchCommands.at(-1)).toEqual({ projectId: 'project-1', action: 'resume', body: { jobId: job.id } })
    expect(page.document.root.textContent).toContain('电脑正在补跑检查')
    expect(page.document.root.textContent).not.toContain('继续时复用正文补跑检查')
  })

  it('refreshes the server job when a start request finishes after the cached page has returned', async () => {
    const pending = deferred<{ job: TestBatchJob | null }>()
    const backend = createBatchBackend()
    backend.setNextBatchStart(pending.promise)
    const page = await openBatch(backend)
    await page.submit('#mbForm')
    const acceptedJob = backend.batchJobs.get('project-1')!
    // The restored GET can reach the computer before the earlier POST upload.
    backend.batchJobs.set('project-1', null)
    for (const listener of page.windowListeners.get('pagehide') || []) listener({ persisted: true })
    for (const listener of page.windowListeners.get('pageshow') || []) listener({ persisted: true })
    await flushRequests()
    expect(page.get('#mbForm')).toBeTruthy()
    acceptedJob.progress.completed = [3]
    acceptedJob.progress.current = 1
    backend.batchJobs.set('project-1', acceptedJob)
    const staleResponse = batchJob()
    staleResponse.running = false
    staleResponse.progress.status = 'completed'
    pending.resolve({ job: staleResponse })
    await flushRequests()
    expect(page.document.root.textContent).toContain('1 / 10 章已保存')
    expect(page.document.root.textContent).toContain('正在生成正文')
    expect(page.document.root.textContent).not.toContain('本批完成')
    expect(backend.batchCommands).toHaveLength(1)
  })

  it('does not leave loading controls stuck when online restoration happens during a stop request', async () => {
    const pending = deferred<{ job: TestBatchJob | null }>()
    const backend = createBatchBackend()
    const job = batchJob()
    backend.batchJobs.set('project-1', job)
    backend.setNextBatchStop(pending.promise)
    const page = await openBatch(backend)
    await page.click('[data-action="mobile-batch-stop"]')
    for (const listener of page.windowListeners.get('online') || []) listener({})
    await vi.advanceTimersByTimeAsync(0)
    job.running = false
    job.stopping = false
    job.progress.status = 'paused'
    pending.resolve({ job })
    await flushRequests()
    expect(page.document.root.textContent).toContain('已暂停')
    expect(page.document.root.textContent).not.toContain('正在读取电脑上的章节与本批进度')
    expect(page.get('[data-action="mobile-batch-resume"]').disabled).toBe(false)
    expect(page.get('[data-action="mobile-batch-clear"]').disabled).toBe(false)
    expect(backend.batchCommands).toHaveLength(1)
  })

  it('waits for the computer to confirm stopping and clears only a stopped batch while preserving saved chapters', async () => {
    const backend = createBatchBackend()
    const job = batchJob()
    backend.batchJobs.set('project-1', job)
    const page = await openBatch(backend)
    await page.click('[data-action="mobile-batch-stop"]')
    expect(backend.batchCommands.at(-1)).toEqual({ projectId: 'project-1', action: 'stop', body: { jobId: job.id } })
    expect(job.running).toBe(true)
    expect(page.document.root.textContent).toContain('正在停止')
    expect(page.document.root.querySelector('[data-action="mobile-batch-clear"]')).toBeNull()
    job.running = false
    job.stopping = false
    job.progress.status = 'paused'
    job.progress.completed = [3]
    job.progress.current = 1
    backend.chapters.get(3)!.content = '已经保存的第三章正文'
    await vi.advanceTimersByTimeAsync(2000)
    page.confirm.mockReturnValueOnce(false)
    await page.click('[data-action="mobile-batch-clear"]')
    expect(backend.batchJobs.get('project-1')).not.toBeNull()
    page.confirm.mockReturnValueOnce(true)
    await page.click('[data-action="mobile-batch-clear"]')
    expect(backend.batchJobs.get('project-1')).toBeNull()
    expect(backend.chapters.get(3)!.content).toBe('已经保存的第三章正文')
    expect(page.get('#mbFrom').value).toBe('4')
    expect(page.get('#mbTo').value).toBe('12')
  })

  it('polls every two seconds without overlapping a slow read or a manual refresh', async () => {
    const backend = createBatchBackend()
    const job = batchJob()
    backend.batchJobs.set('project-1', job)
    const page = await openBatch(backend)
    const pending = deferred<{ job: TestBatchJob | null }>()
    backend.setNextBatchRead(pending.promise)
    await vi.advanceTimersByTimeAsync(2000)
    expect(backend.activeBatchReads).toBe(1)
    await vi.advanceTimersByTimeAsync(10000)
    await page.click('[data-action="mobile-batch-refresh"]')
    expect(backend.batchReads).toHaveLength(2)
    expect(backend.maxConcurrentBatchReads).toBe(1)
    job.progress.completed = [3]
    job.progress.current = 1
    pending.resolve({ job })
    await flushRequests()
    expect(page.document.root.textContent).toContain('1 / 10 章已保存')
    job.retryWait = { chapter: 4, attempt: 1, maxAttempts: 3, waitMs: 10000, retryAt: Date.now() + 10000 }
    await page.click('[data-action="mobile-batch-refresh"]')
    expect(page.document.root.textContent).toContain('10 秒后自动重试')
    await vi.advanceTimersByTimeAsync(2000)
    expect(page.document.root.textContent).toContain('8 秒后自动重试')
  })

  it('reports a failed progress read without claiming the background task stopped and allows retry', async () => {
    const backend = createBatchBackend()
    const job = batchJob()
    backend.batchJobs.set('project-1', job)
    const page = await openBatch(backend)
    backend.failNextBatchRead()
    await vi.advanceTimersByTimeAsync(2000)
    expect(page.get('#mbNotice').textContent).toContain('电脑任务可能仍在运行')
    expect(job.running).toBe(true)
    expect(backend.batchCommands).toHaveLength(0)
    await page.click('[data-action="mobile-batch-refresh"]')
    expect(page.get('#mbNotice').textContent).not.toContain('暂时无法读取最新进度')
    expect(page.document.root.textContent).toContain('正在生成正文')
  })

  it('returns to the chapter list without stopping the computer and ignores an old poll after switching projects', async () => {
    const backend = createBatchBackend()
    const job = batchJob()
    backend.batchJobs.set('project-1', job)
    const page = await openBatch(backend)
    const pending = deferred<{ job: TestBatchJob | null }>()
    backend.setNextBatchRead(pending.promise)
    await vi.advanceTimersByTimeAsync(2000)
    await page.click('[data-action="mobile-batch-chapters"]')
    expect(page.document.root.querySelector('#chapterFilter')).not.toBeNull()
    expect(backend.batchCommands).toHaveLength(0)
    expect(job.running).toBe(true)
    await page.click('[data-action="back"]')
    await page.click('[data-action="back"]')
    await page.click('[data-project="project-2"]')
    await page.click('[data-action="mobile-batch"]')
    job.progress.completed = Array.from({ length: 9 }, (_, index) => index + 3)
    job.progress.current = 9
    pending.resolve({ job })
    await flushRequests()
    expect(page.get('#mbForm')).toBeTruthy()
    expect(page.document.root.textContent).toContain('另一部作品')
    expect(page.document.root.textContent).not.toContain('9 / 10 章已保存')
    expect(backend.batchCommands).toHaveLength(0)
  })

  it('keeps the computer running while hidden or offline and restores current progress on return', async () => {
    const backend = createBatchBackend()
    const job = batchJob()
    backend.batchJobs.set('project-1', job)
    const page = await openBatch(backend)
    for (const listener of page.windowListeners.get('pagehide') || []) listener({ persisted: true })
    await vi.advanceTimersByTimeAsync(4000)
    expect(backend.batchReads).toHaveLength(1)
    expect(backend.batchCommands).toHaveLength(0)
    job.progress.completed = [3, 4]
    job.progress.current = 2
    for (const listener of page.windowListeners.get('pageshow') || []) listener({ persisted: true })
    await flushRequests()
    expect(page.document.root.textContent).toContain('2 / 10 章已保存')
    for (const listener of page.windowListeners.get('offline') || []) listener({})
    await vi.advanceTimersByTimeAsync(0)
    expect(page.get('[data-action="mobile-batch-stop"]').disabled).toBe(true)
    expect(page.get('#mbNotice').textContent).toContain('电脑后台任务会继续')
    const readsBeforeOffline = backend.batchReads.length
    await vi.advanceTimersByTimeAsync(4000)
    expect(backend.batchReads).toHaveLength(readsBeforeOffline)
    job.progress.completed = [3, 4, 5]
    job.progress.current = 3
    for (const listener of page.windowListeners.get('online') || []) listener({})
    await vi.advanceTimersByTimeAsync(0)
    await flushRequests()
    expect(page.document.root.textContent).toContain('3 / 10 章已保存')
    expect(page.get('[data-action="mobile-batch-stop"]').disabled).toBe(false)
    expect(backend.batchCommands).toHaveLength(0)
  })
})
