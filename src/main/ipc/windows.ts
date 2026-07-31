import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { safeHandle } from './safe-handle'
import { projectIdSchema, validateInput } from './validation'

export interface ProjectWindowResult {
  ok: boolean
  focusedExisting: boolean
}

interface ProjectWindowActions {
  open(projectId: string): ProjectWindowResult
  bind(window: BrowserWindow, projectId: string | null): ProjectWindowResult
}

export function registerWindowsIpc(actions: ProjectWindowActions): void {
  safeHandle('windows:openProject', (_event, projectId: string) => {
    const validated = validateInput(projectIdSchema, projectId)
    return actions.open(validated)
  })

  safeHandle('windows:bindProject', (event, projectId: string | null) => {
    const validated = validateInput(z.union([projectIdSchema, z.null()]), projectId)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('window not found')
    return actions.bind(window, validated)
  })
}
