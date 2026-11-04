import { app } from 'electron'
import { join } from 'path'
import { readJson, writeJsonAtomic } from '../main/data/atomic'
import { safeHandle } from '../main/ipc/safe-handle'
import type { AppUpdateState } from '../shared/app-update'

/**
 * Web 版没有 electron-updater，无法自动下载/安装桌面端安装包。
 * 但渲染层的 AppUpdatePanel 启动时就会 invoke('updates:getState')，
 * 若没有注册 handler，页面控制台每次都会抛一个 500。
 *
 * 这里为 web 模式补齐 updates:* 全套通道：
 * - getState 返回 supported:false 的稳定状态，面板显示"自动更新仅在安装后的 Windows 应用中启用"
 * - check/download/restart 返回同样的状态，不做任何实际动作
 * - setAutoCheck 仍然落盘，保持偏好行为一致
 */
export function registerWebAppUpdates(): void {
  const preferencesFile = join(app.getPath('userData'), 'config', 'updates.json')
  let state: AppUpdateState = {
    currentVersion: app.getVersion(),
    supported: false,
    autoCheck: true,
    status: 'idle'
  }

  const readPreferences = async (): Promise<boolean> => {
    const preferences = await readJson(preferencesFile, { autoCheck: true }).catch(() => ({ autoCheck: true }))
    return preferences.autoCheck !== false
  }

  const publish = (patch: Partial<AppUpdateState>): AppUpdateState => {
    state = { ...state, ...patch }
    return state
  }

  void readPreferences().then(autoCheck => {
    publish({ autoCheck })
  })

  safeHandle('updates:getState', () => {
    // 页面重新加载时清掉上一次 download/restart 留下的提示，回到干净的 idle 状态。
    if (state.status === 'error' && state.error?.startsWith('Web 版不支持自动更新')) {
      return publish({ status: 'idle', error: undefined })
    }
    return state
  })

  safeHandle('updates:check', () => {
    // Web 版不支持自动更新，保持 idle，不制造噪音错误。
    return publish({ status: 'idle', error: undefined })
  })

  safeHandle('updates:download', () => {
    // status 用 'error'，让 AppUpdatePanel 的 error 分支统一展示提示，
    // 避免 status='idle' 但带 error 时被当作残留警告渲染出来。
    return publish({ status: 'error', error: 'Web 版不支持自动更新，请在桌面端下载安装包。' })
  })

  safeHandle('updates:restart', () => {
    return publish({ status: 'error', error: 'Web 版不支持自动更新，请在桌面端安装更新。' })
  })

  safeHandle('updates:setAutoCheck', async (_event, enabled: unknown) => {
    const autoCheck = enabled !== false
    await writeJsonAtomic(preferencesFile, { autoCheck }).catch(() => undefined)
    return publish({ autoCheck })
  })
}
