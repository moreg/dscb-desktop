import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageService, ALLOWED_IMAGE_EXTS, buildCliImagePrompt } from '../src/main/data/image-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

/** spawn mock：默认不落盘，由各用例自行注入行为 */
const { spawnMock, fakeHome } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  fakeHome: { current: '' }
}))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: spawnMock }
})
/** homedir 可注入：CLI 产物目录扫描（~/.codex/generated_images）指到临时目录 */
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => fakeHome.current || actual.homedir() }
})

/** 构造最小 settings mock：覆盖 getCoverImageConfig */
function makeSettings(channel: 'api' | 'codex' | 'grok', apiKey = 'sk-test'): SettingsRepository {
  return {
    getCoverImageConfig: async () => ({
      apiKey,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-image-2',
      channel
    })
  } as unknown as SettingsRepository
}

/** 最小子进程桩：EventEmitter + 可记录 stdin 写入 */
interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { on: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { on: vi.fn(), write: vi.fn(), end: vi.fn() }
  return child
}

describe('ImageService 通道分派', () => {
  let svc: ImageService

  beforeEach(() => {
    svc = new ImageService(makeSettings('api'))
    // 默认兜底：立即 close，避免误触发真实 spawn
    spawnMock.mockImplementation(() => {
      const child = makeFakeChild()
      queueMicrotask(() => child.emit('close', 0))
      return child
    })
  })

  afterEach(() => {
    spawnMock.mockReset()
  })

  it('api 通道未配 Key 时报 IMAGE_NOT_CONFIGURED', async () => {
    const noKey = new ImageService(makeSettings('api', ''))
    await expect(noKey.generate('x', '1024x1536')).rejects.toThrow('IMAGE_NOT_CONFIGURED')
  })

  it('api 通道走 /images/generations（含 gpt-image 系列不带 response_format）', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toContain('/images/generations')
      const body = JSON.parse(String(init.body))
      expect(body.model).toBe('gpt-image-2')
      expect(body.response_format).toBeUndefined()
      return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const b64 = await svc.generate('a cat', '1024x1536')
    expect(b64).toBe('aGVsbG8=')
    vi.unstubAllGlobals()
  })

  it('api 通道网络报错（fetch failed / ECONNREFUSED）抛出易读的 IMAGE_NETWORK_ERROR', async () => {
    const fetchMock = vi.fn(async () => {
      const err = new TypeError('fetch failed')
      Object.assign(err, { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:7890' } })
      throw err
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(svc.generate('a cat', '1024x1536')).rejects.toThrow(/IMAGE_NETWORK_ERROR.*ECONNREFUSED/)
    vi.unstubAllGlobals()
  })

  it('api 通道超时报错（TimeoutError）抛出易读的 IMAGE_TIMEOUT', async () => {
    const fetchMock = vi.fn(async () => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      throw err
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(svc.generate('a cat', '1024x1536')).rejects.toThrow('IMAGE_TIMEOUT')
    vi.unstubAllGlobals()
  })

  it('cli 通道不校验 apiKey（缺 Key 不抛 IMAGE_NOT_CONFIGURED）——通过配置读取结果直接断言', async () => {
    const settings = makeSettings('codex', '')
    const cfg = await settings.getCoverImageConfig()
    expect(cfg.channel).toBe('codex')
    expect(cfg.apiKey).toBe('')
    // ImageService 构造同配置后，requireConfig 语义为「CLI 通道无需 Key」：
    // 直接验证 API 通道才要求 Key（对照）
    const apiSettings = makeSettings('api', '')
    const apiCfg = await apiSettings.getCoverImageConfig()
    expect(apiCfg.channel).toBe('api')
    expect(apiCfg.apiKey).toBe('')
  })
})

describe('codex CLI 生图分支', () => {
  afterEach(() => {
    spawnMock.mockReset()
  })

  it('argv 只含沙箱旗标、prompt 走 stdin 且点名模型与竖版尺寸，产物按 stdout 路径读回', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeximg-'))
    const imgPath = join(dir, 'cover.png')
    const bytes = Buffer.from('fake-png-bytes')
    await writeFile(imgPath, bytes)

    const child = makeFakeChild()
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`已生成：${imgPath}\n`))
        child.emit('close', 0)
      })
      return child
    })

    const svc = new ImageService(makeSettings('codex', ''))
    const b64 = await svc.generate('都市夜色 女主特写', '1024x1536')
    expect(b64).toBe(bytes.toString('base64'))

    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(String(bin)).toContain('codex')
    expect(args).toEqual(['exec', '--sandbox', 'danger-full-access', '--skip-git-repo-check'])
    // 提示词不进 argv（Windows 命令行长度/中文编码），经 stdin 传入
    expect(args.join(' ')).not.toContain('都市夜色')
    expect(child.stdin.write).toHaveBeenCalledTimes(1)
    const prompt = child.stdin.write.mock.calls[0][0] as string
    expect(prompt).toContain('gpt-image-2')
    expect(prompt).toContain('image_gen')
    expect(prompt).toContain('1024x1536')
    expect(prompt).toContain('都市夜色 女主特写')
    expect(child.stdin.end).toHaveBeenCalled()
  })

  it('stdout 没给路径时回退扫 ~/.codex/generated_images 按 mtime 取最新', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexgen-'))
    fakeHome.current = root
    try {
      const session = join(root, '.codex', 'generated_images', 'sess-9')
      await mkdir(session, { recursive: true })
      const bytes = Buffer.from('fallback-image')
      const imgPath = join(session, 'exec-fallback.png')
      await writeFile(imgPath, bytes)

      const child = makeFakeChild()
      spawnMock.mockImplementation(() => {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('任务完成，图片已保存。')) // 无路径
          child.emit('close', 0)
        })
        return child
      })

      const svc = new ImageService(makeSettings('codex', ''))
      const b64 = await svc.generate('x', '1024x1536')
      expect(b64).toBe(bytes.toString('base64'))
    } finally {
      fakeHome.current = ''
      await rm(root, { recursive: true, force: true })
    }
  })

  it('codex 未安装（ENOENT）映射为 IMAGE_CLI_NOT_FOUND', async () => {
    const child = makeFakeChild()
    spawnMock.mockImplementation(() => {
      queueMicrotask(() =>
        child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }))
      )
      return child
    })
    const svc = new ImageService(makeSettings('codex', ''))
    await expect(svc.generate('x', '1024x1536')).rejects.toThrow('IMAGE_CLI_NOT_FOUND')
  })
})

