import { describe, it, expect, vi } from 'vitest'
import type { DeslopService } from '../src/main/data/deslop/deslop-service'
import type { ProjectService } from '../src/main/data/project-service'
import type { StyleProfileService } from '../src/main/data/style-profile-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler) },
  BrowserWindow: { fromWebContents: () => null }
}))
import { registerDeslopIpc } from '../src/main/ipc/deslop'

describe('首次去 AI 味扫描入口', () => {
  it('直接调用完整场景扫描，并保留失败状态给界面', async () => {
    const report = { findings: [], narrative: { status: 'failed', checkedChunks: 0, totalChunks: 1, error: '连接超时' } }
    const scanWithNarrative = vi.fn().mockResolvedValue(report)
    const scan = vi.fn()
    registerDeslopIpc(
      { scanWithNarrative, scan } as unknown as DeslopService,
      { resolveDir: async () => { throw new Error('无白名单') } } as unknown as ProjectService,
      {} as StyleProfileService,
      { getDeslopRules: async () => ({}) } as unknown as SettingsRepository
    )
    expect(await handlers.get('deslop:scan')!({}, { projectId: 'project-1', text: '“你就卖十块？”' })).toBe(report)
    expect(scanWithNarrative).toHaveBeenCalledWith('“你就卖十块？”', expect.objectContaining({ meta: { projectId: 'project-1' } }))
    expect(scan).not.toHaveBeenCalled()
  })
})
