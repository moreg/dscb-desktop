import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock child_process.spawn，模拟 codex app-server 子进程行为
const { EventEmitter } = require('events')

interface FakeChild extends EventEmitter {
  stdin: {
    write: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
    writable: boolean
  }
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
    return fakeChildFactory ? fakeChildFactory() : createAutoAppServerChild()
  })
}))

vi.mock('fs/promises', () => ({
  readFile: vi.fn()
}))

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(),
    writable: true
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = vi.fn(() => {
    child.killed = true
    setImmediate(() => child.emit('close', 0))
  })
  return child
}

/** 解析 stdin 写出的 JSON-RPC，驱动自动响应 */
function createAutoAppServerChild(opts?: {
  deltas?: string[]
  completedText?: string
  usage?: { input: number; output: number }
  turnStatus?: 'completed' | 'failed' | 'interrupted'
  turnErrorMessage?: string
  failInitialize?: string
  failThread?: string
  spawnError?: { code: string; message: string }
  /** 不自动回复 turn/start 之后的 turn/completed（用于 abort/timeout） */
  hangAfterTurnStart?: boolean
  /** 在 delta 之前注入的服务端消息（如审批请求） */
  injectBeforeDeltas?: Record<string, unknown>[]
}): FakeChild {
  const child = createFakeChild()
  const deltas = opts?.deltas ?? ['你', '好']
  const completedText = opts?.completedText ?? deltas.join('')
  const turnStatus = opts?.turnStatus ?? 'completed'

  if (opts?.spawnError) {
    setImmediate(() => {
      const err = Object.assign(new Error(opts.spawnError!.message), {
        code: opts.spawnError!.code
      })
      child.emit('error', err)
    })
    return child
  }

  child.stdin.write = vi.fn((raw: string) => {
    const lines = String(raw).split('\n').filter(Boolean)
    for (const line of lines) {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const method = msg.method as string | undefined
      const id = msg.id as number | undefined

      // initialized 通知
      if (method === 'initialized') continue

      if (method === 'initialize' && id != null) {
        if (opts?.failInitialize) {
          setImmediate(() =>
            child.stdout.emit(
              'data',
              Buffer.from(
                JSON.stringify({
                  id,
                  error: { code: -32000, message: opts.failInitialize }
                }) + '\n',
                'utf8'
              )
            )
          )
          continue
        }
        setImmediate(() =>
          child.stdout.emit(
            'data',
            Buffer.from(JSON.stringify({ id, result: { userAgent: 'codex' } }) + '\n', 'utf8')
          )
        )
        continue
      }

      if (method === 'thread/start' && id != null) {
        if (opts?.failThread) {
          setImmediate(() =>
            child.stdout.emit(
              'data',
              Buffer.from(
                JSON.stringify({
                  id,
                  error: { code: -32000, message: opts.failThread }
                }) + '\n',
                'utf8'
              )
            )
          )
          continue
        }
        setImmediate(() => {
          child.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                id,
                result: { thread: { id: 'thr_test' } }
              }) + '\n',
              'utf8'
            )
          )
          child.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                method: 'thread/started',
                params: { thread: { id: 'thr_test' } }
              }) + '\n',
              'utf8'
            )
          )
        })
        continue
      }

      if (method === 'turn/start' && id != null) {
        setImmediate(() => {
          child.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                id,
                result: { turn: { id: 'turn_test', status: 'inProgress' } }
              }) + '\n',
              'utf8'
            )
          )
          child.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                method: 'turn/started',
                params: { turn: { id: 'turn_test' } }
              }) + '\n',
              'utf8'
            )
          )

          if (opts?.hangAfterTurnStart) return

          for (const extra of opts?.injectBeforeDeltas ?? []) {
            child.stdout.emit(
              'data',
              Buffer.from(JSON.stringify(extra) + '\n', 'utf8')
            )
          }

          // 流式 delta
          for (const d of deltas) {
            child.stdout.emit(
              'data',
              Buffer.from(
                JSON.stringify({
                  method: 'item/agentMessage/delta',
                  params: {
                    threadId: 'thr_test',
                    turnId: 'turn_test',
                    itemId: 'item_0',
                    delta: d
                  }
                }) + '\n',
                'utf8'
              )
            )
          }
          // completed 权威全文
          child.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                method: 'item/completed',
                params: {
                  threadId: 'thr_test',
                  turnId: 'turn_test',
                  item: { id: 'item_0', type: 'agentMessage', text: completedText },
                  completedAtMs: Date.now()
                }
              }) + '\n',
              'utf8'
            )
          )
          if (opts?.usage) {
            child.stdout.emit(
              'data',
              Buffer.from(
                JSON.stringify({
                  method: 'thread/tokenUsage/updated',
                  params: {
                    threadId: 'thr_test',
                    turnId: 'turn_test',
                    tokenUsage: {
                      last: {
                        inputTokens: opts.usage.input,
                        outputTokens: opts.usage.output,
                        totalTokens: opts.usage.input + opts.usage.output,
                        cachedInputTokens: 0,
                        reasoningOutputTokens: 0
                      },
                      total: {
                        inputTokens: opts.usage.input,
                        outputTokens: opts.usage.output,
                        totalTokens: opts.usage.input + opts.usage.output,
                        cachedInputTokens: 0,
                        reasoningOutputTokens: 0
                      },
                      modelContextWindow: 200000
                    }
                  }
                }) + '\n',
                'utf8'
              )
            )
          }
          child.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                method: 'turn/completed',
                params: {
                  threadId: 'thr_test',
                  turn: {
                    id: 'turn_test',
                    status: turnStatus,
                    error: opts?.turnErrorMessage
                      ? { message: opts.turnErrorMessage, codexErrorInfo: null, additionalDetails: null }
                      : null,
                    items: [],
                    itemsView: 'full',
                    startedAt: null,
                    completedAt: null,
                    durationMs: null
                  }
                }
              }) + '\n',
              'utf8'
            )
          )
        })
        continue
      }

      if (method === 'turn/interrupt' && id != null) {
        setImmediate(() => {
          child.stdout.emit(
            'data',
            Buffer.from(JSON.stringify({ id, result: {} }) + '\n', 'utf8')
          )
          child.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                method: 'turn/completed',
                params: {
                  threadId: 'thr_test',
                  turn: {
                    id: 'turn_test',
                    status: 'interrupted',
                    error: null,
                    items: [],
                    itemsView: 'full',
                    startedAt: null,
                    completedAt: null,
                    durationMs: null
                  }
                }
              }) + '\n',
              'utf8'
            )
          )
        })
      }
    }
    return true
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

