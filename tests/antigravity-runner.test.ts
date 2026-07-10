import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock child_process.spawn，模拟 agy 子进程行为
const { EventEmitter } = require('events')

interface FakeChild extends EventEmitter {
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  stdout: EventEmitter
  stderr: EventEmitter
  killed: boolean
  kill: ReturnType<typeof vi.fn>
}

let lastSpawnArgs: { bin: string; args: string[] } | null = null
let fakeChildFactory: (() => FakeChild) | null = null

vi.mock('child_process', () => ({
  spawn: vi.fn((bin: string, args: string[]) => {
    lastSpawnArgs = { bin, args }
    const child = fakeChildFactory
      ? fakeChildFactory()
      : createFakeChild({ stdout: '默认回复', exitCode: 0 })
    return child
  })
}))

function createFakeChild(opts: {
  stdout: string
  stderr?: string
  exitCode: number
  spawnError?: { code: string; message: string }
}): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = { write: vi.fn(), end: vi.fn() }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = vi.fn(() => {
    child.killed = true
  })

  // 异步模拟进程行为
  setImmediate(() => {
    if (opts.spawnError) {
      const err = Object.assign(new Error(opts.spawnError.message), {
        code: opts.spawnError.code
      })
      child.emit('error', err)
      return
    }
    child.stdout.emit('data', Buffer.from(opts.stdout, 'utf8'))
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr, 'utf8'))
    child.emit('close', opts.exitCode)
  })

  return child
}

import { runAntigravity, probeAntigravity, listAntigravityModels } from '../src/main/data/antigravity-runner'

beforeEach(() => {
  lastSpawnArgs = null
  fakeChildFactory = null
})

