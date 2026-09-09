import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

interface FakeChild extends EventEmitter {
  stdin: {
    write: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
  }
  stdout: EventEmitter
  stderr: EventEmitter
  killed: boolean
  kill: ReturnType<typeof vi.fn>
}

let lastSpawnArgs: { bin: string; args: string[]; options?: { env?: NodeJS.ProcessEnv } } | null =
  null
let fakeChildFactory: (() => FakeChild) | null = null

vi.mock('child_process', () => ({
  spawn: vi.fn((bin: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    lastSpawnArgs = { bin, args, options }
    return fakeChildFactory
      ? fakeChildFactory()
      : createFakeChild({ stdout: '', exitCode: 0 })
  })
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false)
}))

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => {
    throw new Error('ENOENT')
  }),
  writeFile: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  mkdtemp: vi.fn(async (prefix: string) => `${prefix}testdir`)
}))

function createFakeChild(opts: {
  stdout: string
  stderr?: string
  exitCode: number
  spawnError?: { code: string; message: string }
  stdoutChunks?: Buffer[]
}): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() }
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
      for (const c of opts.stdoutChunks) child.stdout.emit('data', c)
    } else {
      child.stdout.emit('data', Buffer.from(opts.stdout, 'utf8'))
    }
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr, 'utf8'))
    child.emit('close', opts.exitCode)
  })

  return child
}

import { runClaude, probeClaude, listClaudeModels } from '../src/main/data/claude-runner'
import { readFile } from 'fs/promises'

const mockedReadFile = vi.mocked(readFile)

/** 组装 Claude Code `--output-format stream-json` 的 NDJSON 输出 */
function streamJson(
  deltas: string[],
  opts: { usage?: { input: number; output: number }; full?: string } = {}
): string {
  const full = opts.full ?? deltas.join('')
  const lines: string[] = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5' })
  ]
  for (const d of deltas) {
    lines.push(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: d } }
      })
    )
  }
  lines.push(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: full }],
        usage: opts.usage
          ? { input_tokens: opts.usage.input, output_tokens: opts.usage.output }
          : undefined
      }
    })
  )
  lines.push(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: full,
      usage: opts.usage
        ? { input_tokens: opts.usage.input, output_tokens: opts.usage.output }
        : undefined
    })
  )
  return lines.join('\n') + '\n'
}

beforeEach(() => {
  lastSpawnArgs = null
  fakeChildFactory = null
  mockedReadFile.mockReset()
  mockedReadFile.mockRejectedValue(new Error('ENOENT'))
})