describe('runCodex (app-server)', () => {
  it('spawn app-server 而非 exec --json', async () => {
    fakeChildFactory = () =>
      createAutoAppServerChild({ deltas: ['好'], usage: { input: 10, output: 1 } })

    const result = await runCodex('回复一个字', {})

    expect(lastSpawnArgs).not.toBeNull()
    expect(
      lastSpawnArgs!.bin.endsWith('codex') ||
        lastSpawnArgs!.bin.endsWith('codex.exe') ||
        lastSpawnArgs!.bin.endsWith('codex.cmd')
    ).toBe(true)
    expect(lastSpawnArgs!.args).toEqual(['app-server'])
    expect(result.full).toBe('好')
  })

  it('model 非空时 thread/start 带 model', async () => {
    let threadStartParams: Record<string, unknown> | null = null
    fakeChildFactory = () => {
      const child = createAutoAppServerChild({ deltas: ['好'] })
      const origWrite = child.stdin.write
      child.stdin.write = vi.fn((raw: string) => {
        for (const line of String(raw).split('\n').filter(Boolean)) {
          try {
            const msg = JSON.parse(line)
            if (msg.method === 'thread/start') threadStartParams = msg.params
          } catch {
            // skip
          }
        }
        return origWrite(raw)
      })
      return child
    }

    await runCodex('测试', { model: 'gpt-5.5' })
    expect(threadStartParams).not.toBeNull()
    expect(threadStartParams!.model).toBe('gpt-5.5')
  })

  it('model 为空时 thread/start 不带 model', async () => {
    let threadStartParams: Record<string, unknown> | null = null
    fakeChildFactory = () => {
      const child = createAutoAppServerChild({ deltas: ['好'] })
      const origWrite = child.stdin.write
      child.stdin.write = vi.fn((raw: string) => {
        for (const line of String(raw).split('\n').filter(Boolean)) {
          try {
            const msg = JSON.parse(line)
            if (msg.method === 'thread/start') threadStartParams = msg.params
          } catch {
            // skip
          }
        }
        return origWrite(raw)
      })
      return child
    }

    await runCodex('测试', { model: undefined })
    expect(threadStartParams).not.toBeNull()
    expect(threadStartParams!.model).toBeUndefined()
  })

  it('onToken 按 item/agentMessage/delta 真流式喂回', async () => {
    fakeChildFactory = () =>
      createAutoAppServerChild({
        deltas: ['第一', '段', '正文'],
        completedText: '第一段正文',
        usage: { input: 100, output: 5 }
      })

    const tokens: string[] = []
    const result = await runCodex('测试', { onToken: (t) => tokens.push(t) })

    expect(tokens).toEqual(['第一', '段', '正文'])
    expect(result.full).toBe('第一段正文')
  })

  it('item/completed 有全文但无 delta 时兜底喂 onToken', async () => {
    fakeChildFactory = () => createAutoAppServerChild({ deltas: [], completedText: '整段兜底' })

    const tokens: string[] = []
    const result = await runCodex('测试', { onToken: (t) => tokens.push(t) })

    expect(tokens).toEqual(['整段兜底'])
    expect(result.full).toBe('整段兜底')
  })

  it('有 delta 时 item/completed 不重复 onToken', async () => {
    fakeChildFactory = () =>
      createAutoAppServerChild({
        deltas: ['A', 'B'],
        completedText: 'AB'
      })

    const tokens: string[] = []
    await runCodex('测试', { onToken: (t) => tokens.push(t) })
    expect(tokens).toEqual(['A', 'B'])
  })

  it('从 thread/tokenUsage/updated 提取精确用量', async () => {
    fakeChildFactory = () =>
      createAutoAppServerChild({
        deltas: ['你好'],
        usage: { input: 1500, output: 10 }
      })

    const result = await runCodex('测试', {})
    expect(result.usage).not.toBeNull()
    expect(result.usage!.inputTokens).toBe(1500)
    expect(result.usage!.outputTokens).toBe(10)
    expect(result.usage!.totalTokens).toBe(1510)
  })

  it('用量缺失时按字数估算', async () => {
    fakeChildFactory = () => createAutoAppServerChild({ deltas: ['你好'] }) // 2 字 → ceil(2/1.5)=2

    const result = await runCodex('测试', {})
    expect(result.usage!.outputTokens).toBe(2)
  })

  it('turn failed + model not supported -> CODEX_MODEL_ERROR', async () => {
    fakeChildFactory = () =>
      createAutoAppServerChild({
        deltas: [],
        turnStatus: 'failed',
        turnErrorMessage: 'The model is not supported when using Codex with a ChatGPT account.'
      })

    await expect(runCodex('测试', {})).rejects.toThrow('CODEX_MODEL_ERROR')
  })

  it('鉴权错误 -> CODEX_AUTH_EXPIRED（自动重试一次后仍失败）', async () => {
    let calls = 0
    fakeChildFactory = () => {
      calls++
      return createAutoAppServerChild({
        failThread: 'authentication failed, please login'
      })
    }

    await expect(runCodex('测试', {})).rejects.toThrow('CODEX_AUTH_EXPIRED')
    // initialize 成功后 thread/start 失败；auth 重试会再 spawn 一次
    expect(calls).toBeGreaterThanOrEqual(2)
  }, 10000)

  it('rate limit -> LLM_RATE_LIMIT', async () => {
    fakeChildFactory = () =>
      createAutoAppServerChild({
        deltas: [],
        turnStatus: 'failed',
        turnErrorMessage: 'rate limit exceeded'
      })

    await expect(runCodex('测试', {})).rejects.toThrow('LLM_RATE_LIMIT')
  })

  it('spawn ENOENT -> CODEX_NOT_FOUND', async () => {
    fakeChildFactory = () =>
      createAutoAppServerChild({
        spawnError: { code: 'ENOENT', message: 'not found' }
      })

    await expect(runCodex('测试', {})).rejects.toThrow('CODEX_NOT_FOUND')
  })

  it('abort signal 触发 interrupt/kill -> LLM_ABORTED', async () => {
    const controller = new AbortController()
    fakeChildFactory = () => createAutoAppServerChild({ hangAfterTurnStart: true, deltas: [] })

    const promise = runCodex('测试', { signal: controller.signal })
    // 等握手与 turn/start 走完
    await new Promise((r) => setTimeout(r, 30))
    controller.abort()

    await expect(promise).rejects.toThrow('LLM_ABORTED')
  })

  it('超时 -> LLM_TIMEOUT', async () => {
    fakeChildFactory = () => createAutoAppServerChild({ hangAfterTurnStart: true, deltas: [] })

    await expect(runCodex('测试', { timeoutSec: 0 })).rejects.toThrow('LLM_TIMEOUT')
  })

  it('审批类 server request 自动 decline', async () => {
    let declined = false
    fakeChildFactory = () => {
      const child = createAutoAppServerChild({
        deltas: ['好'],
        // 在 delta 之前插入审批请求（与 turn 同批，避免 turn/completed 后 settled）
        injectBeforeDeltas: [
          {
            method: 'item/commandExecution/requestApproval',
            id: 9999,
            params: { threadId: 'thr_test', command: 'echo hi' }
          }
        ]
      })
      const origWrite = child.stdin.write
      child.stdin.write = vi.fn((raw: string) => {
        for (const line of String(raw).split('\n').filter(Boolean)) {
          try {
            const msg = JSON.parse(line)
            if (msg.id != null && msg.result?.decision === 'decline') declined = true
          } catch {
            // skip
          }
        }
        return origWrite(raw)
      })
      return child
    }

    await runCodex('测试', {})
    expect(declined).toBe(true)
  })
})

