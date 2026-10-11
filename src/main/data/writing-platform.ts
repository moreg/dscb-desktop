import { join } from 'path'
import { promises as fs } from 'fs'
import { parseWritingPlatformConfig, type WritingPlatformConfig } from '../../shared/writing-platform'

export { parseWritingPlatformConfig, renderWritingPlatformConfig, type WritingPlatformConfig } from '../../shared/writing-platform'

export async function readWritingPlatformConfig(projectDir: string): Promise<WritingPlatformConfig | null> {
  try {
    const text = await fs.readFile(join(projectDir, '设定', '平台配置.md'), 'utf-8')
    return text.trim() ? parseWritingPlatformConfig(text) : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

