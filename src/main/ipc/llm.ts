import { ipcMain, BrowserWindow } from 'electron'
import { LlmService } from '../data/llm-service'
import { SecretStore } from '../data/secret-store'

export function registerLlmIpc(secret: SecretStore, service: LlmService): void {
  ipcMain.handle('llm:configure', async (_e, apiKey: string) => {
    const config = await secret.read()
    config.providers.minimax = { apiKey }
    config.activeProvider = 'minimax'
    await secret.write(config)
    return true
  })

  ipcMain.handle('llm:hasKey', async () => {
    const config = await secret.read()
    return Boolean(config.providers.minimax?.apiKey)
  })

  ipcMain.handle(
    'llm:generate',
    async (e, payload: { prompt: string; requestId: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        await service.generateStream(payload.prompt, {
          onToken: (token) =>
            win?.webContents.send('llm:token', {
              requestId: payload.requestId,
              token,
              done: false
            })
        })
        win?.webContents.send('llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )
}
