import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

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

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true)
}))

vi.mock('fs/promises', () => ({
  writeFile: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
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
      for (const c of opts.stdoutChunks) child.stdout.emit('data', c)
    } else {
      child.stdout.emit('data', Buffer.from(opts.stdout, 'utf8'))
    }
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr, 'utf8'))
    child.emit('close', opts.exitCode)
  })

  return child
}

import {
  runGrok,
  probeGrok,
  listGrokModels,
  parseGrokJsonOutput,
  toAsciiJson
} from '../src/main/data/grok-runner'

/**
 * `grok --output-format json --json-schema ...` 的真实输出形态
 * （来自本机 grok 0.1.x 实测：单个多行 pretty JSON 对象，非 NDJSON）。
 */
const REAL_JSON_ENVELOPE = `{
  "text": "{\\"city\\":\\"Paris\\"}",
  "stopReason": "end_turn",
  "sessionId": "019fb91e-97a0-7010-a3e0-184ee536c504",
  "thought": "The user wants the capital of France.\\n",
  "usage": {
    "input_tokens": 12206,
    "cache_read_input_tokens": 2560,
    "output_tokens": 67,
    "reasoning_tokens": 57,
    "total_tokens": 14833
  },
  "num_turns": 1,
  "structuredOutput": {
    "city": "Paris"
  }
}`

beforeEach(() => {
  lastSpawnArgs = null
  fakeChildFactory = null
})

function streamingJsonl(parts: string[], usage?: { input: number; output: number }): string {
  const lines: string[] = []
  for (const p of parts) {
    lines.push(JSON.stringify({ type: 'text', data: p }))
  }
  lines.push(
    JSON.stringify({
      type: 'end',
      stopReason: 'EndTurn',
      usage: usage
        ? {
            input_tokens: usage.input,
            output_tokens: usage.output,
            total_tokens: usage.input + usage.output
          }
        : undefined
    })
  )
  return lines.join('\n') + '\n'
}

describe('runGrok', () => {
  it('streams text events and returns usage', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: streamingJsonl(['你', '好'], { input: 100, output: 2 }),
        exitCode: 0
      })
    const tokens: string[] = []
    const result = await runGrok('hi', {
      model: 'grok-4.5',
      onToken: (t) => tokens.push(t)
    })
    expect(tokens.join('')).toBe('你好')
    expect(result.full).toBe('你好')
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 2,
      totalTokens: 102
    })
    expect(lastSpawnArgs?.args).toContain('--prompt-file')
    expect(lastSpawnArgs?.args).toContain('--output-format')
    expect(lastSpawnArgs?.args).toContain('streaming-json')
    expect(lastSpawnArgs?.args).toContain('--max-turns')
    // 空 tools allowlist：禁止技能/工具抢占唯一 turn
    expect(lastSpawnArgs?.args).toContain('--tools')
    const toolsIdx = lastSpawnArgs!.args.indexOf('--tools')
    expect(lastSpawnArgs!.args[toolsIdx + 1]).toBe('')
    // 成品约束写在 prompt 文件内，不再用 --rules argv（避免 Windows 中文编码）
    expect(lastSpawnArgs?.args).not.toContain('--rules')
    expect(lastSpawnArgs?.args).not.toContain('--disallowed-tools')
    expect(lastSpawnArgs?.args).toContain('-m')
    expect(lastSpawnArgs?.args).toContain('grok-4.5')
  })

  it('user abort maps to LLM_ABORTED (not timeout)', async () => {
    fakeChildFactory = () => {
      const child = new EventEmitter() as FakeChild
      child.stdin = { write: vi.fn(), end: vi.fn() }
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
    const promise = runGrok('hi', { signal: controller.signal, timeoutSec: 30 })
    setImmediate(() => controller.abort())
    await expect(promise).rejects.toThrow('LLM_ABORTED')
  })

  it('maps auth failures to GROK_AUTH_EXPIRED', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: JSON.stringify({ type: 'error', message: 'Please sign in again' }) + '\n',
        exitCode: 1
      })
    await expect(runGrok('hi')).rejects.toThrow('GROK_AUTH_EXPIRED')
  })

  it('maps ENOENT to GROK_NOT_FOUND', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        exitCode: 1,
        spawnError: { code: 'ENOENT', message: 'not found' }
      })
    await expect(runGrok('hi')).rejects.toThrow('GROK_NOT_FOUND')
  })

  it('rejects on non-zero exit without text', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        stderr: 'boom failed',
        exitCode: 2
      })
    await expect(runGrok('hi')).rejects.toThrow(/GROK_ERROR/)
  })
})

describe('toAsciiJson', () => {
  it('ASCII 内容原样序列化', () => {
    expect(toAsciiJson({ type: 'object' })).toBe('{"type":"object"}')
  })

  it('中文转成 \\uXXXX，结果是纯 ASCII 且语义不变', () => {
    const out = toAsciiJson({ desc: '中文说明' })
    expect(/^[\x00-\x7e]*$/.test(out)).toBe(true)
    expect(JSON.parse(out)).toEqual({ desc: '中文说明' })
  })

  it('emoji（代理对）逐码元转义后仍可解析', () => {
    const out = toAsciiJson({ e: '✦🎨' })
    expect(/^[\x00-\x7e]*$/.test(out)).toBe(true)
    expect(JSON.parse(out)).toEqual({ e: '✦🎨' })
  })

  it('嵌套 schema 完整保留', () => {
    const schema = { type: 'object', properties: { a: { type: 'string', enum: ['x', 'y'] } } }
    expect(JSON.parse(toAsciiJson(schema))).toEqual(schema)
  })
})