describe('probeCodex', () => {
  it('codex --version 成功 -> 返回版本号', async () => {
    fakeChildFactory = () => {
      const child = createFakeChild()
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('codex-cli 0.144.6\n', 'utf8'))
        child.emit('close', 0)
      })
      return child
    }

    const v = await probeCodex()
    expect(v).toBe('codex-cli 0.144.6')
    expect(lastSpawnArgs!.args).toEqual(['--version'])
  })

  it('codex 未安装 -> 返回 null', async () => {
    fakeChildFactory = () => {
      const child = createFakeChild()
      setImmediate(() => {
        const err = Object.assign(new Error('not found'), { code: 'ENOENT' })
        child.emit('error', err)
      })
      return child
    }

    const v = await probeCodex()
    expect(v).toBeNull()
  })
})

describe('listCodexModels', () => {
  it('config.toml 含 model 字段 -> 该模型排在最前，并合并预设', async () => {
    mockedReadFile.mockResolvedValue('model = "gpt-5.5"\nmodel_reasoning_effort = "medium"')

    const models = await listCodexModels()
    expect(models[0]).toBe('gpt-5.5')
    expect(models).toContain('gpt-5.6-sol')
    expect(models).toContain('gpt-5.4')
    expect(models.filter((m) => m === 'gpt-5.5')).toHaveLength(1)
  })

  it('config.toml 含未知 model -> 仍置顶并附带预设', async () => {
    mockedReadFile.mockResolvedValue('model = "my-custom-model"\n')

    const models = await listCodexModels()
    expect(models[0]).toBe('my-custom-model')
    expect(models).toContain('gpt-5.6-sol')
  })

  it('config.toml 无 model 字段 -> 仅返回预设列表', async () => {
    mockedReadFile.mockResolvedValue('model_reasoning_effort = "medium"')

    const models = await listCodexModels()
    expect(models[0]).toBe('gpt-5.6-sol')
    expect(models).toContain('gpt-5.5')
    expect(models.length).toBeGreaterThan(3)
  })

  it('文件不存在 -> 仍返回预设列表', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'))

    const models = await listCodexModels()
    expect(models).toContain('gpt-5.6-sol')
    expect(models).toContain('gpt-5.5')
  })
})
