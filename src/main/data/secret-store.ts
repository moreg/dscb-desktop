import { safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { dirname } from 'path'

export interface ProvidersConfig {
  activeProvider: string
  providers: {
    minimax?: { apiKey: string }
    openai?: { apiKey: string }
    claude?: { apiKey: string }
    deepseek?: { apiKey: string }
  }
}

const EMPTY: ProvidersConfig = { activeProvider: 'minimax', providers: {} }

export class SecretStore {
  constructor(private readonly file: string) {}

  async read(): Promise<ProvidersConfig> {
    let buf: Buffer
    try {
      buf = await fs.readFile(this.file)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return { ...EMPTY }
      throw err
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secure storage unavailable')
    }
    const json = safeStorage.decryptString(buf)
    return JSON.parse(json) as ProvidersConfig
  }

  async write(config: ProvidersConfig): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secure storage unavailable')
    }
    await fs.mkdir(dirname(this.file), { recursive: true })
    const encrypted = safeStorage.encryptString(JSON.stringify(config))
    await fs.writeFile(this.file, encrypted)
  }
}
