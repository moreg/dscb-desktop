import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock child_process.spawn，模拟 codex 子进程行为
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
    return fakeChildFactory
      ? fakeChildFactory()
      : createFakeChild({ stdout: '', exitCode: 0 })
  })
}))

// mock fs/promises.readFile（listCodexModels 读 config.toml）
vi.mock('fs/promises', () => ({
  readFile: vi.fn()
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

import { runCodex, probeCodex, listCodexModels } from '../src/main/data/codex-runner'
import { readFile } from 'fs/promises'

const mockedReadFile = vi.mocked(readFile)

beforeEach(() => {
  lastSpawnArgs = null
  fakeChildFactory = null
  mockedReadFile.mockReset()
})

/** 构造 codex --json 的标准 JSONL 输出 */
function codexJsonl(text: string, usage?: { input: number; output: number }): string {
  const lines = [
    '{"type":"thread.started","thread_id":"test-id"}',
    '{"type":"turn.started"}'
  ]
  lines.push(JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text }
  }))
  if (usage) {
    lines.push(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: usage.input, output_tokens: usage.output }
    }))
  }
  return lines.join('\n') + '\n'
}

describe('runCodex', () => {
  it('用 stdin 传 prompt，args 含 exec --json --ephemeral', async () => {
    fakeChildFactory = () =>
      createFakeChild({ stdout: codexJsonl('你好，世界'), exitCode: 0 })

    const result = await runCodex('回复两个字', {})

    expect(lastSpawnArgs).not.toBeNull()
    // bin 可能是 'codex'（Unix）或绝对路径 .exe/.cmd（Windows）
    expect(
      lastSpawnArgs!.bin.endsWith('codex') ||
      lastSpawnArgs!.bin.endsWith('codex.exe') ||
      lastSpawnArgs!.bin.endsWith('codex.cmd')
    ).toBe(true)
    expect(lastSpawnArgs!.args).toContain('exec')
    expect(lastSpawnArgs!.args).toContain('--json')
    expect(lastSpawnArgs!.args).toContain('--ephemeral')
    expect(lastSpawnArgs!.args).toContain('--skip-git-repo-check')
    expect(lastSpawnArgs!.args).toContain('-s')
    expect(lastSpawnArgs!.args).toContain('read-only')
    expect(result.full).toBe('你好，世界')
  })

  it('model 非空时追加 -m', async () => {
    fakeChildFactory = () =>
      createFakeChild({ stdout: codexJsonl('好'), exitCode: 0 })

    await runCodex('测试', { model: 'gpt-5.5' })

    const idx = lastSpawnArgs!.args.indexOf('-m')
    expect(idx).toBeGreaterThan(-1)
    expect(lastSpawnArgs!.args[idx + 1]).toBe('gpt-5.5')
  })

  it('model 为空时跳过 -m', async () => {
    fakeChildFactory = () =>
      createFakeChild({ stdout: codexJsonl('好'), exitCode: 0 })

    await runCodex('测试', { model: undefined })

    expect(lastSpawnArgs!.args).not.toContain('-m')
  })

  it('解析 JSONL item.completed 提取 agent_message 文本', async () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"第一段"}}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"第二段"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}'
    ].join('\n') + '\n'
    fakeChildFactory = () => createFakeChild({ stdout: jsonl, exitCode: 0 })

    const result = await runCodex('测试', {})

    // 多个 agent_message 文本应拼接
    expect(result.full).toBe('第一段第二段')
  })

  it('从 turn.completed 提取精确用量', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: codexJsonl('你好', { input: 1500, output: 10 }),
        exitCode: 0
      })

    const result = await runCodex('测试', {})

    expect(result.usage).not.toBeNull()
    expect(result.usage!.inputTokens).toBe(1500)
    expect(result.usage!.outputTokens).toBe(10)
    expect(result.usage!.totalTokens).toBe(1510)
  })

  it('turn.completed 缺失时兜底估算用量', async () => {
    // 只有 item.completed 没有 turn.completed
    const jsonl = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"你好"}}'
    ].join('\n') + '\n'
    fakeChildFactory = () => createFakeChild({ stdout: jsonl, exitCode: 0 })

    const result = await runCodex('测试', {})

    // 兜底：ceil(2/1.5) = 2
    expect(result.usage!.outputTokens).toBe(2)
  })

  it('onToken 回调按 item.completed 喂回', async () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"你好"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
    ].join('\n') + '\n'
    fakeChildFactory = () => createFakeChild({ stdout: jsonl, exitCode: 0 })

    const tokens: string[] = []
    await runCodex('测试', { onToken: (t) => tokens.push(t) })

    expect(tokens).toEqual(['你好'])
  })

  it('UTF-8 多字节字符被 chunk 边界截断时 JSONL 仍能正确解析', async () => {
    // 构造一条完整的 JSONL，其中 text 含中文"冰冷冰霜"
    // 把字节在"冰"和"霜"中间断开，模拟 chunk 截断
    const jsonl = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: '冰冷冰霜' } }),
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
    ].join('\n') + '\n'
    const full = Buffer.from(jsonl, 'utf8')
    // 在 "冰冷冰" 和 "霜" 之间断开（前半段含完整 JSON 到 text 字段值的中间）
    const splitAt = Math.floor(full.length / 2)
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        exitCode: 0,
        stdoutChunks: [full.subarray(0, splitAt), full.subarray(splitAt)]
      })

    const result = await runCodex('测试', {})
    expect(result.full).toBe('冰冷冰霜')
    expect(result.full).not.toContain('\uFFFD')
  })

  it('turn.failed 事件 -> reject 错误', async () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"turn.failed","error":{"message":"The model is not supported when using Codex with a ChatGPT account."}}'
    ].join('\n') + '\n'
    fakeChildFactory = () => createFakeChild({ stdout: jsonl, exitCode: 0 })

    await expect(runCodex('测试', {})).rejects.toThrow('CODEX_MODEL_ERROR')
  })

  it('error 事件含 auth -> LLM_AUTH_FAILED', async () => {
    const jsonl = [
      '{"type":"error","message":"authentication failed, please login"}'
    ].join('\n') + '\n'
    fakeChildFactory = () => createFakeChild({ stdout: jsonl, exitCode: 0 })

    await expect(runCodex('测试', {})).rejects.toThrow('LLM_AUTH_FAILED')
  })

  it('error 事件含 rate/limit -> LLM_RATE_LIMIT', async () => {
    const jsonl = [
      '{"type":"error","message":"rate limit exceeded"}'
    ].join('\n') + '\n'
    fakeChildFactory = () => createFakeChild({ stdout: jsonl, exitCode: 0 })

    await expect(runCodex('测试', {})).rejects.toThrow('LLM_RATE_LIMIT')
  })

  it('spawn ENOENT -> CODEX_NOT_FOUND', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        exitCode: 0,
        spawnError: { code: 'ENOENT', message: 'not found' }
      })

    await expect(runCodex('测试', {})).rejects.toThrow('CODEX_NOT_FOUND')
  })

  it('abort signal 触发 kill -> LLM_TIMEOUT', async () => {
    const controller = new AbortController()
    fakeChildFactory = () => {
      const child = new EventEmitter() as FakeChild
      child.stdin = { write: vi.fn(), end: vi.fn() }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.killed = false
      child.kill = vi.fn(() => {
        child.killed = true
        setImmediate(() => child.emit('close', 0))
      })
      return child
    }

    const promise = runCodex('测试', { signal: controller.signal })
    controller.abort()

    await expect(promise).rejects.toThrow('LLM_TIMEOUT')
  })

  it('超时 timer 触发 kill -> LLM_TIMEOUT（即使有部分输出）', async () => {
    fakeChildFactory = () => {
      const child = new EventEmitter() as FakeChild
      child.stdin = { write: vi.fn(), end: vi.fn() }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.killed = false
      child.kill = vi.fn(() => {
        child.killed = true
        // kill 后模拟 close（部分输出已到达但 turn 未完成）
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"部分内容"}}\n', 'utf8'))
          child.emit('close', 0)
        })
      })
      return child
    }

    // 用极短超时触发 timer
    await expect(runCodex('测试', { timeoutSec: 0 })).rejects.toThrow('LLM_TIMEOUT')
  })

  it('非 JSON 行（如 Reading prompt from stdin...）被跳过', async () => {
    const jsonl = [
      'Reading prompt from stdin...',
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"好"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
    ].join('\n') + '\n'
    fakeChildFactory = () => createFakeChild({ stdout: jsonl, exitCode: 0 })

    const result = await runCodex('测试', {})

    expect(result.full).toBe('好')
  })
})

