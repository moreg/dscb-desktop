import type { IpcTransport } from '../../preload/api'

type Listener = (...args: unknown[]) => void

let transport: IpcTransport | null = null
let ready: Promise<void> | null = null
const listeners = new Map<string, Set<Listener>>()

function tabId(): string {
  const key = 'dscb-web-tab'
  const existing = sessionStorage.getItem(key)
  if (existing && /^[a-zA-Z0-9_-]{8,80}$/.test(existing)) return existing
  const id = crypto.randomUUID().replace(/-/g, '')
  sessionStorage.setItem(key, id)
  return id
}

export function createWebTransport(): IpcTransport {
  if (transport) return transport
  const id = tabId()
  const source = new EventSource(`/api/events?tab=${encodeURIComponent(id)}`)
  let opened = false
  ready = new Promise<void>((resolve, reject) => {
    source.onopen = () => {
      opened = true
      resolve()
    }
    source.onerror = () => {
      if (!opened) reject(new Error('无法连接服务器'))
    }
  })
  source.onmessage = (event: MessageEvent<string>) => {
    let message: { channel?: string; args?: unknown[] }
    try {
      message = JSON.parse(event.data) as { channel?: string; args?: unknown[] }
    } catch {
      return
    }
    if (!message.channel || !Array.isArray(message.args)) return
    const set = listeners.get(message.channel)
    if (!set) return
    for (const listener of [...set]) listener({}, ...message.args)
  }
  transport = {
    invoke(channel, ...args) {
      return fetch('/api/rpc', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dscb-tab': id
        },
        body: JSON.stringify({ channel, args, tabId: id })
      }).then(async (response) => {
        const body = await response.json().catch(() => ({ ok: false, error: '服务器没有返回结果' })) as {
          ok?: boolean
          result?: unknown
          error?: string
        }
        if (response.status === 401) throw new Error('登录已失效，请刷新页面重新输入口令')
        if (!response.ok || !body.ok) throw new Error(body.error || '请求失败')
        return body.result
      })
    },
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set<Listener>()
      set.add(listener as Listener)
      listeners.set(channel, set)
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener as Listener)
    }
  }
  return transport
}

export function whenWebTransportReady(): Promise<void> {
  if (!ready) throw new Error('连接尚未建立')
  return ready
}
