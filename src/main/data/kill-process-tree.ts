import { spawn, type ChildProcess } from 'child_process'

/**
 * 尽力终止子进程及其整棵进程树。
 *
 * 背景：Windows 上 `child.kill('SIGTERM')` 往往只杀直接子进程；
 * codex / grok / agy 会再拉起 node/host 孙进程，点「停止」后孙进程继续跑、
 * token 仍往 UI 灌，表现为「停不下来」。Unix 上用进程组 + SIGKILL 兜底。
 */
export function killProcessTree(child: ChildProcess | null | undefined): void {
  // child.killed 只表示 kill() 成功发送过信号，不代表进程已经退出。
  if (!child || child.exitCode != null || child.signalCode != null) return
  const pid = child.pid
  if (pid == null || pid <= 0) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    return
  }

  if (process.platform === 'win32') {
    // /T 杀整棵树，/F 强制；异步 fire-and-forget，close 事件仍由 child 自己触发
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
      killer.unref?.()
    } catch {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
    return
  }

  try {
    // 负 pid：向整个进程组发信号（spawn 时需 detached 才有组；没有组时退化为杀自身）
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => {
    if (child.exitCode != null || child.signalCode != null) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }, 1500).unref?.()
}