describe('parseGrokJsonOutput', () => {
  it('优先取 structuredOutput（已过 schema 校验）', () => {
    const r = parseGrokJsonOutput(REAL_JSON_ENVELOPE)
    expect(r.full).toBe('{"city":"Paris"}')
    expect(r.error).toBeUndefined()
  })

  it('usage 按 input/output/total 映射', () => {
    expect(parseGrokJsonOutput(REAL_JSON_ENVELOPE).usage).toEqual({
      inputTokens: 12206,
      outputTokens: 67,
      totalTokens: 14833
    })
  })

  it('没有 structuredOutput 时回退 text', () => {
    const r = parseGrokJsonOutput('{"text":"hello","stopReason":"end_turn"}')
    expect(r.full).toBe('hello')
  })

  it('total_tokens 缺失时用 input+output 兜底', () => {
    const r = parseGrokJsonOutput('{"text":"x","usage":{"input_tokens":10,"output_tokens":5}}')
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  })

  it('容忍 JSON 前后夹杂的日志行', () => {
    const r = parseGrokJsonOutput('warning: something\n{"text":"ok"}\nbye')
    expect(r.full).toBe('ok')
  })

  it('空输出 / 非法 JSON 返回空而非抛错', () => {
    expect(parseGrokJsonOutput('')).toEqual({ full: '', usage: null })
    expect(parseGrokJsonOutput('not json at all')).toEqual({ full: '', usage: null })
    expect(parseGrokJsonOutput('{broken')).toEqual({ full: '', usage: null })
  })

  it('error 字段被带出', () => {
    expect(parseGrokJsonOutput('{"error":"rate limit exceeded"}').error).toBe(
      'rate limit exceeded'
    )
  })
})

describe('runGrok --json-schema 结构化模式', () => {
  const schema = { type: 'object', properties: { city: { type: 'string' } } }

  it('传 jsonSchema 时切到 --output-format json 并下发 schema', async () => {
    fakeChildFactory = () => createFakeChild({ stdout: REAL_JSON_ENVELOPE, exitCode: 0 })
    const result = await runGrok('hi', { jsonSchema: schema })

    expect(result.full).toBe('{"city":"Paris"}')
    const args = lastSpawnArgs!.args
    expect(args).toContain('--json-schema')
    expect(args[args.indexOf('--json-schema') + 1]).toBe(toAsciiJson(schema))
    expect(args[args.indexOf('--output-format') + 1]).toBe('json')
    expect(args).not.toContain('streaming-json')
  })

  it('不传 jsonSchema 时保持 streaming-json，不带 --json-schema', async () => {
    fakeChildFactory = () =>
      createFakeChild({ stdout: streamingJsonl(['ok']), exitCode: 0 })
    await runGrok('hi')
    const args = lastSpawnArgs!.args
    expect(args[args.indexOf('--output-format') + 1]).toBe('streaming-json')
    expect(args).not.toContain('--json-schema')
  })

  it('该模式无增量事件：onToken 在收尾时被喂一次全文', async () => {
    fakeChildFactory = () => createFakeChild({ stdout: REAL_JSON_ENVELOPE, exitCode: 0 })
    const tokens: string[] = []
    await runGrok('hi', { jsonSchema: schema, onToken: (t) => tokens.push(t) })
    expect(tokens).toEqual(['{"city":"Paris"}'])
  })

  it('多行 pretty JSON 跨 chunk 到达也能解析（不按行切）', async () => {
    const mid = Math.floor(REAL_JSON_ENVELOPE.length / 2)
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        exitCode: 0,
        stdoutChunks: [
          Buffer.from(REAL_JSON_ENVELOPE.slice(0, mid), 'utf8'),
          Buffer.from(REAL_JSON_ENVELOPE.slice(mid), 'utf8')
        ]
      })
    const result = await runGrok('hi', { jsonSchema: schema })
    expect(result.full).toBe('{"city":"Paris"}')
  })

  it('结构化模式下的鉴权错误仍映射 GROK_AUTH_EXPIRED', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '{"error":"please sign in again"}',
        exitCode: 1
      })
    await expect(runGrok('hi', { jsonSchema: schema })).rejects.toThrow('GROK_AUTH_EXPIRED')
  })

  it('结构化模式下的限流映射 LLM_RATE_LIMIT', async () => {
    fakeChildFactory = () =>
      createFakeChild({ stdout: '{"error":"429 rate limit"}', exitCode: 1 })
    await expect(runGrok('hi', { jsonSchema: schema })).rejects.toThrow('LLM_RATE_LIMIT')
  })
})

describe('probeGrok', () => {
  it('returns version string on success', async () => {
    fakeChildFactory = () =>
      createFakeChild({ stdout: 'grok 0.1.42\n', exitCode: 0 })
    await expect(probeGrok()).resolves.toContain('grok')
  })

  it('returns null when missing', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: '',
        exitCode: 1,
        spawnError: { code: 'ENOENT', message: 'not found' }
      })
    await expect(probeGrok()).resolves.toBeNull()
  })
})

describe('listGrokModels', () => {
  it('parses grok models output', async () => {
    fakeChildFactory = () =>
      createFakeChild({
        stdout: `You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
  - grok-composer-2.5-fast
`,
        exitCode: 0
      })
    await expect(listGrokModels()).resolves.toEqual([
      'grok-4.5',
      'grok-composer-2.5-fast'
    ])
  })
})