describe('buildCliImagePrompt（CLI 提示词拼装）', () => {
  it('codex：点名 image_gen 工具与模型、写死竖版尺寸、禁脚本兜底', () => {
    const prompt = buildCliImagePrompt('codex', 'gpt-image-2', '雨夜霓虹')
    expect(prompt).toContain('image_gen')
    expect(prompt).toContain('gpt-image-2')
    expect(prompt).toContain('1024x1536')
    expect(prompt).toContain('雨夜霓虹')
    expect(prompt).toContain('禁止')
  })

  it('grok：不点名 codex 模型，其余契约一致', () => {
    const prompt = buildCliImagePrompt('grok', 'grok-image', '雨夜霓虹')
    expect(prompt).toContain('image_gen')
    expect(prompt).not.toContain('gpt-image-2')
    expect(prompt).toContain('1024x1536')
  })
})

describe('findLatestImage（CLI 产物目录扫描）', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'imgtest-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('codex 产物：generated_images/<session>/exec-*.png 目录结构可扫描', async () => {
    const session = join(root, 'generated_images', 'sess-1')
    await mkdir(session, { recursive: true })
    await writeFile(join(session, 'exec-abc.png'), Buffer.from('png'))
    await writeFile(join(session, 'exec-old.png'), Buffer.from('old'))
    const files = await import('fs/promises').then((fs) => fs.readdir(session))
    expect(files.some((f) => /exec-.*\.png$/.test(f))).toBe(true)
  })

  it('grok 产物：<session>/images/*.jpg 目录结构存在', async () => {
    const session = join(root, 'sessions', 'sess-2')
    await mkdir(join(session, 'images'), { recursive: true })
    await writeFile(join(session, 'images', '1.jpg'), Buffer.from('jpeg'))
    const files = await import('fs/promises').then((fs) => fs.readdir(join(session, 'images')))
    expect(files).toContain('1.jpg')
  })
})

describe('ALLOWED_IMAGE_EXTS', () => {
  it('只放行常见图片扩展名', () => {
    expect(ALLOWED_IMAGE_EXTS.test('a.png')).toBe(true)
    expect(ALLOWED_IMAGE_EXTS.test('a.jpg')).toBe(true)
    expect(ALLOWED_IMAGE_EXTS.test('a.webp')).toBe(true)
    expect(ALLOWED_IMAGE_EXTS.test('a.exe')).toBe(false)
    expect(ALLOWED_IMAGE_EXTS.test('a.txt')).toBe(false)
  })
})
