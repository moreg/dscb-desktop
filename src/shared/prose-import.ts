import type { ProjectMeta } from './types'

export type ProseImportEncoding = 'auto' | 'utf-8' | 'gb18030' | 'utf-16le' | 'utf-16be'
export interface ProseImportRequest {
  mode: 'files' | 'folder'
  folderPath?: string
  encoding: ProseImportEncoding
}
export interface ProseImportPreview {
  token: string
  suggestedName: string
  fileCount: number
  detectedCount: number
  chapters: Array<{ number: number; title: string; source: string; excerpt: string }>
  duplicates: string[]
  issues: string[]
  missing: string[]
}
export interface ProseImportResult {
  project: ProjectMeta
  importedCount: number
  pendingCount: number
}
