import { promises as fs } from 'fs'
import { basename } from 'path'
import type { SettingsRepository } from './settings-repository'

/** 图像生成请求超时（毫秒）。文生图 3 分钟，图生图 4 分钟 */
const GENERATE_TIMEOUT_MS = 180_000
const EDIT_TIMEOUT_MS = 240_000

/** 允许的参考图扩展名（防任意文件读取外传） */
export const ALLOWED_IMAGE_EXTS = /\.(png|jpg|jpeg|webp|gif|bmp)$/i

/**
 * 图像生成服务（调 OpenAI Images API 或兼容代理）。
 *
 * 与文本 LlmService 分离，因为：
 * - 图像按张计费，与文本 token 不同（不进用量统计维度）
 * - 接口形态不同（Images API 返回 base64，非 SSE 流）
 *
 * 支持 gpt-image-2 及兼容模型。注意：请求体不要带 response_format
 * （旧 DALL-E 参数，gpt-image 系列不支持）。
 */
export class ImageService {
  constructor(private readonly settings: SettingsRepository) {}

  /** 文生图：返回 base64（不含 data: 前缀） */
  async generate(prompt: string, size: string): Promise<string> {
    const cfg = await this.requireConfig()
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/images/generations`
    // 不带 response_format（gpt-image 系列）
    const body: Record<string, unknown> = { model: cfg.model, prompt, size }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS)
    })
    return this.parseImageResponse(res, 'IMAGE_REQUEST_FAILED')
  }

  /** 图生图：传参考图本地路径，返回 base64 */
  async edit(prompt: string, size: string, imagePath: string): Promise<string> {
    const cfg = await this.requireConfig()
    const imgBuffer = await fs.readFile(imagePath)
    const imgBlob = new Blob([imgBuffer])

    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/images/edits`
    const form = new FormData()
    form.append('model', cfg.model)
    form.append('size', size)
    form.append('prompt', prompt)
    form.append('image', imgBlob, basename(imagePath))

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(EDIT_TIMEOUT_MS)
    })
    return this.parseImageResponse(res, 'IMAGE_EDIT_FAILED')
  }

  /** 校验配置存在，返回脱敏前的完整配置（apiKey 不入日志） */
  private async requireConfig(): Promise<{ apiKey: string; baseUrl: string; model: string }> {
    const cfg = await this.settings.getCoverImageConfig()
    if (!cfg.apiKey) throw new Error('IMAGE_NOT_CONFIGURED')
    return cfg
  }

  /** 统一解析图像 API 响应：校验 HTTP 状态 + 提取 b64_json */
  private async parseImageResponse(res: Response, errorLabel: string): Promise<string> {
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`${errorLabel} (${res.status}): ${errText.slice(0, 200)}`)
    }
    const json = (await res.json()) as { data?: Array<{ b64_json?: string }> }
    const b64 = json.data?.[0]?.b64_json
    if (!b64) throw new Error('IMAGE_EMPTY_RESPONSE（API 未返回 b64_json）')
    return b64
  }
}