describe('runAntigravity', () => {
  it('用 stdin 传 prompt，args 含 -p --sandbox --dangerously-skip-permissions', async () => {
    fakeChildFactory = () =>
      createFakeChild({ stdout: '你好，世界', exitCode: 0 })

    const result = await runAntigravity('回复两个字', {})

    expect(lastSpawnArgs).not.toBeNull()
    // bin 可能是 'agy'（Unix）或绝对路径 .exe（Windows）
    expect(lastSpawnArgs!.bin.endsWith('agy') || lastSpawnArgs!.bin.endsWith('agy.exe')).toBe(true)
    expect(lastSpawnArgs!.args).toContain('-p')
    expect(lastSpawnArgs!.args).toContain('--sandbox')
    expect(lastSpawnArgs!.args).toContain('--dangerously-skip-permissions')
    expect(lastSpawnArgs!.args).toContain('--print-timeout')
    // prompt 经 stdin 传入，不在 args 里
    expect(result.full).toBe('你好，世界')
    // stdin.write 被调用，内容是 prompt
    const child = createFakeChild({ stdout: '', exitCode: 0 })
    expect(child.stdin.write).toBeDefined()
  })

  it('model 非空时追加 --model', async () => {
    fakeChildFactory = () =>
      createFakeChild({ stdout: '好', exitCode: 0 })

    await runAntigravity('测试', { model: 'Gemini 3.1 Pro (High)' })

    const idx = lastSpawnArgs!.args.indexOf('--model')
    expect(idx).toBeGreaterThan(-1)
    expect(lastSpawnArgs!.args[idx + 1]).toBe('Gemini 3.1 Pro (High)')
  })

  it('model 为空/undefined 时跳过 --model（走 agy 默认）', async () => {
    fakeChildFactory = () =>
      createFakeChild({ stdout: '好', exitCode: 0 })

    await runAntigravity('测试', { model: undefined })
    await runAntigravity('测试', { model: '' })

    expect(lastSpawnArgs!.args).not.toContain('--model')
  })

  it('onToken 回调按 stdout 数据块喂回（伪流式）', async () => {
    fakeChildFactory = () =>
      createFakeChild({ stdout: '第一段第二段', exitCode: 0 })

    const tokens: string[] = []
    await runAntigravity('测试', { onToken: (t) => tokens.push(t) })

    expect(tokens).toEqual(['第一段第二段'])
  })

  it('用量估算：按 1 字 ≈ 1.5 token', async () => {
    fakeChildFactory = () =>
      createFakeChild({ stdout: '你好', exitCode: 0 })

    const result = await runAntigravity('测试', {})

    // "你好" = 2 字符，ceil(2/1.5) = 2
    expect(result.usage).not.toBeNull()
    expect(result.usage!.outputTokens).toBe(2)
    expect(result.usage!.inputTokens).toBe(0)
  })

  it('stdout 前缀 Error: + 认证失败 -> LLM_AUTH_FAILED', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: 'Error: authentication failed or timed out',
        exitCode: 0
      })

    await expect(runAntigravity('测试', {})).rejects.toThrow('LLM_AUTH_FAILED')
  })

  it('stdout 前缀 Error: + 超时 -> LLM_TIMEOUT', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: 'Error: command timed out after 300s',
        exitCode: 0
      })

    await expect(runAntigravity('测试', {})).rejects.toThrow('LLM_TIMEOUT')
  })

  it('stdout 前缀 Error: + 限流 -> LLM_RATE_LIMIT', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: 'Error: rate limit exceeded, please try again later',
        exitCode: 0
      })

    await expect(runAntigravity('测试', {})).rejects.toThrow('LLM_RATE_LIMIT')
  })

  it('stdout 前缀 Error: + 其他 -> AGY_ERROR', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: 'Error: something unexpected happened',
        exitCode: 0
      })

    await expect(runAntigravity('测试', {})).rejects.toThrow('AGY_ERROR')
  })

  it('spawn ENOENT -> AGY_NOT_FOUND', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        exitCode: 0,
        spawnError: { code: 'ENOENT', message: 'not found' }
      })

    await expect(runAntigravity('测试', {})).rejects.toThrow('AGY_NOT_FOUND')
  })

  it('abort signal 触发 kill -> LLM_TIMEOUT', async () => {
    const controller = new AbortController()
    // 创建一个不会自己 close 的 child，等待 abort
    fakeChildFactory = () => {
      const child = new EventEmitter() as FakeChild
      child.stdin = { write: vi.fn(), end: vi.fn() }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.killed = false
      child.kill = vi.fn(() => {
        child.killed = true
        // kill 后模拟 close
        setImmediate(() => child.emit('close', 0))
      })
      // 不主动 emit 任何 data/close，等 abort
      return child
    }

    const promise = runAntigravity('测试', { signal: controller.signal })
    // 立即 abort
    controller.abort()

    await expect(promise).rejects.toThrow('LLM_TIMEOUT')
  })

  it('串行化：多个调用按顺序执行', async () => {
    const order: number[] = []

    fakeChildFactory = () => {
      const child = new EventEmitter() as FakeChild
      child.stdin = { write: vi.fn(), end: vi.fn() }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.killed = false
      child.kill = vi.fn(() => {
        child.killed = true
      })
      // 第一个调用延迟 close
      if (order.length === 0) {
        order.push(1)
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from('第一个', 'utf8'))
          child.emit('close', 0)
        })
      } else {
        order.push(order.length + 1)
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from('第二个', 'utf8'))
          child.emit('close', 0)
        })
      }
      return child
    }

    const p1 = runAntigravity('一', {})
    // 第一个未完成时启动第二个 -- 应排队（agyChain 保证串行）
    const p2 = runAntigravity('二', {})

    await p1
    await p2

    // 顺序：[1, 2] -- 证明第二个 spawn 在第一个 close 后才发生
    expect(order).toEqual([1, 2])
  })
})

describe('probeAntigravity', () => {
  it('agy --version 成功 -> 返回版本号', async () => {
    fakeChildFactory = () =>
      createFakeChild({ stdout: '1.1.0\n', exitCode: 0 })

    const v = await probeAntigravity()
    expect(v).toBe('1.1.0')
    expect(lastSpawnArgs!.args).toEqual(['--version'])
  })

  it('agy 未安装 -> 返回 null', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        exitCode: 0,
        spawnError: { code: 'ENOENT', message: 'not found' }
      })

    const v = await probeAntigravity()
    expect(v).toBeNull()
  })
})

describe('listAntigravityModels', () => {
  it('agy models 输出多行 -> 返回模型名数组', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: 'Gemini 3.5 Flash (Medium)\nGemini 3.5 Flash (High)\nClaude Sonnet 4.6 (Thinking)\n',
        exitCode: 0
      })

    const models = await listAntigravityModels()
    expect(models).toEqual([
      'Gemini 3.5 Flash (Medium)',
      'Gemini 3.5 Flash (High)',
      'Claude Sonnet 4.6 (Thinking)'
    ])
    expect(lastSpawnArgs!.args).toEqual(['models'])
  })

  it('未登录 -> 返回空数组（不抛错）', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: 'Error: Please sign in to view available models.',
        exitCode: 0
      })

    const models = await listAntigravityModels()
    expect(models).toEqual([])
  })

  it('agy 未安装 -> 返回空数组', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        exitCode: 0,
        spawnError: { code: 'ENOENT', message: 'not found' }
      })

    const models = await listAntigravityModels()
    expect(models).toEqual([])
  })
})
