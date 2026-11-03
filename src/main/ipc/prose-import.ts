import { dialog } from 'electron'
import { z } from 'zod'
import { safeHandle } from './safe-handle'
import { validateInput } from './validation'
import { prepareProseImport, type ProseImportPlan } from '../data/prose-import'
import type { ProjectService } from '../data/project-service'

const previewSchema = z.object({
  mode: z.enum(['files', 'folder']),
  folderPath: z.string().max(4096).optional(),
  encoding: z.enum(['auto', 'utf-8', 'gb18030', 'utf-16le', 'utf-16be'])
})
const commitSchema = z.object({ token: z.string().uuid(), name: z.string().trim().min(1).max(100) })

export function registerProseImportIpc(service: ProjectService): void {
  const sessions = new Map<number, { plan: ProseImportPlan; expires: number }>()
  const busy = new Set<number>()
  const watched = new Set<number>()
  const prune = () => {
    for (const [id, session] of sessions) if (session.expires < Date.now() && !busy.has(id)) sessions.delete(id)
  }
  const timer = setInterval(prune, 60000)
  timer.unref()
  safeHandle('library:previewProse', async (event, payload: unknown) => {
    const request = validateInput(previewSchema, payload)
    const owner = event.sender.id
    if (busy.has(owner)) throw new Error('正在处理导入，请稍候。')
    busy.add(owner)
    sessions.delete(owner)
    prune()
    try {
      let paths: string[]
      if (request.mode === 'folder' && request.folderPath?.trim()) paths = [request.folderPath.trim()]
      else {
        const selected = await dialog.showOpenDialog({
          title: request.mode === 'folder' ? '选择正文文件夹' : '选择正文文件（可多选）',
          filters: [{ name: '正文文件', extensions: ['txt', 'md'] }],
          properties: request.mode === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections']
        })
        if (selected.canceled || !selected.filePaths.length) return null
        paths = selected.filePaths
      }
      const plan = await prepareProseImport(paths, request.encoding)
      if (event.sender.isDestroyed()) return null
      if (!watched.has(owner)) {
        watched.add(owner)
        event.sender.once('destroyed', () => { sessions.delete(owner); watched.delete(owner) })
      }
      sessions.set(owner, { plan, expires: Date.now() + 30 * 60 * 1000 })
      return plan.preview
    } finally { busy.delete(owner) }
  })
  safeHandle('library:cancelProse', async (event) => {
    if (!busy.has(event.sender.id)) sessions.delete(event.sender.id)
  })
  safeHandle('library:commitProse', async (event, payload: unknown) => {
    const input = validateInput(commitSchema, payload)
    const owner = event.sender.id
    if (busy.has(owner)) throw new Error('正在处理导入，请勿重复提交。')
    const session = sessions.get(owner)
    if (!session || session.expires < Date.now() || session.plan.preview.token !== input.token) {
      throw new Error('预览已失效，请重新选择正文。')
    }
    busy.add(owner)
    try {
      const result = await service.importProse(input.name, session.plan)
      sessions.delete(owner)
      return result
    } finally { busy.delete(owner) }
  })
}
