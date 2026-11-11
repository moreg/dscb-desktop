import { describe, expect, it } from 'vitest'
import { spawn } from 'child_process'
import { once } from 'events'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'
import {
  recoverProjectFolderLocks, selectReleasableCodexHelpers,
  type ProjectLockProcess, type ProjectLockSnapshot
} from '../src/main/data/project-folder-locks'

const localAppData = 'C:\\Users\\Tester\\AppData\\Local'
const codex = `${localAppData}\\OpenAI\\Codex`
const directory = 'J:\\book\\待改名作品'
const server = { pid: 10, executablePath: `${codex}\\bin\\version\\codex.exe`, commandLine: 'codex app-server' }
function holder(patch: Partial<ProjectLockProcess> = {}): ProjectLockProcess {
  return {
    pid: 20, name: 'node_repl.exe', executablePath: `${codex}\\runtimes\\cua_node\\version\\bin\\node_repl.exe`,
    commandLine: 'node_repl.exe', startTimeTicks: '639000000000000000', cpuSeconds: 0.015625,
    ageSeconds: 3600, sessionId: 1, hasWindow: false, hasConnection: false,
    paths: [directory], childPids: [], ancestors: [server], ...patch
  }
}
const snapshot = (holders: ProjectLockProcess[], patch: Partial<ProjectLockSnapshot> = {}): ProjectLockSnapshot =>
  ({ holders, sessionId: 1, networkKnown: true, ...patch })
const select = (items: ProjectLockProcess[], patch: Partial<ProjectLockSnapshot> = {}) =>
  selectReleasableCodexHelpers(snapshot(items, patch), directory, localAppData, 100)

describe('项目目录占用的自动清理范围', () => {
  it('只选择已启动一段时间、低累计活动、只持有项目根目录的 Codex 工具进程', () => {
    expect(select([holder()]).map(item => item.pid)).toEqual([20])
    expect(select([holder({ paths: ['j:/book/待改名作品/'] })])).toHaveLength(1)
  })

  it.each([
    { cpuSeconds: 0.3 }, { cpuSeconds: NaN }, { cpuSeconds: -1 }, { ageSeconds: 30 },
    { hasWindow: true }, { hasConnection: true }, { sessionId: 2 }, { startTimeTicks: '' },
    { executablePath: 'C:\\Program Files\\nodejs\\node.exe' },
    { paths: [`${directory}\\正文\\第001章.md`] }, { paths: [directory, `${directory}\\正文`] },
    { paths: [] }, { childPids: [999] }, { pid: 100 }, { ancestors: [] },
    { ancestors: [{ ...server, executablePath: 'C:\\other\\codex.exe' }] }
  ])('保留活动程序、未知程序和不完整身份：%j', patch => {
    expect(select([holder(patch)])).toEqual([])
  })

  it('网络状态无法确定时不自动结束进程', () => {
    expect(select([holder()], { networkKnown: false })).toEqual([])
  })

  it('允许随工具退出的已验证 Windows 控制台，但仍保留带未知子进程的工具', () => {
    expect(select([holder({ childPids: [50], passiveChildPids: [50] })])).toHaveLength(1)
    expect(select([holder({ childPids: [50, 60], passiveChildPids: [50] })])).toEqual([])
  })

  it('低活动的已知 CUA 进程树按子进程优先清理；任一成员活动时整组保留', () => {
    const host = holder({ pid: 30, name: 'node.exe', childPids: [40],
      executablePath: `${codex}\\runtimes\\cua_node\\version\\bin\\node.exe`,
      commandLine: 'node.exe C:\\runtime\\node_modules\\@oai\\cua-repl\\bin\\cua-repl.mjs' })
    const child = holder({ pid: 40, ancestors: [host, server] })
    expect(select([host, child]).map(item => item.pid)).toEqual([40, 30])
    expect(select([{ ...host, cpuSeconds: 10 }, child])).toEqual([])
    expect(select([host, { ...child, hasConnection: true }])).toEqual([])
    expect(select([{ ...host, childPids: [40, 999] }, child])).toEqual([])
  })

  it('即使可执行文件来自 Codex，普通 node 脚本也不在清理范围内', () => {
    expect(select([holder({ name: 'node.exe', executablePath: `${codex}\\runtimes\\cua_node\\version\\bin\\node.exe`,
      commandLine: 'node.exe my-server.js' })])).toEqual([])
  })
})

describe.skipIf(process.platform !== 'win32')('真实 Windows 目录句柄', () => {
  it('查到占用目录的普通 Node 进程并保留它，不因名称相同而误杀', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aw-folder-lock-'))
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('aw-folder-lock-')) throw new Error('Unexpected test directory')
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    const closed = once(child, 'close')
    try {
      await once(child.stdout!, 'data')
      const result = await recoverProjectFolderLocks(root)
      expect(result.released).toEqual([])
      expect(result.remaining.some(item => item.pid === child.pid && item.paths.includes(root))).toBe(true)
      expect(child.exitCode).toBeNull()
    } finally {
      child.kill()
      await closed
      // Only remove the exact mkdtemp directory inside the temporary workspace.
      await rm(root, { recursive: true, force: true })
    }
  }, 25_000)
})
