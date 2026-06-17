import type { RendererApi } from './types'

declare global {
  interface Window {
    api: RendererApi
  }
}

export {}
