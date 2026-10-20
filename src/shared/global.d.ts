import type { RendererApi } from './types'

declare global {
  interface Window {
    api: RendererApi
    /** 由 Web 构建的页面注入。桌面版没有这个标记。 */
    __DSCB_WEB__?: boolean
  }
}

export {}
