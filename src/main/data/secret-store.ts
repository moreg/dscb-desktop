import { promises as fs } from 'fs'
import { dirname } from 'path'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

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
const APP_SECRET = 'ai-writer-desktop-v1'
const SALT = Buffer.from('a1b2c3d4e5f60718293a4b5c6d7e8f90', 'hex')
const KEY = scryptSync(APP_SECRET, SALT, 32)

function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

function decrypt(b64: string): string {
  const buf = Buffer.from(b64, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const enc = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}

export class SecretStore {
  constructor(private readonly file: string) {}

  async read(): Promise<ProvidersConfig> {
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf-8')
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return { ...EMPTY }
      throw err
    }
    const json = decrypt(raw.trim())
    return JSON.parse(json) as ProvidersConfig
  }

  async write(config: ProvidersConfig): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true })
    const b64 = encrypt(JSON.stringify(config))
    await fs.writeFile(this.file, b64, 'utf-8')
  }
}
