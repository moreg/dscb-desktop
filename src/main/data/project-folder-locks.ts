import { execFile } from 'child_process'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, win32 } from 'path'
import { windowsProjectLockScript } from './windows-project-lock-script'

export interface LockProcessIdentity {
  pid: number
  executablePath: string
  commandLine: string
}

export interface ProjectLockProcess extends LockProcessIdentity {
  name: string
  startTimeTicks: string
  cpuSeconds: number
  ageSeconds: number
  sessionId: number
  hasWindow: boolean
  hasConnection: boolean
  paths: string[]
  childPids: number[]
  passiveChildPids?: number[]
  ancestors: LockProcessIdentity[]
}

export interface ProjectLockSnapshot {
  holders: ProjectLockProcess[]
  networkKnown: boolean
  sessionId: number
}

export interface ProjectLockRecovery {
  released: number[]
  remaining: ProjectLockProcess[]
}

function normalized(value: string): string {
  return win32.normalize(value).replace(/\\+$/, '').toLowerCase()
}

/** Only nearly unused, windowless Codex tool runtimes holding the root directory qualify.
 * Low recent CPU alone is insufficient: an already-used runtime may be waiting for a task.
 * The native helper rechecks identity, total CPU, connections and children before stopping it.
 */
export function selectReleasableCodexHelpers(
  snapshot: ProjectLockSnapshot,
  directory: string,
  localAppData: string,
  ownPid: number
): ProjectLockProcess[] {
  if (!snapshot.networkKnown || !win32.isAbsolute(localAppData)) return []
  const codexRoot = normalized(win32.join(localAppData, 'OpenAI', 'Codex'))
  const runtimePattern = /^\\runtimes\\cua_node\\[^\\]+\\bin\\(node_repl|node)\.exe$/
  const isCodexServer = (item: LockProcessIdentity): boolean => {
    const executable = normalized(item.executablePath)
    return executable.startsWith(codexRoot) && /^\\bin\\[^\\]+\\codex\.exe$/.test(executable.slice(codexRoot.length))
  }
  const runtimeKind = (item: LockProcessIdentity): string | undefined => {
    const executable = normalized(item.executablePath)
    if (!executable.startsWith(codexRoot)) return undefined
    const kind = runtimePattern.exec(executable.slice(codexRoot.length))?.[1]
    if (kind === 'node' && !/[\\/]@oai[\\/]cua-repl[\\/]bin[\\/]cua-repl\.mjs(?:"|\s|$)/i.test(item.commandLine)) return undefined
    return kind
  }
  const candidates = snapshot.holders.filter(item => {
    const kind = runtimeKind(item)
    const parent = item.ancestors[0]
    const isKnownParent = parent && (isCodexServer(parent) || (
      kind === 'node_repl' && runtimeKind(parent) === 'node' &&
      item.ancestors[1] && isCodexServer(item.ancestors[1])
    ))
    return kind && isKnownParent && item.pid !== ownPid &&
      item.sessionId === snapshot.sessionId && /^\d+$/.test(item.startTimeTicks) &&
      Number.isFinite(item.cpuSeconds) && item.cpuSeconds >= 0 && item.cpuSeconds <= 0.25 &&
      item.ageSeconds >= 60 && !item.hasWindow && !item.hasConnection &&
      item.paths.length > 0 && item.paths.every(path => normalized(path) === normalized(directory))
  })
  // Never stop a host with an unknown, active or non-matching child.
  let eligible = new Set(candidates.map(item => item.pid))
  for (;;) {
    const next = new Set(candidates.filter(item => eligible.has(item.pid) &&
      item.childPids.every(pid => eligible.has(pid) || item.passiveChildPids?.includes(pid)) &&
      (runtimeKind(item.ancestors[0]) !== 'node' || eligible.has(item.ancestors[0].pid))).map(item => item.pid))
    if (next.size === eligible.size) break
    eligible = next
  }
  const ordered: ProjectLockProcess[] = []
  const visited = new Set<number>()
  const visit = (item: ProjectLockProcess): void => {
    if (visited.has(item.pid)) return
    visited.add(item.pid)
    for (const child of candidates) if (item.childPids.includes(child.pid)) visit(child)
    ordered.push(item)
  }
  for (const item of candidates) if (eligible.has(item.pid)) visit(item)
  return ordered
}

/** Run a bounded, hidden Windows helper. Paths and process identities are data, never code. */
async function lockCommand<T>(directory: string, action: 'inspect' | 'release', candidates: ProjectLockProcess[] = []): Promise<T> {
  const executable = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const scriptDirectory = await mkdtemp(join(tmpdir(), 'ai-writer-lock-'))
  const scriptFile = join(scriptDirectory, 'project-lock.ps1')
  try {
    await writeFile(scriptFile, '\uFEFF' + windowsProjectLockScript, 'utf8')
    return await new Promise<T>((resolve, reject) => {
      execFile(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
        windowsHide: true,
        cwd: process.env.SystemRoot || 'C:\\Windows',
        timeout: 12_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        env: {
          ...process.env,
          AI_WRITER_LOCK_DIRECTORY: directory,
          AI_WRITER_LOCK_ACTION: action,
          AI_WRITER_LOCK_CANDIDATES: JSON.stringify(candidates)
        }
      }, (error, stdout) => {
        if (error) { reject(error); return }
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as T) }
        catch (error) { reject(error) }
      })
    })
  } finally {
    // Only remove this exact mkdtemp directory, never the inspected project directory.
    await rm(scriptDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function inspectProjectFolderLocks(directory: string): Promise<ProjectLockSnapshot> {
  return lockCommand(directory, 'inspect')
}

export async function recoverProjectFolderLocks(directory: string): Promise<ProjectLockRecovery> {
  if (process.platform !== 'win32') return { released: [], remaining: [] }
  const snapshot = await inspectProjectFolderLocks(directory)
  const candidates = selectReleasableCodexHelpers(snapshot, directory, process.env.LOCALAPPDATA || '', process.pid)
  if (!candidates.length) return { released: [], remaining: snapshot.holders }
  const result = await lockCommand<{ released: number[] }>(directory, 'release', candidates)
  const remaining = (await inspectProjectFolderLocks(directory)).holders
  return { released: result.released, remaining }
}
