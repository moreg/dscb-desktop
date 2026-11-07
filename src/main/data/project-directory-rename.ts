import { promises as fs } from 'fs'
import { recoverProjectFolderLocks, type ProjectLockRecovery } from './project-folder-locks'

export class ProjectFolderInUseError extends Error {}

const isBusy = (error: unknown): boolean =>
  ['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException)?.code || '')

/** Fast retry first; only run the Windows diagnostic when normal rename still fails. */
export async function renameProjectDirectory(from: string, to: string): Promise<void> {
  const attemptRename = async (): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(from, to); return }
      catch (error) {
        if (!isBusy(error) || attempt === 3) throw error
        await new Promise(resolve => setTimeout(resolve, 80 * (attempt + 1)))
      }
    }
  }
  let originalError: unknown
  try { await attemptRename(); return }
  catch (error) {
    if (!isBusy(error)) throw error
    originalError = error
  }
  let recovery: ProjectLockRecovery | undefined
  if (process.platform === 'win32') {
    try { recovery = await recoverProjectFolderLocks(from) }
    catch { console.warn('[project-rename] Windows lock inspection unavailable; retrying normally.') }
    // Handles may close while inspecting, even when no eligible helper was stopped.
    try { await attemptRename(); return }
    catch (error) {
      if (!isBusy(error)) throw error
      originalError = error
    }
  }
  const owners = recovery?.remaining.slice(0, 6)
    .map(item => `${item.name || '未知程序'}（PID ${item.pid}）`).join('、')
  const message = owners
    ? `自动重试后，文件夹仍由以下程序使用：${owners}。请关闭对应程序后再次保存；本次书名和简介尚未保存。`
    : '已自动释放本应用的目录监听并重试，仍无法重命名文件夹。请检查其他程序的占用或目录写入权限后再次保存；本次书名和简介尚未保存。'
  throw new ProjectFolderInUseError(message, { cause: originalError })
}
