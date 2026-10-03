import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Canvas } from 'skia-canvas'
import { ImageService, ALLOWED_IMAGE_EXTS, buildCliImagePrompt } from '../src/main/data/image-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

const { spawnMock, killMock, environment } = vi.hoisted(() => ({
  spawnMock: vi.fn(), killMock: vi.fn(), environment: { home: '', temporaryRoot: '' }
}))
vi.mock('child_process', async (original) => ({ ...await original<typeof import('child_process')>(), spawn: spawnMock }))
vi.mock('../src/main/data/kill-process-tree', () => ({ killProcessTree: killMock }))
vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>()
  return { ...actual, homedir: () => environment.home || actual.homedir(), tmpdir: () => environment.temporaryRoot || actual.tmpdir() }
})

function settings(channel: 'api' | 'codex' | 'grok', apiKey = 'sk-test'): SettingsRepository {
  return { getCoverImageConfig: async () => ({ apiKey, baseUrl: 'https://example.invalid/v1', model: 'gpt-image-2', channel }) } as unknown as SettingsRepository
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
}
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() })
  return child
}

let root: string
let png: Buffer
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'image-service-test-'))
  const canvas = new Canvas(24, 32)
  canvas.getContext('2d').fillRect(0, 0, 24, 32)
  png = await canvas.toBuffer('png')
  spawnMock.mockImplementation(() => { throw new Error('Unexpected CLI call') })
  killMock.mockImplementation((child: FakeChild) => queueMicrotask(() => child.emit('close', -1)))
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request') }))
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  spawnMock.mockReset()
  killMock.mockReset()
  environment.home = ''
  environment.temporaryRoot = ''
  const absolute = resolve(root)
  if (!basename(absolute).startsWith('image-service-test-')) throw new Error('Unsafe fixture cleanup')
  await fs.rm(absolute, { recursive: true, force: true })
})

function response(b64: unknown = png.toString('base64')): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 })
}

function installCli(run: (child: FakeChild, cwd: string, args: string[]) => Promise<void> | void): FakeChild[] {
  const children: FakeChild[] = []
  spawnMock.mockImplementation((_bin: string, args: string[], options: { cwd: string }) => {
    const child = fakeChild()
    children.push(child)
    queueMicrotask(() => Promise.resolve(run(child, options.cwd, args)).catch(error => child.emit('error', error)))
    return child
  })
  return children
}

function abortingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = options.signal!
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    if (signal.aborted) reject(new DOMException('aborted', 'AbortError'))
  }))
}

