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

import { runGrok, probeGrok, listGrokModels } from '../src/main/data/grok-runner'

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