describe('probeCodex', () => {
  it('codex --version 成功 -> 返回版本号', async () => {
    fakeChildFactory = () =>
      createFakeChild({ stdout: 'codex-cli 0.142.5\n', exitCode: 0 })

    const v = await probeCodex()
    expect(v).toBe('codex-cli 0.142.5')
    expect(lastSpawnArgs!.args).toEqual(['--version'])
  })

  it('codex 未安装 -> 返回 null', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        exitCode: 0,
        spawnError: { code: 'ENOENT', message: 'not found' }
      })

    const v = await probeCodex()
    expect(v).toBeNull()
  })
})

describe('listCodexModels', () => {
  it('config.toml 含 model 字段 -> 返回模型名', async () => {
    mockedReadFile.mockResolvedValue('model = "gpt-5.5"\nmodel_reasoning_effort = "medium"')

    const models = await listCodexModels()
    expect(models).toEqual(['gpt-5.5'])
  })

  it('config.toml 无 model 字段 -> 返回空数组', async () => {
    mockedReadFile.mockResolvedValue('model_reasoning_effort = "medium"')

    const models = await listCodexModels()
    expect(models).toEqual([])
  })

  it('文件不存在 -> 返回空数组', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'))

    const models = await listCodexModels()
    expect(models).toEqual([])
  })
})
