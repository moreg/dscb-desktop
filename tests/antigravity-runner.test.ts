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
  /** 自定义分块：把 stdout 按指定 Buffer 数组分多次 emit（测试 UTF-8 截断） */
  stdoutChunks?: Buffer[]
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
    if (opts.stdoutChunks) {
      for (const c of opts.stdoutChunks) {
        child.stdout.emit('data', c)
      }
    } else {
      child.stdout.emit('data', Buffer.from(opts.stdout, 'utf8'))
    }
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
  it('prompt 作为 -p 参数传入，args 含 --dangerously-skip-permissions 且不含 --sandbox', async () => {
    fakeChildFactory = () =>
      createFakeChild({ stdout: '你好，世界', exitCode: 0 })

    const result = await runAntigravity('回复两个字', {})

    expect(lastSpawnArgs).not.toBeNull()
    // bin 可能是 'agy'（Unix）或绝对路径 .exe（Windows）
    expect(lastSpawnArgs!.bin.endsWith('agy') || lastSpawnArgs!.bin.endsWith('agy.exe')).toBe(true)
    // -p 后紧跟 prompt 内容（agy 不从 stdin 读取，prompt 必须作为 -p 的参数）
    const pIdx = lastSpawnArgs!.args.indexOf('-p')
    expect(pIdx).toBeGreaterThan(-1)
    expect(lastSpawnArgs!.args[pIdx + 1]).toBe('回复两个字')
    // --sandbox 会触发 agy "是否创建 sandbox 目录"引导话术，不能加
    expect(lastSpawnArgs!.args).not.toContain('--sandbox')
    expect(lastSpawnArgs!.args).toContain('--dangerously-skip-permissions')
    expect(lastSpawnArgs!.args).toContain('--print-timeout')
    expect(result.full).toBe('你好，世界')
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

  it('UTF-8 多字节字符被 chunk 边界截断时不产生乱码', async () => {
    // "冰" = UTF-8 [e6 99 b4]，"霜" = [e9 9c 9c]
    // 把 "冰冷冰霜" 的字节在 "冰"和"霜"中间断开，模拟 chunk 截断
    const full = Buffer.from('冰冷冰霜', 'utf8')
    // 找到第 3 个字符（"霜"）的起始字节位置（前 3 个字符 = 9 字节）
    const splitAt = 9
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        exitCode: 0,
        stdoutChunks: [full.subarray(0, splitAt), full.subarray(splitAt)]
      })

    const tokens: string[] = []
    const result = await runAntigravity('测试', { onToken: (t) => tokens.push(t) })

    // 完整结果不能有乱码字符 �
    expect(result.full).toBe('冰冷冰霜')
    expect(result.full).not.toContain('\uFFFD')
    // onToken 回调也不能有乱码
    expect(tokens.join('')).toBe('冰冷冰霜')
    expect(tokens.every((t) => !t.includes('\uFFFD'))).toBe(true)
  })

  it('单 chunk 内多个不完整尾部拼接后正确解码', async () => {
    // "震惊" = [e9 9c 87 e6 83 8a]，拆成 3 个 chunk：每 2 字节一段
    const full = Buffer.from('震惊', 'utf8')
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        exitCode: 0,
        stdoutChunks: [full.subarray(0, 2), full.subarray(2, 4), full.subarray(4)]
      })

    const result = await runAntigravity('测试', {})
    expect(result.full).toBe('震惊')
    expect(result.full).not.toContain('\uFFFD')
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

  it('stderr Error + 认证失败 -> AGY_AUTH_EXPIRED（agy 1.1.1 真实行为）', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        stderr: 'Error: Please sign in to continue',
        exitCode: 1
      })

    await expect(runAntigravity('测试', {})).rejects.toThrow('AGY_AUTH_EXPIRED')
  })

  it('stderr Error + 超时 -> LLM_TIMEOUT', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        stderr: 'Error: timeout waiting for response',
        exitCode: 1
      })

    await expect(runAntigravity('测试', {})).rejects.toThrow('LLM_TIMEOUT')
  })

  it('stderr Error + 限流 -> LLM_RATE_LIMIT', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        stderr: 'Error: rate limit exceeded',
        exitCode: 1
      })

    await expect(runAntigravity('测试', {})).rejects.toThrow('LLM_RATE_LIMIT')
  })

  it('stderr Error + 其他 -> AGY_ERROR', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        stderr: 'Error: something unexpected happened',
        exitCode: 1
      })

    await expect(runAntigravity('测试', {})).rejects.toThrow('AGY_ERROR')
  })

  it('exit 非 0 且 stdout/stderr 均空 -> AGY_ERROR', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        exitCode: 1
      })

    await expect(runAntigravity('测试', {})).rejects.toThrow('AGY_ERROR')
  })

  it('exit 非 0 且 stdout 有部分内容（agent 思考过程）-> 不当成功返回', async () => {
    // agy 超时时 stdout 可能有 agent 的部分思考文本，不应作为正文返回
    fakeChildFactory = () =>
      createFakeChild({
        stdout: 'I will check the permissions to see what actions are available.',
        stderr: 'Error: timeout waiting for response',
        exitCode: 1
      })

    await expect(runAntigravity('测试', {})).rejects.toThrow('LLM_TIMEOUT')
  })

  it('stdout 含 Error 前缀（向后兼容旧 agy 行为）-> 正确映射', async () => {
    // 旧版 agy 可能把错误打到 stdout，保留兼容
    fakeChildFactory = () =>
      createFakeChild({
        stdout: 'Error: authentication failed',
        exitCode: 0
      })

    await expect(runAntigravity('测试', {})).rejects.toThrow('AGY_AUTH_EXPIRED')
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

  it('超长 prompt（> 30000 字符）直接报错，不尝试不可靠的文件读取', async () => {
    const longPrompt = 'a'.repeat(30001)
    await expect(runAntigravity(longPrompt, {})).rejects.toThrow('AGY_ERROR')
    // 不应 spawn 子进程
    expect(lastSpawnArgs).toBeNull()
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
