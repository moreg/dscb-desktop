import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const PREFIX = Buffer.from('DSCB1')
let destroyGraceMs = 20_000

type Listener = (...args: unknown[]) => void

export interface WebContentsLike {
  id: number
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
  once(event: string, listener: Listener): void
  on(event: string, listener: Listener): void
  removeListener(event: string, listener: Listener): void
}

interface ListenerEntry {
  listener: Listener
  once: boolean
}

export interface BrowserWindowLike {
  isDestroyed(): boolean
  webContents: WebContentsLike
  focus(): void
}

interface TabState {
  id: string
  contents: WebContentsLike
  destroyed: boolean
  listeners: Map<string, ListenerEntry[]>
  subscribers: Set<(channel: string, args: unknown[]) => void>
  buffer: Array<{ channel: string; args: unknown[] }>
  destroyTimer: ReturnType<typeof setTimeout> | null
  window: BrowserWindowLike
}

type IpcHandler = (event: { sender: WebContentsLike }, ...args: unknown[]) => unknown

interface ShimState {
  userData: string
  exportsDir: string
  handlers: Map<string, IpcHandler>
  tabs: Map<string, TabState>
  byContentsId: Map<number, TabState>
  nextId: number
  keyCache: { secret: string; key: Buffer } | null
}

function shimState(): ShimState {
  const holder = globalThis as { __dscbWebShim?: ShimState }
  if (!holder.__dscbWebShim) {
    holder.__dscbWebShim = {
      userData: '',
      exportsDir: '',
      handlers: new Map(),
      tabs: new Map(),
      byContentsId: new Map(),
      nextId: 1,
      keyCache: null
    }
  }
  return holder.__dscbWebShim
}

export function setDestroyGraceForTests(ms: number): void {
  destroyGraceMs = ms
}

export function configureShim(options: { userData: string; exportsDir: string }): void {
  const state = shimState()
  state.userData = options.userData
  state.exportsDir = options.exportsDir
}

export function resetShimForTests(): void {
  const state = shimState()
  for (const tab of state.tabs.values()) {
    if (tab.destroyTimer) clearTimeout(tab.destroyTimer)
  }
  state.tabs.clear()
  state.byContentsId.clear()
  state.handlers.clear()
  state.nextId = 1
  state.keyCache = null
  destroyGraceMs = 20_000
}

function userDataDir(): string {
  return shimState().userData || process.env.WEB_DATA_DIR || join(homedir(), '.dscb-web')
}

function dataKey(): Buffer {
  const state = shimState()
  const secret = process.env.WEB_DATA_KEY || 'dscb-web-dev-key'
  if (state.keyCache?.secret === secret) return state.keyCache.key
  const key = scryptSync(secret, 'dscb-web-secret', 32)
  state.keyCache = { secret, key }
  return key
}

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return true
  },
  encryptString(plain: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', dataKey(), iv)
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([PREFIX, iv, tag, encrypted])
  },
  decryptString(encoded: Buffer): string {
    const data = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded)
    if (data.length < 33 || !data.subarray(0, 5).equals(PREFIX)) {
      throw new Error('providers.enc is unreadable')
    }
    const iv = data.subarray(5, 17)
    const tag = data.subarray(17, 33)
    const encrypted = data.subarray(33)
    const decipher = createDecipheriv('aes-256-gcm', dataKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
  }
}

function emit(tab: TabState, event: string, ...args: unknown[]): void {
  const entries = tab.listeners.get(event)
  if (!entries) return
  for (const entry of [...entries]) {
    if (entry.once) {
      const list = tab.listeners.get(event) ?? []
      tab.listeners.set(event, list.filter((item) => item !== entry))
    }
    entry.listener(...args)
  }
}

function deliver(tab: TabState, channel: string, args: unknown[]): void {
  if (tab.destroyed) return
  if (tab.subscribers.size === 0) {
    tab.buffer.push({ channel, args })
    if (tab.buffer.length > 500) tab.buffer.shift()
    return
  }
  for (const subscriber of tab.subscribers) subscriber(channel, args)
}

function createTab(tabId: string): TabState {
  const state = shimState()
  const existing = state.tabs.get(tabId)
  if (existing && !existing.destroyed) return existing
  const id = state.nextId++
  const tab: TabState = {
    id: tabId,
    destroyed: false,
    listeners: new Map(),
    subscribers: new Set(),
    buffer: [],
    destroyTimer: null,
    contents: undefined as unknown as WebContentsLike,
    window: undefined as unknown as BrowserWindowLike
  }
  const contents: WebContentsLike = {
    id,
    send(channel, ...args) {
      deliver(tab, channel, args)
    },
    isDestroyed: () => tab.destroyed,
    once(event, listener) {
      const list = tab.listeners.get(event) ?? []
      list.push({ listener, once: true })
      tab.listeners.set(event, list)
    },
    on(event, listener) {
      const list = tab.listeners.get(event) ?? []
      list.push({ listener, once: false })
      tab.listeners.set(event, list)
    },
    removeListener(event, listener) {
      const list = tab.listeners.get(event)
      if (!list) return
      tab.listeners.set(event, list.filter((entry) => entry.listener !== listener))
    }
  }
  tab.contents = contents
  tab.window = {
    isDestroyed: () => tab.destroyed,
    webContents: contents,
    focus() {}
  }
  state.tabs.set(tabId, tab)
  state.byContentsId.set(id, tab)
  return tab
}