describe('runClaude', () => {
  it('真流式喂回 text_delta，并从 result 取用量', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: streamJson(['你', '好'], { usage: { input: 100, output: 2 } }),
        exitCode: 0
      })
    const tokens: string[] = []
    const result = await runClaude('hi', {
      model: 'claude-sonnet-5',
      onToken: (t) => tokens.push(t)
    })
    expect(tokens.join('')).toBe('你好')
    expect(result.full).toBe('你好')
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 2, totalTokens: 102 })

    const args = lastSpawnArgs!.args
    expect(args).toContain('-p')
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json')
    expect(args).toContain('--verbose')
    expect(args).toContain('--include-partial-messages')
    expect(args).toContain('--strict-mcp-config')
    // MCP 空配置按 cwd 下的相对文件名传入（内联 JSON 在 Windows shell 下会被破坏）
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('mcp-empty.json')
    expect(args).toContain('--disallowedTools')
    expect(args).toContain('Bash')
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5')
  })

  it('prompt 走 stdin，不进 argv', async () => {
    let written = ''
    fakeChildFactory = () => {
      const child = createFakeChild({ stdout: streamJson(['ok']), exitCode: 0 })
      child.stdin.write = vi.fn((s: string) => {
        written += s
        return true
      })
      return child
    }
    await runClaude('这是一段中文提示词', {})
    expect(written).toContain('这是一段中文提示词')
    expect(lastSpawnArgs!.args).not.toContain('这是一段中文提示词')
  })

  it('model 为 default 时不加 --model', async () => {
    fakeChildFactory = () => createFakeChild({ stdout: streamJson(['ok']), exitCode: 0 })
    await runClaude('hi', { model: 'default' })
    expect(lastSpawnArgs!.args).not.toContain('--model')
  })

  it('thinkingEffort 映射到子进程 MAX_THINKING_TOKENS 环境变量', async () => {
    fakeChildFactory = () => createFakeChild({ stdout: streamJson(['ok']), exitCode: 0 })
    await runClaude('hi', { thinkingEffort: 'high' })
    expect(lastSpawnArgs!.options?.env?.MAX_THINKING_TOKENS).toBe('24000')

    await runClaude('hi', { thinkingEffort: 'none' })
    expect(lastSpawnArgs!.options?.env?.MAX_THINKING_TOKENS).toBe('0')
  })

  it('未传 thinkingEffort 时不注入 MAX_THINKING_TOKENS', async () => {
    fakeChildFactory = () => createFakeChild({ stdout: streamJson(['ok']), exitCode: 0 })
    await runClaude('hi', {})
    expect(lastSpawnArgs!.options?.env?.MAX_THINKING_TOKENS).toBeUndefined()
  })

  it('无增量事件时用 assistant/result 全文兜底喂 onToken', async () => {
    const stdout =
      JSON.stringify({ type: 'system', subtype: 'init' }) +
      '\n' +
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '整段兜底正文',
        usage: { input_tokens: 10, output_tokens: 5 }
      }) +
      '\n'
    fakeChildFactory = () => createFakeChild({ stdout, exitCode: 0 })
    const tokens: string[] = []
    const result = await runClaude('hi', { onToken: (t) => tokens.push(t) })
    expect(tokens).toEqual(['整段兜底正文'])
    expect(result.full).toBe('整段兜底正文')
  })

  it('用量缺失时按字数估算', async () => {
    fakeChildFactory = () => createFakeChild({ stdout: streamJson(['你好']), exitCode: 0 })
    const result = await runClaude('hi', {})
    expect(result.usage!.outputTokens).toBe(2) // ceil(2 / 1.5)
  })

  it('result 报错（鉴权）映射 CLAUDE_AUTH_EXPIRED，并自动重试一次', async () => {
    let calls = 0
    fakeChildFactory = () => {
      calls++
      return createFakeChild({
        stdout:
          JSON.stringify({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            result: 'Invalid API key · Please run /login'
          }) + '\n',
        exitCode: 1
      })
    }
    await expect(runClaude('hi')).rejects.toThrow('CLAUDE_AUTH_EXPIRED')
    expect(calls).toBeGreaterThanOrEqual(2)
  }, 10000)

  it('限流映射 LLM_RATE_LIMIT', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        stderr: 'API Error: 429 rate_limit_error',
        exitCode: 1
      })
    await expect(runClaude('hi')).rejects.toThrow('LLM_RATE_LIMIT')
  })

  it('ENOENT 映射 CLAUDE_NOT_FOUND', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        exitCode: 1,
        spawnError: { code: 'ENOENT', message: 'not found' }
      })
    await expect(runClaude('hi')).rejects.toThrow('CLAUDE_NOT_FOUND')
  })

  it('用户中止映射 LLM_ABORTED（非超时）', async () => {
    fakeChildFactory = () => {
      const child = new EventEmitter() as FakeChild
      child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.killed = false
      child.kill = vi.fn(() => {
        child.killed = true
        setImmediate(() => child.emit('close', 1))
        return true
      })
      return child
    }
    const controller = new AbortController()
    const promise = runClaude('hi', { signal: controller.signal, timeoutSec: 30 })
    setImmediate(() => controller.abort())
    await expect(promise).rejects.toThrow('LLM_ABORTED')
  })

  it('非零退出且无输出 -> CLAUDE_ERROR', async () => {
    fakeChildFactory = () =>
      createFakeChild({ stdout: '', stderr: 'boom', exitCode: 2 })
    await expect(runClaude('hi')).rejects.toThrow(/CLAUDE_ERROR/)
  })
})

describe('probeClaude', () => {
  it('claude --version 成功 -> 返回版本号', async () => {
    fakeChildFactory = () =>
      createFakeChild({ stdout: '1.0.113 (Claude Code)\n', exitCode: 0 })
    const v = await probeClaude()
    expect(v).toContain('Claude Code')
    expect(lastSpawnArgs!.args).toEqual(['--version'])
  })

  it('未安装 -> 返回 null', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        exitCode: 1,
        spawnError: { code: 'ENOENT', message: 'not found' }
      })
    await expect(probeClaude()).resolves.toBeNull()
  })
})

describe('listClaudeModels', () => {
  it('settings.json 含 model -> 置顶并合并预设', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ model: 'claude-opus-5' }))
    const models = await listClaudeModels()
    expect(models[0]).toBe('claude-opus-5')
    expect(models).toContain('sonnet')
    expect(models.filter((m) => m === 'claude-opus-5')).toHaveLength(1)
  })

  it('settings.json 含未知 model -> 仍置顶', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ model: 'my-custom' }))
    const models = await listClaudeModels()
    expect(models[0]).toBe('my-custom')
    expect(models).toContain('opus')
  })

  it('文件缺失 / 非法 JSON -> 仅返回预设', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'))
    const models = await listClaudeModels()
    expect(models[0]).toBe('sonnet')
    expect(models).toContain('claude-sonnet-5')
    expect(models.length).toBeGreaterThan(3)
  })
})