describe('ImageService HTTP', () => {
  it('缺少 API Key 时不发请求', async () => {
    await expect(new ImageService(settings('api', '')).generate('prompt', '1024x1536')).rejects.toThrow('IMAGE_NOT_CONFIGURED')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('发送模型、尺寸和提示词，不添加旧 response_format', async () => {
    const fetchMock = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    expect(await new ImageService(settings('api')).generate('prompt', '1024x1536')).toBe(png.toString('base64'))
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.invalid/v1/images/generations')
    expect(JSON.parse(String(options.body))).toEqual({ model: 'gpt-image-2', prompt: 'prompt', size: '1024x1536' })
  })
  it.each([123, null, '', 'not-base64!', 'abcd=', 'YWJj\n!'])('拒绝无效 b64_json %s', async invalid => {
    vi.stubGlobal('fetch', vi.fn(async () => response(invalid)))
    await expect(new ImageService(settings('api')).generate('x', '1024x1536')).rejects.toThrow(/IMAGE_(EMPTY|INVALID)_RESPONSE/)
  })
  it('HTTP 错误和 JSON 格式错误保留服务响应含义，不自动重试', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('provider overloaded', { status: 503 }))
      .mockResolvedValueOnce(new Response('not json', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const service = new ImageService(settings('api'))
    await expect(service.generate('x', '1024x1536')).rejects.toThrow('IMAGE_REQUEST_FAILED (503)')
    await expect(service.generate('x', '1024x1536')).rejects.toThrow('API 响应不是有效 JSON')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('网络拒绝返回可识别错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }))
    await expect(new ImageService(settings('api')).generate('x', '1024x1536')).rejects.toThrow(/IMAGE_NETWORK_ERROR.*ECONNREFUSED/)
  })
  it('调用前取消不发请求', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(new ImageService(settings('api')).generate('x', '1024x1536', controller.signal)).rejects.toThrow('IMAGE_ABORTED')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('调用中取消真正中止 fetch，并清理调用方监听', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const fetchMock = abortingFetch()
    vi.stubGlobal('fetch', fetchMock)
    const task = new ImageService(settings('api')).generate('x', '1024x1536', controller.signal)
    const rejection = expect(task).rejects.toThrow('IMAGE_ABORTED')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort()
    await rejection
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
  it('十分钟超时返回超时而非用户取消，付费请求不自动重试', async () => {
    vi.useFakeTimers()
    const fetchMock = abortingFetch()
    vi.stubGlobal('fetch', fetchMock)
    const task = new ImageService(settings('api')).generate('x', '1024x1536')
    const rejection = expect(task).rejects.toThrow('IMAGE_TIMEOUT')
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(600_000)
    await rejection
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('成功后清理超时定时器', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => response()))
    await new ImageService(settings('api')).generate('x', '1024x1536')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('参考图验证', () => {
  it('依据图片真实内容设置 MIME 和文件名，支持文件名含空格', async () => {
    const reference = join(root, 'reference with spaces.jpg')
    await fs.writeFile(reference, png)
    const fetchMock = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    await new ImageService(settings('api')).edit('prompt', '1024x1536', reference)
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url.endsWith('/images/edits')).toBe(true)
    const image = (options.body as FormData).get('image') as File
    expect(image.type).toBe('image/png')
    expect(image.name).toBe('reference with spaces.png')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png)
  })
  it.each([['jpg', 'image/jpeg'], ['webp', 'image/webp']] as const)('真实 %s 参考图使用对应 MIME', async (format, mime) => {
    const canvas = new Canvas(24, 32)
    canvas.getContext('2d').fillRect(0, 0, 24, 32)
    const bytes = await canvas.toBuffer(format)
    const reference = join(root, 'disguised.png')
    await fs.writeFile(reference, bytes)
    const fetchMock = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    await new ImageService(settings('api')).edit('prompt', '1024x1536', reference)
    const [, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const file = (options.body as FormData).get('image') as File
    expect(file.type).toBe(mime)
    expect(file.name).toBe(`disguised.${format}`)
    expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes)
  })
  it.each(['not an image', '\u0089PNG\r\n\u001a\ntruncated'])('无效或损坏参考图不发网络请求', async bytes => {
    const reference = join(root, 'bad.png')
    await fs.writeFile(reference, bytes)
    await expect(new ImageService(settings('api')).edit('x', '1024x1536', reference)).rejects.toThrow('IMAGE_REFERENCE_INVALID')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('真实 PNG 文件头也必须能完整解码', async () => {
    const reference = join(root, 'truncated.png')
    await fs.writeFile(reference, png.subarray(0, 24))
    await expect(new ImageService(settings('api')).edit('x', '1024x1536', reference)).rejects.toThrow('IMAGE_REFERENCE_INVALID')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('超过 20 MiB 时在读入和上传前拒绝', async () => {
    const reference = join(root, 'large.png')
    const file = await fs.open(reference, 'w')
    await file.truncate(20 * 1024 * 1024 + 1)
    await file.close()
    await expect(new ImageService(settings('api')).edit('x', '1024x1536', reference)).rejects.toThrow('20 MiB')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('像素过大时在原生解码分配像素内存之前拒绝', async () => {
    const reference = join(root, 'oversized.png')
    const bytes = Buffer.from(png)
    bytes.writeUInt32BE(10_000, 16)
    bytes.writeUInt32BE(5_000, 20)
    await fs.writeFile(reference, bytes)
    await expect(new ImageService(settings('api')).edit('x', '1024x1536', reference)).rejects.toThrow('分辨率过大')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('参考图必须是文件且存在', async () => {
    const service = new ImageService(settings('api'))
    await expect(service.edit('x', '1024x1536', root)).rejects.toThrow('IMAGE_REFERENCE_INVALID')
    await expect(service.edit('x', '1024x1536', join(root, 'missing.png'))).rejects.toThrow('IMAGE_REFERENCE_INVALID')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('CLI 图生图在启动之前明确提示不支持', async () => {
    await expect(new ImageService(settings('codex', '')).edit('x', '1024x1536', join(root, 'a.png'))).rejects.toThrow('IMAGE_CLI_NO_EDIT')
    expect(spawnMock).not.toHaveBeenCalled()
  })
  it('图生图请求同样能取消且不重试', async () => {
    const reference = join(root, 'ref.png')
    await fs.writeFile(reference, png)
    const controller = new AbortController()
    const fetchMock = abortingFetch()
    vi.stubGlobal('fetch', fetchMock)
    const task = new ImageService(settings('api')).edit('x', '1024x1536', reference, controller.signal)
    const rejection = expect(task).rejects.toThrow('IMAGE_ABORTED')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort()
    await rejection
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('CLI 任务隔离', () => {
  it.each(['codex', 'grok'] as const)('%s 只读取独立任务目标，忽略 stdout 其他路径', async channel => {
    let outputDirectory = ''
    const children = installCli(async (child, cwd) => {
      outputDirectory = cwd
      await fs.writeFile(join(cwd, 'generated.png'), png)
      child.stdout.emit('data', Buffer.from(`wrong output: ${join(root, 'unrelated.png')}`))
      child.emit('close', 0)
    })
    expect(await new ImageService(settings(channel, '')).generate('都市夜色', '1024x1536')).toBe(png.toString('base64'))
    expect(basename(outputDirectory).startsWith('cover-image-')).toBe(true)
    await expect(fs.access(outputDirectory)).rejects.toThrow()
    const args = spawnMock.mock.calls[0][1] as string[]
    const prompt = channel === 'codex' ? children[0].stdin.write.mock.calls[0][0] as string : args[args.length - 1]
    expect(prompt).toContain(JSON.stringify(join(outputDirectory, 'generated.png')))
    expect(prompt).toContain('都市夜色')
    expect(prompt).toContain('image_gen')
    expect(children[0].listenerCount('close')).toBe(0)
    expect(children[0].stdout.listenerCount('data')).toBe(0)
  })
  it('目录含空格时仍能精确读取目标', async () => {
    const temporaryRoot = join(root, 'temporary directory with spaces')
    await fs.mkdir(temporaryRoot)
    environment.temporaryRoot = temporaryRoot
    installCli(async (child, cwd) => { await fs.writeFile(join(cwd, 'generated.png'), png); child.emit('close', 0) })
    expect(await new ImageService(settings('codex', '')).generate('x', '1024x1536')).toBe(png.toString('base64'))
    expect(await fs.readdir(temporaryRoot)).toEqual([])
  })
  it('退出码非零即失败，即使该任务留下图片', async () => {
    let directory = ''
    installCli(async (child, cwd) => { directory = cwd; await fs.writeFile(join(cwd, 'generated.png'), png); child.stderr.emit('data', Buffer.from('generation failed')); child.emit('close', 1) })
    await expect(new ImageService(settings('codex', '')).generate('x', '1024x1536')).rejects.toThrow(/IMAGE_CLI_GENERATE_FAILED.*code=1/)
    await expect(fs.access(directory)).rejects.toThrow()
  })
  it('当前任务没有产物时不会回退拿其他会话图片或 stdout 的旧图', async () => {
    environment.home = root
    const session = join(root, '.codex', 'generated_images', 'other-session')
    await fs.mkdir(session, { recursive: true })
    const unrelated = join(session, 'other-task.png')
    await fs.writeFile(unrelated, png)
    installCli(child => { child.stdout.emit('data', Buffer.from(unrelated)); child.emit('close', 0) })
    await expect(new ImageService(settings('codex', '')).generate('x', '1024x1536')).rejects.toThrow('IMAGE_CLI_NO_FILE')
    expect(await fs.readFile(unrelated)).toEqual(png)
  })
  it('并发 CLI 请求分别返回自己的产物', async () => {
    const otherCanvas = new Canvas(24, 32)
    otherCanvas.getContext('2d').fillStyle = 'red'
    otherCanvas.getContext('2d').fillRect(0, 0, 24, 32)
    const other = await otherCanvas.toBuffer('png')
    let count = 0
    const directories: string[] = []
    installCli(async (child, cwd) => { const bytes = count++ === 0 ? png : other; directories.push(cwd); await fs.writeFile(join(cwd, 'generated.png'), bytes); child.emit('close', 0) })
    const service = new ImageService(settings('codex', ''))
    const results = await Promise.all([service.generate('a', '1024x1536'), service.generate('b', '1024x1536')])
    expect(new Set(directories).size).toBe(2)
    expect(new Set(results)).toEqual(new Set([png.toString('base64'), other.toString('base64')]))
  })
  it('任务产物不是图片时拒绝并清理', async () => {
    let directory = ''
    installCli(async (child, cwd) => { directory = cwd; await fs.writeFile(join(cwd, 'generated.png'), 'invalid bytes'); child.emit('close', 0) })
    await expect(new ImageService(settings('codex', '')).generate('x', '1024x1536')).rejects.toThrow('IMAGE_CLI_INVALID_OUTPUT')
    await expect(fs.access(directory)).rejects.toThrow()
  })
  it('取消 CLI 终止进程树，待退出后只清理本次目录与监听', async () => {
    const controller = new AbortController()
    let directory = ''
    const children = installCli((_child, cwd) => { directory = cwd })
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const task = new ImageService(settings('codex', '')).generate('x', '1024x1536', controller.signal)
    const rejection = expect(task).rejects.toThrow('IMAGE_ABORTED')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    controller.abort()
    await rejection
    expect(killMock).toHaveBeenCalledWith(children[0])
    expect(children[0].listenerCount('close')).toBe(0)
    expect(children[0].stdin.listenerCount('error')).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    await expect(fs.access(directory)).rejects.toThrow()
  })
  it('CLI 不存在的错误不会扫描全局目录', async () => {
    installCli(child => { child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' })) })
    await expect(new ImageService(settings('codex', '')).generate('x', '1024x1536')).rejects.toThrow('IMAGE_CLI_NOT_FOUND')
  })
  it('CLI 超时会终止进程树并清理本次输出目录', async () => {
    const actualSetTimeout = globalThis.setTimeout
    let expire: (() => void) | undefined
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
      if (timeout === 600_000) expire = () => callback(...args)
      return actualSetTimeout(callback, timeout, ...args)
    }) as typeof setTimeout)
    let directory = ''
    const children = installCli((_child, cwd) => { directory = cwd })
    const task = new ImageService(settings('codex', '')).generate('x', '1024x1536')
    const rejection = expect(task).rejects.toThrow('IMAGE_CLI_TIMEOUT')
    await vi.waitFor(() => expect(expire).toBeDefined())
    expire!()
    await rejection
    expect(killMock).toHaveBeenCalledWith(children[0])
    expect(children[0].listenerCount('close')).toBe(0)
    await expect(fs.access(directory)).rejects.toThrow()
  })

})

describe('提示词与扩展名', () => {
  it('独立输出文件路径带引号，点名模型、竖版尺寸并禁止脚本替代绘图', () => {
    const output = join(root, 'folder with spaces', 'generated.png')
    const prompt = buildCliImagePrompt('codex', 'gpt-image-2', '雨夜霓虹', output)
    expect(prompt).toContain(JSON.stringify(output))
    expect(prompt).toContain('gpt-image-2')
    expect(prompt).toContain('1024x1536')
    expect(prompt).toContain('禁止用')
    expect(buildCliImagePrompt('grok', 'grok-image', 'x')).not.toContain('gpt-image-2')
  })
  it('扩展名匹配保持兼容，实际读取内容还需真实解码', () => {
    for (const file of ['a.png', 'a.jpg', 'a.webp']) expect(ALLOWED_IMAGE_EXTS.test(file)).toBe(true)
    expect(ALLOWED_IMAGE_EXTS.test('a.exe')).toBe(false)
    expect(ALLOWED_IMAGE_EXTS.test('a.txt')).toBe(false)
  })
})