function destroyTab(tab: TabState): void {
  if (tab.destroyed) return
  tab.destroyed = true
  if (tab.destroyTimer) {
    clearTimeout(tab.destroyTimer)
    tab.destroyTimer = null
  }
  emit(tab, 'destroyed')
  tab.subscribers.clear()
  tab.buffer = []
}

export function retainTab(tabId: string): void {
  const tab = createTab(tabId)
  if (tab.destroyTimer) {
    clearTimeout(tab.destroyTimer)
    tab.destroyTimer = null
  }
}

export function releaseTab(tabId: string): void {
  const tab = shimState().tabs.get(tabId)
  if (!tab || tab.destroyed || tab.subscribers.size > 0 || tab.destroyTimer) return
  tab.destroyTimer = setTimeout(() => destroyTab(tab), destroyGraceMs)
  tab.destroyTimer.unref?.()
}

export function subscribeTab(
  tabId: string,
  subscriber: (channel: string, args: unknown[]) => void
): () => void {
  const tab = createTab(tabId)
  retainTab(tabId)
  tab.subscribers.add(subscriber)
  const pending = tab.buffer.splice(0)
  for (const event of pending) subscriber(event.channel, event.args)
  return () => {
    tab.subscribers.delete(subscriber)
    if (tab.subscribers.size === 0) releaseTab(tabId)
  }
}

export async function invokeTab(tabId: string, channel: string, args: unknown[]): Promise<unknown> {
  const tab = createTab(tabId)
  if (tab.destroyed) throw new Error('页面已关闭')
  const handler = shimState().handlers.get(channel)
  if (!handler) throw new Error(`未知通道 ${channel}`)
  return await handler({ sender: tab.contents }, ...args)
}

function dialogOptions(first: unknown, second: unknown): { defaultPath?: string } {
  const candidate = second && typeof second === 'object' ? second : first
  if (!candidate || typeof candidate !== 'object') return {}
  const path = (candidate as { defaultPath?: unknown }).defaultPath
  return { defaultPath: typeof path === 'string' ? path : undefined }
}

function exportFilePath(defaultPath: string | undefined): string {
  const dir = shimState().exportsDir || join(userDataDir(), 'exports')
  mkdirSync(dir, { recursive: true })
  const raw = basename(defaultPath || 'export.txt')
  const cleaned = raw.replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').replace(/^\.+/, '') || 'export.txt'
  return join(dir, `${randomBytes(4).toString('hex')}-${cleaned}`)
}

export const dialog = {
  async showOpenDialog(): Promise<{ canceled: boolean; filePaths: string[] }> {
    return { canceled: true, filePaths: [] }
  },
  async showSaveDialog(first?: unknown, second?: unknown): Promise<{ canceled: boolean; filePath?: string }> {
    return { canceled: false, filePath: exportFilePath(dialogOptions(first, second).defaultPath) }
  }
}

export const shell = {
  async openPath(): Promise<string> {
    return 'Web 版无法在服务器上打开本地文件夹'
  },
  openExternal(): void {},
  showItemInFolder(): void {}
}

export const app = {
  getPath(name: string): string {
    if (name === 'home') return homedir()
    if (name === 'temp') return process.env.TEMP || process.env.TMP || '/tmp'
    return userDataDir()
  },
  getVersion(): string {
    return process.env.npm_package_version || '0.1.14'
  },
  isPackaged: false
}

export const BrowserWindow = {
  fromWebContents(contents: { id?: number } | null | undefined): BrowserWindowLike | null {
    if (!contents || typeof contents.id !== 'number') return null
    const tab = shimState().byContentsId.get(contents.id)
    if (!tab || tab.destroyed) return null
    return tab.window
  },
  getAllWindows(): BrowserWindowLike[] {
    return [...shimState().tabs.values()].filter((tab) => !tab.destroyed).map((tab) => tab.window)
  }
}

export const ipcMain = {
  // IPC 边界与桌面版 safeHandle 相同：handler 参数由各通道自行声明。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void {
    shimState().handlers.set(channel, listener as IpcHandler)
  }
}
